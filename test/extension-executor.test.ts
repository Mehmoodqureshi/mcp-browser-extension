/**
 * ExtensionExecutor: every Executor method against a fake bridge that records
 * the wire command it would send. The executor is a translation layer, so the
 * contract is the exact (method, params, tabId, timeout, profile) it emits, plus
 * the few places it adds behaviour of its own: the fill_form capability gate
 * and its partial-failure message, proxy_status on an old extension, eval
 * truncation, download relocation into the task folder, and the short-lived
 * "opening tab" memory.
 */

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ExtensionExecutor } from '../src/executor/extension-executor';
import { ExecutorError, MAX_EVAL_BYTES } from '../src/executor/types';
import type { BridgeServer } from '../src/bridge/server';
import { ensureWorkspace } from '../src/bridge/datadir';
import { resetActiveWorkspaceForTesting, setActiveWorkspace } from '../src/bridge/workspace';
import { MAX_DOWNLOAD_BYTES } from '../shared/download';
import { WIRE_CAP_FILL_FORM, fillFormTimeoutMs } from '../shared/protocol';

interface Sent {
  method: string;
  params: Record<string, unknown>;
  opts: { tabId?: string; timeoutMs?: number; profile?: string };
}

class FakeBridge {
  sent: Sent[] = [];
  connected = new Set<string>(['default']);
  caps = new Set<string>();
  reply: (method: string, params: Record<string, unknown>) => unknown = () => ({ ok: true });
  lastActive: Array<[string, number]> = [];
  lastTab: Array<[string, string, number]> = [];

  async sendCommand(method: string, params: Record<string, unknown>, opts: Sent['opts'] = {}): Promise<unknown> {
    this.sent.push({ method, params, opts });
    return this.reply(method, params);
  }
  hasConnection(profile: string): boolean {
    return this.connected.has(profile);
  }
  connectedProfiles(): string[] {
    return [...this.connected];
  }
  noPairMessage(profile: string): string {
    return `no browser paired as "${profile}"`;
  }
  hasCap(_profile: string, cap: string): boolean {
    return this.caps.has(cap);
  }
  lastActiveUrl(profile: string, ttl: number): string | null {
    this.lastActive.push([profile, ttl]);
    return 'https://example.com/';
  }
  lastTabUrl(profile: string, tabId: string, ttl: number): string | null {
    this.lastTab.push([profile, tabId, ttl]);
    return tabId === 't1' ? 'https://example.com/t1' : null;
  }
}

function setup(): { ex: ExtensionExecutor; bridge: FakeBridge; last: () => Sent } {
  const bridge = new FakeBridge();
  const ex = new ExtensionExecutor(bridge as unknown as BridgeServer);
  return { ex, bridge, last: () => bridge.sent[bridge.sent.length - 1] };
}

function useWorkspace(profile = 'work'): { dataDir: string; downloadDir: string } {
  const dataDir = mkdtempSync(join(tmpdir(), 'cmcp-extexec-'));
  const w = ensureWorkspace(dataDir, profile, 'task-1', { createdAt: new Date().toISOString() });
  setActiveWorkspace(w);
  return { dataDir, downloadDir: w.downloadDir };
}

afterEach(() => resetActiveWorkspaceForTesting());

