import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { PhonePairing } from '../src/remote/phone-pairing';
import { phoneControlReply, startPhoneControl } from '../src/remote/phone-control';
import { startHttpMcp } from '../src/remote/http';
import { PHONE_ACCESS_MS, PHONE_INVITATION_MS } from '../shared/phone-pairing';
import { configureManager, resetManagerForTesting } from '../src/executor/manager';
import { StubExecutor } from '../src/executor/stub-executor';
import { resolvePolicy } from '../src/security/policy';
import { withClientIdentity } from '../src/bridge/client-identity';
import { getActiveWorkspace, setActiveWorkspace, switchWorkspace } from '../src/bridge/workspace';
import { ensureWorkspace } from '../src/bridge/datadir';
import { dispatchToolCall } from '../src/mcp/tools';

function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'mbe-phone-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let now = Date.now();
  const pairing = new PhonePairing(dir, 'personal', () => now);
  pairing.setPublicUrl('https://relay.example/remote');
  const invite = () => JSON.parse(pairing.create().invitation!.payload) as { code: string; url: string; expiresAt: number };
  const claim = (name = 'My phone') => pairing.claim(invite().code, name);
  return { dir, pairing, invite, claim, advance: (ms: number) => { now += ms; } };
}

test('a QR is a single-use invitation, requires approval, and has no lasting credential', (t) => {
  const f = fixture(t);
  const qr = f.invite();
  assert.equal(qr.url, 'https://relay.example/remote/pair');
  assert.ok(qr.expiresAt <= Date.now() + PHONE_INVITATION_MS);
  const phone = f.pairing.claim(qr.code, 'My phone');
  assert.throws(() => f.pairing.claim(qr.code, 'Second scanner'), /invalid or expired/);
  assert.equal(f.pairing.authenticate(phone.token), undefined);
  assert.equal(f.pairing.status(phone.token)?.state, 'pending');
  assert.equal(f.pairing.status(phone.token)?.mcpUrl, undefined);
  assert.equal(f.pairing.state().invitation, undefined);
  f.pairing.approve(phone.id);
  assert.equal(f.pairing.status(phone.token)?.state, 'paired');
  assert.equal(f.pairing.status(phone.token)?.mcpUrl, 'https://relay.example/remote/mcp');
  assert.equal(f.pairing.authenticate(phone.token)?.id, phone.id);
  assert.equal(f.pairing.authenticate(qr.code), undefined);
  assert.ok(!JSON.stringify(f.pairing.state()).includes(phone.token));
});

test('expiry, replacement, cancellation, denial and loss of relay invalidate invitations', (t) => {
  const f = fixture(t);
  const old = f.invite();
  f.advance(PHONE_INVITATION_MS);
  assert.throws(() => f.pairing.claim(old.code, 'Phone'), /expired/);
  const next = f.invite();
  f.invite();
  assert.throws(() => f.pairing.claim(next.code, 'Phone'), /expired/);
  const cancelled = f.invite();
  f.pairing.cancel();
  assert.throws(() => f.pairing.claim(cancelled.code, 'Phone'), /expired/);
  const denied = f.claim();
  f.pairing.deny(denied.id);
  assert.equal(f.pairing.status(denied.token), undefined);
  const pending = f.claim();
  f.advance(PHONE_INVITATION_MS);
  assert.throws(() => f.pairing.approve(pending.id), /expired/);
  const offline = f.claim();
  f.pairing.setPublicUrl();
  assert.equal(f.pairing.state().online, false);
  assert.equal(f.pairing.status(offline.token), undefined);
  assert.throws(() => f.pairing.create(), /offline/);
  assert.throws(() => f.pairing.setPublicUrl('http://untrusted.example'), /secure/);
});

test('saved phones keep their identity after restart; removal and expiry invalidate queued access', (t) => {
  const f = fixture(t);
  const first = f.claim(); f.pairing.approve(first.id);
  const second = f.claim('Second phone'); f.pairing.approve(second.id);
  const identity = f.pairing.identity(first.id);
  const saved = new PhonePairing(f.dir, 'personal');
  assert.equal(saved.identity(first.id).id, identity.id);
  assert.equal(saved.authenticate(first.token)?.id, first.id);
  const path = join(f.dir, 'phone-pairing', readdirSync(join(f.dir, 'phone-pairing')).find((p) => p.endsWith('.json'))!);
  const disk = readFileSync(path, 'utf8');
  assert.ok(!disk.includes(first.token) && !disk.includes(second.token));
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
  f.pairing.remove(first.id);
  assert.equal(f.pairing.authenticate(first.token), undefined);
  assert.throws(() => identity.assertAccess!(), /removed or expired/);
  assert.equal(f.pairing.authenticate(second.token)?.id, second.id);
  assert.equal(new PhonePairing(f.dir, 'personal').authenticate(first.token), undefined);
  f.advance(PHONE_ACCESS_MS);
  assert.equal(f.pairing.authenticate(second.token), undefined);
});

