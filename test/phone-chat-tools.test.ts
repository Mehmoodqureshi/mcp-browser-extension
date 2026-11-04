import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCodexChatRunner } from '../src/remote/phone-chat';
import { PhonePairing } from '../src/remote/phone-pairing';
import { configureManager, resetManagerForTesting } from '../src/executor/manager';
import { StubExecutor } from '../src/executor/stub-executor';
import { resolvePolicy, type Policy } from '../src/security/policy';
import { currentClientIdentity, withClientIdentity } from '../src/bridge/client-identity';
import { ensureWorkspace } from '../src/bridge/datadir';
import { resetActiveWorkspaceForTesting, setActiveWorkspace } from '../src/bridge/workspace';
import { dispatchToolCall, setToolAllowlist, TOOL_NAMES } from '../src/mcp/tools';
import { setPersonWaitForTesting } from '../src/mcp/person-wait';

const isolatedTools = ['profile_use', 'profile_rename', 'task_new', 'tasks_list', 'task_status'];
const textOf = (result: any) => result.contentItems.filter((c: any) => c.type === 'inputText').map((c: any) => c.text).join('\n');
const jsonOf = (result: any) => JSON.parse(result.contentItems.find((c: any) => c.type === 'inputText').text);

function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'mbe-chat-tools-'));
  const uploadsDir = join(dir, 'uploads'); mkdirSync(uploadsDir);
  const upload = join(uploadsDir, 'example.txt'); writeFileSync(upload, 'fixture file');
  const outside = join(dir, 'private.txt'); writeFileSync(outside, 'not an upload');
  const pairing = new PhonePairing(dir, 'personal'); pairing.setPublicUrl('https://relay.example/remote');
  const pair = () => {
    const phone = pairing.claim(JSON.parse(pairing.create().invitation!.payload).code, 'Test phone');
    pairing.approve(phone.id); return phone;
  };
  const phone = pair();
  resetManagerForTesting(); resetActiveWorkspaceForTesting(); setToolAllowlist(null);
  setPersonWaitForTesting(1, 5);
  t.after(() => {
    resetManagerForTesting(); resetActiveWorkspaceForTesting(); setToolAllowlist(null);
    setPersonWaitForTesting(10_000, 45_000); rmSync(dir, { recursive: true, force: true });
  });
  const policy = resolvePolicy({ allowDomains: ['example.com'], enableMutations: true, allowEval: true,
    allowDownloads: true, allowUploads: true, uploadsDir, allowObservers: true });
  const browser = new StubExecutor({ activeUrl: 'https://example.com/fixture',
    observers: { installed: true, console: [], network: [], dialogs: [], dialogPolicy: 'dismiss' },
    proxy: { enabled: false, server: null, auth: false, control: 'controllable_by_this_extension', webrtcProtected: false, exitIp: null } });
  configureManager({ policy, makeExecutor: () => browser });
  return { dir, pairing, phone, pair, policy, browser, upload, outside };
}

// Uses the real authenticated in-memory MCP server. Only the model and browser
// are fixtures: schemas, dispatch, policy, identity and artifact storage run normally.
function adapter(pairing: PhonePairing, id: string, policy: Policy) {
  let command: { tool: string; arguments: Record<string, unknown> }, response: any, catalog: any[] = [];
  const identities: string[] = [];
  const runner = createCodexChatRunner(pairing, id, 'test', policy, async () => {
    identities.push(currentClientIdentity()!.id); return null;
  }, (_cwd, emit) => ({
    notify() {}, close() {}, respond: (_id, result) => {
      response = result;
      emit({ method: 'turn/completed', params: { threadId: 'catalog-test', turn: { status: 'completed' } } });
    }, request: async (method, params: any) => {
      if (method === 'account/read') return { account: { type: 'chatgpt' } };
      if (method === 'config/read') return { config: {} };
      if (method === 'model/list') return { data: [{ model: 'fixture', isDefault: true, defaultReasoningEffort: 'low' }] };
      if (method === 'thread/start') {
        catalog = params.dynamicTools;
        return { thread: { id: 'catalog-test' }, modelProvider: 'openai', sandbox: { type: 'readOnly' } };
      }
      if (method === 'turn/start') queueMicrotask(() => emit({ id: 1, method: 'item/tool/call', params: { threadId: 'catalog-test', ...command } }));
      return {};
    },
  }));
  return { identities, catalog: () => catalog, close: () => runner.close(), call: async (tool: string, args: Record<string, unknown> = {}) => {
    command = { tool, arguments: args }; response = undefined;
    await runner.run('Exercise a browser capability in the disposable fixture', () => {});
    assert.ok(response, `${tool} must receive a response`); return response;
  } };
}