test('status/ping/unavailableReason follow the active profile', async () => {
  const { ex, bridge } = setup();
  const ok = ex.status();
  assert.equal(ok.ready, true);
  assert.equal(ok.backend, 'extension');
  assert.equal(ok.activeProfile, 'default', 'no workspace yet: the default profile');
  assert.equal(ok.detail, undefined);
  assert.deepEqual(ok.connectedProfiles, ['default']);
  assert.equal(ok.cdpAttached, false);
  assert.equal(await ex.ping(50), true);
  assert.deepEqual(bridge.sent[0], { method: 'ping_probe', params: {}, opts: { timeoutMs: 50, profile: 'default' } });
  assert.match(ex.unavailableReason(), /profile "default" is not responding/);

  useWorkspace('work');
  const off = ex.status();
  assert.equal(off.ready, false);
  assert.equal(off.activeProfile, 'work');
  assert.equal(off.detail, 'active profile "work" has no paired browser');
  assert.equal(ex.unavailableReason(), 'no browser paired as "work"');
  const before = bridge.sent.length;
  assert.equal(await ex.ping(), false, 'unpaired: false without a round-trip');
  assert.equal(bridge.sent.length, before);

  bridge.connected.add('work');
  bridge.reply = () => {
    throw new ExecutorError('TIMEOUT', 'late');
  };
  assert.equal(await ex.ping(), false, 'a failed probe is false, never a throw');
  assert.equal(bridge.sent[bridge.sent.length - 1].opts.timeoutMs, 800, 'default deadline');
  await ex.ensureReady();
  await ex.dispose();
});

test('cached URLs ask the bridge with the short TTL for the active profile', () => {
  const { ex, bridge } = setup();
  assert.equal(ex.cachedActiveUrl(), 'https://example.com/');
  assert.equal(ex.cachedTabUrl('t1'), 'https://example.com/t1');
  assert.equal(ex.cachedTabUrl('t2'), null);
  assert.deepEqual(bridge.lastActive, [['default', 2_000]]);
  assert.deepEqual(bridge.lastTab[0], ['default', 't1', 2_000]);
});

test('commands carry the routed profile once a workspace is active', async () => {
  const { ex, last } = setup();
  useWorkspace('research');
  await ex.tabsList();
  assert.deepEqual(last(), { method: 'tabs_list', params: {}, opts: { profile: 'research' } });
});

test('tab and navigation methods map onto their wire commands', async () => {
  const { ex, bridge, last } = setup();
  bridge.reply = (m) => (m === 'tab_new' ? { tabId: 'n1', url: 'https://a.test/', title: '' } : { ok: true });

  await ex.tabSelect('t9');
  assert.deepEqual(last(), { method: 'tab_select', params: {}, opts: { tabId: 't9', profile: 'default' } });
  await ex.tabNew('https://a.test/', { active: false });
  assert.deepEqual(last().params, { url: 'https://a.test/', active: false });
  await ex.tabClose('t9');
  assert.deepEqual(last(), { method: 'tab_close', params: {}, opts: { tabId: 't9', profile: 'default' } });
  await ex.navigate({ url: 'https://b.test/', tabId: 't2', waitUntil: 'domcontentloaded' });
  assert.deepEqual(last(), {
    method: 'navigate',
    params: { url: 'https://b.test/', waitUntil: 'domcontentloaded' },
    opts: { tabId: 't2', profile: 'default' },
  });
  await ex.back('t2');
  assert.equal(last().method, 'back');
  await ex.forward();
  assert.deepEqual(last(), { method: 'forward', params: {}, opts: { tabId: undefined, profile: 'default' } });
  await ex.reload({ tabId: 't3', waitUntil: 'networkidle' });
  assert.deepEqual(last(), { method: 'reload', params: { waitUntil: 'networkidle' }, opts: { tabId: 't3', profile: 'default' } });
  await ex.reload();
  assert.deepEqual(last().params, { waitUntil: undefined });
});

test('a background tab opened without a URL yet is remembered briefly as opening', async () => {
  const { ex, bridge } = setup();
  bridge.reply = (_m, p) => ({ tabId: p.url === 'https://slow.test/' ? 'slow' : 'fast', url: p.url === 'https://slow.test/' ? '' : 'https://fast.test/' });
  await ex.tabNew('https://slow.test/');
  await ex.tabNew('https://fast.test/');
  assert.equal(ex.isOpeningTab('slow'), true);
  assert.equal(ex.isOpeningTab('fast'), false, 'the URL came back: nothing to wait for');
  assert.equal(ex.isOpeningTab('never'), false);

  // An expired entry is dropped the next time a tab is opened.
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 60_000;
    assert.equal(ex.isOpeningTab('slow'), false, 'past the 10 s window');
    bridge.reply = () => ({ tabId: 'other', url: '' });
    await ex.tabNew('https://other.test/');
    assert.equal(ex.isOpeningTab('other'), true);
  } finally {
    Date.now = realNow;
  }
  const blank = setup();
  blank.bridge.reply = () => ({ tabId: 'b', url: '' });
  await blank.ex.tabNew();
  assert.equal(blank.ex.isOpeningTab('b'), false, 'no URL asked for: not an opening navigation');
});

