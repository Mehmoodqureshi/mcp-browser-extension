/**
 * Observers, files, batch and status: what the agent learns about a page
 * (console, network, dialogs), what it carries away from it (downloads into
 * the task workspace), how it fans calls out (batch), and how it reports on
 * itself (chrome_status, proxy_status, tasks and profiles).
 *
 * The harness installs no task workspace and no profile bridge (the CLI boot
 * path does both), so this file installs them itself, the way cli.ts does,
 * and removes them again afterwards.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

import { RUN_E2E, startHarness, textOf, type Harness } from './harness';
import { ensureWorkspace } from '../../src/bridge/datadir';
import { resetActiveWorkspaceForTesting, setActiveWorkspace } from '../../src/bridge/workspace';
import { setProfileBridge } from '../../src/mcp/tools';

let h: Harness;
let dialogServer: Server;
let dialogBase = '';
const skip = !RUN_E2E;

/** A page whose buttons raise each native dialog and write the page's view of the answer into #out. */
const DIALOG_PAGE = `<!doctype html><title>Dialogs</title>
  <button id="c" onclick="document.getElementById('out').textContent = 'C:' + confirm('E2E-CONFIRM?')">confirm</button>
  <button id="p" onclick="document.getElementById('out').textContent = 'P:' + prompt('E2E-PROMPT?', 'fallback')">prompt</button>
  <button id="a" onclick="alert('E2E-ALERT'); document.getElementById('out').textContent = 'A:returned'">alert</button>
  <div id="out"></div>`;