test('every enabled phone tool is advertised and callable through chat with the paired identity', async (t) => {
  const f = fixture(t), chat = adapter(f.pairing, f.phone.id, f.policy); t.after(chat.close);
  const tabId = (await f.browser.tabsList())[0].tabId;
  const calls: Record<string, Record<string, unknown>> = {
    tabs_list: {}, tab_select: { tabId }, tab_new: { url: 'https://example.com/fixture' }, tab_close: { tabId },
    navigate: { tabId, url: 'https://example.com/fixture' }, back: { tabId }, forward: { tabId }, reload: { tabId },
    click: { tabId, selector: 'button' }, draw: { tabId, strokes: [{ points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }] },
    type: { tabId, selector: 'input', text: 'fixture' }, select_option: { tabId, selector: 'select', values: ['one'] },
    press: { tabId, key: 'Escape' }, hover: { tabId, selector: 'button' }, scroll: { tabId, deltaY: 100 },
    screenshot: { tabId }, get_text: { tabId }, get_html: { tabId }, snapshot: { tabId }, page_watch: { tabId, action: 'create', name: 'Phone checkpoint' },
    get_cookies: { tabId }, storage: { tabId, op: 'get', key: 'example' }, eval: { tabId, expression: 'document.title' },
    wait_for: { tabId, selector: 'body' }, extract_links: { tabId }, read_as_markdown: { tabId },
    fill_form: { tabId, fields: { '#name': 'Fixture' } }, download_file: { url: 'https://example.com/file.txt' },
    upload_file: { tabId, selector: 'input[type=file]', files: [f.upload] }, frames_list: { tabId },
    console_logs: { tabId }, network_log: { tabId }, dialogs: { tabId }, print_pdf: { tabId },
    proxy_status: {}, chrome_status: {}, auth_check: { tabId },
    batch: { ops: [{ tool: 'get_text', args: { tabId } }, { tool: 'frames_list', args: { tabId } }] },
  };
  const results = new Map<string, any>();
  for (const [tool, args] of Object.entries(calls)) {
    const result = await chat.call(tool, args);
    assert.equal(result.success, true, `${tool}: ${textOf(result)}`); results.set(tool, result);
  }
  const expected = TOOL_NAMES.filter((name) => !isolatedTools.includes(name)).sort();
  assert.deepEqual(Object.keys(calls).sort(), expected, 'every browser tool needs a phone chat fixture');
  assert.deepEqual(chat.catalog().map((tool) => tool.name).sort(), expected);
  assert.ok(chat.identities.length >= expected.length);
  assert.ok(chat.identities.every((id) => id === f.pairing.identity(f.phone.id).id));
  assert.ok(results.get('screenshot').contentItems.some((c: any) => c.type === 'inputImage' && c.imageUrl.startsWith('data:image/png;base64,')));
  const cookies = jsonOf(results.get('get_cookies')); assert.ok(cookies.valuesHidden); assert.notEqual(cookies.cookies[0].value, '1');
  const pdf = jsonOf(results.get('print_pdf'));
  assert.ok(pdf.path.startsWith(f.pairing.identity(f.phone.id).workspace!.resultsDir));
  assert.match(readFileSync(pdf.path, 'utf8'), /^%PDF/);
  const watchId = jsonOf(results.get('page_watch')).watchId;
  assert.equal((await chat.call('page_watch', { action: 'compare', watchId, tabId })).success, true);
  assert.equal(jsonOf(await chat.call('page_watch', { action: 'list' })).watches.length, 1);
  assert.equal((await chat.call('page_watch', { action: 'delete', watchId })).success, true);
  assert.equal(jsonOf(await chat.call('page_watch', { action: 'list' })).watches.length, 0);
  const deniedUpload = await chat.call('upload_file', { tabId, selector: 'input[type=file]', files: [f.outside] });
  assert.equal(deniedUpload.success, false); assert.match(textOf(deniedUpload), /outside the allowed uploads dir/);
  for (const tool of isolatedTools) assert.equal((await chat.call(tool)).success, false, tool);
  const batch = jsonOf(await chat.call('batch', { mode: 'serial', ops: isolatedTools.map((tool) => ({ tool, args: {} })) }));
  assert.ok(batch.results.every((result: any) => result.status === 'error'), 'batch must not bypass phone isolation');
});

