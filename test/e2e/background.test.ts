/**
 * The agent works in the background: nothing it does may take the person off
 * the tab they are on, and a page that stops answering must not freeze the
 * extension for every later call.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { RUN_E2E, startHarness, textOf, type Harness } from './harness';

let h: Harness;
const skip = !RUN_E2E;

/** The id of the tab the person is looking at, read from Chrome itself. */
const activeTabId = (): Promise<number | undefined> =>
  h.inSw(async () => {
    type Tabs = { tabs: { query(q: object): Promise<{ id?: number }[]> } };
    const c = (globalThis as unknown as { chrome: Tabs }).chrome;
    const [t] = await c.tabs.query({ active: true, lastFocusedWindow: true });
    return t?.id;
  });

/** Chrome's own numeric id inside a minted "ext:<session>:<id>" handle. */
const rawId = (tabId: string): number => Number(tabId.split(':').pop());

before(async () => {
  if (!skip) h = await startHarness();
});
after(async () => {
  await h?.close();
});

test('a full work session never changes the tab the person is on', { skip }, async () => {
  const mine = await activeTabId();
  assert.ok(mine !== undefined, 'the browser starts with a tab of its own');

  const tab = await h.open('/form');
  await h.json('navigate', { url: `${h.base}/form` });
  await h.json('type', { selector: '#name', text: 'Ada' });
  await h.json('type', { selector: '#email', text: 'ada@example.com', trusted: true });
  await h.json('click', { selector: '#agree', trusted: true });
  await h.json('select_option', { selector: '#color', values: ['blue'] });
  await h.json('screenshot', {});
  await h.json('screenshot', { fullPage: true });
  await h.json('get_text', {});
  await h.json('snapshot', {});
  await h.json('hover', { selector: '#hoverme' });
  await h.json('scroll', { deltaY: 200 });
  await h.json('reload', {});

  assert.equal(await activeTabId(), mine, 'the person must still be on their own tab');
  await h.json('tab_close', { tabId: tab });
});

test('tab_select switches the agent without showing the tab; show:true brings it forward', { skip }, async () => {
  const mine = await activeTabId();
  const a = await h.open('/');
  const b = await h.open('/form');

  const picked = await h.json<{ tabId: string; shown: boolean }>('tab_select', { tabId: a });
  assert.equal(picked.shown, false);
  assert.equal(await activeTabId(), mine, 'a plain tab_select stays in the background');
  // Calls without a tabId now go to the picked tab.
  const text = await h.json<{ text: string }>('get_text', {});
  assert.match(text.text, /E2E-HOME/);

  await h.json('tab_select', { tabId: b, show: true });
  assert.equal(await activeTabId(), rawId(b), 'show:true is the one way to bring a tab forward');

  await h.json('tab_close', { tabId: a });
  await h.json('tab_close', { tabId: b });
});

test('a page that stops answering fails fast and leaves the tab usable', { skip, timeout: 120_000 }, async () => {
  const tab = await h.open('/hang');
  await h.json('click', { selector: '#spin', tabId: tab });
  await new Promise((r) => setTimeout(r, 300)); // the renderer is now busy for 30s

  const started = Date.now();
  const shot = await h.call('screenshot', { tabId: tab });
  const took = Date.now() - started;
  assert.equal(shot.isError, true, 'a frozen page cannot be captured');
  assert.match(textOf(shot), /TIMEOUT/);
  assert.ok(took < 26_000, `screenshot gives up on its own deadline, not the 60s call timeout (took ${took}ms)`);

  // Once the page recovers, debugger-backed calls on the same tab work again:
  // the hung capture did not leave the per-tab lock held.
  const recovered = Date.now() + 15_000;
  let shotAgain = await h.call('screenshot', { tabId: tab });
  while (shotAgain.isError && Date.now() < recovered) {
    await new Promise((r) => setTimeout(r, 1000));
    shotAgain = await h.call('screenshot', { tabId: tab });
  }
  assert.equal(shotAgain.isError, undefined, textOf(shotAgain));
  const click = await h.call('click', { selector: '#spin', tabId: tab, trusted: true });
  assert.equal(click.isError, undefined, textOf(click));
  await h.call('tab_close', { tabId: tab });
});

test('one frozen tab does not stall screenshots in the other tabs', { skip, timeout: 120_000 }, async () => {
  const frozen = await h.open('/hang');
  const healthy = await h.open('/');
  // Border both tabs, so a capture has to take the shared border lock.
  await h.json('get_text', { tabId: frozen });
  await h.json('get_text', { tabId: healthy });
  await h.json('click', { selector: '#spin', tabId: frozen });
  await new Promise((r) => setTimeout(r, 300));

  // Start a capture of the frozen tab and leave it pending.
  const stuck = h.call('screenshot', { tabId: frozen });
  await new Promise((r) => setTimeout(r, 500));

  const started = Date.now();
  const shot = await h.call('screenshot', { tabId: healthy });
  const took = Date.now() - started;
  assert.equal(shot.isError, undefined, textOf(shot));
  assert.ok(took < 6_000, `the healthy tab's screenshot must not wait on the frozen one (took ${took}ms)`);

  await stuck;
  await h.call('tab_close', { tabId: frozen });
  await h.call('tab_close', { tabId: healthy });
});
