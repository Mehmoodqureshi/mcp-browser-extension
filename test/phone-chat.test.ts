import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PhoneChat, createCodexChatRunner } from '../src/remote/phone-chat';
import { PhonePairing } from '../src/remote/phone-pairing';
import { startHttpMcp } from '../src/remote/http';
import { resolvePolicy } from '../src/security/policy';
import { configureManager, resetManagerForTesting } from '../src/executor/manager';
import { StubExecutor } from '../src/executor/stub-executor';
import { currentClientIdentity } from '../src/bridge/client-identity';
import type { DrawStroke } from '../shared/protocol';
import { setPersonWaitForTesting } from '../src/mcp/person-wait';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const send = (requestId = 'request_123') => ({ action: 'send', requestId, text: 'List my tabs' });

test('phone conversations are isolated, sends are idempotent, concurrent turns reject and stop ignores late updates', async () => {
  let calls = 0, closed = 0;
  let update!: (text: string | null, activity: string) => void;
  let done!: () => void;
  const chats = new PhoneChat(() => ({ run: (_text, next) => { calls++; update = next; return new Promise((resolve) => { done = resolve; }); }, close: () => { closed++; } }), () => {});
  try {
    assert.equal(chats.request('a', send()).state, 'working');
    chats.request('a', send()); await tick(); assert.equal(calls, 1);
    assert.throws(() => chats.request('a', send('request_456')), /Wait for/);
    update('First reply', 'Writing');
    assert.equal(chats.request('a', { action: 'status' }).messages[1].text, 'First reply');
    assert.deepEqual(chats.request('b', { action: 'status' }).messages, []);
    const snapshot = chats.request('a', { action: 'status' }); snapshot.messages[1].text = 'changed';
    assert.equal(chats.request('a', { action: 'status' }).messages[1].text, 'First reply');
    assert.equal(chats.request('a', { action: 'stop' }).state, 'stopped');
    update('Late reply', ''); done(); await tick();
    assert.equal(chats.request('a', { action: 'status' }).messages[1].text, 'First reply');
    assert.equal(closed, 1);
    assert.throws(() => chats.request('a', send('request_789')), /new chat/);
    assert.deepEqual(chats.request('a', { action: 'reset' }).messages, []);
  } finally { chats.close(); }
});

test('limits, timeout and revocation fail closed without exposing runner diagnostics', async () => {
  let revoked = false, closed = 0;
  const chats = new PhoneChat(() => ({ run: () => new Promise(() => {}), close: () => { closed++; } }), () => { if (revoked) throw new Error('removed'); }, 15);
  try {
    assert.throws(() => chats.request('a', { ...send(), text: 'x'.repeat(8001) }), /8,000/);
    chats.request('a', send()); await new Promise((r) => setTimeout(r, 30));
    assert.equal(chats.request('a', { action: 'status' }).state, 'error'); assert.equal(closed, 1);
    revoked = true; chats.remove('a');
    assert.throws(() => chats.request('a', { action: 'status' }), /removed/);
  } finally { chats.close(); }
});

test('access expiring during a streamed reply stops the runner without throwing into the process', async () => {
  let expired = false, closed = false;
  let update!: (text: string | null, activity: string) => void;
  const chats = new PhoneChat(() => ({ run: (_text, next) => { update = next; return new Promise(() => {}); }, close: () => { closed = true; } }), () => { if (expired) throw new Error('expired'); });
  try {
    chats.request('phone', send()); await tick(); expired = true;
    assert.doesNotThrow(() => update('late content', 'Writing'));
    assert.equal(closed, true);
  } finally { chats.close(); }
});

function pairingFixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'mbe-chat-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pairing = new PhonePairing(dir, 'test'); pairing.setPublicUrl('https://relay.example/remote');
  const phone = pairing.claim(JSON.parse(pairing.create().invitation!.payload).code, 'Test phone'); pairing.approve(phone.id);
  return { pairing, phone };
}

