/**
 * shared/observers.ts `readObservers` against a real page (headless Chromium,
 * see page-harness). It reads the ring buffers the in-page hook keeps on a
 * global; these pin the read contract the console_logs / network_log / dialogs
 * tools rely on: absent hook, policy and prompt updates, sinceSeq polling,
 * limit keeping the newest, explicit draining, and the Resource Timing
 * fallback with its cursor (so a resource is reported once, not on every read).
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

import { OBSERVER_GLOBAL, observerMatches } from '../shared/observers';
import { ORIGIN, hasChromium, openHarness, type PageHarness } from './page-harness';

let h: PageHarness;

before(async () => {
  if (hasChromium) h = await openHarness();
});
after(async () => {
  await h?.close();
});

type Opts = Record<string, unknown>;
type Read = Record<string, unknown> & { installed: boolean };

function read(opts: Opts, globalName: string = OBSERVER_GLOBAL): Promise<Read> {
  return h.page.evaluate(
    ([g, o]) =>
      (window as unknown as { __mcp: { observers: { readObservers: (g: string, o: unknown) => Read } } }).__mcp.observers.readObservers(g, o),
    [globalName, opts] as const,
  );
}

/** Install hook-shaped state: seq 1..n across console, network and dialogs. */
async function install(): Promise<void> {
  await h.page.evaluate((g) => {
    const state = {
      v: 1,
      seq: 6,
      console: [
        { seq: 1, ts: 1, level: 'log', text: 'one' },
        { seq: 3, ts: 3, level: 'error', text: 'three' },
        { seq: 5, ts: 5, level: 'warn', text: 'five' },
      ],
      network: [
        { seq: 2, ts: 2, via: 'fetch', method: 'GET', url: '/a', status: 200 },
        { seq: 4, ts: 4, via: 'xhr', method: 'POST', url: '/b', status: 500 },
      ],
      dialogs: [{ seq: 6, ts: 6, kind: 'confirm', message: 'Sure?', answered: 'dismiss' }],
      dialogPolicy: 'dismiss',
      promptText: '',
      dropped: true,
      resourceCursor: 0,
    };
    (window as unknown as Record<string, unknown>)[g] = state;
  }, OBSERVER_GLOBAL);
}

const state = (): Promise<Record<string, unknown>> =>
  h.page.evaluate((g) => (window as unknown as Record<string, Record<string, unknown>>)[g], OBSERVER_GLOBAL);

test('readObservers: no hook on the page reads as not installed', { skip: !hasChromium }, async () => {
  await h.load('');
  assert.deepEqual(await read({ console: true }), { installed: false });
});

test('readObservers: returns only the buffers asked for, with hook version, policy and dropped flag', { skip: !hasChromium }, async () => {
  await h.load('');
  await install();
  const res = await read({ console: true, dialogs: true });
  assert.equal(res.installed, true);
  assert.equal(res.hookVersion, 1);
  assert.equal(res.dialogPolicy, 'dismiss');
  assert.equal(res.dropped, true);
  assert.deepEqual((res.console as Array<{ text: string }>).map((e) => e.text), ['one', 'three', 'five']);
  assert.deepEqual((res.dialogs as Array<{ message: string }>).map((e) => e.message), ['Sure?']);
  assert.equal(res.network, undefined, 'network not requested');
});

test('readObservers: sinceSeq returns only newer entries, and limit keeps the newest', { skip: !hasChromium }, async () => {
  await h.load('');
  await install();
  const since = await read({ console: true, network: true, sinceSeq: 2 });
  assert.deepEqual((since.console as Array<{ seq: number }>).map((e) => e.seq), [3, 5]);
  assert.deepEqual((since.network as Array<{ seq: number }>).map((e) => e.seq), [4]);

  const limited = await read({ console: true, limit: 2 });
  assert.deepEqual((limited.console as Array<{ seq: number }>).map((e) => e.seq), [3, 5], 'the newest two');

  const badLimit = await read({ console: true, limit: 0 });
  assert.equal((badLimit.console as unknown[]).length, 3, 'a non-positive limit falls back to the default');
});

