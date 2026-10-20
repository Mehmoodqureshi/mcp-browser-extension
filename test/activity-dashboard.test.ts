import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { ACTIVITY_LIMIT, activityHost, activityEntry, activityRows, type ActivityEntry } from '../shared/activity';

function load(file: string): any {
  const source = buildSync({ entryPoints: [`extension/src/sw/${file}.ts`], bundle: true, write: false, platform: 'browser', format: 'cjs' }).outputFiles[0].text;
  const module = { exports: {} };
  runInNewContext(source, { module, exports: module.exports, URL });
  return module.exports;
}
const { AccessSwitch } = load('access-switch');
const { ActivityLog } = load('activity');

function accessFixture(saved: unknown = false) {
  let stored = saved, disconnects = 0, revokes = 0, fail = false;
  const gate = new AccessSwitch({
    read: async () => stored,
    write: async (value: boolean) => { if (fail) throw Error('write failed'); stored = value; },
    revoke: async () => { revokes++; if (fail) throw Error('revoke failed'); },
    disconnect: () => { disconnects++; },
  });
  return { gate, stored: () => stored, disconnects: () => disconnects, revokes: () => revokes, fail: () => { fail = true; } };
}

test('stop invalidates issued checks immediately and persists across worker recreation', async () => {
  const f = accessFixture();
  await f.gate.initialize();
  const check = f.gate.check();
  const stopped = f.gate.stop();
  assert.throws(check, /stopped/);
  assert.equal(f.disconnects(), 1);
  await stopped;
  assert.equal(f.stored(), true);
  const next = accessFixture(f.stored());
  await next.gate.initialize();
  assert.throws(() => next.gate.check(), /stopped/);
  await f.gate.resume();
  f.gate.check()();
  assert.throws(check, /stopped/, 'old requests remain invalid after resume');
  assert.equal(f.revokes(), 2);
});

test('failed persistence never silently reopens access', async () => {
  const f = accessFixture();
  await f.gate.initialize();
  f.fail();
  await assert.rejects(f.gate.stop(), /write failed/);
  assert.throws(() => f.gate.check(), /stopped/);
  await assert.rejects(f.gate.resume(), /write failed/);
  assert.throws(() => f.gate.check(), /stopped/);
  const invalid = accessFixture('false');
  await invalid.gate.initialize();
  assert.throws(() => invalid.gate.check(), /stopped/);
});

test('a stop racing startup or resume wins and cannot be undone by a pending read', async () => {
  const f = accessFixture();
  const initializing = f.gate.initialize();
  const stopping = f.gate.stop();
  await initializing;
  assert.throws(() => f.gate.check(), /stopped/);
  await stopping;
  const resuming = f.gate.resume();
  const stoppedAgain = f.gate.stop();
  await Promise.all([resuming, stoppedAgain]);
  assert.equal(f.stored(), true);
  assert.throws(() => f.gate.check(), /stopped/);
});

test('a stop during resume persistence keeps memory and durable state stopped', async () => {
  let release!: () => void, started!: () => void;
  const reached = new Promise<void>((resolve) => { started = resolve; });
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  let stored = true;
  const gate = new AccessSwitch({
    read: async () => stored,
    write: async (value: boolean) => {
      if (!value) { started(); await waiting; }
      stored = value;
    },
    revoke: async () => {}, disconnect: () => {},
  });
  await gate.initialize();
  const resume = gate.resume();
  await reached;
  const stop = gate.stop();
  release();
  await Promise.all([resume, stop]);
  assert.equal(stored, true);
  assert.throws(() => gate.check(), /stopped/);
});

const entry = (i: number): ActivityEntry => ({
  id: String(i), at: i, method: 'get_text', host: 'example.org',
  app: 'Test app', key: 'a'.repeat(64), outcome: 'done',
});
function historyFixture(saved: unknown = []) {
  let stored = saved;
  const deps = { read: async () => stored, write: async (rows: ActivityEntry[]) => { stored = structuredClone(rows); } };
  const log = new ActivityLog(deps);
  return { log, deps, rows: () => stored as ActivityEntry[] };
}

