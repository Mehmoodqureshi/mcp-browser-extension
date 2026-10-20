import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import childProcess, { type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema, LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ProgressNotification } from '@modelcontextprotocol/sdk/types.js';
import { closeAccessBrowserPrompt, requireAccess, setAccessPollIntervalForTesting } from '../src/access';
import { createServer } from '../src/mcp/server';
import { configureManager, resetManagerForTesting } from '../src/executor/manager';
import { StubExecutor } from '../src/executor/stub-executor';
import { resolvePolicy } from '../src/security/policy';

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'condition did not become true');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function setup(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'cmcp-access-'));
  const originalFetch = globalThis.fetch;
  const state = {
    status: 'pending', allowed: true, prompts: 0, starts: 0, polls: 0, validations: 0,
    browserForms: [] as string[],
    notifications: [] as Array<{ data: { status: string; message: string } }>,
  };
  t.mock.method(childProcess, 'spawn', (_command: string, args: string[]) => {
    state.browserForms.push(args.at(-1)!);
    return Object.assign(new EventEmitter(), { unref() {} }) as ChildProcess;
  });
  const server = {
    elicitInput: async () => {
      state.prompts++;
      return { action: 'accept', content: { email: 'user@example.com' } };
    },
    sendLoggingMessage: async (message: typeof state.notifications[number]) => { state.notifications.push(message); },
  } as unknown as Server;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('http://127.0.0.1:')) return originalFetch(input, init);
    if (url.endsWith('/start')) {
      state.starts++;
      return Response.json({ status: 'pending' });
    }
    if (url.endsWith('/status')) {
      state.polls++;
      if (state.status === 'offline') throw new Error('offline');
      if (state.status === 'expired') return Response.json({}, { status: 410 });
      return Response.json({ status: state.status });
    }
    if (url.endsWith('/validate')) {
      state.validations++;
      return state.allowed ? Response.json({ authorized: true }) : Response.json({}, { status: 403 });
    }
    throw new Error('unexpected request ' + url);
  };
  setAccessPollIntervalForTesting(2, 500);
  const saved = () => JSON.parse(readFileSync(join(dataDir, 'access.json'), 'utf8')) as { verified?: boolean; challengeId?: string; deviceSecret: string };
  t.after(async () => {
    // Resolve any surviving watcher before restoring real network access.
    state.status = 'expired';
    if (existsSync(join(dataDir, 'access.json')) && saved().challengeId) await requireAccess(server, dataDir);
    closeAccessBrowserPrompt(dataDir);
    globalThis.fetch = originalFetch;
    setAccessPollIntervalForTesting(2_000);
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { state, server, dataDir, saved };
}

test('the original call waits, receives verification, and caches access; revocation fails closed', async (t) => {
  const h = setup(t);
  const progress: ProgressNotification[] = [];
  let verified = false;
  let completed = false;
  const call = requireAccess(h.server, h.dataDir, {
    progressToken: 0,
    sendNotification: async (message) => { progress.push(message); },
    onVerified: () => { verified = true; },
  }).then((value) => { completed = true; return value; });
  await until(() => h.state.polls > 0);
  assert.equal(completed, false, 'sending an email must not finish the tool call');
  h.state.status = 'approved';
  assert.equal(await call, null);
  assert.equal(verified, true);
  assert.equal(h.saved().verified, true);
  assert.equal(h.saved().challengeId, undefined);
  if (process.platform !== 'win32') assert.equal(statSync(join(h.dataDir, 'access.json')).mode & 0o777, 0o600);
  assert.deepEqual(h.state.notifications.map((n) => n.data.status), ['pending', 'verified']);
  assert.match(progress.at(-1)!.params.message!, /Email verified/);
  assert.ok(progress.every((n, i) => n.params.progressToken === 0 && n.params.progress === i + 1));
  assert.equal(await requireAccess(h.server, h.dataDir), null);
  assert.equal(h.state.validations, 1);

  const realNow = Date.now;
  const future = realNow() + 60_001;
  Date.now = () => future;
  h.state.allowed = false;
  try {
    const denied = await requireAccess(h.server, h.dataDir);
    assert.match(denied!.content[0].text, /revoked/);
    assert.equal(h.saved().verified, false);
    assert.equal(h.state.prompts, 1);
  } finally { Date.now = realNow; }
});

test('expiry and denied grants return failure to the waiting call and notify the client', async (t) => {
  for (const status of ['expired', 'approved']) {
    await t.test(status, async (t) => {
      const h = setup(t);
      const call = requireAccess(h.server, h.dataDir);
      await until(() => h.state.polls > 0);
      h.state.status = status;
      h.state.allowed = false;
      const result = await call;
      assert.equal(result?.isError, true);
      assert.match(result!.content[0].text, status === 'expired' ? /expired/ : /did not grant access/);
      assert.notEqual(h.saved().verified, true);
      assert.equal(h.saved().challengeId, undefined);
      assert.equal(h.state.notifications.at(-1)?.data.status, status === 'expired' ? 'expired' : 'denied');
    });
  }
});

test('a bounded wait stays pending, reuses the email, and reports late background approval', async (t) => {
  const h = setup(t);
  setAccessPollIntervalForTesting(2, 20);
  const pending = await requireAccess(h.server, h.dataDir);
  assert.match(pending!.content[0].text, /ACCESS_PENDING/);
  assert.notEqual(h.saved().verified, true);
  h.state.status = 'approved';
  await until(() => h.state.notifications.some((n) => n.data.status === 'verified'));
  let verified = false;
  assert.equal(await requireAccess(h.server, h.dataDir, { onVerified: () => { verified = true; } }), null);
  assert.equal(verified, true, 'next call also carries the completion if the first wait ended');
  assert.equal(h.state.prompts, 1);
  assert.equal(h.state.starts, 1);
});

test('a follow-up wait reuses the active challenge and resumes when it is approved', async (t) => {
  const h = setup(t);
  setAccessPollIntervalForTesting(2, 20);
  await requireAccess(h.server, h.dataDir);
  setAccessPollIntervalForTesting(2, 500);
  const next = requireAccess(h.server, h.dataDir);
  h.state.status = 'approved';
  assert.equal(await next, null);
  assert.equal(h.state.starts, 1);
  assert.equal(h.state.prompts, 1);
});

test('expiry after a wait ends is reported on the next call before asking for another email', async (t) => {
  const h = setup(t);
  setAccessPollIntervalForTesting(2, 20);
  await requireAccess(h.server, h.dataDir);
  h.state.status = 'expired';
  await until(() => h.state.notifications.some((n) => n.data.status === 'expired'));
  assert.match((await requireAccess(h.server, h.dataDir))!.content[0].text, /expired/);
  assert.equal(h.state.prompts, 1);
});

test('cancelling one concurrent caller does not cancel another or run the cancelled action', async (t) => {
  const h = setup(t);
  const controller = new AbortController();
  const cancelled = requireAccess(h.server, h.dataDir, { signal: controller.signal });
  const ongoing = requireAccess(h.server, h.dataDir);
  await until(() => h.state.polls > 0);
  controller.abort();
  assert.match((await cancelled)!.content[0].text, /cancelled/);
  h.state.status = 'approved';
  assert.equal(await ongoing, null);
  assert.equal(h.state.prompts, 1);
});

test('network errors do not claim verification failed or succeeded, and recovery activates access', async (t) => {
  const h = setup(t);
  h.state.status = 'offline';
  setAccessPollIntervalForTesting(2, 20);
  const result = await requireAccess(h.server, h.dataDir);
  assert.match(result!.content[0].text, /service is unavailable/);
  assert.notEqual(h.saved().verified, true);
  h.state.status = 'approved';
  await until(() => h.state.notifications.some((n) => n.data.status === 'verified'));
  assert.equal(await requireAccess(h.server, h.dataDir), null);
});

test('notifications contain no email address, device secret, or challenge identifier', async (t) => {
  const h = setup(t);
  const call = requireAccess(h.server, h.dataDir);
  await until(() => h.state.polls > 0);
  const { deviceSecret, challengeId } = h.saved();
  h.state.status = 'approved';
  await call;
  const wire = JSON.stringify(h.state.notifications);
  assert.ok(!wire.includes('user@example.com'));
  assert.ok(!wire.includes(deviceSecret));
  assert.ok(!wire.includes(challengeId!));
});

test('a local verified flag cannot release a waiting tool without a valid server grant', async (t) => {
  const h = setup(t);
  const call = requireAccess(h.server, h.dataDir);
  await until(() => h.state.polls > 0);
  h.state.allowed = false;
  const state = h.saved();
  state.verified = true;
  delete state.challengeId;
  writeFileSync(join(h.dataDir, 'access.json'), JSON.stringify(state));
  assert.match((await call)!.content[0].text, /did not grant access/);
  assert.equal(h.saved().verified, false);
  assert.ok(h.state.validations > 0);
});

test('notification transport errors do not prevent verified access', async (t) => {
  const h = setup(t);
  h.server.sendLoggingMessage = async () => { throw new Error('client disconnected'); };
  h.state.status = 'approved';
  assert.equal(await requireAccess(h.server, h.dataDir, {
    progressToken: 'request-1', sendNotification: async () => { throw new Error('client disconnected'); },
  }), null);
  assert.equal(h.saved().verified, true);
});

test('concurrent tool calls use one email prompt without opening chat and browser forms together', async (t) => {
  for (const mode of ['accept', 'decline', 'cancel', 'unsupported'] as const) {
    await t.test(mode, async (t) => {
      const h = setup(t);
      setAccessPollIntervalForTesting(2, 20);
      let respond!: () => void;
      const waitingForInput = new Promise<void>((resolve) => { respond = resolve; });
      h.server.elicitInput = async () => {
        h.state.prompts++;
        await waitingForInput;
        if (mode === 'unsupported') throw new Error('Client cannot display the email prompt');
        return mode === 'accept'
          ? { action: 'accept', content: { email: 'user@example.com' } }
          : { action: mode };
      };
      const calls = Array.from({ length: 8 }, () => requireAccess(h.server, h.dataDir));
      try {
        await until(() => h.state.prompts > 0);
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(h.state.prompts, 1, 'parallel calls share the pending chat prompt');
        assert.equal(h.state.browserForms.length, 0, 'no browser form while chat is collecting input');
        assert.equal(h.state.starts, 0, 'no email before input');
      } finally {
        respond();
      }
      const responses = await Promise.all(calls);
      const expected = mode === 'accept' ? /ACCESS_PENDING/ : /ACCESS_INPUT_REQUIRED/;
      for (const response of responses) assert.match(response!.content[0].text, expected);
      assert.equal(h.state.prompts, 1);
      assert.equal(h.state.browserForms.length, mode === 'accept' ? 0 : 1);
      assert.equal(h.state.starts, mode === 'accept' ? 1 : 0);

      for (let retry = 0; retry < 3; retry++) {
        const response = await requireAccess(h.server, h.dataDir);
        assert.match(response!.content[0].text, expected);
        if (mode !== 'accept') assert.deepEqual(response, responses[0], 'reuse the same fallback URL');
      }
      assert.equal(h.state.prompts, 1, 'retries cannot ask for the email again');
      assert.equal(h.state.browserForms.length, mode === 'accept' ? 0 : 1, 'retries cannot open another tab');

      if (mode !== 'accept') {
        const url = h.state.browserForms[0];
        const html = await (await fetch(url)).text();
        const csrf = html.match(/name="csrf" value="([^"]+)"/)![1];
        const sent = await fetch(url, {
          method: 'POST', headers: { origin: new URL(url).origin, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ email: 'user@example.com', csrf }),
        });
        assert.equal(sent.status, 200);
        assert.match((await requireAccess(h.server, h.dataDir))!.content[0].text, /ACCESS_PENDING/);
      }
      assert.equal(h.state.starts, 1);
      assert.notEqual(h.saved().verified, true, 'neither input method grants access on its own');
      h.state.status = 'approved';
      await until(() => h.saved().verified === true);
      assert.equal(await requireAccess(h.server, h.dataDir), null);
      assert.equal(h.state.prompts, 1);
      assert.equal(h.state.starts, 1);
      assert.equal(h.state.browserForms.length, mode === 'accept' ? 0 : 1);
    });
  }
});

