import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CanUseTool, Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { createServer } from '../mcp/server';
import { requireAccess } from '../access';
import type { Policy } from '../security/policy';
import type { PhonePairing } from './phone-pairing';
import { ChatRequestError, chatInstructions, toolActivity, type ChatRunner, type ChatSpeed } from './phone-chat';

const SERVER = 'browser';
const SDK = '@anthropic-ai/claude-agent-sdk';

/**
 * The Claude Agent SDK bundles Claude Code (hundreds of MB), so it is an
 * optional peer: only computers that offer Claude in phone chat install it.
 */
export function claudeChatAvailable(resolve: (id: string) => string = require.resolve): boolean {
  try { resolve(SDK); return true; } catch { return false; }
}
const PREFIX = `mcp__${SERVER}__`;
const models = (): Record<ChatSpeed, string> => ({
  fast: process.env.MBE_PHONE_CLAUDE_FAST_MODEL || 'haiku',
  smart: process.env.MBE_PHONE_CLAUDE_MODEL || 'sonnet',
});
type QueryFactory = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query;

/**
 * Phone chat through the local Claude Code sign-in. Claude only receives the
 * paired phone's browser tools: no built-in tools, user settings, hooks,
 * skills, other MCP servers or saved sessions.
 */
export function createClaudeChatRunner(pairing: PhonePairing, id: string, version: string, policy: Policy, accessGuard = requireAccess,
  queryFactory?: QueryFactory): ChatRunner {
  const identity = pairing.identity(id);
  const cwd = join(pairing.dataDir, 'phone-chat'); mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const server = createServer(version, policy, accessGuard, identity);
  const abort = new AbortController();
  const inbox: SDKUserMessage[] = [];
  let wakeInbox: (() => void) | undefined;
  let closed = false;
  let session: Query | undefined;
  let starting: Promise<void> | undefined;
  let model = models().smart;
  let turn: { resolve(): void; reject(error: Error): void; update(text: string | null, activity: string): void; parts: Map<string, string>; live: string } | undefined;

  const prompt = async function* (): AsyncGenerator<SDKUserMessage> {
    while (!closed) {
      const next = inbox.shift();
      if (next) { yield next; continue; }
      await new Promise<void>((resolve) => { wakeInbox = resolve; });
      wakeInbox = undefined;
    }
  };
  const shown = (): string => [...turn!.parts.values(), turn!.live].filter(Boolean).join('\n\n').slice(0, 24_000);
  const canUseTool: CanUseTool = async (name, input) => {
    if (closed || !turn || !name.startsWith(PREFIX)) return { behavior: 'deny', message: 'This tool is not available.' };
    try { identity.assertAccess?.(); }
    catch { return { behavior: 'deny', message: 'Phone access was removed. Ask the user to check the extension.', interrupt: true }; }
    turn.update(null, toolActivity.get(name.slice(PREFIX.length)) ?? 'Using the browser');
    return { behavior: 'allow', updatedInput: input };
  };
  const handle = (message: SDKMessage): void => {
    if (!turn) return;
    if (message.type === 'stream_event') {
      const event: any = message.event;
      if (event.type === 'message_start') turn.live = '';
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
        turn.live = (turn.live + event.delta.text).slice(0, 24_000);
        turn.update(shown(), 'Writing a reply');
      }
    } else if (message.type === 'assistant') {
      const text = (message.message.content as any[]).filter((block) => block.type === 'text').map((block) => block.text).join('');
      turn.live = '';
      if (text) turn.parts.set(message.message.id ?? message.uuid, text.slice(0, 24_000));
      turn.update(shown(), (message.message.content as any[]).some((block) => block.type === 'tool_use') ? 'Using the browser' : 'Writing a reply');
    } else if (message.type === 'result') {
      const current = turn; turn = undefined;
      if (message.subtype === 'success' && !message.is_error) current.resolve();
      else current.reject(new Error('Claude turn failed or stopped.'));
    }
  };
  const start = async (initial: string): Promise<void> => {
    model = initial;
    const factory = queryFactory ?? await import(SDK).then((sdk: typeof import('@anthropic-ai/claude-agent-sdk')) => sdk.query, () => {
      throw new ChatRequestError(409, 'Claude is not set up on your computer. Install @anthropic-ai/claude-agent-sdk next to MCP Browser Extension, then start a new chat.');
    });
    const env: Record<string, string | undefined> = { PATH: process.env.PATH, CLAUDE_AGENT_SDK_CLIENT_APP: `mcp-browser-extension-mobile/${version}` };
    // Claude Code owns its sign-in. Never forward API keys or tokens from this process.
    for (const key of ['HOME', 'USER', 'TMPDIR', 'LANG', 'CLAUDE_CONFIG_DIR']) if (process.env[key]) env[key] = process.env[key];
    session = factory({ prompt: prompt(), options: {
      cwd, env, abortController: abort, systemPrompt: chatInstructions,
      model, effort: 'low',
      tools: [], settingSources: [], strictMcpConfig: true, persistSession: false, includePartialMessages: true,
      mcpServers: { [SERVER]: { type: 'sdk', name: SERVER, instance: server as any, timeout: 300_000 } },
      permissionMode: 'default', canUseTool,
      ...(process.env.MBE_CLAUDE_BIN ? { pathToClaudeCodeExecutable: process.env.MBE_CLAUDE_BIN } : {}),
    } });
    void (async () => {
      try { for await (const message of session!) { if (closed) return; handle(message); } }
      catch { /* Reported to the active turn below. */ }
      if (!closed && turn) { const current = turn; turn = undefined; current.reject(new ChatRequestError(409, 'Claude could not finish. Check that Claude Code is installed and signed in on your computer, then start a new chat.')); }
    })();
  };
  const close = (): void => {
    if (closed) return; closed = true; abort.abort(); wakeInbox?.();
    turn?.reject(new Error('Stopped.')); turn = undefined;
    try { session?.close(); } catch { /* Already stopped. */ }
    void server.close().catch(() => undefined);
  };
  return {
    // Spawning Claude Code and loading the browser tools happens before the first message.
    warm: () => { if (!closed) { starting ??= start(models().smart); starting.catch(() => undefined); } },
    run: async (text, update, speed = 'smart') => {
      if (closed) throw new Error('Closed chat.');
      identity.assertAccess?.();
      const wanted = models()[speed];
      starting ??= start(wanted); await starting;
      if (closed) throw new Error('Closed chat.');
      if (model !== wanted) { await session!.setModel(wanted); model = wanted; }
      await new Promise<void>((resolve, reject) => {
        turn = { resolve, reject, update, parts: new Map(), live: '' };
        update(null, 'Working on your request');
        inbox.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null } as SDKUserMessage);
        wakeInbox?.();
      });
    }, close,
  };
}
