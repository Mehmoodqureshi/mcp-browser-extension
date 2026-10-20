/**
 * The safety guarantees, proven end to end against the real extension: the
 * server gate refuses what the policy forbids, the extension's own mirror of
 * that gate refuses it too when the server is bypassed (commands sent straight
 * down the bridge), and a refused call leaves nothing behind on the page.
 *
 * Each describe starts its own harness with its own policy, one at a time.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { RUN_E2E, startHarness, textOf, type Harness } from './harness';
import type { Policy } from '../../src/security/policy';

const skip = !RUN_E2E;

// ---------------------------------------------------------------------------
// A second page server: hosts other than 127.0.0.1, redirects, and a request log
// so a test can prove a refused navigation never reached the network.
// ---------------------------------------------------------------------------

const EXTRA: Record<string, string> = {
  '/secret': `<!doctype html><title>SECRET-TITLE</title><p id="s">SECRET-BODY</p>`,
  '/form': `<!doctype html><title>Form</title><input id="name" name="name">
    <button id="btn" onclick="this.textContent='CLICKED'">press</button>
    <select id="color"><option value="red">Red</option><option value="blue">Blue</option></select>`,
  '/upload': `<!doctype html><title>Upload</title><input id="file" type="file" onchange="document.getElementById('picked').textContent = this.files[0] ? this.files[0].name + ':' + this.files[0].size : ''"><div id="picked"></div>`,
  '/console': `<!doctype html><title>Console</title><script>console.log('E2E-LOG');</script>`,
  '/download': `<!doctype html><title>Download</title><a id="dl" href="/file.txt" download="file.txt">get</a>`,
};

interface Extra {
  port: number;
  /** http://127.0.0.1:<port> (allowlisted by the default harness). */
  allowed: string;
  /** http://localhost:<port> (same server, a host that is NOT allowlisted). */
  other: string;
  /** Every request seen, as "host path". */
  log: string[];
  close(): void;
}

async function startExtra(): Promise<Extra> {
  const log: string[] = [];
  let port = 0;
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0];
    log.push(`${req.headers.host ?? ''} ${path}`);
    if (path === '/redir') {
      res.writeHead(302, { location: `http://localhost:${port}/secret` });
      res.end();
      return;
    }
    if (path === '/file.txt') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="file.txt"' });
      res.end('E2E-DOWNLOAD-BODY');
      return;
    }
    const html = EXTRA[path];
    if (!html) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    port,
    allowed: `http://127.0.0.1:${port}`,
    other: `http://localhost:${port}`,
    log,
    close: () => server.close(),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Assert a tool call was refused by the policy. */
function assertDenied(r: CallToolResult, why?: RegExp): void {
  assert.equal(r.isError, true, `expected a refusal, got: ${textOf(r).slice(0, 300)}`);
  assert.match(textOf(r), /POLICY_DENIED/);
  if (why) assert.match(textOf(r), why);
}

/** Send a command straight to the extension, skipping the server gate entirely. */
async function direct(
  h: Harness,
  method: string,
  params: Record<string, unknown>,
  tabId?: string,
): Promise<{ ok: true; data: unknown } | { ok: false; code: string; message: string }> {
  try {
    const data = await h.bridge.sendCommand(method as never, params, { tabId, timeoutMs: 15_000 });
    return { ok: true, data };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { ok: false, code: String(e.code ?? ''), message: String(e.message ?? err) };
  }
}

/** Open a tab with Playwright (no tool call, so no gate) and return its tool handle. */
async function openRaw(h: Harness, url: string): Promise<{ tabId: string; page: import('playwright').Page }> {
  const page = await h.ctx.newPage();
  await page.goto(url);
  const tabs = await h.json<Array<{ tabId: string; url: string }>>('tabs_list');
  const hit = tabs.find((t) => t.url === url || t.url === url + '/' || t.url.startsWith(url));
  assert.ok(hit, `tab for ${url} is listed`);
  return { tabId: hit.tabId, page };
}

