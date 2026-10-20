import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { webcrypto, randomUUID } from 'node:crypto';
import { createClientIdentity, withClientIdentity, currentClientIdentity } from '../src/bridge/client-identity';
import { CLIENT_GRANT_MS, CLIENT_REQUEST_MS, type ClientConnection } from '../shared/client-auth';
import { PROTOCOL_VERSION, type CommandFrame } from '../shared/protocol';

const source = buildSync({ entryPoints: ['extension/src/sw/client-approvals.ts'], bundle: true, write: false, platform: 'browser', format: 'cjs' }).outputFiles[0].text;
interface Gate {
  authorize(cmd: CommandFrame): Promise<() => void>;
  decide(id: string, allow: boolean): Promise<void>;
  revokeAll(): Promise<void>;
}
function fixture(saved?: ClientConnection[]) {
  const module = { exports: {} as { ClientApprovals: new (deps: unknown) => Gate; isApprovalPage: (sender: unknown) => boolean } };
  runInNewContext(source, { module, exports: module.exports, crypto: webcrypto, atob, TextEncoder, URL,
    chrome: { runtime: { id: 'ours', getURL: (p: string) => `chrome-extension://ours/${p}` } } });
  let records = saved;
  let now = Date.now();
  let challenge = randomUUID();
  let failWrite = false;
  const gate = new module.exports.ClientApprovals({
    read: async () => structuredClone(records),
    write: async (next: ClientConnection[]) => { if (failWrite) throw new Error('disk unavailable'); records = structuredClone(next); },
    challenge: () => challenge, now: () => now,
  });
  const identity = createClientIdentity(() => 'Test app 1.0');
  const command = (who = identity, method: CommandFrame['method'] = 'get_text'): CommandFrame => {
    const cmd: CommandFrame = { type: 'command', v: PROTOCOL_VERSION, id: randomUUID(), method, params: {}, timeoutMs: 30_000 };
    cmd.authorization = who.sign(cmd, challenge);
    return cmd;
  };
  return { gate, identity, command, records: () => records, advance: (ms: number) => { now += ms; },
    rotate: () => { challenge = randomUUID(); }, breakStorage: () => { failWrite = true; }, isApprovalPage: module.exports.isApprovalPage };
}

async function approve(f: ReturnType<typeof fixture>, who = f.identity): Promise<void> {
  await assert.rejects(f.gate.authorize(f.command(who)), /Please approve/);
  await f.gate.decide(who.id, true);
}

test('a valid key requests Chrome approval; separate keys remain separate', async () => {
  const f = fixture();
  const second = createClientIdentity(() => 'Second app');
  await approve(f);
  (await f.gate.authorize(f.command()))();
  await assert.rejects(f.gate.authorize(f.command(second)), /Please approve/);
  await f.gate.decide(second.id, true);
  await f.gate.decide(f.identity.id, false);
  await assert.rejects(f.gate.authorize(f.command()), /revoked/);
  (await f.gate.authorize(f.command(second)))();
  assert.equal(f.records()?.length, 2);
});

test('stop all revokes every key and invalidates issued checks before saving', async () => {
  const f = fixture();
  const second = createClientIdentity(() => 'Second app');
  await approve(f);
  await approve(f, second);
  const check = await f.gate.authorize(f.command());
  const stopping = f.gate.revokeAll();
  assert.throws(check, /revoked/);
  await stopping;
  await assert.rejects(f.gate.authorize(f.command()), /revoked/);
  await assert.rejects(f.gate.authorize(f.command(second)), /revoked/);
  await f.gate.decide(f.identity.id, true);
  (await f.gate.authorize(f.command()))();
  await assert.rejects(f.gate.authorize(f.command(second)), /revoked/);
});

test('no token, bypass flag or self-claimed app name substitutes for the signing key', async () => {
  const f = fixture();
  await approve(f);
  const unsigned = f.command();
  delete unsigned.authorization;
  unsigned.params = { yolo: true, bypassPermissions: true, approved: true };
  await assert.rejects(f.gate.authorize(unsigned), /authorization is missing/);
  const impostor = createClientIdentity(() => 'Test app 1.0');
  await assert.rejects(f.gate.authorize(f.command(impostor)), /Please approve/);
});

test('method, parameters, target, timeout and claimed name cannot be modified by a relay', async () => {
  const f = fixture();
  await approve(f);
  for (const mutate of [
    (c: CommandFrame) => { c.method = 'click'; },
    (c: CommandFrame) => { c.params = { selector: '#send' }; },
    (c: CommandFrame) => { c.tabId = 'ext:s:99'; },
    (c: CommandFrame) => { c.timeoutMs = 999; },
    (c: CommandFrame) => { c.authorization!.name = 'Trusted app'; },
  ]) {
    const cmd = f.command(); mutate(cmd);
    await assert.rejects(f.gate.authorize(cmd), /signature is invalid/);
  }
});