interface ObsEntry {
  seq: number;
  level?: string;
  text?: string;
  url?: string;
  status?: number;
  kind?: string;
  message?: string;
  answered?: string;
}
interface ObsResult {
  entries: ObsEntry[];
  count: number;
  policy?: string;
}
interface BatchHeader {
  batch: { mode: string; total: number; ok: number; error: number; skipped: number; omittedOps?: number };
  results: { index: number; tool: string; status: string }[];
}
interface WorkspaceView {
  profile: string;
  task: string;
  taskDir: string;
  downloadDir: string;
  resultsDir: string;
  screenshotsDir: string;
  historyPath: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll an observer tool until `pred` holds (the hook records asynchronously). */
async function pollObs(tool: string, args: Record<string, unknown>, pred: (r: ObsResult) => boolean): Promise<ObsResult> {
  const end = Date.now() + 8_000;
  let r = await h.json<ObsResult>(tool, args);
  while (!pred(r) && Date.now() < end) {
    await sleep(200);
    r = await h.json<ObsResult>(tool, args);
  }
  return r;
}

const header = (r: { content: { type: string }[] }): BatchHeader => {
  const first = r.content[0] as { type: string; text?: string };
  return JSON.parse(first.text ?? 'null') as BatchHeader;
};

const outText = async (tabId: string): Promise<string> =>
  (await h.json<{ text: string }>('get_text', { tabId, selector: '#out' })).text.trim();

before(async () => {
  if (skip) return;
  h = await startHarness();
  setActiveWorkspace(ensureWorkspace(h.dataDir, 'default', 'default'));
  setProfileBridge(h.bridge);
  dialogServer = createServer((req, res) => {
    if ((req.url ?? '/').split('?')[0] === '/dialogs') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(DIALOG_PAGE);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  await new Promise<void>((r) => dialogServer.listen(0, '127.0.0.1', r));
  const addr = dialogServer.address();
  dialogBase = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
after(async () => {
  setProfileBridge(null);
  resetActiveWorkspaceForTesting();
  dialogServer?.close();
  await h?.close();
});

// ---------------------------------------------------------------------------
// console_logs / network_log
// ---------------------------------------------------------------------------

test('console_logs records log and error levels, pages with sinceSeq, and drains with clear', { skip }, async () => {
  const tab = await h.open('/console');
  const all = await pollObs('console_logs', { tabId: tab }, (r) => r.entries.some((e) => e.text === 'E2E-ERR'));
  const log = all.entries.find((e) => e.text === 'E2E-LOG');
  const err = all.entries.find((e) => e.text === 'E2E-ERR');
  assert.ok(log, `E2E-LOG recorded: ${JSON.stringify(all.entries)}`);
  assert.ok(err, 'E2E-ERR recorded');
  assert.equal(log.level, 'log');
  assert.equal(err.level, 'error');
  assert.ok(err.seq > log.seq, 'seq is monotonic in call order');

  const onlyErrors = await h.json<ObsResult>('console_logs', { tabId: tab, level: 'error' });
  assert.ok(onlyErrors.entries.length >= 1);
  assert.ok(onlyErrors.entries.every((e) => e.level === 'error'), 'the level filter keeps only errors');
  assert.ok(!onlyErrors.entries.some((e) => e.text === 'E2E-LOG'));

  const newer = await h.json<ObsResult>('console_logs', { tabId: tab, sinceSeq: log.seq });
  assert.ok(newer.entries.every((e) => e.seq > log.seq), 'sinceSeq returns only newer entries');
  assert.ok(newer.entries.some((e) => e.text === 'E2E-ERR'));
  assert.ok(!newer.entries.some((e) => e.text === 'E2E-LOG'));

  const limited = await h.json<ObsResult>('console_logs', { tabId: tab, limit: 1 });
  assert.equal(limited.entries.length, 1, 'limit caps the count');

  // Entries logged after a read show up when polling past the last seq.
  const lastSeq = Math.max(...all.entries.map((e) => e.seq));
  await h.json('eval', { tabId: tab, expression: "console.warn('E2E-LATER'); 1" });
  const later = await pollObs('console_logs', { tabId: tab, sinceSeq: lastSeq }, (r) => r.entries.some((e) => e.text === 'E2E-LATER'));
  const warn = later.entries.find((e) => e.text === 'E2E-LATER');
  assert.ok(warn, 'a later console.warn is picked up by sinceSeq polling');
  assert.equal(warn.level, 'warn');

  const drained = await h.json<ObsResult>('console_logs', { tabId: tab, clear: true });
  assert.ok(drained.count >= 3, 'clear still returns what it drained');
  const empty = await h.json<ObsResult>('console_logs', { tabId: tab });
  assert.equal(empty.count, 0, 'the buffer is empty after clear');
  await h.json('tab_close', { tabId: tab });
});

test('network_log records the failing fetch with its 404 status', { skip }, async () => {
  const tab = await h.open('/console');
  const r = await pollObs('network_log', { tabId: tab }, (x) => x.entries.some((e) => !!e.url?.includes('/missing-resource') && e.status !== undefined));
  const miss = r.entries.find((e) => e.url?.includes('/missing-resource'));
  assert.ok(miss, `the fetch is recorded: ${JSON.stringify(r.entries)}`);
  assert.equal(miss.status, 404);
  assert.equal(miss.url, `${h.base}/missing-resource`);

  const failed = await h.json<ObsResult>('network_log', { tabId: tab, failedOnly: true });
  assert.ok(failed.entries.some((e) => e.url?.includes('/missing-resource')), 'failedOnly keeps the 404');
  const filtered = await h.json<ObsResult>('network_log', { tabId: tab, urlContains: 'no-such-substring' });
  assert.equal(filtered.count, 0, 'urlContains filters out everything else');

  await h.json('network_log', { tabId: tab, clear: true });
  const after = await h.json<ObsResult>('network_log', { tabId: tab });
  assert.equal(after.count, 0, 'clear drains the network buffer');
  await h.json('tab_close', { tabId: tab });
});

// ---------------------------------------------------------------------------
// dialogs
// ---------------------------------------------------------------------------

test('dialogs are intercepted and recorded; policy and promptText decide what the page sees', { skip, timeout: 60_000 }, async () => {
  const { tabId: tab } = await h.json<{ tabId: string }>('tab_new', { url: `${dialogBase}/dialogs` });

  // Default policy is dismiss: confirm -> false, prompt -> null, alert does not block.
  const initial = await h.json<ObsResult>('dialogs', { tabId: tab });
  assert.equal(initial.policy, 'dismiss');
  assert.equal(initial.count, 0);

  await h.json('click', { tabId: tab, selector: '#c' });
  assert.equal(await outText(tab), 'C:false', 'dismiss answers confirm() with false');
  await h.json('click', { tabId: tab, selector: '#p' });
  assert.equal(await outText(tab), 'P:null', 'dismiss answers prompt() with null');
  await h.json('click', { tabId: tab, selector: '#a' });
  assert.equal(await outText(tab), 'A:returned', 'alert() returns instead of blocking the renderer');

  const seen = await h.json<ObsResult>('dialogs', { tabId: tab });
  assert.deepEqual(
    seen.entries.map((e) => [e.kind, e.message, e.answered]),
    [
      ['confirm', 'E2E-CONFIRM?', 'false'],
      ['prompt', 'E2E-PROMPT?', 'null'],
      ['alert', 'E2E-ALERT', 'dismissed'],
    ],
  );

  // Switch to accept with a prompt answer.
  const set = await h.json<ObsResult>('dialogs', { tabId: tab, policy: 'accept', promptText: 'E2E-ANSWER', clear: true });
  assert.equal(set.policy, 'accept');
  await h.json('click', { tabId: tab, selector: '#c' });
  assert.equal(await outText(tab), 'C:true', 'accept answers confirm() with true');
  await h.json('click', { tabId: tab, selector: '#p' });
  assert.equal(await outText(tab), 'P:E2E-ANSWER', 'promptText answers prompt()');

  const accepted = await h.json<ObsResult>('dialogs', { tabId: tab });
  assert.equal(accepted.policy, 'accept');
  assert.deepEqual(
    accepted.entries.map((e) => [e.kind, e.answered]),
    [
      ['confirm', 'true'],
      ['prompt', 'E2E-ANSWER'],
    ],
    'clear dropped the earlier dismiss-era records',
  );

  // Back to dismiss.
  await h.json('dialogs', { tabId: tab, policy: 'dismiss' });
  await h.json('click', { tabId: tab, selector: '#c' });
  assert.equal(await outText(tab), 'C:false');

  const bad = await h.call('dialogs', { tabId: tab, policy: 'maybe' });
  assert.equal(bad.isError, true);
  assert.match(textOf(bad), /"policy" must be "dismiss" or "accept"/);
  await h.json('tab_close', { tabId: tab });
});

// ---------------------------------------------------------------------------
// download_file
// ---------------------------------------------------------------------------

test('download_file by URL lands the file in the active task downloads dir', { skip, timeout: 60_000 }, async () => {
  const ws = await h.json<WorkspaceView>('task_new', { name: 'e2e-download' });
  const res = await h.json<{ path: string; bytes: number }>('download_file', { url: `${h.base}/file.txt`, suggestedName: 'e2e-file.txt' });
  assert.equal(dirname(res.path), ws.downloadDir, `saved into the task's downloads/: ${res.path}`);
  assert.equal(res.path, join(ws.downloadDir, 'e2e-file.txt'));
  assert.equal(readFileSync(res.path, 'utf8'), 'E2E-DOWNLOAD-BODY');
  assert.equal(res.bytes, 'E2E-DOWNLOAD-BODY'.length);

  const listed = await h.json<{ task: string; downloads: number }[]>('tasks_list');
  const mine = listed.find((t) => t.task === 'e2e-download');
  assert.ok(mine, 'tasks_list includes the new task');
  assert.equal(mine.downloads, 1, 'tasks_list counts the download');

  const none = await h.call('download_file', {});
  assert.equal(none.isError, true);
  assert.match(textOf(none), /provide "url" or a target/);
});

test(
  'download_file from a link element (selector) downloads the linked file',
  { skip, timeout: 60_000 },
  async () => {
    const ws = await h.json<WorkspaceView>('task_new', { name: 'e2e-download-link' });
    const tab = await h.open('/download');
    const res = await h.call('download_file', { tabId: tab, selector: '#dl', suggestedName: 'from-link.txt' });
    try {
      assert.equal(res.isError, undefined, textOf(res));
      const out = JSON.parse(textOf(res)) as { path: string };
      assert.equal(dirname(out.path), ws.downloadDir);
      assert.equal(readFileSync(out.path, 'utf8'), 'E2E-DOWNLOAD-BODY');
    } finally {
      await h.call('tab_close', { tabId: tab });
    }
  },
);

// ---------------------------------------------------------------------------
// batch
// ---------------------------------------------------------------------------

test('batch serial runs ops in order and reports a per-op result', { skip }, async () => {
  const tab = await h.open('/');
  const r = await h.call('batch', {
    mode: 'serial',
    ops: [
      { tool: 'tab_select', args: { tabId: tab } },
      { tool: 'get_text', args: { selector: '#title' } }, // no tabId: serial may use the selected tab
      { tool: 'navigate', args: { url: `${h.base}/links` } },
      { tool: 'eval', args: { expression: 'document.title' } },
    ],
  });
  assert.equal(r.isError, undefined, textOf(r));
  const hd = header(r);
  assert.deepEqual(hd.batch, { mode: 'serial', total: 4, ok: 4, error: 0, skipped: 0 });
  assert.deepEqual(hd.results.map((x) => [x.index, x.tool, x.status]), [
    [0, 'tab_select', 'ok'],
    [1, 'get_text', 'ok'],
    [2, 'navigate', 'ok'],
    [3, 'eval', 'ok'],
  ]);
  const body = textOf(r);
  assert.match(body, /--- op 1 \(get_text\) ok ---/);
  assert.match(body, /E2E-HOME/, 'op 1 read the home page');
  assert.match(body, /Links/, 'op 3 ran after the navigate in op 2');
  await h.json('tab_close', { tabId: tab });
});

test('batch parallel runs tab-scoped ops with tabId and rejects them without one', { skip }, async () => {
  const a = await h.open('/');
  const b = await h.open('/markdown');
  const r = await h.call('batch', {
    ops: [
      { tool: 'get_text', args: { tabId: a, selector: '#title' } },
      { tool: 'get_text', args: { tabId: b, selector: 'h1' } },
      { tool: 'get_text', args: {} },
      { tool: 'tabs_list' },
    ],
  });
  assert.equal(r.isError, undefined, 'partial success is success');
  const hd = header(r);
  assert.equal(hd.batch.mode, 'parallel');
  assert.deepEqual(hd.results.map((x) => x.status), ['ok', 'ok', 'error', 'ok']);
  const body = textOf(r);
  assert.match(body, /E2E-HOME/);
  assert.match(body, /Heading One/);
  assert.match(body, /"get_text" needs an explicit "tabId" in a parallel batch/);
  await h.json('tab_close', { tabId: a });
  await h.json('tab_close', { tabId: b });
});

test('batch stopOnError skips the rest; nested batch is refused per op', { skip }, async () => {
  const tab = await h.open('/');
  const r = await h.call('batch', {
    mode: 'serial',
    stopOnError: true,
    ops: [
      { tool: 'get_text', args: { tabId: tab, selector: '#title' } },
      { tool: 'no_such_tool' },
      { tool: 'get_text', args: { tabId: tab } },
    ],
  });
  const hd = header(r);
  assert.deepEqual(hd.batch, { mode: 'serial', total: 3, ok: 1, error: 1, skipped: 1 });
  assert.deepEqual(hd.results.map((x) => x.status), ['ok', 'error', 'skipped']);
  assert.match(textOf(r), /unknown tool: no_such_tool/);
  assert.doesNotMatch(textOf(r), /--- op 2/, 'a skipped op carries no payload');

  // Without stopOnError the failing op does not stop the run.
  const cont = await h.call('batch', {
    mode: 'serial',
    ops: [{ tool: 'no_such_tool' }, { tool: 'get_text', args: { tabId: tab, selector: '#title' } }],
  });
  assert.deepEqual(header(cont).results.map((x) => x.status), ['error', 'ok']);

  const nested = await h.call('batch', { ops: [{ tool: 'batch', args: { ops: [{ tool: 'tabs_list' }] } }] });
  assert.equal(nested.isError, true, 'a batch where nothing succeeded is an error');
  assert.deepEqual(header(nested).results.map((x) => x.status), ['error']);
  assert.match(textOf(nested), /batch cannot be nested inside batch/);
  await h.json('tab_close', { tabId: tab });
});

test('batch validates its envelope and maxResultBytes, and elides past the budget', { skip }, async () => {
  const tooSmall = await h.call('batch', { ops: [{ tool: 'tabs_list' }], maxResultBytes: 100 });
  assert.equal(tooSmall.isError, true);
  assert.match(textOf(tooSmall), /"maxResultBytes" must be >= 4096/);
  const tooBig = await h.call('batch', { ops: [{ tool: 'tabs_list' }], maxResultBytes: 64 * 1024 * 1024 });
  assert.equal(tooBig.isError, true);
  assert.match(textOf(tooBig), /"maxResultBytes" must be <= 33554432/);
  const notNum = await h.call('batch', { ops: [{ tool: 'tabs_list' }], maxResultBytes: 'lots' });
  assert.match(textOf(notNum), /"maxResultBytes" must be a finite number/);

  const empty = await h.call('batch', { ops: [] });
  assert.equal(empty.isError, true);
  assert.match(textOf(empty), /at least one operation/);
  const badMode = await h.call('batch', { ops: [{ tool: 'tabs_list' }], mode: 'sideways' });
  assert.match(textOf(badMode), /"mode" must be "parallel" or "serial"/);

  // Two ~6 KB results against a 4 KB budget: the first always gets through,
  // the second is replaced by a one-line summary.
  const tab = await h.open('/');
  const big = { tool: 'eval', args: { tabId: tab, expression: "'x'.repeat(6000)" } };
  const r = await h.call('batch', { mode: 'serial', ops: [big, big], maxResultBytes: 4096 });
  const hd = header(r);
  assert.equal(hd.batch.ok, 2);
  assert.equal(hd.batch.omittedOps, 1);
  assert.match(textOf(r), /--- op 1 \(eval\) omitted: .*batch result budget reached/);
  await h.json('tab_close', { tabId: tab });
});

// ---------------------------------------------------------------------------
// status, proxy, tasks and profiles
// ---------------------------------------------------------------------------

test('chrome_status reports the paired profile, extension version and capabilities', { skip }, async () => {
  const s = await h.json<{
    ready: boolean;
    backend: string;
    activeProfile: string;
    connectedProfiles: string[];
    profiles: { name: string; extVersion?: string }[];
    extension?: { version?: string; source?: string };
    pairState: string;
    disabledCapabilities?: unknown[];
  }>('chrome_status');
  const manifest = JSON.parse(readFileSync(join(process.cwd(), 'extension-dist', 'manifest.json'), 'utf8')) as { version: string };
  assert.equal(s.ready, true);
  assert.equal(s.backend, 'extension');
  assert.equal(s.activeProfile, 'default');
  assert.ok(s.connectedProfiles.includes('default'), JSON.stringify(s.connectedProfiles));
  const paired = s.profiles.find((p) => p.name === 'default');
  assert.ok(paired, `the harness browser pairs as "default": ${JSON.stringify(s.profiles)}`);
  assert.equal(paired.extVersion, manifest.version);
  assert.equal(s.extension?.version, manifest.version, 'reports the loaded extension build version');
  assert.equal(s.pairState, 'ok');
  assert.equal(s.disabledCapabilities, undefined, 'every capability is on, so none is reported as switched off');
});

test('proxy_status answers with a structured result', { skip, timeout: 60_000 }, async () => {
  const r = await h.call('proxy_status');
  assert.equal(r.isError, undefined, textOf(r));
  const s = JSON.parse(textOf(r)) as { enabled: boolean; hint?: string };
  assert.equal(typeof s.enabled, 'boolean');
  assert.equal(s.enabled, false, 'a fresh profile has no proxy');
  assert.match(String(s.hint), /no proxy in this profile/);
});

test('task_new, task_status and tasks_list agree on paths under the data dir', { skip }, async () => {
  const made = await h.json<WorkspaceView>('task_new', { name: 'e2e task/../x' });
  assert.equal(made.profile, 'default');
  assert.doesNotMatch(made.task, /[/\\]/, 'the task name is sanitized to one path segment');
  assert.notEqual(made.task, '..');
  const root = resolve(h.dataDir) + sep;
  for (const p of [made.taskDir, made.downloadDir, made.resultsDir, made.screenshotsDir]) {
    assert.ok(resolve(p).startsWith(root), `${p} is under the data dir`);
    assert.ok(existsSync(p) && statSync(p).isDirectory(), `${p} exists`);
  }
  assert.equal(made.taskDir, join(h.dataDir, 'profiles', 'default', 'tasks', made.task));

  const status = await h.json<WorkspaceView>('task_status');
  assert.deepEqual(status, made, 'task_status reports the task just made active');

  const listed = await h.json<{ profile: string; task: string; dir: string }[]>('tasks_list');
  const row = listed.find((t) => t.task === made.task);
  assert.ok(row, 'tasks_list includes it');
  assert.equal(row.profile, 'default');
  assert.equal(row.dir, made.taskDir);

  const bad = await h.call('task_new', {});
  assert.equal(bad.isError, true);
});

test('profile_use to a profile with no browser fails clearly; switching back to default works', { skip }, async () => {
  const tab = await h.open('/');
  const ghost = await h.json<WorkspaceView>('profile_use', { name: 'ghost' });
  assert.equal(ghost.profile, 'ghost');
  assert.equal(ghost.task, 'default', 'a profile switch resets the task');
  assert.ok(existsSync(ghost.taskDir), 'the workspace exists even without a browser');

  const r = await h.call('get_text', { tabId: tab });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /NO_BACKEND|EXTENSION_DISCONNECTED/);
  assert.match(textOf(r), /No browser is paired for profile "ghost"/);

  const s = await h.json<{ ready: boolean; activeProfile: string; pairState: string }>('chrome_status');
  assert.equal(s.ready, false);
  assert.equal(s.activeProfile, 'ghost');
  assert.notEqual(s.pairState, 'ok');

  // Workspace tools still work without a browser.
  assert.equal((await h.json<WorkspaceView>('task_status')).profile, 'ghost');

  const back = await h.json<WorkspaceView>('profile_use', { name: 'default' });
  assert.equal(back.profile, 'default');
  const text = await h.json<{ text: string }>('get_text', { tabId: tab });
  assert.match(text.text, /E2E-HOME/, 'the default browser answers again');
  assert.equal((await h.json<{ ready: boolean }>('chrome_status')).ready, true);
  await h.json('tab_close', { tabId: tab });
});