test('interaction methods flatten targets and frame options into params', async () => {
  const { ex, last } = setup();
  await ex.click({ selector: '#go' }, { tabId: 't1', button: 'right', clickCount: 2, trusted: true, frameId: 3 });
  assert.deepEqual(last(), {
    method: 'click',
    params: { selector: '#go', frameId: 3, button: 'right', clickCount: 2, trusted: true },
    opts: { tabId: 't1', profile: 'default' },
  });
  await ex.click({ ref: 'e4' });
  assert.deepEqual(last().params, { ref: 'e4', button: undefined, clickCount: undefined, trusted: undefined });

  await ex.type({ ref: 'e1' }, 'hi', { clear: true, pressEnter: true, keyEvents: true, trusted: false, allFrames: true });
  assert.deepEqual(last().params, { ref: 'e1', allFrames: true, text: 'hi', clear: true, pressEnter: true, keyEvents: true, trusted: false });

  await ex.fill({ selector: '#email' }, 'a@b.c', { tabId: 't2' });
  assert.deepEqual(last(), {
    method: 'type',
    params: { selector: '#email', text: 'a@b.c', clear: true, keyEvents: false },
    opts: { tabId: 't2', profile: 'default' },
  });

  await ex.selectOption({ selector: 'select' }, ['a', 'b'], { frameId: 0 });
  assert.deepEqual(last().params, { selector: 'select', frameId: 0, values: ['a', 'b'] });

  await ex.press('Enter', { modifiers: ['Shift'], tabId: 't1' });
  assert.deepEqual(last(), { method: 'press', params: { key: 'Enter', modifiers: ['Shift'] }, opts: { tabId: 't1', profile: 'default' } });

  await ex.hover({ selector: '.menu' });
  assert.deepEqual(last().params, { selector: '.menu' });

  await ex.scroll({ deltaY: 300, target: { ref: 'e9' }, frameId: 1, tabId: 't1' });
  assert.deepEqual(last().params, { x: undefined, y: undefined, deltaX: undefined, deltaY: 300, ref: 'e9', frameId: 1 });

  const strokes = [{ points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }];
  await ex.draw(strokes as never, { tabId: 'c1' });
  assert.deepEqual(last(), { method: 'draw', params: { strokes }, opts: { tabId: 'c1', profile: 'default' } });

  await ex.uploadFile({ selector: 'input[type=file]' }, ['/tmp/a.txt'], { tabId: 't1' });
  assert.deepEqual(last().params, { selector: 'input[type=file]', files: ['/tmp/a.txt'] });
});