test('a paired phone cannot change profiles or reach another task through batch dispatch', async (t) => {
  const f = fixture(t);
  setActiveWorkspace(ensureWorkspace(f.dir, 'owner', 'default'));
  const p = f.claim(); f.pairing.approve(p.id);
  const identity = f.pairing.identity(p.id);
  await withClientIdentity(identity, async () => {
    await new Promise((r) => setImmediate(r));
    assert.equal(getActiveWorkspace().profile, 'personal');
    assert.throws(() => switchWorkspace({ profile: 'owner' }), /cannot switch/);
    assert.equal((await dispatchToolCall('profile_use', { profile: 'owner' })).isError, true);
    assert.equal((await dispatchToolCall('tasks_list', {})).isError, true);
  });
  assert.equal(getActiveWorkspace().profile, 'owner');
});

test('native helper reaches only the private profile controller and emits one framed reply', async (t) => {
  const f = fixture(t);
  const control = await startPhoneControl(f.pairing);
  try {
    const state = await phoneControlReply(f.dir, { profile: 'personal', action: 'create' });
    assert.equal(state.ok, true);
    assert.equal((await phoneControlReply(f.dir, { profile: 'other', action: 'create' })).ok, false);
    const path = join(f.dir, 'phone-pairing', readdirSync(join(f.dir, 'phone-pairing')).find((p) => p.startsWith('control-'))!);
    const config = JSON.parse(readFileSync(path, 'utf8')) as { port: number; token: string };
    const url = `http://127.0.0.1:${config.port}/`;
    assert.equal((await fetch(url, { method: 'POST', body: '{"action":"approve"}' })).status, 404);
    assert.equal((await fetch(url, { method: 'POST', headers: { origin: 'https://example.com', authorization: `Bearer ${config.token}` } })).status, 404);
    const body = Buffer.from(JSON.stringify({ type: 'phone_pairing', profile: 'personal', action: 'state' }));
    const prefix = Buffer.alloc(4); prefix.writeUInt32LE(body.length);
    const output = await new Promise<Buffer>((resolve, reject) => {
      const child = spawn(process.execPath, ['dist/src/cli.js', '--native-host'], { env: { ...process.env, MCP_BROWSER_EXTENSION_DATA: f.dir } });
      const chunks: Buffer[] = [];
      child.stdout.on('data', (c) => chunks.push(c));
      child.once('error', reject);
      child.once('exit', (code) => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`helper exit ${code}`)));
      child.stdin.end(Buffer.concat([prefix, body]));
    });
    assert.equal(output.length, output.readUInt32LE(0) + 4);
    const reply = JSON.parse(output.subarray(4).toString());
    assert.equal(reply.ok, true);
    assert.equal(reply.state.profile, 'personal');
  } finally { await control.close(); }
  assert.equal((await phoneControlReply(f.dir, { profile: 'personal', action: 'state' })).ok, false);
});

test('HTTP pairing needs QR possession and desktop approval; MCP sessions are isolated and revocable', async (t) => {
  const f = fixture(t);
  resetManagerForTesting();
  const policy = resolvePolicy({ allowDomains: ['example.com'] });
  configureManager({ policy, makeExecutor: () => new StubExecutor({ activeUrl: 'https://example.com' }) });
  const owner = 'k'.repeat(43);
  const server = await startHttpMcp({ port: 0, key: owner, policy, version: 'test', log: () => {}, accessGuard: async () => null, phonePairing: f.pairing });
  const base = `http://127.0.0.1:${server.port}`;
  const clients: Client[] = [];
  const headers = (token: string) => ({ 'content-type': 'application/json', authorization: `Bearer ${token}` });
  const post = (path: string, data: unknown, extra = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body: JSON.stringify(data) });
  const connect = async (token: string) => {
    const client = new Client({ name: 'phone-test', version: '1' });
    clients.push(client);
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: headers(token) } });
    await client.connect(transport);
    return { client, transport };
  };
  try {
    assert.equal((await post('/pair/approve', {})).status, 404);
    assert.equal((await post('/pair/claim', { code: 'x', name: 'Phone' })).status, 400);
    const qr = f.invite();
    assert.equal((await post('/pair/claim', { code: qr.code, name: 'Phone' }, { origin: 'https://example.com' })).status, 404);
    const response = await post('/pair/claim', { code: qr.code, name: 'Phone' });
    assert.equal(response.status, 202);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const phone = await response.json() as { id: string; token: string };
    assert.equal((await post('/pair/claim', { code: qr.code, name: 'Phone' })).status, 400);
    await assert.rejects(connect(phone.token));
    f.pairing.approve(phone.id);
    const first = await connect(phone.token);
    const ownerClient = await connect(owner);
    assert.equal(server.sessions(), 2);
    const names = (await first.client.listTools()).tools.map((tool) => tool.name);
    assert.ok(names.includes('tabs_list'));
    assert.ok(!names.includes('profile_use') && !names.includes('task_new'));
    const stolen = await post('/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
      { ...headers(owner), 'mcp-session-id': first.transport.sessionId! });
    assert.equal(stolen.status, 404);
    assert.equal((await first.client.callTool({ name: 'tabs_list', arguments: {} })).isError, undefined);
    f.pairing.remove(phone.id);
    assert.equal(server.sessions(), 1);
    assert.equal((await post('/pair/status', {}, headers(phone.token))).status, 404);
    await assert.rejects(first.client.listTools());
    assert.ok((await ownerClient.client.listTools()).tools.length > 0);
    assert.equal((await fetch(`${base}/mcp/%`)).status, 404);
  } finally {
    await Promise.allSettled(clients.map((c) => c.close()));
    await server.close();
  }
});
