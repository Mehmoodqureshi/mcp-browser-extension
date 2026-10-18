/**
 * Real-DOM harness for the page-injected functions in shared/ (snapshot,
 * page-fns, observers). The repo has no jsdom, and those functions only make
 * sense against a real layout engine anyway (visibility, innerText, shadow
 * roots, frames), so they run in headless Playwright Chromium.
 *
 * The compiled CommonJS modules from dist/shared are served to the page as
 * plain scripts from a fake origin (http://mcp.test), so the page runs the very
 * bytes Node would. When the suite runs under c8 (NODE_V8_COVERAGE is set),
 * the page's V8 coverage for those scripts is written into the same directory
 * under the dist file's URL, so c8 attributes it to the right source files.
 *
 * Nothing here touches the network: every request to the fake origins is
 * answered by `page.route`.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';

export const ORIGIN = 'http://mcp.test';
/** A second origin, for cross-origin frames. */
export const OTHER_ORIGIN = 'http://other.test';

const MODULES = ['snapshot', 'page-fns', 'observers'] as const;

export let hasChromium = false;
try {
  hasChromium = existsSync(chromium.executablePath());
} catch {
  hasChromium = false;
}

function modulePath(name: string): string {
  return join(__dirname, '..', 'shared', `${name}.js`);
}

/** The scripts that load the shared modules as `window.__mcp[name]`. */
export function moduleScripts(): string {
  const loaders = MODULES.map(
    (m) => `<script src="/__mod/${m}.js"></script><script>window.__mcp[${JSON.stringify(m)}] = exports; exports = {};</script>`,
  ).join('');
  return `<script>var exports = {}; var require = function () { return {}; }; window.__mcp = {};</script>${loaders}`;
}

/** A full document: module scripts in <head>, `body` as given. */
export function doc(body: string, opts: { title?: string; head?: string } = {}): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${opts.title ?? 'Fixture'}</title>` +
    `${moduleScripts()}${opts.head ?? ''}</head><body>${body}</body></html>`
  );
}

export interface PageHarness {
  page: Page;
  /** Serve `html` (wrapped by `doc`) at ORIGIN/page and navigate to it. */
  load(body: string, opts?: { title?: string; head?: string }): Promise<void>;
  /** Extra routes: path (e.g. "/frame") on either origin -> full HTML or text. */
  serve(url: string, body: string, contentType?: string): void;
  close(): Promise<void>;
}

let coverageFiles = 0;

export async function openHarness(): Promise<PageHarness> {
  const browser: Browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const collect = !!process.env.NODE_V8_COVERAGE;
  if (collect) await page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: false });

  const extra = new Map<string, { body: string; type: string }>();
  let current = doc('');
  let navs = 0;

  const handler = async (route: import('playwright').Route): Promise<void> => {
    const url = new URL(route.request().url());
    const key = `${url.origin}${url.pathname}`;
    const mod = /^\/__mod\/([a-z-]+)\.js$/.exec(url.pathname);
    if (mod) {
      await route.fulfill({ status: 200, contentType: 'application/javascript', body: readFileSync(modulePath(mod[1]), 'utf8') });
      return;
    }
    if (url.origin === ORIGIN && url.pathname === '/page') {
      await route.fulfill({ status: 200, contentType: 'text/html', body: current });
      return;
    }
    const hit = extra.get(key);
    if (hit) {
      await route.fulfill({ status: 200, contentType: hit.type, body: hit.body });
      return;
    }
    await route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
  };
  await page.route(`${ORIGIN}/**`, handler);
  await page.route(`${OTHER_ORIGIN}/**`, handler);

  return {
    page,
    async load(body, opts) {
      current = doc(body, opts);
      await page.goto(`${ORIGIN}/page?n=${++navs}`);
    },
    serve(url, body, contentType = 'text/html') {
      const u = new URL(url);
      extra.set(`${u.origin}${u.pathname}`, { body, type: contentType });
    },
    async close() {
      try {
        if (collect) {
          const entries = await page.coverage.stopJSCoverage();
          const dir = process.env.NODE_V8_COVERAGE as string;
          mkdirSync(dir, { recursive: true });
          for (const e of entries) {
            const m = /\/__mod\/([a-z-]+)\.js$/.exec(e.url);
            if (!m) continue;
            const url = pathToFileURL(realpathSync(modulePath(m[1]))).href;
            // One script per file: c8 merges same-URL scripts across files.
            const file = join(dir, `coverage-browser-${process.pid}-${Date.now()}-${++coverageFiles}.json`);
            writeFileSync(file, JSON.stringify({ result: [{ scriptId: e.scriptId, url, functions: e.functions }] }));
          }
        }
      } finally {
        await browser.close();
      }
    },
  };
}
