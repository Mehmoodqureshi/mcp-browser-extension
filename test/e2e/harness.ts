/**
 * End-to-end harness: the real extension (extension-dist) in Playwright's
 * Chromium, paired with a real BridgeServer, driven through the same tool
 * dispatcher the MCP server uses. Every capability is switched on and only the
 * fixture server's host is allowlisted, so a test exercises exactly what a
 * person's agent would, against pages this file controls.
 *
 * Gated behind RUN_E2E=1 (needs `npx playwright install chromium` and a
 * fresh `npm run build:ext`).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Worker } from 'playwright';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const RUN_E2E = !!process.env.RUN_E2E;

// The data dir is read on every call; point it at a throwaway folder before any
// tool runs so screenshots, downloads and history never touch the real profile.
const dataDir = mkdtempSync(join(tmpdir(), 'mbe-e2e-data-'));
process.env.MCP_BROWSER_EXTENSION_DATA = dataDir;

import { BridgeServer } from '../../src/bridge/server';
import { ExtensionExecutor } from '../../src/executor/extension-executor';
import { configureManager, resetManagerForTesting } from '../../src/executor/manager';
import { resolvePolicy, toWirePolicy, type Policy } from '../../src/security/policy';
import { dispatchToolCall, resetRateLimiter, resetWorkTab } from '../../src/mcp/tools';
import { siteOrigins } from '../../shared/browser-permissions';

/** Fixture pages, keyed by path. Each is a full HTML document. */
export const PAGES: Record<string, string> = {
  '/': `<!doctype html><title>Home</title><h1 id="title">E2E-HOME</h1>
    <p class="lead">The quick brown fox.</p>
    <a id="to-form" href="/form">Form</a> <a id="to-links" href="/links">Links</a>`,
  '/form': `<!doctype html><title>Form</title>
    <form id="f" onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'SENT:' + new FormData(this).get('name') + ':' + new FormData(this).get('color') + ':' + (new FormData(this).get('agree') ? 'yes' : 'no');">
      <label for="name">Name</label><input id="name" name="name">
      <label for="email">Email</label><input id="email" name="email" type="email">
      <label for="color">Color</label><select id="color" name="color"><option value="red">Red</option><option value="blue">Blue</option></select>
      <label><input id="agree" name="agree" type="checkbox"> Agree</label>
      <textarea id="notes" name="notes"></textarea>
      <button id="send" type="submit">Send</button>
    </form>
    <div id="out"></div>
    <button id="hoverme" onmouseenter="this.textContent='HOVERED'">hover</button>
    <input id="keys" onkeydown="document.getElementById('keyout').textContent = event.key">
    <div id="keyout"></div>`,
  '/links': `<!doctype html><title>Links</title>
    <a href="/">Home</a> <a href="/form">Form</a> <a href="https://example.org/x">External</a> <a href="/form">Form again</a>`,
  '/newtab': `<!doctype html><title>NewTab</title><a id="blank" href="/" target="_blank">open</a>
    <button id="popup" onclick="window.open('/', '_blank')">popup</button>`,
  '/alert': `<!doctype html><title>Alert</title><button id="raise" onclick="setTimeout(() => alert('stuck?'), 0)">raise</button>`,
  '/delayed': `<!doctype html><title>Delayed</title><div id="root"></div>
    <script>setTimeout(() => { const d = document.createElement('div'); d.id = 'late'; d.textContent = 'LATE-ARRIVAL'; document.getElementById('root').append(d); }, 800);</script>`,
  '/long': `<!doctype html><title>Long</title><div style="height:5000px;background:linear-gradient(#fff,#00f)">top</div><div id="bottom">BOTTOM</div>`,
  '/storage': `<!doctype html><title>Storage</title><script>localStorage.setItem('seed', 'S1'); document.cookie = 'e2e=cookie-value; path=/';</script>`,
  '/frames': `<!doctype html><title>Frames</title><h1>outer</h1><iframe id="inner" src="/frame-inner"></iframe>`,
  '/frame-inner': `<!doctype html><title>Inner</title><button id="in-btn" onclick="this.textContent='IN-CLICKED'">inner</button>`,
  '/console': `<!doctype html><title>Console</title><script>console.log('E2E-LOG'); console.error('E2E-ERR'); fetch('/missing-resource').catch(() => {});</script>`,
  '/download': `<!doctype html><title>Download</title><a id="dl" href="/file.txt" download="file.txt">get</a>`,
  '/upload': `<!doctype html><title>Upload</title><input id="file" type="file" onchange="document.getElementById('picked').textContent = this.files[0] ? this.files[0].name + ':' + this.files[0].size : ''"><div id="picked"></div>`,
  '/login': `<!doctype html><title>Sign in</title><form><label>Email<input type="email" name="email" autocomplete="username"></label><label>Password<input type="password" name="password" autocomplete="current-password"></label><button>Sign in</button></form>`,
  '/shadow': `<!doctype html><title>Shadow</title><div id="host"></div><script>const r = document.getElementById('host').attachShadow({mode:'open'}); r.innerHTML = '<button id="sb">shadow-btn</button>';</script>`,
  '/markdown': `<!doctype html><title>Article</title><article><h1>Heading One</h1><p>Paragraph with <strong>bold</strong> text.</p><ul><li>item a</li><li>item b</li></ul></article>`,
  '/watch': `<!doctype html><title>Watch</title><button id="a">Alpha</button><button id="b">Beta</button>
    <button id="mutate" onclick="document.getElementById('b').remove(); const n = document.createElement('button'); n.textContent = 'Gamma'; document.body.append(n);">mutate</button>`,
  '/bounce': `<!doctype html><title>Bounce</title><body style="margin:0;background:#151515;height:100vh"><iframe src="/slow" style="display:none"></iframe><script>setTimeout(() => location.replace('/bounce-done'), 1000);</script>`,
  '/bounce-done': `<!doctype html><title>Landed</title><body style="margin:0;background:#fff;height:100vh"><h1>LANDED</h1>`,
  '/hang': `<!doctype html><title>Hang</title><button id="spin" onclick="setTimeout(() => { const end = Date.now() + 30000; while (Date.now() < end) {} }, 0)">spin</button>`,
  '/website-actions': `<!doctype html><title>Website permission fixture</title>
    <h1>Local website permission test</h1><p>No real messages, deletions or purchases happen here.</p>
    <div id="count">0</div>
    <script>window.count = 0; window.effect = () => document.querySelector('#count').textContent = String(++window.count);</script>
    <button id="send" onclick="effect()">Send message</button>
    <button id="delete" onclick="effect()">Delete item</button>
    <button id="buy" onclick="effect()">Buy now</button>
    <input id="message">`,
};