test('history strips all non-schema fields and URL secrets and bounds concurrent writes', async () => {
  const f = historyFixture();
  assert.equal(activityHost('https://user:password@example.org/private?token=SECRET#fragment'), 'example.org');
  assert.equal(activityHost('chrome-extension://id/options.html'), '');
  assert.equal(activityEntry({ ...entry(1), host: 'about:blank', tabId: 17 }).host, 'about:blank');
  assert.equal(activityEntry({ ...entry(1), host: 'chrome://newtab' }).host, 'chrome://newtab');
  assert.equal(activityEntry({ ...entry(1), tabId: -1 }).tabId, undefined);
  await Promise.all(Array.from({ length: ACTIVITY_LIMIT + 20 }, (_, i) =>
    f.log.record({ ...entry(i), params: { text: 'SECRET' }, response: 'SECRET', url: 'SECRET' })));
  assert.equal(f.rows().length, ACTIVITY_LIMIT);
  assert.equal(f.rows()[0].id, '20');
  assert.doesNotMatch(JSON.stringify(f.rows()), /SECRET|params|response|url/);
});

test('history pairs open and close by tab and app, retaining other tabs and actions', () => {
  const open = { ...entry(1), method: 'tab_new', tabId: 41, host: 'about:blank' };
  const other = { ...entry(2), method: 'tab_new', tabId: 42 };
  const read = { ...entry(3), tabId: 41 };
  const close = { ...entry(4), method: 'tab_close', tabId: 41 };
  const rows = activityRows([open, other, read, close]);
  assert.deepEqual(rows.map((row) => row.id), ['2', '3', '4']);
  assert.equal(rows[2].opened?.id, '1');
  assert.equal(rows[2].host, 'example.org', 'use the website at close after a blank tab navigates');
  assert.equal(rows[2].at, close.at, 'sort a combined row by its closing request');
  assert.equal(activityRows([open, { ...close, key: 'b'.repeat(64) }]).length, 2, 'different apps stay identifiable');
  assert.equal(activityRows([{ ...open, tabId: undefined }, close]).length, 2, 'old entries are never guessed by hostname');
  assert.equal(activityRows([close]).length, 1, 'a close survives if its open aged out or was cleared');
});

test('failed or running closes do not hide a successful open', () => {
  const open = { ...entry(1), method: 'tab_new', tabId: 41 };
  for (const outcome of ['blocked', 'failed', 'running', 'interrupted'] as const) {
    const rows = activityRows([open, { ...entry(2), method: 'tab_close', tabId: 41, outcome }]);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].opened, undefined);
    assert.equal(rows[1].outcome, outcome);
  }
});

test('running activity is updated once; a worker restart marks lost work interrupted', async () => {
  const f = historyFixture();
  await f.log.record({ ...entry(1), outcome: 'running' });
  await f.log.record(entry(1));
  assert.equal(f.rows().length, 1);
  assert.equal(f.rows()[0].outcome, 'done');
  await f.log.record({ ...entry(2), outcome: 'running' });
  const restarted = new ActivityLog(f.deps);
  await restarted.interrupt();
  assert.equal(f.rows()[1].outcome, 'interrupted');
});

test('clearing history does not restore a late result from an already-running request', async () => {
  const f = historyFixture();
  const generation = f.log.token();
  await f.log.record({ ...entry(1), outcome: 'running' }, generation);
  await f.log.clear();
  await f.log.record(entry(1), generation);
  assert.equal(f.rows().length, 0);
  await f.log.record(entry(2), f.log.token());
  assert.equal(f.rows().length, 1);
});

test('a burst cannot create an unbounded activity write queue', async () => {
  const f = historyFixture();
  const results = await Promise.allSettled(Array.from({ length: 300 }, (_, i) => f.log.record(entry(i))));
  assert.equal(results.filter((r) => r.status === 'rejected').length, 44);
  assert.equal(f.rows().length, ACTIVITY_LIMIT);
  await f.log.record(entry(301));
  assert.equal(f.rows().at(-1)?.id, '301', 'history recovers after the burst');
});