test('read methods pass their options through', async () => {
  const { ex, bridge, last } = setup();
  await ex.getText();
  assert.deepEqual(last().params, {});
  await ex.getText({ selector: 'main' }, { frameId: 2 });
  assert.deepEqual(last().params, { selector: 'main', frameId: 2 });
  await ex.getHtml({ ref: 'e2' }, { outer: true });
  assert.deepEqual(last().params, { ref: 'e2', outer: true });
  await ex.snapshot({ interactiveOnly: false, max: 50, locator: { role: 'button', name: 'Go' }, allFrames: true });
  assert.deepEqual(last().params, { interactiveOnly: false, max: 50, locator: { role: 'button', name: 'Go' }, allFrames: true });
  await ex.getCookies({ url: 'https://a.test/' });
  assert.deepEqual(last().params, { url: 'https://a.test/' });
  await ex.storage({ op: 'set', key: 'k', value: 'v', session: true, tabId: 't1' });
  assert.deepEqual(last(), { method: 'storage', params: { op: 'set', key: 'k', value: 'v', session: true }, opts: { tabId: 't1', profile: 'default' } });
  await ex.screenshot({ fullPage: true, format: 'png', quality: 80, scale: 2, target: { selector: '#c' } });
  assert.deepEqual(last().params, { fullPage: true, format: 'png', quality: 80, scale: 2, selector: '#c' });

  await ex.waitFor({ selector: '#x', gone: true, timeoutMs: 1_000 });
  assert.deepEqual(last().params, { selector: '#x', textContains: undefined, gone: true, timeoutMs: 1_000 });
  assert.equal(last().opts.timeoutMs, 6_000, 'the wire deadline outlives the in-page wait by 5 s');
  await ex.waitFor({ textContains: 'Done' });
  assert.equal(last().opts.timeoutMs, undefined, 'no explicit wait: the bridge default');

  bridge.reply = () => ({ frames: [{ frameId: 0, url: 'https://a.test/' }] });
  assert.deepEqual(await ex.framesList({ tabId: 't1' }), [{ frameId: 0, url: 'https://a.test/' }]);
  bridge.reply = () => ({});
  assert.deepEqual(await ex.framesList(), [], 'a reply without frames is an empty list');

  await ex.observers({ tabId: 't1', frameId: 0, console: true, network: false, dialogs: true, sinceSeq: 5, limit: 10, clear: true, setPolicy: 'accept', promptText: 'ok', includeResources: true });
  assert.deepEqual(last().params, {
    frameId: 0, console: true, network: false, dialogs: true, sinceSeq: 5, limit: 10, clear: true,
    setPolicy: 'accept', promptText: 'ok', includeResources: true,
  });

  await ex.printPdf({ landscape: true, scale: 0.5, pageRanges: '1-2', tabId: 't1' });
  assert.deepEqual(last(), {
    method: 'print_pdf',
    params: { landscape: true, printBackground: undefined, scale: 0.5, paperWidth: undefined, paperHeight: undefined, pageRanges: '1-2', preferCSSPageSize: undefined },
    opts: { tabId: 't1', timeoutMs: 60_000, profile: 'default' },
  });
});

test('eval results over the size cap are truncated, small ones pass through', async () => {
  const { ex, bridge, last } = setup();
  bridge.reply = () => ({ ok: true, value: { a: 1 }, type: 'object' });
  assert.deepEqual(await ex.eval('1', { awaitPromise: true, frameId: 4 }), { ok: true, value: { a: 1 }, type: 'object' });
  assert.deepEqual(last().params, { expression: '1', awaitPromise: true, frameId: 4 });

  bridge.reply = () => ({ ok: true, value: 'x'.repeat(MAX_EVAL_BYTES + 10), type: 'string' });
  const big = await ex.eval('big');
  assert.equal(big.truncated, true);
  assert.match(String(big.value), /\.\.\.\[truncated\]$/);
});

test('fillFields: asks even without the capability; null only when the extension lacks the op; a partial failure says how far it got', async () => {
  const { ex, bridge, last } = setup();
  const fields = [
    { selector: '#a', value: '1' },
    { selector: '#b', value: '2' },
    { selector: '#c', value: '3' },
  ];
  // A peer sees no capabilities at all, so it asks; an old extension says so.
  bridge.reply = () => {
    throw new ExecutorError('TARGET_GONE', 'unhandled method: fill_form');
  };
  assert.equal(await ex.fillFields(fields as never), null, 'old extension: caller goes field by field');
  assert.equal(bridge.sent.length, 1);
  bridge.reply = () => ({ filled: 3 });
  assert.deepEqual(await ex.fillFields(fields as never), { filled: 3 }, 'no capability seen (a peer): the batch still runs');
  bridge.reply = () => {
    throw new ExecutorError('TIMEOUT', 'slow');
  };
  await assert.rejects(ex.fillFields(fields as never), (err: unknown) => err instanceof ExecutorError && err.code === 'TIMEOUT');

  bridge.caps.add(WIRE_CAP_FILL_FORM);
  bridge.reply = () => ({ filled: 3 });
  assert.deepEqual(await ex.fillFields(fields as never, { tabId: 't1', frameId: 2 }), { filled: 3 });
  assert.deepEqual(last(), {
    method: 'fill_form',
    params: { ops: fields, frameId: 2 },
    opts: { tabId: 't1', timeoutMs: fillFormTimeoutMs(3), profile: 'default' },
  });

  bridge.reply = () => ({ filled: 1, error: { code: 'SELECTOR_NOT_FOUND', selector: '#b', message: 'no such element' } });
  await assert.rejects(ex.fillFields(fields as never), (err: unknown) => {
    assert.ok(err instanceof ExecutorError);
    assert.equal(err.code, 'SELECTOR_NOT_FOUND');
    assert.equal(err.message, 'field 2 of 3 (#b) failed after 1 filled: no such element');
    return true;
  });
  bridge.reply = () => ({ filled: 0, error: { code: 'WEIRD', selector: '#a', message: 'odd' } });
  await assert.rejects(ex.fillFields(fields as never), (err: unknown) => err instanceof ExecutorError && err.code === 'TARGET_GONE');
});