/** The Chrome URLs of every open tab, read in the service worker. */
const tabUrls = (h: Harness): Promise<string[]> =>
  h.inSw(async () => {
    type Tabs = { tabs: { query(q: object): Promise<{ url?: string; pendingUrl?: string }[]> } };
    const c = (globalThis as unknown as { chrome: Tabs }).chrome;
    return (await c.tabs.query({})).map((t) => t.pendingUrl || t.url || '');
  });

/** Requests seen since `from`, ignoring the favicon Chrome fetches on its own schedule. */
const requests = (x: Extra, from: number): string[] => x.log.slice(from).filter((l) => !l.endsWith(' /favicon.ico'));

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 1. Deny-all domains
// ---------------------------------------------------------------------------

describe('deny-all domains (allowDomains: [])', () => {
  let h: Harness;
  let x: Extra;
  before(async () => {
    if (skip) return;
    x = await startExtra();
    h = await startHarness({ allowDomains: [] });
  });
  after(async () => {
    await h?.close();
    x?.close();
  });

  test('navigate is refused with a helpful message and the page is never requested', { skip }, async () => {
    const before = x.log.length;
    const r = await h.call('navigate', { url: `${x.allowed}/secret` });
    assertDenied(r, /Please allow access to/i);
    assert.match(textOf(r), /127\.0\.0\.1/, 'names the refused host');
    assert.match(textOf(r), /MCP Browser Extension icon → Allow next to/, 'shows the one-line approval steps');
    assert.doesNotMatch(textOf(r), /--unsafe-all-domains|[\r\n]/);
    await sleep(300);
    assert.deepEqual(requests(x, before), [], 'no request reached the page server');
    assert.ok(!(await tabUrls(h)).some((u) => u.includes('/secret')), 'no tab is on the page');
  });

  test('get_text on a tab already on a page is refused and returns none of its content', { skip }, async () => {
    const { tabId, page } = await openRaw(h, `${x.allowed}/secret`);
    for (const tool of ['get_text', 'get_html', 'snapshot', 'read_as_markdown', 'screenshot']) {
      const r = await h.call(tool, { tabId });
    assertDenied(r, /Please allow access to/i);
      assert.doesNotMatch(textOf(r), /SECRET-BODY/, `${tool} leaks nothing`);
    }
    await page.close();
  });

  test('the extension refuses the same read on its own when the server is bypassed', { skip }, async () => {
    const { tabId, page } = await openRaw(h, `${x.allowed}/secret`);
    const r = await direct(h, 'get_text', {}, tabId);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, 'POLICY_DENIED');
      assert.doesNotMatch(r.message, /SECRET-BODY/);
    }
    const before = x.log.length;
    const nav = await direct(h, 'navigate', { url: `${x.allowed}/form` }, tabId);
    assert.equal(nav.ok, false);
    if (!nav.ok) assert.equal(nav.code, 'POLICY_DENIED');
    await sleep(300);
    assert.deepEqual(requests(x, before), [], 'the extension did not load the page');
    assert.match(page.url(), /\/secret$/, 'the tab stayed where it was');
    await page.close();
  });
});

// ---------------------------------------------------------------------------
// 2. Non-allowlisted hosts, redirects, uploads (default harness: 127.0.0.1 only)
// ---------------------------------------------------------------------------