test('a suppressed email dialog offers a browser form instead of a retry loop', async (t) => {
  const h = setup(t);
  h.server.elicitInput = async () => ({ action: 'decline' });
  const response = await requireAccess(h.server, h.dataDir);
  assert.match(response!.content[0].text, /http:\/\/127\.0\.0\.1:\d+\//);
  assert.equal(h.state.starts, 0, 'no email is sent before the person supplies an address');
  assert.equal(h.state.browserForms.length, 1, 'the form opens without relying on the agent');
  assert.ok(response!.content[0].text.includes(h.state.browserForms[0]));
  assert.notEqual(h.saved().verified, true, 'suppressing a prompt cannot grant access');
  const repeated = await requireAccess(h.server, h.dataDir);
  assert.deepEqual(repeated, response, 'retries reuse the form instead of prompting again');
  assert.equal(h.state.browserForms.length, 1, 'retries must not open duplicate tabs');
});

test('unsupported, cancelled, and empty elicitation results all offer a manual form', async (t) => {
  for (const mode of ['unsupported', 'cancel', 'empty', 'missing'] as const) {
    await t.test(mode, async (t) => {
      const h = setup(t);
      h.server.elicitInput = async () => {
        if (mode === 'unsupported') throw new Error('Client does not support form elicitation');
        if (mode === 'cancel') return { action: 'cancel' };
        const content: Record<string, string> = mode === 'empty' ? { email: ' ' } : {};
        return { action: 'accept', content };
      };
      const response = await requireAccess(h.server, h.dataDir);
      assert.match(response!.content[0].text, /ACCESS_INPUT_REQUIRED/);
      assert.match(response!.content[0].text, /http:\/\/127\.0\.0\.1:\d+\//);
      assert.equal(h.state.starts, 0);
      assert.equal(h.state.browserForms.length, 1);
    });
  }
});

test('cancelling the actual tool request does not open a fallback verification form', async (t) => {
  const h = setup(t);
  const controller = new AbortController();
  h.server.elicitInput = async () => { controller.abort(); return { action: 'cancel' }; };
  const response = await requireAccess(h.server, h.dataDir, { signal: controller.signal });
  assert.match(response!.content[0].text, /cancelled/);
  assert.doesNotMatch(response!.content[0].text, /http:\/\//);
  assert.equal(h.state.starts, 0);
  assert.equal(h.state.browserForms.length, 0, 'a cancelled tool must not open a tab');
});

test('a failed browser launch leaves the manual verification form available', async (t) => {
  const h = setup(t);
  h.server.elicitInput = async () => ({ action: 'decline' });
  t.mock.method(childProcess, 'spawn', () => {
    const child = Object.assign(new EventEmitter(), { unref() {} }) as ChildProcess;
    queueMicrotask(() => child.emit('error', new Error('No desktop browser')));
    return child;
  });
  const response = await requireAccess(h.server, h.dataDir);
  const url = response!.content[0].text.match(/http:\/\/127\.0\.0\.1:\d+\/verify\/[a-f0-9]+/)![0];
  assert.equal((await fetch(url)).status, 200);
  assert.notEqual(h.saved().verified, true);
  assert.equal(h.state.starts, 0);
});

test('browser fallback completes the same grant validation with no secret in the page or URL', async (t) => {
  const h = setup(t);
  h.server.elicitInput = async () => ({ action: 'decline' });
  const response = await requireAccess(h.server, h.dataDir);
  const url = response!.content[0].text.match(/http:\/\/127\.0\.0\.1:\d+\/verify\/[a-f0-9]+/)![0];
  const html = await (await fetch(url)).text();
  assert.match(html, /type="email"/);
  assert.ok(!html.includes(h.saved().deviceSecret));
  assert.ok(!response!.content[0].text.includes(h.saved().deviceSecret));
  const csrf = html.match(/name="csrf" value="([^"]+)"/)![1];
  const send = () => fetch(url, {
    method: 'POST', headers: { origin: new URL(url).origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: 'user@example.com', csrf }),
  });
  assert.equal((await send()).status, 200);
  assert.equal((await send()).status, 200);
  assert.equal(h.state.starts, 1, 'a repeated submit must not send another email');
  assert.notEqual(h.saved().verified, true);
  h.state.status = 'approved';
  await until(() => h.saved().verified === true);
  let verified = false;
  assert.equal(await requireAccess(h.server, h.dataDir, { onVerified: () => { verified = true; } }), null);
  assert.equal(verified, true);
  assert.equal(h.state.validations, 1);
});

test('a tool retry while the browser form is sending email waits for the challenge to exist', async (t) => {
  const h = setup(t);
  h.server.elicitInput = async () => ({ action: 'decline' });
  h.state.status = 'expired'; // The backend has no challenge until /start finishes.
  const response = await requireAccess(h.server, h.dataDir);
  const url = response!.content[0].text.match(/http:\/\/127\.0\.0\.1:\d+\/verify\/[a-f0-9]+/)![0];
  const html = await (await fetch(url)).text();
  const csrf = html.match(/name="csrf" value="([^"]+)"/)![1];
  const savedFetch = globalThis.fetch;
  let release!: () => void;
  const sending = new Promise<void>((resolve) => { release = resolve; });
  let started = false;
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith('/start')) {
      started = true;
      await sending;
      h.state.status = 'pending';
    }
    return savedFetch(input, init);
  };
  const submitted = fetch(url, {
    method: 'POST', headers: { origin: new URL(url).origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: 'user@example.com', csrf }),
  }).catch(() => null);
  await until(() => started);
  const challenge = h.saved().challengeId;
  const retry = requireAccess(h.server, h.dataDir);
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(h.state.polls, 0, 'do not check a challenge before the backend creates it');
    assert.equal(h.saved().challengeId, challenge);
    assert.notEqual(h.saved().verified, true);
  } finally {
    release();
    await submitted;
  }
  assert.equal((await submitted)?.status, 200);
  h.state.status = 'approved';
  assert.equal(await retry, null);
  assert.equal(h.state.starts, 1);
  assert.equal(h.state.validations, 1);
});