test('proxyStatus: passes the answer through; an extension without the method gets UNSUPPORTED', async () => {
  const { ex, bridge, last } = setup();
  bridge.reply = () => ({ mode: 'direct' });
  assert.deepEqual(await ex.proxyStatus(), { mode: 'direct' });
  assert.equal(last().opts.timeoutMs, 25_000);

  bridge.reply = () => {
    throw new ExecutorError('TARGET_GONE', 'unhandled method: proxy_status');
  };
  await assert.rejects(ex.proxyStatus(), (err: unknown) => {
    assert.ok(err instanceof ExecutorError);
    assert.equal(err.code, 'UNSUPPORTED');
    assert.match(err.message, /without proxy support/);
    return true;
  });

  const other = new ExecutorError('TIMEOUT', 'slow');
  bridge.reply = () => {
    throw other;
  };
  await assert.rejects(ex.proxyStatus(), (err: unknown) => err === other, 'any other error is rethrown as is');
  const plain = new Error('boom');
  bridge.reply = () => {
    throw plain;
  };
  await assert.rejects(ex.proxyStatus(), (err: unknown) => err === plain);
});

test('download: moves the file into the task folder; keeps Chrome path when capture fails; passes through otherwise', async () => {
  const { ex, bridge, last } = setup();
  const { downloadDir } = useWorkspace('dl');
  const src = mkdtempSync(join(tmpdir(), 'cmcp-dlsrc-'));
  const file = join(src, 'report.csv');
  writeFileSync(file, 'a,b\n1,2\n');

  bridge.reply = () => ({ path: file, sourcePath: file, suggestedName: 'report.csv', backend: 'extension', bytes: 8 });
  const moved = await ex.download({ url: 'https://a.test/report.csv', suggestedName: 'report.csv', tabId: 't1' });
  assert.deepEqual(last().params, { url: 'https://a.test/report.csv', suggestedName: 'report.csv' });
  assert.equal(moved.path, join(downloadDir, 'report.csv'));
  assert.equal(moved.sourcePath, undefined);
  assert.equal(moved.bytes, 8);
  assert.equal(readFileSync(moved.path, 'utf8'), 'a,b\n1,2\n');
  assert.equal(existsSync(file), false, 'the original is moved, not copied');

  // The source no longer exists, so the capture throws: report Chrome's path.
  const kept = await ex.download({ target: { selector: 'a.dl' } });
  assert.deepEqual(last().params, { url: undefined, selector: 'a.dl', suggestedName: undefined });
  assert.equal(kept.path, file);
  assert.equal(kept.sourcePath, undefined);

  bridge.reply = () => ({ path: '/x/y.bin', backend: 'extension', bytes: 1 });
  assert.deepEqual(await ex.download({ url: 'https://a.test/y.bin' }), { path: '/x/y.bin', backend: 'extension', bytes: 1 });
  assert.ok(MAX_DOWNLOAD_BYTES > 0);
});