describe('a host that is not allowlisted (localhost vs 127.0.0.1)', () => {
  let h: Harness;
  let x: Extra;
  let outside: string;
  before(async () => {
    if (skip) return;
    x = await startExtra();
    h = await startHarness();
    outside = mkdtempSync(join(tmpdir(), 'mbe-e2e-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE-SECRET');
  });
  after(async () => {
    await h?.close();
    x?.close();
    if (outside) rmSync(outside, { recursive: true, force: true });
  });

  test('navigate to localhost or example.org is refused and never loads', { skip }, async () => {
    const tab = await h.open('/');
    const before = x.log.length;
    const r = await h.call('navigate', { url: `${x.other}/secret`, tabId: tab });
    assertDenied(r, /localhost/);
    assert.match(textOf(r), /Allow next to localhost/);
    assertDenied(await h.call('navigate', { url: 'https://example.org/', tabId: tab }), /example\.org/);
    // No tab id given: the gate refuses before an agent tab is even opened.
    assertDenied(await h.call('navigate', { url: `${x.other}/secret` }), /localhost/);
    await sleep(300);
    assert.deepEqual(requests(x, before), [], 'nothing was requested from the refused host');
    assert.ok(!(await tabUrls(h)).some((u) => u.startsWith(x.other)), 'no tab is on localhost');
    const text = await h.json<{ text: string }>('get_text', { tabId: tab });
    assert.match(text.text, /E2E-HOME/, 'the agent tab is still on the allowed page');
    await h.call('tab_close', { tabId: tab });
  });

  test('reads and actions on a tab already on localhost are refused', { skip }, async () => {
    const { tabId, page } = await openRaw(h, `${x.other}/form`);
    for (const tool of ['get_text', 'get_html', 'snapshot', 'read_as_markdown', 'screenshot', 'extract_links', 'get_cookies', 'frames_list']) {
      const r = await h.call(tool, { tabId });
      assertDenied(r, /localhost/);
    }
    assertDenied(await h.call('eval', { tabId, expression: 'document.title = "PWNED"' }));
    assertDenied(await h.call('type', { tabId, selector: '#name', text: 'leak' }));
    assertDenied(await h.call('click', { tabId, selector: '#btn' }));
    assert.equal(await page.inputValue('#name'), '', 'the refused type wrote nothing');
    assert.equal(await page.textContent('#btn'), 'press', 'the refused click did nothing');
    assert.equal(await page.title(), 'Form', 'the refused eval did not run');
    await page.close();
  });

  test('the extension refuses reads and navigation on localhost when the server is bypassed', { skip }, async () => {
    const { tabId, page } = await openRaw(h, `${x.other}/secret`);
    for (const method of ['get_text', 'get_html', 'screenshot', 'frames_list', 'print_pdf', 'eval']) {
      const r = await direct(h, method, method === 'eval' ? { expression: 'document.body.innerText' } : {}, tabId);
      assert.equal(r.ok, false, `${method} must be refused by the extension`);
      if (!r.ok) {
        assert.equal(r.code, 'POLICY_DENIED', `${method}: ${r.message}`);
        assert.doesNotMatch(r.message, /SECRET-BODY/);
      }
    }
    const typed = await direct(h, 'type', { selector: '#s', text: 'x' }, tabId);
    assert.equal(typed.ok, false);

    // A navigate from an allowed tab to the refused host, sent straight down.
    const mine = await h.open('/');
    const before = x.log.length;
    const nav = await direct(h, 'navigate', { url: `${x.other}/secret` }, mine);
    assert.equal(nav.ok, false);
    if (!nav.ok) assert.equal(nav.code, 'POLICY_DENIED');
    await sleep(300);
    assert.deepEqual(requests(x, before), [], 'the extension never requested the refused page');
    await page.close();
    await h.call('tab_close', { tabId: mine });
  });

  test(
    'get_cookies on an allowed tab cannot read the cookies of a host that is not allowlisted',
    { skip: skip || undefined },
    async () => {
      await h.ctx.addCookies([{ name: 'sess', value: 'LOCALHOST-SECRET', domain: 'localhost', path: '/', httpOnly: true }]);
      const tab = await h.open('/');
      const r = await h.call('get_cookies', { tabId: tab, url: `${x.other}/` });
      await h.call('tab_close', { tabId: tab });
      assert.doesNotMatch(textOf(r), /LOCALHOST-SECRET/, 'a cookie of a non-allowlisted host reached the agent');
      assertDenied(r, /localhost/);
    },
  );

  test(
    'the extension gates every content method on a non-allowlisted tab when the server is bypassed',
    { skip: skip || undefined },
    async () => {
      const { tabId, page } = await openRaw(h, `${x.other}/form`);
      const ran: string[] = [];
      for (const [method, params] of [
        ['snapshot', {}],
        ['get_cookies', {}],
        ['storage', { op: 'get' }],
        ['storage', { op: 'set', key: 'planted', value: 'BY-AGENT' }],
        ['select_option', { selector: '#color', values: ['blue'] }],
      ] as Array<[string, Record<string, unknown>]>) {
        const r = await direct(h, method, params, tabId);
        if (r.ok) ran.push(`${method}${params.op ? ':' + String(params.op) : ''}`);
      }
      const planted = await page.evaluate(() => localStorage.getItem('planted'));
      const color = await page.inputValue('#color');
      await page.close();
      assert.deepEqual(ran, [], `the extension ran these on localhost: ${ran.join(', ')}`);
      assert.equal(planted, null, 'storage set wrote to a non-allowlisted page');
      assert.equal(color, 'red', 'select_option changed a non-allowlisted page');
    },
  );

  test('a redirect from an allowed URL to localhost hands back none of its content', { skip }, async () => {
    const tab = await h.open('/');
    const before = x.log.length;
    const nav = await h.call('navigate', { url: `${x.allowed}/redir`, tabId: tab });
    assert.equal(nav.isError, undefined, textOf(nav));
    // Wait until the tab has really landed on the other host.
    const landed = Date.now() + 10_000;
    while (!(await tabUrls(h)).some((u) => u.startsWith(`${x.other}/secret`)) && Date.now() < landed) await sleep(100);
    assert.ok(requests(x, before).includes(`localhost:${x.port} /secret`), 'the redirect was followed by the browser');
    // Whatever navigate itself returns, every follow-up read is gated on where
    // the tab actually landed, not where it was sent.
    for (const tool of ['get_text', 'get_html', 'snapshot', 'read_as_markdown', 'screenshot']) {
      const r = await h.call(tool, { tabId: tab });
      assertDenied(r, /localhost/);
      assert.doesNotMatch(textOf(r), /SECRET-BODY/);
    }
    assertDenied(await h.call('eval', { tabId: tab, expression: 'document.body.innerText' }));
    const r = await direct(h, 'get_text', {}, tab);
    assert.equal(r.ok, false, 'the extension refuses the landed page too');
    assert.doesNotMatch(textOf(nav), /SECRET-BODY/, 'navigate does not return the body');
    await h.call('tab_close', { tabId: tab });
  });

  test(
    'navigate through a redirect does not return the title of the non-allowlisted page it landed on',
    { skip: skip || undefined },
    async () => {
      const tab = await h.open('/');
      await h.json('get_text', { tabId: tab }); // the tab has finished its first load
      const nav = await h.call('navigate', { url: `${x.allowed}/redir`, tabId: tab });
      await h.call('tab_close', { tabId: tab });
      assert.doesNotMatch(textOf(nav), /SECRET-TITLE/, `navigate returned: ${textOf(nav)}`);
    },
  );

  test(
    'tab_new refuses a URL on a host that is not allowlisted',
    { skip: skip || undefined },
    async () => {
      const before = x.log.length;
      const r = await h.call('tab_new', { url: `${x.other}/secret?leak=1` });
      await sleep(300);
      const requested = requests(x, before).some((l) => l.startsWith(`localhost:${x.port} /secret`));
      if (!r.isError) {
        const id = (JSON.parse(textOf(r)) as { tabId?: string }).tabId;
        if (id) await h.call('tab_close', { tabId: id });
      }
      assert.equal(requested, false, 'the non-allowlisted page must not be requested');
      assertDenied(r, /localhost/);
      assert.doesNotMatch(textOf(r), /SECRET-TITLE/);
    },
  );

  test('upload_file accepts a file inside uploadsDir (control)', { skip }, async () => {
    const tab = await h.open('/upload');
    const r = await h.call('upload_file', { tabId: tab, selector: '#file', files: [join(h.uploadsDir, 'hello.txt')] });
    assert.equal(r.isError, undefined, textOf(r));
    const picked = await h.json<{ text: string }>('get_text', { tabId: tab, selector: '#picked' });
    assert.match(picked.text, /hello\.txt:12/);
    await h.call('tab_close', { tabId: tab });
  });

  test('upload_file refuses a path outside uploadsDir, including ../ traversal', { skip }, async () => {
    const tab = await h.open('/upload');
    for (const f of [
      join(outside, 'secret.txt'),
      join(h.uploadsDir, '..', 'secret.txt'),
      `${h.uploadsDir}/../../${outside.split('/').pop()}/secret.txt`,
      `${h.uploadsDir}-evil/secret.txt`,
      '/etc/hosts',
    ]) {
      const r = await h.call('upload_file', { tabId: tab, selector: '#file', files: [f] });
      assert.equal(r.isError, true, `${f} must be refused`);
      assert.match(textOf(r), /outside the allowed uploads dir/);
    }
    // One bad path in a list refuses the whole call.
    const mixed = await h.call('upload_file', {
      tabId: tab,
      selector: '#file',
      files: [join(h.uploadsDir, 'hello.txt'), join(outside, 'secret.txt')],
    });
    assert.equal(mixed.isError, true);
    const picked = await h.json<{ text: string }>('get_text', { tabId: tab, selector: '#picked' });
    assert.equal(picked.text.trim(), '', 'no file reached the page');
    await h.call('tab_close', { tabId: tab });
  });

  test(
    'upload_file refuses a symlink inside uploadsDir that points outside it',
    { skip: skip || undefined },
    async () => {
      const link = join(h.uploadsDir, `link-${process.pid}.txt`);
      symlinkSync(join(outside, 'secret.txt'), link);
      const tab = await h.open('/upload');
      try {
        const r = await h.call('upload_file', { tabId: tab, selector: '#file', files: [link] });
        const picked = await h.json<{ text: string }>('get_text', { tabId: tab, selector: '#picked' });
        assert.equal(picked.text.trim(), '', `the outside file reached the page: ${picked.text}`);
        assert.equal(r.isError, true, 'a symlink escaping uploadsDir must be refused');
      } finally {
        rmSync(link, { force: true });
        await h.call('tab_close', { tabId: tab });
      }
    },
  );
});

// ---------------------------------------------------------------------------
// 3. Safe mode: mutations off
// ---------------------------------------------------------------------------

describe('safe mode (enableMutations: false)', () => {
  let h: Harness;
  let x: Extra;
  before(async () => {
    if (skip) return;
    x = await startExtra();
    h = await startHarness({ enableMutations: false });
  });
  after(async () => {
    await h?.close();
    x?.close();
  });

  test('click, type, navigate and tab_new are refused; get_text still works', { skip }, async () => {
    const { tabId, page } = await openRaw(h, `${x.allowed}/form`);
    const text = await h.json<{ text: string }>('get_text', { tabId });
    assert.match(text.text, /press/, 'reads stay available in safe mode');

    assertDenied(await h.call('type', { tabId, selector: '#name', text: 'Ada' }), /safe-mode/);
    assertDenied(await h.call('click', { tabId, selector: '#btn' }), /safe-mode/);
    assertDenied(await h.call('fill_form', { tabId, fields: { '#name': 'Ada' } }), /safe-mode/);
    assertDenied(await h.call('select_option', { tabId, selector: '#name', values: ['x'] }), /safe-mode/);
    assertDenied(await h.call('press', { tabId, key: 'Enter' }), /safe-mode/);
    assertDenied(await h.call('storage', { tabId, op: 'set', key: 'k', value: 'v' }), /safe-mode/);
    const before = x.log.length;
    assertDenied(await h.call('navigate', { tabId, url: `${x.allowed}/secret` }), /safe-mode/);
    assertDenied(await h.call('reload', { tabId }), /safe-mode/);
    assertDenied(await h.call('tab_new', { url: `${x.allowed}/secret` }), /safe-mode/);
    await sleep(300);

    assert.equal(await page.inputValue('#name'), '', 'the refused type left the field unchanged');
    assert.equal(await page.textContent('#btn'), 'press', 'the refused click did not fire');
    assert.match(page.url(), /\/form$/, 'the refused navigate left the tab where it was');
    assert.deepEqual(requests(x, before), [], 'nothing was requested');
    await page.close();
  });

  test('the extension refuses mutations on its own when the server is bypassed', { skip }, async () => {
    const { tabId, page } = await openRaw(h, `${x.allowed}/form`);
    const ok = await direct(h, 'get_text', {}, tabId);
    assert.equal(ok.ok, true, 'a read goes through the extension gate');
    for (const [method, params] of [
      ['type', { selector: '#name', text: 'Ada' }],
      ['click', { selector: '#btn' }],
      ['navigate', { url: `${x.allowed}/secret` }],
      ['tab_new', { url: `${x.allowed}/secret` }],
    ] as Array<[string, Record<string, unknown>]>) {
      const r = await direct(h, method, params, method === 'tab_new' ? undefined : tabId);
      assert.equal(r.ok, false, `${method} must be refused by the extension`);
      if (!r.ok) assert.equal(r.code, 'POLICY_DENIED', `${method}: ${r.message}`);
    }
    await sleep(300);
    assert.equal(await page.inputValue('#name'), '', 'the field is unchanged');
    assert.equal(await page.textContent('#btn'), 'press', 'the button is unchanged');
    assert.ok(!(await tabUrls(h)).some((u) => u.endsWith('/secret')), 'no tab reached the page');
    await page.close();
  });

  test(
    'the extension refuses select_option and storage writes in safe mode when the server is bypassed',
    { skip: skip || undefined },
    async () => {
      const { tabId, page } = await openRaw(h, `${x.allowed}/form`);
      const sel = await direct(h, 'select_option', { selector: '#color', values: ['blue'] }, tabId);
      const st = await direct(h, 'storage', { op: 'set', key: 'planted', value: 'BY-AGENT' }, tabId);
      const color = await page.inputValue('#color');
      const planted = await page.evaluate(() => localStorage.getItem('planted'));
      await page.close();
      assert.equal(color, 'red', 'select_option changed the page in safe mode');
      assert.equal(planted, null, 'storage set wrote to the page in safe mode');
      assert.equal(sel.ok, false);
      assert.equal(st.ok, false);
    },
  );
});

// ---------------------------------------------------------------------------
// 4. Capabilities off: eval, downloads, uploads, observers
// ---------------------------------------------------------------------------

describe('capabilities switched off', () => {
  let h: Harness;
  let x: Extra;
  before(async () => {
    if (skip) return;
    x = await startExtra();
    h = await startHarness({ allowEval: false, allowDownloads: false, allowUploads: false, allowObservers: false });
  });
  after(async () => {
    await h?.close();
    x?.close();
  });

  test('allowEval false refuses eval and the expression never runs', { skip }, async () => {
    const { tabId, page } = await openRaw(h, `${x.allowed}/form`);
    assertDenied(await h.call('eval', { tabId, expression: 'document.title = "PWNED"' }), /eval is disabled/);
    const r = await direct(h, 'eval', { expression: 'document.title = "PWNED"' }, tabId);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'POLICY_DENIED');
    assert.equal(await page.title(), 'Form');
    await page.close();
  });

  test('allowDownloads false refuses download_file and nothing is fetched', { skip }, async () => {
    const { tabId, page } = await openRaw(h, `${x.allowed}/download`);
    const before = x.log.length;
    assertDenied(await h.call('download_file', { url: `${x.allowed}/file.txt` }), /downloads are disabled/);
    assertDenied(await h.call('download_file', { tabId, selector: '#dl' }), /downloads are disabled/);
    const r = await direct(h, 'download_file', { url: `${x.allowed}/file.txt` });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'POLICY_DENIED');
    await sleep(300);
    assert.ok(!requests(x, before).some((l) => l.endsWith('/file.txt')), 'the file was never requested');
    await page.close();
  });

  test('allowUploads false refuses upload_file, even for a file inside uploadsDir', { skip }, async () => {
    const { tabId, page } = await openRaw(h, `${x.allowed}/upload`);
    const file = join(h.uploadsDir, 'hello.txt');
    assertDenied(await h.call('upload_file', { tabId, selector: '#file', files: [file] }), /uploads are disabled/);
    const r = await direct(h, 'upload_file', { selector: '#file', files: [file] }, tabId);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'POLICY_DENIED');
    assert.equal((await page.textContent('#picked'))?.trim(), '', 'no file reached the page');
    await page.close();
  });

  test('allowObservers false refuses console_logs, network_log and dialogs', { skip }, async () => {
    const { tabId, page } = await openRaw(h, `${x.allowed}/console`);
    for (const tool of ['console_logs', 'network_log', 'dialogs']) {
      const r = await h.call(tool, { tabId });
      assertDenied(r, /observers .* are disabled/);
      assert.doesNotMatch(textOf(r), /E2E-LOG/);
    }
    const r = await direct(h, 'observers', { console: true }, tabId);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'POLICY_DENIED');
    await page.close();
  });
});

