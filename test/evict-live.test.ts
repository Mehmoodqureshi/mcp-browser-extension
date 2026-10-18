/**
 * Port eviction with the REAL process probes (no injected deps), against child
 * processes this test spawns and owns. test/evict.test.ts covers the decision
 * logic with fakes; this pins that the default liveness check and the `ps`
 * command-line read actually identify a live mcp-browser-extension, leave any
 * other process alone, and treat an exited pid as dead.
 */

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { evictPortOwner } from '../src/bridge/evict';
import { writeHandshake } from '../src/bridge/auth';

const PORT = 45_679;
const POSIX = process.platform !== 'win32';

function handshakeFor(pid: number, port = PORT): string {
  const dir = mkdtempSync(join(tmpdir(), 'evict-live-'));
  writeHandshake(dir, { port, token: 'tok' });
  const path = join(dir, 'handshake.json');
  const hs = JSON.parse(readFileSync(path, 'utf8'));
  hs.pid = pid;
  writeFileSync(path, JSON.stringify(hs), { mode: 0o600 });
  return dir;
}

/** A long-lived node child whose command line carries `marker`. */
async function child(t: TestContext, marker: string): Promise<ChildProcess> {
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000); process.stdout.write("up")', marker], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  await once(c.stdout!, 'data');
  t.after(() => {
    if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  });
  return c;
}

test('a live mcp-browser-extension (by its real command line) is terminated and reported gone', { skip: !POSIX }, async (t) => {
  const owner = await child(t, '/opt/node_modules/mcp-browser-extension/dist/src/cli.js');
  const logs: string[] = [];
  const exited = once(owner, 'exit');
  const ok = await evictPortOwner(handshakeFor(owner.pid!), PORT, (m) => logs.push(m));
  assert.equal(ok, true);
  const [, signal] = await exited;
  assert.equal(signal, 'SIGTERM', 'asked politely first');
  assert.match(logs[0], new RegExp(`port ${PORT} is held by mcp-browser-extension pid ${owner.pid}`));
  assert.match(logs[1], new RegExp(`previous owner \\(pid ${owner.pid}\\) exited; reclaiming port ${PORT}`));
});

test('a live process that is not mcp-browser-extension is left alone', { skip: !POSIX }, async (t) => {
  const bystander = await child(t, 'some-other-server');
  const logs: string[] = [];
  const ok = await evictPortOwner(handshakeFor(bystander.pid!), PORT, (m) => logs.push(m));
  assert.equal(ok, false);
  assert.equal(bystander.exitCode, null);
  assert.equal(bystander.signalCode, null, 'never signalled');
  assert.match(logs[0], new RegExp(`held by pid ${bystander.pid}, which does not look like mcp-browser-extension`));
});

test('an exited pid reads as dead with the real liveness probe', { skip: !POSIX }, async () => {
  const c = spawn(process.execPath, ['-e', '0']);
  await once(c, 'exit');
  const logs: string[] = [];
  assert.equal(await evictPortOwner(handshakeFor(c.pid!), PORT, (m) => logs.push(m)), false);
  assert.deepEqual(logs, []);
});

test('a SIGTERM that cannot be delivered gives up without escalating', async () => {
  const kills: string[] = [];
  const ok = await evictPortOwner(handshakeFor(424_242), PORT, () => {}, {
    isAlive: () => true,
    commandLine: () => 'node /x/mcp-browser-extension/cli.js',
    kill: (_pid, sig) => {
      kills.push(sig);
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    },
  });
  assert.equal(ok, false);
  assert.deepEqual(kills, ['SIGTERM']);
});

test('a malformed handshake pid or port is never acted on', async () => {
  const dir = handshakeFor(0);
  assert.equal(await evictPortOwner(dir, PORT, () => {}, { isAlive: () => true }), false, 'pid 0');
  const unreadable = mkdtempSync(join(tmpdir(), 'evict-live-'));
  writeFileSync(join(unreadable, 'handshake.json'), '{oops');
  assert.equal(await evictPortOwner(unreadable, PORT, () => {}), false);
});