test('concurrent replay executes at most once and connection challenges cannot be reused', async () => {
  const f = fixture();
  await approve(f);
  const cmd = f.command();
  const results = await Promise.allSettled([f.gate.authorize(cmd), f.gate.authorize(cmd)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const old = f.command();
  f.rotate();
  await assert.rejects(f.gate.authorize(old), /authorization is missing, stale or invalid/);
  (await f.gate.authorize(f.command()))();
});

test('expiry and revocation are rechecked after queued work, immediately before execution', async () => {
  const f = fixture();
  await approve(f);
  const check = await f.gate.authorize(f.command());
  f.advance(CLIENT_GRANT_MS + 1);
  assert.throws(check, /expired/);
  const g = fixture();
  await approve(g);
  const queued = await g.gate.authorize(g.command());
  await g.gate.decide(g.identity.id, false);
  assert.throws(queued, /revoked/);
});

test('expired requests cannot be approved and old timestamps are rejected', async () => {
  const f = fixture();
  await assert.rejects(f.gate.authorize(f.command()), /Please approve/);
  f.advance(CLIENT_REQUEST_MS + 1);
  await assert.rejects(f.gate.decide(f.identity.id, true), /request expired/);
  await assert.rejects(f.gate.authorize(f.command()), /stale/);
});

test('failed approval storage does not grant access; failed revoke blocks this worker', async () => {
  const f = fixture();
  await assert.rejects(f.gate.authorize(f.command()), /Please approve/);
  f.breakStorage();
  await assert.rejects(f.gate.decide(f.identity.id, true), /disk unavailable/);
  await assert.rejects(f.gate.authorize(f.command()), /storage failed/);
  const g = fixture();
  await approve(g);
  g.breakStorage();
  await assert.rejects(g.gate.decide(g.identity.id, false), /disk unavailable/);
  await assert.rejects(g.gate.authorize(g.command()), /storage failed/);
});

test('durable grants reload without extending their expiry', async () => {
  const f = fixture();
  await approve(f);
  const records = f.records()!;
  const g = fixture(records);
  (await g.gate.authorize(g.command(f.identity)))();
  assert.equal(g.records()![0].expiresAt, records[0].expiresAt);
  const invalid = fixture([{ ...records[0], state: 'yes' as 'approved' }]);
  await assert.rejects(invalid.gate.authorize(invalid.command()), /Cannot load/);
});

test('only the exact top-level extension UI may send decisions', () => {
  const f = fixture();
  assert.equal(f.isApprovalPage({ id: 'ours', url: 'chrome-extension://ours/options.html', frameId: 0 }), true);
  for (const sender of [
    { id: 'other', url: 'chrome-extension://ours/options.html' },
    { id: 'ours', url: 'https://example.com' },
    { id: 'ours', url: 'chrome-extension://ours/options.html.evil' },
    { id: 'ours', url: 'chrome-extension://ours/options.html', frameId: 9 },
  ]) assert.equal(f.isApprovalPage(sender), false);
});

test('parallel MCP sessions keep their own signing identities', async () => {
  const a = createClientIdentity(() => 'A'), b = createClientIdentity(() => 'B');
  const results = await Promise.all([a, b].map((identity) => withClientIdentity(identity, async () => {
    await new Promise((resolve) => setImmediate(resolve));
    return currentClientIdentity()?.id;
  })));
  assert.deepEqual(results, [a.id, b.id]);
  assert.equal(currentClientIdentity(), undefined);
});


test('an expired stored grant becomes a pending request, never an automatic renewal', async () => {
  const f = fixture();
  await approve(f);
  const old = f.records()!.map((c) => ({ ...c, expiresAt: Date.now() - 1 }));
  const g = fixture(old);
  await assert.rejects(g.gate.authorize(g.command(f.identity)), /Please approve/);
  assert.equal(g.records()![0].state, 'pending');
});

test('a burst of requests is bounded and cannot delay revocation checks', async () => {
  const f = fixture();
  await approve(f);
  const check = await f.gate.authorize(f.command());
  const requests = Array.from({ length: 100 }, () => f.gate.authorize(f.command()));
  const settled = Promise.allSettled(requests);
  const revoked = f.gate.decide(f.identity.id, false);
  assert.throws(check, /revoked/);
  const results = await settled;
  assert.ok(results.some((r) => r.status === 'rejected' && /Too many pending/.test(String(r.reason))));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 0);
  await revoked;
});