function serve(req: IncomingMessage, res: ServerResponse): void {
  const path = (req.url ?? '/').split('?')[0];
  if (path === '/file.txt') {
    res.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="file.txt"' });
    res.end('E2E-DOWNLOAD-BODY');
    return;
  }
  if (path === '/slow') {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>Slow</title><p>SLOW-DONE</p>');
    }, 1500);
    return;
  }
  const html = PAGES[path];
  if (!html) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

export interface Harness {
  base: string;
  /** The hub's port: a second BridgeServer started on it joins as a peer. */
  port: number;
  policy: Policy;
  dataDir: string;
  uploadsDir: string;
  bridge: BridgeServer;
  ctx: BrowserContext;
  sw: Worker;
  approveClient(bridge?: BridgeServer): Promise<void>;
  /** Real Chrome permission requests, only in this throwaway Chromium profile. */
  grantBrowserPermissions(request: { permissions?: string[]; origins?: string[] }): Promise<void>;
  /** Call a tool through the dispatcher; returns the raw MCP result. */
  call(tool: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  /** Call a tool and parse its first text block as JSON; throws on a tool error. */
  json<T = Record<string, unknown>>(tool: string, args?: Record<string, unknown>): Promise<T>;
  /** Run code in the extension's service worker (to read real Chrome tab state). */
  inSw<T>(fn: () => Promise<T> | T): Promise<T>;
  /** Open a fresh agent tab at a fixture path and return its tabId. */
  open(path: string): Promise<string>;
  close(): Promise<void>;
}

export const textOf = (r: CallToolResult): string =>
  r.content
    .filter((c) => c.type === 'text')
    .map((c) => (c.type === 'text' ? c.text : ''))
    .join('\n');

async function waitFor(predicate: () => boolean, ms: number, label: string): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

export async function startHarness(
  overrides: Partial<Policy> = {},
  browserOptions: { deviceScaleFactor?: number; approveClient?: boolean; siteGrants?: boolean; browserPermissions?: boolean; legacyPermissions?: boolean; legacyProxy?: boolean; automaticPermission?: boolean } = {},
): Promise<Harness> {
  const page: Server = createServer(serve);
  await new Promise<void>((resolve) => page.listen(0, '127.0.0.1', resolve));
  const addr = page.address();
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  const uploadsDir = join(dataDir, 'uploads');
  mkdirSync(uploadsDir, { recursive: true });
  writeFileSync(join(uploadsDir, 'hello.txt'), 'HELLO-UPLOAD');

  const policy = resolvePolicy({
    allowDomains: ['127.0.0.1'],
    enableMutations: true,
    allowEval: true,
    allowDownloads: true,
    allowUploads: true,
    allowObservers: true,
    allowCookieValues: true,
    uploadsDir,
    ...overrides,
  });
  const token = 'e2e-token';
  const bridge = new BridgeServer({ token, serverVersion: 'e2e', port: 0, heartbeatMs: 0, policy: toWirePolicy(policy), siteGrants: browserOptions.siteGrants ?? false,
    onLog: (message) => { if (process.env.MBE_E2E_DEBUG) console.error(`[e2e bridge] ${message}`); } });
  const port = await bridge.start();

  const userDataDir = mkdtempSync(join(tmpdir(), 'mbe-e2e-chrome-'));
  const extPath = join(userDataDir, 'fixture-extension');
  cpSync(process.env.MBE_EXTENSION_BUILD_DIR ?? join(process.cwd(), 'extension-dist'), extPath, { recursive: true });
  // A developer's local build may contain a live pairing file written by the
  // CLI. Never let the disposable test extension connect to that real server.
  rmSync(join(extPath, 'pairing.json'), { force: true });
  const manifestPath = join(extPath, 'manifest.json');
  const manifestText = readFileSync(manifestPath, 'utf8');
  const backgroundPath = join(extPath, 'background.js');
  const backgroundText = readFileSync(backgroundPath, 'utf8');
  if (browserOptions.browserPermissions !== false || browserOptions.legacyPermissions) {
    // Bootstrap an existing Downloads grant using an older install, then restore
    // the exact production bundle. Native Chrome permission dialogs cannot be
    // accepted by headless Playwright. This never touches a person's profile.
    const prior = JSON.parse(manifestText);
    const legacy = browserOptions.legacyPermissions
      ? ['cookies', 'downloads', 'webRequest', 'webRequestAuthProvider']
      : ['downloads'];
    prior.permissions.push(...legacy);
    prior.optional_permissions = prior.optional_permissions.filter((p: string) => !legacy.includes(p));
    if (browserOptions.legacyPermissions) prior.host_permissions = ['<all_urls>'];
    writeFileSync(manifestPath, JSON.stringify(prior));
    writeFileSync(backgroundPath, 'chrome.runtime.onInstalled.addListener(() => {});');
  }
  // Extensions need full Chromium; "chromium" channel runs it in new headless
  // mode, so no window appears on the person's screen during a run.
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: !process.env.E2E_HEADED,
    // A native display scale exercises chrome.debugger captures. Playwright's
    // deviceScaleFactor emulates only the page, not the browser's compositor.
    ...(browserOptions.deviceScaleFactor ? { viewport: null } : {}),
    acceptDownloads: true,
    args: [
      `--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`, '--no-first-run',
      '--enable-unsafe-extension-debugging',
      ...(browserOptions.deviceScaleFactor ? [`--force-device-scale-factor=${browserOptions.deviceScaleFactor}`] : []),
    ],
  });
  try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15_000 });
  if (process.env.MBE_E2E_DEBUG) sw.on('console', (message) => console.error(`[e2e extension] ${message.type()}: ${message.text()}`));
  const extensionId = new URL(sw.url()).hostname;
  if (browserOptions.browserPermissions !== false || browserOptions.legacyPermissions) {
    await sw.evaluate(({ legacy, proxy }) => (globalThis as unknown as { chrome: { storage: { local: { set(v: unknown): Promise<void> } } } }).chrome.storage.local.set(
      legacy ? {
        migrationSentinel: 'keep-existing-settings',
        ...(proxy ? { proxy: { enabled: true, scheme: 'http', host: '127.0.0.1', port: 9, username: 'fixture', password: 'fixture' } } : {}),
      } : { optionalBrowserPermissionsV1: true },
    ), { legacy: browserOptions.legacyPermissions === true, proxy: browserOptions.legacyProxy === true });
    const previous = sw;
    writeFileSync(manifestPath, manifestText);
    writeFileSync(backgroundPath, backgroundText);
    const loaded = ctx.waitForEvent('serviceworker', { predicate: (worker) => worker !== previous, timeout: 15_000 });
    const cdp = await ctx.browser()!.newBrowserCDPSession();
    await cdp.send('Extensions.loadUnpacked', { path: extPath });
    const wake = await ctx.newPage();
    await wake.goto(`chrome-extension://${extensionId}/options.html`);
    await wake.evaluate(() => (globalThis as unknown as { chrome: { runtime: { sendMessage(v: unknown): Promise<unknown> } } }).chrome.runtime.sendMessage({ type: 'reconnect' }));
    sw = await loaded;
    await wake.close();
    await cdp.detach();
  }
  // Seed remembered approval for named fixture hosts through Chrome's real
  // extension settings. No active host permission is added: the product's
  // trusted Allow click must still call permissions.request successfully.
  const admin = await ctx.newPage();
  await admin.goto('chrome://extensions');
  const fixtureOrigins = [...new Set(['127.0.0.1', 'localhost', ...policy.allowDomains].flatMap(siteOrigins))];
  if (browserOptions.automaticPermission) fixtureOrigins.push('http://*/*', 'https://*/*');
  for (const host of fixtureOrigins) {
    await admin.evaluate(([id, host]) => {
      const c = (globalThis as unknown as { chrome: { developerPrivate: { addHostPermission(id: string, host: string): Promise<void> } } }).chrome;
      return c.developerPrivate.addHostPermission(id, host);
    }, [extensionId, host]);
  }
  await admin.close();
  // Most regression cases intentionally exercise the retained named-site mode.
  // Automatic-mode fixtures keep a fresh preference so they test its default.
  if (!browserOptions.automaticPermission) {
    await sw.evaluate(() => (globalThis as any).chrome.storage.local.set({ localSiteChecksV1: false }));
  }
  await sw.evaluate(
    ([p, t]) =>
      (globalThis as unknown as { chrome: { storage: { local: { set(v: unknown): Promise<void> } } } }).chrome.storage.local.set({ wsPort: p, token: t }),
    [port, token] as [number, string],
  );
  try {
    await waitFor(() => bridge.hasActiveExtension(), 15_000, 'extension to pair');
  } catch (err) {
    if (process.env.MBE_E2E_DEBUG) {
      const state = await sw.evaluate(async () => {
        const c = (globalThis as unknown as { chrome: { storage: { local: { get(keys: string[]): Promise<Record<string, unknown>> } } } }).chrome;
        const saved = await c.storage.local.get(['wsPort', 'connState', 'profile']);
        return { ...saved, tokenPresent: typeof (await c.storage.local.get(['token'])).token === 'string' };
      }).catch((e) => ({ inspectionError: String(e) }));
      console.error(`[e2e pairing] expectedPort=${port} active=${bridge.hasActiveExtension()} state=${JSON.stringify(state)}`);
    }
    throw err;
  }

  const grantBrowserPermissions = async (request: { permissions?: string[]; origins?: string[] }): Promise<void> => {
    const options = await ctx.newPage();
    try {
      await options.goto(new URL('options.html', sw.url()).href);
      await options.waitForFunction(async () => {
        const c = (globalThis as unknown as { chrome: { storage: { local: { get(key: string): Promise<Record<string, unknown>> } } } }).chrome;
        return (await c.storage.local.get('optionalBrowserPermissionsV1')).optionalBrowserPermissionsV1 === true;
      });
      await options.evaluate((request) => {
        const button = document.createElement('button');
        button.id = 'fixture-permissions';
        button.textContent = 'Grant fixture permissions';
        button.addEventListener('click', async () => {
          const c = (globalThis as unknown as { chrome: { permissions: { request(request: unknown): Promise<boolean> } } }).chrome;
          try { button.dataset.result = String(await c.permissions.request(request)); }
          catch (err) { button.dataset.result = String(err); }
        });
        document.body.append(button);
      }, request);
      await options.locator('#fixture-permissions').click();
      await options.waitForFunction(() => document.querySelector<HTMLElement>('#fixture-permissions')?.dataset.result !== undefined);
      const result = await options.locator('#fixture-permissions').getAttribute('data-result');
      if (result !== 'true') throw new Error(`fixture Chrome permission request failed: ${result}`);
    } finally { await options.close(); }
  };
  if (browserOptions.browserPermissions !== false) {
    await grantBrowserPermissions({ origins: policy.allowDomains.flatMap(siteOrigins), permissions: ['cookies', 'downloads'] });
  }

  const approveClient = async (client = bridge): Promise<void> => {
    try { await client.sendCommand('ping_probe', { requireClientApproval: true }); }
    catch (err) { if (!(err instanceof Error) || !err.message.includes('Please approve')) throw err; }
    const options = await ctx.newPage();
    await options.goto(new URL('options.html', sw.url()).href);
    await options.getByRole('button', { name: 'Approve for 8 hours', exact: true }).click();
    await options.getByRole('button', { name: 'Approve for 8 hours', exact: true }).waitFor({ state: 'hidden' });
    await options.close();
  };
  if (browserOptions.approveClient !== false) await approveClient();

  resetManagerForTesting();
  configureManager({ policy, makeExecutor: () => new ExtensionExecutor(bridge) });

  const call = async (tool: string, args: Record<string, unknown> = {}): Promise<CallToolResult> => {
    resetRateLimiter();
    return dispatchToolCall(tool, args);
  };
  const json = async <T>(tool: string, args: Record<string, unknown> = {}): Promise<T> => {
    const r = await call(tool, args);
    if (r.isError) throw new Error(`${tool} failed: ${textOf(r)}`);
    const first = r.content.find((c) => c.type === 'text');
    return JSON.parse(first && first.type === 'text' ? first.text : 'null') as T;
  };

  return {
    base,
    port,
    policy,
    dataDir,
    uploadsDir,
    bridge,
    approveClient,
    grantBrowserPermissions,
    ctx,
    sw,
    call,
    json,
    inSw: (fn) => sw.evaluate(fn),
    async open(path: string): Promise<string> {
      const t = await json<{ tabId: string }>('tab_new', { url: base + path });
      return t.tabId;
    },
    async close(): Promise<void> {
      resetWorkTab();
      resetManagerForTesting();
      await ctx.close().catch(() => undefined);
      await bridge.stop().catch(() => undefined);
      page.close();
      rmSync(userDataDir, { recursive: true, force: true });
    },
  };
  } catch (err) {
    await ctx.close().catch(() => undefined);
    await bridge.stop().catch(() => undefined);
    page.close();
    rmSync(userDataDir, { recursive: true, force: true });
    throw err;
  }
}