describe('uploads on with no uploadsDir', () => {
  let h: Harness;
  before(async () => {
    if (skip) return;
    h = await startHarness({ uploadsDir: undefined } as Partial<Policy>);
  });
  after(async () => {
    await h?.close();
  });

  test('upload_file is refused when no uploadsDir is configured', { skip }, async () => {
    const tab = await h.open('/upload');
    const r = await h.call('upload_file', { tabId: tab, selector: '#file', files: [join(h.uploadsDir, 'hello.txt')] });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /uploads require an --uploads-dir/);
    const picked = await h.json<{ text: string }>('get_text', { tabId: tab, selector: '#picked' });
    assert.equal(picked.text.trim(), '', 'no file reached the page');
    await h.call('tab_close', { tabId: tab });
  });
});

// ---------------------------------------------------------------------------
// 5. The extension's own pages remain protected
// ---------------------------------------------------------------------------

describe("the extension's own pages", () => {
  let h: Harness;
  let extId: string;
  before(async () => {
    if (skip) return;
    h = await startHarness();
    extId = new URL(h.sw.url()).host;
    // Even an explicitly named extension host cannot authorize driving its UI.
    h.policy.allowDomains.push(extId);
  });
  after(async () => {
    await h?.close();
  });

  test('the extension never reads, drives or navigates to its own chrome-extension:// pages', { skip }, async () => {
    const page = await h.ctx.newPage();
    await page.goto(`chrome-extension://${extId}/options.html`);
    const raw = await h.inSw(async () => {
      type Tabs = { tabs: { query(q: object): Promise<{ id?: number; url?: string }[]> } };
      const c = (globalThis as unknown as { chrome: Tabs }).chrome;
      const tabs = await c.tabs.query({});
      return tabs.filter((t) => (t.url ?? '').includes('/options.html')).map((t) => t.id as number);
    });
    assert.ok(raw.length > 0, 'the options page is open');
    const agent = await h.open('/');
    const session = agent.split(':')[1];
    const handle = `ext:${session}:${raw[raw.length - 1]}`;

    // Through the tool layer: refused (the page is not even a listable tab).
    for (const tool of ['get_text', 'get_html', 'screenshot', 'snapshot']) {
      const r = await h.call(tool, { tabId: handle });
      assert.equal(r.isError, true, `${tool} on the options page must fail`);
    }
    assert.equal((await h.call('eval', { tabId: handle, expression: '1' })).isError, true);

    // Straight to the extension: refused by the own-page rule, not the allowlist.
    for (const [method, params] of [
      ['get_text', {}],
      ['get_html', {}],
      ['eval', { expression: 'document.body.innerText' }],
      ['click', { selector: 'button' }],
      ['type', { selector: 'input', text: 'x' }],
      ['screenshot', {}],
    ] as Array<[string, Record<string, unknown>]>) {
      const r = await direct(h, method, params, handle);
      assert.equal(r.ok, false, `${method} must be refused`);
      if (!r.ok) {
        assert.equal(r.code, 'POLICY_DENIED', `${method}: ${r.message}`);
        assert.match(r.message, /never acts on its own pages/);
      }
    }

    // Navigating the agent's tab onto an extension page is refused too.
    const nav = await direct(h, 'navigate', { url: `chrome-extension://${extId}/options.html` }, agent);
    assert.equal(nav.ok, false);
    if (!nav.ok) assert.match(nav.message, /never acts on its own pages/);
    const viaTool = await h.call('navigate', { url: `chrome-extension://${extId}/options.html`, tabId: agent });
    assertDenied(viaTool, /never acts on its own pages/);
    const text = await h.json<{ text: string }>('get_text', { tabId: agent });
    assert.match(text.text, /E2E-HOME/, 'the agent tab never left its page');

    await page.close();
    await h.call('tab_close', { tabId: agent });
  });
});