test('a failed email send through the browser form can be retried', async (t) => {
  const h = setup(t);
  h.server.elicitInput = async () => ({ action: 'decline' });
  const response = await requireAccess(h.server, h.dataDir);
  const url = response!.content[0].text.match(/http:\/\/127\.0\.0\.1:\d+\/verify\/[a-f0-9]+/)![0];
  const html = await (await fetch(url)).text();
  const csrf = html.match(/name="csrf" value="([^"]+)"/)![1];
  const savedFetch = globalThis.fetch;
  let fail = true;
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith('/start') && fail) throw new Error('offline');
    return savedFetch(input, init);
  };
  const send = () => fetch(url, {
    method: 'POST', headers: { origin: new URL(url).origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: 'user@example.com', csrf }),
  });
  assert.equal((await send()).status, 400);
  assert.equal(h.saved().challengeId, undefined);
  fail = false;
  assert.equal((await send()).status, 200);
  assert.equal(h.state.starts, 1);
});

test('a real MCP tool call receives progress, a verification notification, and its original browser result', async (t) => {
  const h = setup(t);
  resetManagerForTesting();
  const policy = resolvePolicy({ allowDomains: ['example.com'] });
  const executor = new StubExecutor({ activeUrl: 'https://example.com' });
  let browserCalls = 0;
  const tabsList = executor.tabsList.bind(executor);
  executor.tabsList = async () => { browserCalls++; return tabsList(); };
  configureManager({ policy, makeExecutor: () => executor });
  const server = createServer('test', policy, (server, _dir, request) => requireAccess(server, h.dataDir, request));
  const client = new Client({ name: 'verification-test', version: '1' }, { capabilities: { elicitation: { form: {} } } });
  let prompts = 0;
  let respond!: () => void;
  const waitingForInput = new Promise<void>((resolve) => { respond = resolve; });
  client.setRequestHandler(ElicitRequestSchema, async () => {
    prompts++;
    await waitingForInput;
    return { action: 'accept', content: { email: 'user@example.com' } };
  });
  const notifications: unknown[] = [];
  client.setNotificationHandler(LoggingMessageNotificationSchema, (message) => { notifications.push(message.params.data); });
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTx), client.connect(clientTx)]);
  const progress: string[] = [];
  try {
    assert.deepEqual(client.getServerCapabilities()?.logging, {});
    const call = client.callTool({ name: 'tabs_list', arguments: {} }, undefined, {
      onprogress: (value) => { if (value.message) progress.push(value.message); },
    });
    await until(() => prompts > 0);
    assert.equal(h.state.browserForms.length, 0, 'an active chat prompt cannot open a browser form');
    assert.equal(h.state.starts, 0);
    respond();
    await until(() => h.state.polls > 0);
    assert.equal(h.state.browserForms.length, 0, 'accepting the chat prompt cannot open a browser form');
    assert.equal(browserCalls, 0, 'the browser cannot be used before verification');
    h.state.status = 'approved';
    const response = await call;
    assert.notEqual(response.isError, true);
    const content = response.content as Array<{ type: string; text: string }>;
    assert.match(content[0].text, /Email verified/);
    assert.match(content[1].text, /https:\/\/example.com/);
    assert.ok(browserCalls > 0);
    assert.ok(progress.some((message) => message.includes('Email verified')));
    assert.ok(notifications.some((value) => (value as { status?: string }).status === 'verified'));
    assert.equal(prompts, 1);
    assert.equal(h.state.starts, 1);
    assert.equal(h.state.browserForms.length, 0);
  } finally {
    respond();
    await client.close();
    await server.close();
    resetManagerForTesting();
  }
});

