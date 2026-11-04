import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PhoneChat, createCodexChatRunner, type ChatAgent } from '../src/remote/phone-chat';
import { createClaudeChatRunner } from '../src/remote/claude-chat';
import { PhonePairing } from '../src/remote/phone-pairing';
import { resolvePolicy } from '../src/security/policy';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function pairingFixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'mbe-claude-chat-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pairing = new PhonePairing(dir, 'test'); pairing.setPublicUrl('https://relay.example/remote');
  const phone = pairing.claim(JSON.parse(pairing.create().invitation!.payload).code, 'Test phone'); pairing.approve(phone.id);
  return { pairing, phone };
}

test('phone chat starts with Codex, switches assistant only through a new chat and creates the chosen runner', async () => {
  const created: ChatAgent[] = [];
  let closed = 0;
  const chats = new PhoneChat((_id, agent) => { created.push(agent); return { run: async (_text, next) => next(`hi from ${agent}`, ''), close: () => { closed++; } }; }, () => {});
  try {
    const first = chats.request('phone', { action: 'status' });
    assert.equal(first.agent, 'codex');
    assert.deepEqual(first.agents, ['codex', 'claude']);
    assert.throws(() => chats.request('phone', { action: 'reset', agent: 'gemini' }), /Choose Codex or Claude/);
    chats.request('phone', { action: 'send', requestId: 'request_1', text: 'hello' }); await tick(); await tick();
    assert.deepEqual(created, ['codex']);
    const switched = chats.request('phone', { action: 'reset', agent: 'claude' });
    assert.equal(switched.agent, 'claude'); assert.equal(switched.messages.length, 0); assert.equal(closed, 1);
    chats.request('phone', { action: 'send', requestId: 'request_2', text: 'hello' }); await tick(); await tick();
    const reply = chats.request('phone', { action: 'status' });
    assert.deepEqual(created, ['codex', 'claude']);
    assert.equal(reply.messages[1].text, 'hi from claude');
    // A plain reset keeps the current assistant; an idle matching reset keeps the chat.
    assert.equal(chats.request('phone', { action: 'reset' }).agent, 'claude');
    const before = chats.request('phone', { action: 'status' }).version;
    assert.equal(chats.request('phone', { action: 'reset', agent: 'claude' }).version, before);
  } finally { chats.close(); }
});

test('Claude chat is locked to browser tools, uses no user settings or saved sessions and streams the reply', async (t) => {
  const { pairing, phone } = pairingFixture(t);
  let options: any;
  const prompts: string[] = [];
  const runner = createClaudeChatRunner(pairing, phone.id, 'test', resolvePolicy({}), async () => null, ({ prompt, options: given }) => {
    options = given;
    const messages = (async function* () {
      for await (const message of prompt) {
        prompts.push(String((message.message as any).content));
        const allowed = await given.canUseTool!('mcp__browser__tabs_list', {}, { signal: new AbortController().signal, suggestions: [], toolUseID: 't1' } as any);
        const shell = await given.canUseTool!('Bash', { command: 'ls' }, { signal: new AbortController().signal, suggestions: [], toolUseID: 't2' } as any);
        assert.equal(allowed?.behavior, 'allow'); assert.equal(shell?.behavior, 'deny');
        yield { type: 'stream_event', event: { type: 'message_start' } } as any;
        yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'You have ' } } } as any;
        yield { type: 'assistant', uuid: 'u1', message: { id: 'm1', content: [{ type: 'text', text: 'You have 2 tabs.' }] } } as any;
        yield { type: 'result', subtype: 'success', is_error: false } as any;
      }
    })();
    return Object.assign(messages, { close() {} }) as any;
  });
  const updates: Array<[string | null, string]> = [];
  try {
    await runner.run('List my tabs', (text, activity) => updates.push([text, activity]));
    assert.deepEqual(prompts, ['List my tabs']);
    assert.deepEqual(options.tools, []);
    assert.deepEqual(options.settingSources, []);
    assert.equal(options.strictMcpConfig, true);
    assert.equal(options.persistSession, false);
    assert.equal(options.permissionMode, 'default');
    assert.deepEqual(Object.keys(options.mcpServers), ['browser']);
    assert.equal(options.mcpServers.browser.type, 'sdk');
    assert.equal(options.env.ANTHROPIC_API_KEY, undefined);
    assert.ok(updates.some(([, activity]) => activity === 'Looking at your open tabs'));
    assert.ok(updates.some(([text]) => text === 'You have '));
    assert.equal(updates.at(-1)![0], 'You have 2 tabs.');
  } finally { runner.close(); }
});