test('chat HTTP requires an approved phone, rejects web origins and owner keys, and removes running work on revocation', async (t) => {
  const { pairing, phone } = pairingFixture(t);
  let closed = 0;
  const chats = new PhoneChat(() => ({ run: () => new Promise(() => {}), close: () => { closed++; } }), (id) => pairing.identity(id).assertAccess?.());
  const owner = 'k'.repeat(43);
  const server = await startHttpMcp({ port: 0, key: owner, version: 'test', policy: resolvePolicy({}), log: () => {}, phonePairing: pairing, phoneChat: chats });
  const request = (token = phone.token, origin?: string, body: unknown = { action: 'status' }) => fetch(`http://127.0.0.1:${server.port}/pair/chat`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
  try {
    assert.equal((await request(owner)).status, 404);
    assert.equal((await request(phone.token, 'https://example.com')).status, 404);
    const pending = pairing.claim(JSON.parse(pairing.create().invitation!.payload).code, 'Pending');
    assert.equal((await request(pending.token)).status, 404);
    assert.equal((await request(phone.token, undefined, send())).status, 200); await tick();
    pairing.remove(phone.id); assert.equal(closed, 1);
    const response = await request(); assert.equal(response.status, 404); assert.equal(response.headers.get('cache-control'), 'no-store');
  } finally { await server.close(); }
});

test('chat HTTP returns new reply data promptly and revocation releases a waiting request', async (t) => {
  const { pairing, phone } = pairingFixture(t);
  let update!: (text: string | null, activity: string) => void;
  const chats = new PhoneChat(() => ({ run: (_text, next) => { update = next; return new Promise(() => {}); }, close: () => {} }), (id) => pairing.identity(id).assertAccess?.());
  const server = await startHttpMcp({ port: 0, key: 'k'.repeat(43), version: 'test', policy: resolvePolicy({}), log: () => {}, phonePairing: pairing, phoneChat: chats });
  const request = (body: unknown) => fetch(`http://127.0.0.1:${server.port}/pair/chat`, { method: 'POST', signal: AbortSignal.timeout(3000),
    headers: { authorization: `Bearer ${phone.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const initial = await (await request(send())).json() as { version: number };
    const waiting = request({ action: 'status', since: initial.version, waitMs: 15_000 });
    await tick(); update('Ready to read', 'Writing a reply');
    const delivered = await (await waiting).json() as { version: number; messages: { text: string }[] };
    assert.equal(delivered.messages[1].text, 'Ready to read'); assert.ok(delivered.version > initial.version);
    const removed = request({ action: 'status', since: delivered.version, waitMs: 15_000 });
    await tick(); pairing.remove(phone.id);
    assert.equal((await removed).status, 404);
  } finally { await server.close(); }
});

test('Codex adapter disables inherited integrations and sends browser calls through the paired identity', async (t) => {
  const { pairing, phone } = pairingFixture(t);
  resetManagerForTesting();
  const policy = resolvePolicy({ allowDomains: ['example.com'] });
  configureManager({ policy, makeExecutor: () => new StubExecutor({ activeUrl: 'https://example.com/chat-fixture' }) });
  let thread: any, closed = false;
  let emit!: (message: any) => void;
  const responses: any[] = [];
  const runner = createCodexChatRunner(pairing, phone.id, 'test', policy, async () => null, (_cwd, event) => {
    emit = event;
    return { notify: () => {}, close: () => { closed = true; }, respond: (_id, result) => {
      responses.push(result);
      emit({ method: 'item/agentMessage/delta', params: { threadId: 'mobile', itemId: 'reply', delta: 'Your tab is open.' } });
      emit({ method: 'turn/completed', params: { threadId: 'mobile', turn: { status: 'completed' } } });
    }, request: async (method, params: any) => {
      if (method === 'account/read') return { account: { type: 'chatgpt' } };
      if (method === 'config/read') return { config: { mcp_servers: { unrelated: { enabled: true } } } };
      if (method === 'model/list') return { data: [{ model: 'fixture-model', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }], defaultReasoningEffort: 'medium' }] };
      if (method === 'thread/start') { thread = params; return { thread: { id: 'mobile' }, modelProvider: 'openai', sandbox: { type: 'readOnly' } }; }
      if (method === 'turn/start') { assert.equal(params.effort, 'low'); queueMicrotask(() => emit({ id: 20, method: 'item/tool/call', params: { threadId: 'mobile', tool: 'tabs_list', arguments: {}, namespace: null } })); }
      return {};
    } };
  });
  let reply = '';
  try {
    await runner.run('List tabs', (text) => { if (text) reply = text; });
    assert.equal(reply, 'Your tab is open.');
    assert.equal(thread.config.mcp_servers.unrelated.enabled, false);
    assert.equal(thread.config.features.shell_tool, false); assert.equal(thread.config.features.plugins, false);
    assert.equal(thread.ephemeral, true);
    assert.equal(thread.model, 'fixture-model');
    assert.equal(thread.config.model_reasoning_effort, 'low');
    assert.ok(thread.dynamicTools.every((tool: any) => !tool.description.includes('Verify this device')));
    assert.ok(thread.dynamicTools.some((tool: any) => tool.name === 'tabs_list'));
    assert.ok(thread.dynamicTools.some((tool: any) => tool.name === 'batch'));
    assert.ok(!thread.dynamicTools.some((tool: any) => ['eval', 'profile_use', 'download_file', 'upload_file'].includes(tool.name)));
    assert.equal(responses[0].success, true);
    assert.match(responses[0].contentItems[0].text, /chat-fixture/);
    emit({ id: 21, method: 'item/tool/call', params: { threadId: 'different', tool: 'tabs_list', arguments: {} } });
    await tick(); assert.equal(responses[1].success, false);
    pairing.remove(phone.id); await assert.rejects(runner.run('Try again', () => {}), /removed/);
  } finally { runner.close(); assert.equal(closed, true); resetManagerForTesting(); }
});

test('chat status waits for changes, releases on cancellation/reset/stop and never serves revoked content', async () => {
  let update!: (text: string | null, activity: string) => void;
  let revoked = false;
  const chats = new PhoneChat(() => ({ run: (_text, next) => { update = next; return new Promise(() => {}); }, close: () => {} }), () => { if (revoked) throw new Error('removed'); });
  try {
    chats.request('phone', send()); await tick();
    const initial = chats.request('phone', { action: 'status' });
    let received = false;
    const pending = chats.poll('phone', { action: 'status', since: initial.version, waitMs: 1000 }).then((value) => { received = true; return value; });
    await tick(); assert.equal(received, false);
    update('A live reply', 'Writing');
    const changed = await pending;
    assert.equal(changed.messages[1].text, 'A live reply'); assert.ok(changed.version > initial.version);
    for (let i = 0; i < 6; i++) {
      const abort = new AbortController();
      const cancelled = chats.poll('phone', { action: 'status', since: changed.version, waitMs: 1000 }, abort.signal);
      abort.abort(); await assert.rejects(cancelled, /cancelled/);
    }
    const stopped = chats.poll('phone', { action: 'status', since: changed.version, waitMs: 1000 });
    chats.request('phone', { action: 'stop' }); assert.equal((await stopped).state, 'stopped');
    const beforeReset = chats.request('phone', { action: 'status' });
    const reset = chats.poll('phone', { action: 'status', since: beforeReset.version, waitMs: 1000 });
    chats.request('phone', { action: 'reset' });
    const empty = await reset; assert.deepEqual(empty.messages, []); assert.ok(empty.version > beforeReset.version);
    const removed = chats.poll('phone', { action: 'status', since: empty.version, waitMs: 1000 });
    revoked = true; chats.remove('phone'); await assert.rejects(removed, /removed/);
  } finally { chats.close(); }
});

test('phone requests can show tabs and open pages visibly while background requests stay in the background', async (t) => {
  const { pairing, phone } = pairingFixture(t);
  resetManagerForTesting();
  const calls: unknown[] = [];
  class Browser extends StubExecutor {
    override async tabSelect(id: string) { calls.push({ show: id }); return super.tabSelect(id); }
    override async tabNew(url?: string, options?: { active?: boolean }) { calls.push({ url, active: options?.active }); return super.tabNew(url, options); }
  }
  const browser = new Browser({ activeUrl: 'https://example.com' });
  const tabId = (await browser.tabsList())[0].tabId;
  const policy = resolvePolicy({ allowDomains: ['example.com'], enableMutations: true });
  configureManager({ policy, makeExecutor: () => browser });
  const commands = [
    { tool: 'tab_select', arguments: { tabId, show: true } },
    { tool: 'tab_select', arguments: { tabId, show: false } },
    { tool: 'tab_new', arguments: { url: 'https://example.com/visible', active: true } },
    { tool: 'tab_new', arguments: { url: 'https://example.com/background', active: false } },
  ];
  let emit!: (message: any) => void;
  const runner = createCodexChatRunner(pairing, phone.id, 'test', policy, async () => null, (_cwd, event) => {
    emit = event;
    return { notify: () => {}, close: () => {}, respond: (_id, result: any) => {
      assert.equal(result.success, true);
      emit({ method: 'turn/completed', params: { threadId: 'mobile', turn: { status: 'completed' } } });
    }, request: async (method, params: any) => {
      if (method === 'account/read') return { account: { type: 'chatgpt' } };
      if (method === 'config/read') return { config: {} };
      if (method === 'model/list') return { data: [{ model: 'fixture', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'medium' }], defaultReasoningEffort: 'medium' }] };
      if (method === 'thread/start') return { thread: { id: 'mobile' }, modelProvider: 'openai', sandbox: { type: 'readOnly' } };
      if (method === 'turn/start') {
        assert.equal(params.effort, 'medium', 'unsupported reasoning levels fall back to the catalog default');
        queueMicrotask(() => emit({ id: 20, method: 'item/tool/call', params: { threadId: 'mobile', ...commands.shift() } }));
      }
      return {};
    } };
  });
  try {
    for (let i = 0; i < 4; i++) await runner.run('Run the browser instruction', () => {});
    assert.deepEqual(calls, [{ show: tabId }, { url: 'https://example.com/visible', active: true }, { url: 'https://example.com/background', active: false }]);
  } finally { runner.close(); resetManagerForTesting(); }
});

test('phone chat exposes canvas drawing, carries the phone identity and keeps mutation and website restrictions', async (t) => {
  const { pairing, phone } = pairingFixture(t);
  setPersonWaitForTesting(1, 5);
  t.after(() => setPersonWaitForTesting(10_000, 45_000));
  const strokes = [{ points: [{ x: 20, y: 30 }, { x: 50, y: 60 }] }];
  for (const mode of ['allowed', 'mutations-disabled', 'site-blocked'] as const) {
    const calls: unknown[] = [];
    class Browser extends StubExecutor {
      override async draw(value: DrawStroke[]) {
        calls.push({ strokes: value, identity: currentClientIdentity()?.id, profile: currentClientIdentity()?.profile });
        return super.draw(value);
      }
    }
    const browser = new Browser({ activeUrl: 'https://example.com/canvas' });
    const tabId = (await browser.tabsList())[0].tabId;
    const policy = resolvePolicy({ enableMutations: mode !== 'mutations-disabled', allowDomains: mode === 'site-blocked' ? [] : ['example.com'] });
    resetManagerForTesting(); configureManager({ policy, makeExecutor: () => browser });
    let result: any, advertised = false;
    const runner = createCodexChatRunner(pairing, phone.id, 'test', policy, async () => null, (_cwd, emit) => ({
      notify() {}, close() {}, respond: (_id, reply) => {
        result = reply;
        emit({ method: 'turn/completed', params: { threadId: 'drawing', turn: { status: 'completed' } } });
      }, request: async (method, params: any) => {
        if (method === 'account/read') return { account: { type: 'chatgpt' } };
        if (method === 'config/read') return { config: {} };
        if (method === 'model/list') return { data: [{ model: 'fixture', isDefault: true, defaultReasoningEffort: 'low' }] };
        if (method === 'thread/start') {
          advertised = params.dynamicTools.some((tool: any) => tool.name === 'draw');
          return { thread: { id: 'drawing' }, modelProvider: 'openai', sandbox: { type: 'readOnly' } };
        }
        if (method === 'turn/start') queueMicrotask(() => emit({ id: 1, method: 'item/tool/call',
          params: { threadId: 'drawing', tool: 'draw', arguments: { tabId, strokes } } }));
        return {};
      },
    }));
    try {
      await runner.run('Draw a line on the canvas', () => {});
      assert.equal(advertised, mode !== 'mutations-disabled', mode);
      assert.equal(result.success, mode === 'allowed', mode);
      assert.deepEqual(calls, mode === 'allowed' ? [{ strokes, identity: pairing.identity(phone.id).id, profile: 'test' }] : [], mode);
    } finally { runner.close(); resetManagerForTesting(); }
  }
});