for (const mode of ['auto-decline', 'auto-cancel', 'no-elicitation'] as const) {
  test(`a real MCP client with ${mode} verifies through the browser before tools can run`, async (t) => {
    const h = setup(t);
    setAccessPollIntervalForTesting(2, 20);
    resetManagerForTesting();
    const policy = resolvePolicy({ allowDomains: ['example.com'] });
    const executor = new StubExecutor({ activeUrl: 'https://example.com' });
    let browserCalls = 0;
    let prompts = 0;
    const tabsList = executor.tabsList.bind(executor);
    executor.tabsList = async () => { browserCalls++; return tabsList(); };
    configureManager({ policy, makeExecutor: () => executor });
    const server = createServer('test', policy, (server, _dir, request) => requireAccess(server, h.dataDir, request));
    const client = new Client({ name: 'verification-test', version: '1' }, {
      capabilities: mode !== 'no-elicitation' ? { elicitation: { form: {} } } : {},
    });
    if (mode !== 'no-elicitation') {
      client.setRequestHandler(ElicitRequestSchema, async () => {
        prompts++;
        return { action: mode === 'auto-decline' ? 'decline' : 'cancel' };
      });
    }
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTx), client.connect(clientTx)]);
    const call = () => client.callTool({ name: 'tabs_list', arguments: {} });
    const text = (response: Awaited<ReturnType<typeof call>>) =>
      (response.content as Array<{ text: string }>).map((part) => part.text).join('\n');
    try {
      const blockedCalls = await Promise.all(Array.from({ length: 8 }, () => call()));
      const blocked = blockedCalls[0];
      assert.ok(blockedCalls.every((response) => text(response) === text(blocked)));
      assert.equal(blocked.isError, true);
      assert.match(text(blocked), /ACCESS_INPUT_REQUIRED/);
      const url = text(blocked).match(/http:\/\/127\.0\.0\.1:\d+\/verify\/[a-f0-9]+/)![0];
      assert.equal(text(await call()), text(blocked), 'retries reuse the same form');
      assert.equal(prompts, mode === 'no-elicitation' ? 0 : 1);
      assert.equal(h.state.browserForms.length, 1, 'parallel calls and retries open only one form');
      assert.equal(browserCalls, 0);
      assert.equal(h.state.starts, 0);

      const html = await (await fetch(url)).text();
      const csrf = html.match(/name="csrf" value="([^"]+)"/)![1];
      const sent = await fetch(url, {
        method: 'POST', headers: { origin: new URL(url).origin, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ email: 'user@example.com', csrf }),
      });
      assert.equal(sent.status, 200);
      assert.match(await sent.text(), /Check your inbox/);
      const pending = await call();
      assert.equal(pending.isError, true);
      assert.match(text(pending), /ACCESS_PENDING/);
      assert.equal(browserCalls, 0, 'entering an email does not authorize browser access');

      h.state.status = 'approved';
      await until(() => h.saved().verified === true);
      const verified = await call();
      assert.notEqual(verified.isError, true);
      assert.match(text(verified), /Email verified/);
      assert.match(text(verified), /https:\/\/example.com/);
      assert.ok(browserCalls > 0);
      assert.equal(h.state.starts, 1);
      assert.equal(h.state.validations, 1);
      assert.equal(prompts, mode === 'no-elicitation' ? 0 : 1);
      assert.equal(h.state.browserForms.length, 1);
      await assert.rejects(fetch(url), 'the local form closes after verification');
    } finally {
      await client.close();
      await server.close();
      resetManagerForTesting();
    }
  });
}