// ---------------------------------------------------------------------------
// 6. No policy at all: the extension fails closed
// ---------------------------------------------------------------------------

describe('an extension that has received no policy', () => {
  let h: Harness;
  let wss: WebSocketServer | null = null;
  before(async () => {
    if (skip) return;
    h = await startHarness();
  });
  after(async () => {
    wss?.close();
    await h?.close();
  });

  test('refuses every command (except ping_probe) when a welcome carries no policy', { skip, timeout: 60_000 }, async () => {
    const tab = await h.open('/form');

    // A fake server that completes the handshake but sends no policy.
    const replies = new Map<string, { ok: boolean; error?: { code: string; message: string }; data?: unknown }>();
    let peer: WebSocket | null = null;
    wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((r) => wss!.once('listening', () => r()));
    const fakePort = (wss.address() as { port: number }).port;
    const welcomed = new Promise<void>((resolve) => {
      wss!.on('connection', (ws) => {
        ws.on('message', (raw) => {
          const f = JSON.parse(String(raw)) as { type: string; id?: string; ok?: boolean; error?: { code: string; message: string }; data?: unknown };
          if (f.type === 'hello') {
            peer = ws;
            ws.send(JSON.stringify({ type: 'welcome', v: 1, serverVersion: 'fake', sessionId: 'fake', heartbeatMs: 0 }));
            resolve();
          } else if ((f.type === 'result' || f.type === 'error') && f.id) {
            replies.set(f.id, { ok: f.ok === true, error: f.error, data: f.data });
          }
        });
      });
    });

    // Point the extension at the fake server, then drop the real one.
    await h.sw.evaluate(
      (p) =>
        (globalThis as unknown as { chrome: { storage: { local: { set(v: unknown): Promise<void> } } } }).chrome.storage.local.set({ wsPort: p }),
      fakePort,
    );
    await h.bridge.stop();
    await Promise.race([welcomed, sleep(20_000).then(() => { throw new Error('extension never dialled the fake server'); })]);
    await sleep(200);

    const send = async (id: string, method: string, params: Record<string, unknown>, tabId?: string) => {
      (peer as WebSocket | null)?.send(JSON.stringify({ type: 'command', v: 1, id, method, params, tabId, timeoutMs: 10_000 }));
      const end = Date.now() + 10_000;
      while (!replies.has(id) && Date.now() < end) await sleep(50);
      return replies.get(id);
    };

    const probe = await send('p1', 'ping_probe', {});
    assert.ok(probe, 'the extension answers on this socket');
    for (const [id, method, params, tabId] of [
      ['c1', 'get_text', {}, tab],
      ['c2', 'eval', { expression: 'document.title = "PWNED"' }, tab],
      ['c3', 'type', { selector: '#name', text: 'leak' }, tab],
      ['c4', 'tabs_list', {}, undefined],
      ['c5', 'tab_new', { url: 'about:blank' }, undefined],
    ] as Array<[string, string, Record<string, unknown>, string | undefined]>) {
      const r = await send(id, method, params, tabId);
      assert.ok(r, `${method} got a reply`);
      assert.equal(r.ok, false, `${method} must be refused without a policy`);
      assert.equal(r.error?.code, 'POLICY_DENIED');
      assert.match(r.error?.message ?? '', /no policy has arrived/);
    }
    const title = await h.inSw(async () => {
      type Tabs = { tabs: { query(q: object): Promise<{ title?: string; url?: string }[]> } };
      const c = (globalThis as unknown as { chrome: Tabs }).chrome;
      return (await c.tabs.query({})).map((t) => t.title ?? '');
    });
    assert.ok(!title.includes('PWNED'), 'the refused eval never ran');
  });
});