test('readObservers: setPolicy and promptText update the hook; anything else is ignored', { skip: !hasChromium }, async () => {
  await h.load('');
  await install();
  const res = await read({ setPolicy: 'accept', promptText: 'my answer' });
  assert.equal(res.dialogPolicy, 'accept');
  assert.equal((await state()).promptText, 'my answer');
  const bogus = await read({ setPolicy: 'explode' });
  assert.equal(bogus.dialogPolicy, 'accept', 'an unknown policy leaves the current one');
  await read({ setPolicy: 'dismiss', promptText: null });
  const s = await state();
  assert.equal(s.dialogPolicy, 'dismiss');
  assert.equal(s.promptText, 'my answer', 'a null promptText is not a reset');
});

test('readObservers: clear drains exactly the buffers it returned and resets dropped', { skip: !hasChromium }, async () => {
  await h.load('');
  await install();
  const first = await read({ console: true, clear: true });
  assert.equal((first.console as unknown[]).length, 3, 'clear still returns what it drains');
  const s = await state();
  assert.equal((s.console as unknown[]).length, 0);
  assert.equal((s.network as unknown[]).length, 2, 'network was not read, so not drained');
  assert.equal((s.dialogs as unknown[]).length, 1);
  assert.equal(s.dropped, false);

  await read({ network: true, dialogs: true, clear: true });
  const after2 = await state();
  assert.equal((after2.network as unknown[]).length, 0);
  assert.equal((after2.dialogs as unknown[]).length, 0);
});

test('readObservers: includeResources adds Resource Timing entries once, after the cursor', { skip: !hasChromium }, async () => {
  const long = `/res/${'x'.repeat(2100)}.js`;
  h.serve(`${ORIGIN}/res/one.js`, 'void 0;', 'application/javascript');
  h.serve(`${ORIGIN}${long}`, 'void 0;', 'application/javascript');
  await h.load(`<script src="/res/one.js"></script><script src="${long}"></script>`);
  await install();

  const res = await read({ network: true, includeResources: true });
  const net = res.network as Array<Record<string, unknown>>;
  const resources = net.filter((e) => e.via === 'resource');
  assert.ok(resources.length >= 2, 'the module scripts and the fixture scripts are resources too');
  const one = resources.find((e) => String(e.url).endsWith('/res/one.js'));
  assert.ok(one);
  assert.equal(one.method, 'GET');
  assert.equal(one.initiator, 'script');
  assert.equal(typeof one.durationMs, 'number');
  assert.ok((one.seq as number) > 6, 'resource entries continue the hook sequence');
  const longEntry = resources.find((e) => String(e.url).includes('xxxx'));
  assert.ok(longEntry);
  assert.equal(String(longEntry.url).length, 2001, 'very long URLs are cut to 2000 chars plus an ellipsis');
  assert.ok(String(longEntry.url).endsWith('…'));

  const again = await read({ network: true, includeResources: true, sinceSeq: one.seq as number });
  const repeated = (again.network as Array<Record<string, unknown>>).filter((e) => e.url === one.url);
  assert.deepEqual(repeated, [], 'the cursor stops a resource from being reported twice');

  const without = await read({ network: true });
  assert.equal(
    (without.network as Array<Record<string, unknown>>).filter((e) => e.via === 'resource').length,
    resources.length,
    'already-recorded resources stay in the buffer; no new ones are added without includeResources',
  );
});

test('readObservers: a broken Resource Timing API leaves the fetch/XHR records intact', { skip: !hasChromium }, async () => {
  await h.load('');
  await install();
  await h.page.evaluate(() => {
    performance.getEntriesByType = () => {
      throw new Error('unavailable');
    };
  });
  const res = await read({ network: true, includeResources: true });
  assert.deepEqual((res.network as Array<{ seq: number }>).map((e) => e.seq), [2, 4]);
});

test('readObservers: the global name is a parameter, not a constant', { skip: !hasChromium }, async () => {
  await h.load('');
  await install();
  assert.deepEqual(await read({ console: true }, '__someOtherGlobal'), { installed: false });
});

test('observerMatches: bare hosts, wildcard subdomains, all-domains, and disabled observers', () => {
  assert.deepEqual(observerMatches({ allowDomains: ['example.com'], allowObservers: false } as never), []);
  assert.deepEqual(
    observerMatches({ allowDomains: ['example.com', '*.github.com', 'example.com'], allowObservers: true } as never),
    ['*://example.com/*', '*://*.github.com/*'],
  );
  assert.deepEqual(observerMatches({ allowDomains: ['a.com', '*'], allowObservers: true } as never), ['<all_urls>']);
  assert.deepEqual(observerMatches({ allowObservers: true } as never), []);
});