test('Claude chat rejects the turn when Claude Code fails', async (t) => {
  const { pairing, phone } = pairingFixture(t);
  const runner = createClaudeChatRunner(pairing, phone.id, 'test', resolvePolicy({}), async () => null, ({ prompt }) => Object.assign((async function* () {
    for await (const _message of prompt) yield { type: 'result', subtype: 'error_during_execution', is_error: true } as any;
  })(), { close() {} }) as any);
  try { await assert.rejects(runner.run('hello', () => {}), /Claude turn failed/); }
  finally { runner.close(); }
});

test('an open chat screen warms one runner, and each message carries Fast or Smart', async () => {
  let created = 0, warmed = 0; const speeds: unknown[] = [];
  const chats = new PhoneChat(() => { created++; return { warm: () => { warmed++; }, run: async (_text, next, speed) => { speeds.push(speed); next('ok', ''); }, close() {} }; }, () => {});
  try {
    chats.request('phone', { action: 'status', warm: true });
    chats.request('phone', { action: 'status', warm: true });
    assert.equal(created, 1); assert.equal(warmed, 1);
    assert.deepEqual(chats.request('phone', { action: 'status' }).speeds, ['fast', 'smart']);
    assert.throws(() => chats.request('phone', { action: 'send', requestId: 'request_9', text: 'hi', speed: 'turbo' }), /Fast or Smart/);
    chats.request('phone', { action: 'send', requestId: 'request_1', text: 'hi', speed: 'fast' }); await tick(); await tick();
    chats.request('phone', { action: 'send', requestId: 'request_2', text: 'hi' }); await tick(); await tick();
    assert.deepEqual(speeds, ['fast', 'smart']); assert.equal(created, 1, 'the warmed runner serves the conversation');
  } finally { chats.close(); }
});

test('Codex Fast uses the catalog fast model per turn and Smart keeps the main model', async (t) => {
  const { pairing, phone } = pairingFixture(t);
  const turns: any[] = []; let emit!: (message: any) => void;
  const runner = createCodexChatRunner(pairing, phone.id, 'test', resolvePolicy({}), async () => null, (_cwd, event) => {
    emit = event;
    return { notify() {}, close() {}, respond() {}, request: async (method: string, params: any) => {
      if (method === 'account/read') return { account: { type: 'chatgpt' } };
      if (method === 'config/read') return { config: {} };
      if (method === 'model/list') return { data: [
        { model: 'gpt-6.1-terra', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] },
        { model: 'gpt-6-luna', description: 'Fast and affordable model for easier tasks.', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }] };
      if (method === 'thread/start') return { thread: { id: 'th' }, modelProvider: 'openai', sandbox: { type: 'readOnly' } };
      if (method === 'turn/start') { turns.push(params); queueMicrotask(() => emit({ method: 'turn/completed', params: { threadId: 'th', turn: { status: 'completed' } } })); }
      return {};
    } };
  });
  try {
    await runner.run('a', () => {}, 'fast'); await runner.run('b', () => {}, 'smart');
    assert.deepEqual(turns.map((turn) => [turn.model, turn.effort]), [['gpt-6-luna', 'low'], ['gpt-6.1-terra', 'low']]);
  } finally { runner.close(); }
});

test('without the optional Claude package the phone is offered Codex only', async () => {
  const { claudeChatAvailable } = await import('../src/remote/claude-chat');
  assert.equal(claudeChatAvailable(() => { throw new Error('missing'); }), false);
  assert.equal(claudeChatAvailable(() => '/sdk.mjs'), true);
  const chats = new PhoneChat(() => ({ run: async () => {}, close() {} }), () => {}, 300_000, ['codex']);
  try {
    assert.deepEqual(chats.request('phone', { action: 'status' }).agents, ['codex']);
    assert.throws(() => chats.request('phone', { action: 'reset', agent: 'claude' }), /not available/);
  } finally { chats.close(); }
});