test('chat honors disabled capabilities, website permissions and explicit tool restrictions including batch', async (t) => {
  const f = fixture(t);
  const policy = resolvePolicy({ allowDomains: ['example.com'] });
  resetManagerForTesting(); configureManager({ policy, makeExecutor: () => f.browser });
  const chat = adapter(f.pairing, f.phone.id, policy); t.after(chat.close);
  await chat.call('tabs_list');
  for (const tool of ['draw', 'hover', 'fill_form', 'eval', 'upload_file', 'download_file', 'console_logs', 'network_log', 'dialogs']) {
    assert.ok(!chat.catalog().some((entry) => entry.name === tool), tool);
    assert.equal((await chat.call(tool)).success, false, tool);
  }
  const batch = jsonOf(await chat.call('batch', { mode: 'serial', ops: [
    { tool: 'eval', args: { expression: 'document.title' } }, { tool: 'storage', args: { op: 'set', key: 'x', value: 'y' } },
  ] }));
  assert.ok(batch.results.every((result: any) => result.status === 'error'));
  policy.allowDomains.length = 0;
  assert.equal((await chat.call('get_text')).success, false, 'site revocation remains enforced');
  chat.close();
  setToolAllowlist(['tabs_list', 'batch']);
  const limited = adapter(f.pairing, f.phone.id, policy); t.after(limited.close);
  assert.equal((await limited.call('tabs_list')).success, true);
  assert.deepEqual(limited.catalog().map((tool) => tool.name).sort(), ['batch', 'tabs_list']);
  assert.equal((await limited.call('get_text')).success, false);
  const escaped = jsonOf(await limited.call('batch', { ops: [{ tool: 'get_text', args: { tabId: '1' } }] }));
  assert.ok(escaped.results[0].status === 'error');
});

test('page checkpoints stay private to each phone and the desktop even with known IDs or batch calls', async (t) => {
  const f = fixture(t), other = f.pair();
  setActiveWorkspace(ensureWorkspace(f.dir, 'personal', 'default'));
  const owner = await dispatchToolCall('page_watch', { action: 'create', name: 'Desktop checkpoint' });
  const ownerId = JSON.parse((owner.content[0] as any).text).watchId; assert.ok(ownerId);
  const first = adapter(f.pairing, f.phone.id, f.policy), second = adapter(f.pairing, other.id, f.policy);
  t.after(first.close); t.after(second.close);
  const firstId = jsonOf(await first.call('page_watch', { action: 'create', name: 'First phone' })).watchId;
  const secondId = jsonOf(await second.call('page_watch', { action: 'create', name: 'Second phone' })).watchId;
  for (const [chat, ownId, foreignId] of [[first, firstId, secondId], [second, secondId, firstId]] as const) {
    assert.deepEqual(jsonOf(await chat.call('page_watch', { action: 'list' })).watches.map((w: any) => w.id), [ownId]);
    for (const watchId of [ownerId, foreignId]) {
      assert.equal((await chat.call('page_watch', { action: 'compare', watchId })).success, false);
      await chat.call('batch', { mode: 'serial', ops: [{ tool: 'page_watch', args: { action: 'delete', watchId } }] });
    }
  }
  assert.equal((await first.call('page_watch', { action: 'compare', watchId: firstId })).success, true);
  assert.equal((await second.call('page_watch', { action: 'compare', watchId: secondId })).success, true);
  assert.equal((await dispatchToolCall('page_watch', { action: 'compare', watchId: ownerId })).isError, undefined);
  assert.equal((await dispatchToolCall('page_watch', { action: 'compare', watchId: firstId })).isError, true);
  // Direct phone MCP calls use exactly the same isolation as chat.
  const listed = await withClientIdentity(f.pairing.identity(f.phone.id), () => dispatchToolCall('page_watch', { action: 'list' }));
  assert.deepEqual(JSON.parse((listed.content[0] as any).text).watches.map((w: any) => w.id), [firstId]);
});
