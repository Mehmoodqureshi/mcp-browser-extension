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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  '/hang': `<!doctype html><title>Hang</title><button id="spin" onclick="setTimeout(() => { const end = Date.now() + 30000; while (Date.now() < end) {} }, 0)">spin</button>`,
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

export async function startHarness(overrides: Partial<Policy> = {}): Promise<Harness> {
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
    uploadsDir,
    ...overrides,
  });
  const token = 'e2e-token';
  const bridge = new BridgeServer({ token, serverVersion: 'e2e', port: 0, heartbeatMs: 0, policy: toWirePolicy(policy), siteGrants: false });
  const port = await bridge.start();

  const extPath = join(process.cwd(), 'extension-dist');
  const userDataDir = mkdtempSync(join(tmpdir(), 'mbe-e2e-chrome-'));
  // Extensions need full Chromium; "chromium" channel runs it in new headless
  // mode, so no window appears on the person's screen during a run.
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: !process.env.E2E_HEADED,
    acceptDownloads: true,
    args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`, '--no-first-run'],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15_000 });
  await sw.evaluate(
    ([p, t]) =>
      (globalThis as unknown as { chrome: { storage: { local: { set(v: unknown): Promise<void> } } } }).chrome.storage.local.set({ wsPort: p, token: t }),
    [port, token] as [number, string],
  );
  await waitFor(() => bridge.hasActiveExtension(), 15_000, 'extension to pair');

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
}
