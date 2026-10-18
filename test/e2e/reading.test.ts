/**
 * Reading and capture: every tool that reads a page or captures it returns the
 * page's real content, honours its caps, and leaves the full artifact on disk.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { RUN_E2E, startHarness, textOf, type Harness } from './harness';
import { ensureWorkspace } from '../../src/bridge/datadir';
import { setActiveWorkspace, resetActiveWorkspaceForTesting } from '../../src/bridge/workspace';

let h: Harness;
const skip = !RUN_E2E;

/** Pages only this file needs, served on 127.0.0.1 (the allowlist matches host, not port). */
const BIG_WORD = 'READ-WORD ';
const EXTRA: Record<string, string> = {
  '/big': `<!doctype html><title>Big</title><p id="big">BIG-START ${BIG_WORD.repeat(600)}BIG-END</p>`,
  '/watch-form': `<!doctype html><title>WatchForm</title><label for="secret">Secret</label>
    <input id="secret" name="secret" value="SECRET-FORM-VALUE-42"><button id="go">Go</button>`,
  '/box': `<!doctype html><title>Box</title><style>body{margin:0}</style>
    <div id="box" style="position:absolute;left:20px;top:30px;width:200px;height:100px;background:#c00">box</div>`,
};
let extra: Server;
let extraBase = '';

before(async () => {
  if (skip) return;
  h = await startHarness();
  // The harness installs no task workspace, so artifacts would land nowhere;
  // give this file its own under the harness's throwaway data dir.
  setActiveWorkspace(ensureWorkspace(h.dataDir, 'default', 'reading'));
  extra = createServer((req, res) => {
    const html = EXTRA[(req.url ?? '/').split('?')[0]];
    res.writeHead(html ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html ?? 'not found');
  });
  await new Promise<void>((resolve) => extra.listen(0, '127.0.0.1', resolve));
  const addr = extra.address();
  extraBase = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
after(async () => {
  resetActiveWorkspaceForTesting();
  extra?.close();
  await h?.close();
});

/** Open a page from this file's own server. */
const openExtra = async (path: string): Promise<string> =>
  (await h.json<{ tabId: string }>('tab_new', { url: extraBase + path })).tabId;

const image = (r: CallToolResult): { data: Buffer; mimeType: string } => {
  const c = r.content.find((x) => x.type === 'image');
  assert.ok(c && c.type === 'image', `expected an image block, got: ${textOf(r)}`);
  return { data: Buffer.from(c.data, 'base64'), mimeType: c.mimeType };
};

/** Pixel size read from the encoded bytes themselves (PNG IHDR or JPEG SOFn). */
function dims(buf: Buffer): { width: number; height: number } {
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  throw new Error('no JPEG frame header');
}

const isJpeg = (b: Buffer): boolean => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const isPng = (b: Buffer): boolean => b.subarray(1, 4).toString('latin1') === 'PNG' && b[0] === 0x89;

const screenshotFiles = (): string[] => readdirSync(join(h.dataDir, 'profiles', 'default', 'tasks', 'reading', 'screenshots'));

test('get_text reads the whole page and a selector', { skip }, async () => {
  const tab = await h.open('/');
  const whole = await h.json<{ text: string; truncated?: boolean }>('get_text', { tabId: tab });
  assert.match(whole.text, /E2E-HOME/);
  assert.match(whole.text, /The quick brown fox\./);
  assert.equal(whole.truncated, undefined);

  const lead = await h.json<{ text: string }>('get_text', { tabId: tab, selector: '.lead' });
  assert.equal(lead.text.trim(), 'The quick brown fox.');
  assert.doesNotMatch(lead.text, /E2E-HOME/);
  await h.json('tab_close', { tabId: tab });
});

test('get_text caps at maxBytes and saves the full text to disk', { skip }, async () => {
  const tab = await openExtra('/big');
  const r = await h.json<{ text: string; truncated: boolean; totalBytes: number; returnedBytes: number; savedTo: string }>(
    'get_text',
    { tabId: tab, maxBytes: 1024 },
  );
  assert.equal(r.truncated, true);
  assert.ok(Buffer.byteLength(r.text, 'utf8') <= 1024, `returned ${Buffer.byteLength(r.text)} bytes`);
  assert.equal(r.returnedBytes, Buffer.byteLength(r.text, 'utf8'));
  assert.ok(r.totalBytes > 6000, `total ${r.totalBytes}`);
  assert.match(r.text, /^BIG-START/);
  assert.doesNotMatch(r.text, /BIG-END/);

  assert.ok(r.savedTo && existsSync(r.savedTo), `artifact missing: ${r.savedTo}`);
  assert.ok(r.savedTo.startsWith(h.dataDir), 'the artifact lives under the data dir');
  const saved = JSON.parse(readFileSync(r.savedTo, 'utf8')) as { text: string };
  assert.match(saved.text, /BIG-START/);
  assert.match(saved.text, /BIG-END/, 'the file on disk is the full, uncapped read');
  await h.json('tab_close', { tabId: tab });
});

test('get_text rejects a maxBytes below the floor', { skip }, async () => {
  const tab = await h.open('/');
  const r = await h.call('get_text', { tabId: tab, maxBytes: 10 });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /maxBytes/);
  assert.match(textOf(r), /1024/);
  await h.json('tab_close', { tabId: tab });
});

test('get_html returns markup with fixture ids, narrows by selector, and caps', { skip }, async () => {
  const tab = await h.open('/form');
  const page = await h.json<{ html: string }>('get_html', { tabId: tab });
  for (const id of ['id="f"', 'id="name"', 'id="color"', 'id="send"', 'id="hoverme"']) {
    assert.ok(page.html.includes(id), `page html is missing ${id}`);
  }

  const outer = await h.json<{ html: string }>('get_html', { tabId: tab, selector: '#color', outer: true });
  assert.match(outer.html, /^<select[^>]*id="color"/);
  assert.match(outer.html, /<option value="blue">Blue<\/option>/);
  assert.doesNotMatch(outer.html, /id="send"/);
  await h.json('tab_close', { tabId: tab });

  const big = await openExtra('/big');
  const capped = await h.json<{ html: string; truncated: boolean; totalBytes: number }>('get_html', { tabId: big, maxBytes: 1024 });
  assert.equal(capped.truncated, true);
  assert.ok(Buffer.byteLength(capped.html, 'utf8') <= 1024);
  assert.ok(capped.totalBytes > 6000);
  assert.doesNotMatch(capped.html, /BIG-END/);
  await h.json('tab_close', { tabId: big });
});

interface SnapNode { ref: string; role: string; name: string; tag: string }

test('snapshot lists /form controls by role, and its refs drive click', { skip }, async () => {
  const tab = await h.open('/form');
  const snap = await h.json<{ nodes: SnapNode[]; title: string }>('snapshot', { tabId: tab });
  assert.equal(snap.title, 'Form');
  const find = (role: string, name: RegExp): SnapNode | undefined => snap.nodes.find((n) => n.role === role && name.test(n.name));
  const tags = (role: string): string[] => snap.nodes.filter((n) => n.role === role).map((n) => n.tag);
  assert.deepEqual(tags('textbox').sort(), ['input', 'input', 'input', 'textarea'], JSON.stringify(snap.nodes));
  assert.deepEqual(tags('combobox'), ['select']);
  assert.deepEqual(tags('checkbox'), ['input']);
  const send = find('button', /^Send$/);
  assert.ok(send && send.ref);
  const hover = find('button', /^hover$/);
  assert.ok(hover);

  await h.json('type', { tabId: tab, selector: '#name', text: 'Ref' });
  await h.json('click', { tabId: tab, ref: send.ref });
  const out = await h.json<{ text: string }>('get_text', { tabId: tab, selector: '#out' });
  assert.match(out.text, /^SENT:Ref:red:no$/);
  await h.json('tab_close', { tabId: tab });
});

test(
  'snapshot names /form controls by their <label>',
  { skip },
  async () => {
    const tab = await h.open('/form');
    const snap = await h.json<{ nodes: SnapNode[] }>('snapshot', { tabId: tab });
    const has = (role: string, name: string): boolean => snap.nodes.some((n) => n.role === role && n.name === name);
    try {
      assert.ok(has('textbox', 'Name'), JSON.stringify(snap.nodes));
      assert.ok(has('textbox', 'Email'), JSON.stringify(snap.nodes));
      assert.ok(has('combobox', 'Color'), JSON.stringify(snap.nodes));
      assert.ok(has('checkbox', 'Agree'), JSON.stringify(snap.nodes));
      // The documented role+name locator rests on the same names.
      const typed = await h.call('type', { tabId: tab, role: 'textbox', name: 'Name', text: 'ByLabel' });
      assert.equal(typed.isError, undefined, textOf(typed));
    } finally {
      await h.json('tab_close', { tabId: tab });
    }
  },
);

test('snapshot reaches into an open shadow root', { skip }, async () => {
  const tab = await h.open('/shadow');
  const snap = await h.json<{ nodes: SnapNode[] }>('snapshot', { tabId: tab });
  const btn = snap.nodes.find((n) => n.role === 'button' && n.name === 'shadow-btn');
  assert.ok(btn, JSON.stringify(snap.nodes));
  await h.json('tab_close', { tabId: tab });
});

test('read_as_markdown renders headings, emphasis and lists', { skip }, async () => {
  const tab = await h.open('/markdown');
  const md = textOf(await h.call('read_as_markdown', { tabId: tab }));
  assert.match(md, /^# Heading One$/m);
  assert.match(md, /\*\*bold\*\*/);
  assert.match(md, /^[-*] item a$/m);
  assert.match(md, /^[-*] item b$/m);
  await h.json('tab_close', { tabId: tab });
});

test('extract_links dedupes, limits and filters to the same origin', { skip }, async () => {
  const tab = await h.open('/links');
  type Links = { links: { href: string; text: string }[] };
  const all = await h.json<Links>('extract_links', { tabId: tab });
  assert.equal(all.links.length, 4);
  assert.ok(all.links.some((l) => l.href === 'https://example.org/x'));

  const deduped = await h.json<Links>('extract_links', { tabId: tab, dedupe: true });
  assert.equal(deduped.links.length, 3);
  assert.equal(deduped.links.filter((l) => l.href === `${h.base}/form`).length, 1);

  const limited = await h.json<Links>('extract_links', { tabId: tab, limit: 2 });
  assert.equal(limited.links.length, 2);

  const same = await h.json<Links>('extract_links', { tabId: tab, sameOriginOnly: true });
  assert.equal(same.links.length, 3);
  assert.ok(same.links.every((l) => l.href.startsWith(h.base)), JSON.stringify(same.links));
  assert.ok(!same.links.some((l) => l.href.includes('example.org')));
  await h.json('tab_close', { tabId: tab });
});

test('screenshot defaults to JPEG, PNG on request, with sane sizes saved to disk', { skip }, async () => {
  const tab = await h.open('/');
  const viewport = await h.json<{ value: { w: number; h: number } }>('eval', {
    tabId: tab,
    expression: '({ w: innerWidth, h: innerHeight })',
  });
  const before = screenshotFiles().length;

  const jpeg = image(await h.call('screenshot', { tabId: tab }));
  assert.equal(jpeg.mimeType, 'image/jpeg');
  assert.ok(isJpeg(jpeg.data), 'the bytes are a JPEG');
  const jd = dims(jpeg.data);
  assert.equal(jd.width, viewport.value.w);
  assert.equal(jd.height, viewport.value.h);

  const png = image(await h.call('screenshot', { tabId: tab, format: 'png' }));
  assert.equal(png.mimeType, 'image/png');
  assert.ok(isPng(png.data), 'the bytes are a PNG');
  const pd = dims(png.data);
  assert.ok(pd.width >= 200 && pd.width <= 4000, `png width ${pd.width}`);
  assert.ok(pd.height >= 200 && pd.height <= 4000, `png height ${pd.height}`);

  const files = screenshotFiles();
  assert.equal(files.length, before + 2);
  assert.ok(files.some((f) => f.endsWith('.jpg')));
  assert.ok(files.some((f) => f.endsWith('.png')));
  const newestPng = files.filter((f) => f.endsWith('.png')).sort().pop()!;
  const onDisk = readFileSync(join(h.dataDir, 'profiles', 'default', 'tasks', 'reading', 'screenshots', newestPng));
  assert.ok(onDisk.equals(png.data), 'the saved file is the returned image');
  await h.json('tab_close', { tabId: tab });
});

test('fullPage screenshot of /long is taller than the viewport or says it was cut', { skip }, async () => {
  const tab = await h.open('/long');
  const vh = (await h.json<{ value: number }>('eval', { tabId: tab, expression: 'innerHeight' })).value;
  const r = await h.call('screenshot', { tabId: tab, fullPage: true });
  assert.equal(r.isError, undefined, textOf(r));
  const shot = image(r);
  const d = dims(shot.data);
  const caption = textOf(r);
  if (/truncated/.test(caption)) {
    assert.match(caption, /full height \d+px/);
  }
  assert.ok(d.height > vh, `full page height ${d.height} should exceed viewport ${vh}`);
  await h.json('tab_close', { tabId: tab });
});

test('element screenshot crops to the element; a missing one is SELECTOR_NOT_FOUND', { skip }, async () => {
  const tab = await openExtra('/box');
  const r = await h.call('screenshot', { tabId: tab, selector: '#box', format: 'png' });
  assert.equal(r.isError, undefined, textOf(r));
  const d = dims(image(r).data);
  assert.equal(d.width, 200);
  assert.equal(d.height, 100);

  const miss = await h.call('screenshot', { tabId: tab, selector: '#nope' });
  assert.equal(miss.isError, true);
  assert.match(textOf(miss), /SELECTOR_NOT_FOUND/);
  await h.json('tab_close', { tabId: tab });
});

test('print_pdf writes a real PDF to disk', { skip }, async () => {
  const tab = await h.open('/markdown');
  const r = await h.json<{ path: string; bytes: number; title: string }>('print_pdf', { tabId: tab });
  assert.ok(r.path && existsSync(r.path), `pdf missing: ${r.path}`);
  assert.ok(r.path.startsWith(h.dataDir));
  const bytes = readFileSync(r.path);
  assert.equal(bytes.subarray(0, 4).toString('latin1'), '%PDF');
  assert.equal(bytes.byteLength, r.bytes);
  assert.ok(r.bytes > 500);
  assert.equal(r.title, 'Article');
  await h.json('tab_close', { tabId: tab });
});

test('page_watch create, compare after a change, list, delete', { skip }, async () => {
  const tab = await h.open('/watch');
  const made = await h.json<{ watchId: string; name: string; elements: number }>('page_watch', {
    tabId: tab,
    action: 'create',
    name: 'watch-e2e',
  });
  assert.match(made.watchId, /^watch_/);
  assert.equal(made.name, 'watch-e2e');
  assert.ok(made.elements >= 3);

  await h.json('click', { tabId: tab, selector: '#mutate' });
  type Diff = { added: SnapNode[]; removed: SnapNode[]; currentUrl: string };
  const diff = await h.json<Diff>('page_watch', { tabId: tab, action: 'compare', watchId: made.watchId });
  assert.ok(diff.removed.some((n) => n.name === 'Beta'), JSON.stringify(diff));
  assert.ok(diff.added.some((n) => n.name === 'Gamma'), JSON.stringify(diff));
  assert.ok(!diff.removed.some((n) => n.name === 'Alpha'));
  assert.ok(!diff.added.some((n) => n.name === 'Alpha'));

  const listed = await h.json<{ watches: { id: string; name: string }[] }>('page_watch', { action: 'list' });
  assert.ok(listed.watches.some((w) => w.id === made.watchId && w.name === 'watch-e2e'));

  assert.deepEqual(await h.json('page_watch', { action: 'delete', watchId: made.watchId }), { deleted: true });
  const after = await h.json<{ watches: { id: string }[] }>('page_watch', { action: 'list' });
  assert.ok(!after.watches.some((w) => w.id === made.watchId));
  const again = await h.call('page_watch', { tabId: tab, action: 'compare', watchId: made.watchId });
  assert.equal(again.isError, true);
  await h.json('tab_close', { tabId: tab });
});

test('page_watch never writes form values to disk', { skip }, async () => {
  const tab = await openExtra('/watch-form');
  await h.json('type', { tabId: tab, selector: '#secret', text: '-TYPED-77' });
  // The live snapshot does carry the value, so the absence below is the store's doing.
  const snap = await h.json<{ nodes: { value?: string }[] }>('snapshot', { tabId: tab });
  assert.ok(snap.nodes.some((n) => (n.value ?? '').includes('SECRET-FORM-VALUE-42')), JSON.stringify(snap.nodes));

  const made = await h.json<{ watchId: string }>('page_watch', { tabId: tab, action: 'create', name: 'private' });
  const file = join(h.dataDir, 'profiles', 'default', 'page-watches', `${made.watchId}.json`);
  assert.ok(existsSync(file), `watch file missing at ${file}`);
  const raw = readFileSync(file, 'utf8');
  assert.ok(!raw.includes('SECRET-FORM-VALUE-42'), 'the default value is not stored');
  assert.ok(!raw.includes('TYPED-77'), 'the typed value is not stored');
  assert.ok(raw.includes('"name":"Go"'), 'the structure is still stored');
  await h.json('page_watch', { action: 'delete', watchId: made.watchId });
  await h.json('tab_close', { tabId: tab });
});

test('get_cookies reads the cookie /storage set', { skip }, async () => {
  const tab = await h.open('/storage');
  const r = await h.json<{ cookies: { name: string; value: string; domain: string; path: string }[] }>('get_cookies', { tabId: tab });
  const c = r.cookies.find((x) => x.name === 'e2e');
  assert.ok(c, JSON.stringify(r));
  assert.equal(c.value, 'cookie-value');
  assert.equal(c.domain, '127.0.0.1');
  assert.equal(c.path, '/');
  await h.json('tab_close', { tabId: tab });
});

test('storage get, set and remove on localStorage', { skip }, async () => {
  const tab = await h.open('/storage');
  const seed = await h.json<{ ok: boolean; value: string | null }>('storage', { tabId: tab, op: 'get', key: 'seed' });
  assert.equal(seed.value, 'S1');

  assert.equal((await h.json<{ ok: boolean }>('storage', { tabId: tab, op: 'set', key: 'k2', value: 'V2' })).ok, true);
  assert.equal((await h.json<{ value: string }>('storage', { tabId: tab, op: 'get', key: 'k2' })).value, 'V2');
  const page = await h.json<{ value: string }>('eval', { tabId: tab, expression: "localStorage.getItem('k2')" });
  assert.equal(page.value, 'V2', 'the page itself sees the write');

  const all = await h.json<{ entries: Record<string, string> }>('storage', { tabId: tab, op: 'get' });
  assert.equal(all.entries.seed, 'S1');
  assert.equal(all.entries.k2, 'V2');

  assert.equal((await h.json<{ ok: boolean }>('storage', { tabId: tab, op: 'remove', key: 'k2' })).ok, true);
  assert.equal((await h.json<{ value: string | null }>('storage', { tabId: tab, op: 'get', key: 'k2' })).value, null);

  const noKey = await h.call('storage', { tabId: tab, op: 'set', value: 'x' });
  assert.equal(noKey.isError, true);
  assert.match(textOf(noKey), /requires a "key"/);
  await h.json('tab_close', { tabId: tab });
});

test('eval returns page values', { skip }, async () => {
  const tab = await h.open('/');
  const num = await h.json<{ ok: boolean; value: unknown; type: string }>('eval', { tabId: tab, expression: '6 * 7' });
  assert.deepEqual([num.ok, num.value, num.type], [true, 42, 'number']);
  const title = await h.json<{ value: unknown }>('eval', { tabId: tab, expression: "document.getElementById('title').textContent" });
  assert.equal(title.value, 'E2E-HOME');
  const obj = await h.json<{ value: unknown }>('eval', { tabId: tab, expression: '({ a: [1, 2], b: "x" })' });
  assert.deepEqual(obj.value, { a: [1, 2], b: 'x' });
  await h.json('tab_close', { tabId: tab });
});

test(
  'eval with awaitPromise resolves the promise',
  { skip },
  async () => {
    const tab = await h.open('/');
    try {
      const r = await h.json<{ ok: boolean; value: unknown }>('eval', {
        tabId: tab,
        expression: 'new Promise((r) => setTimeout(() => r("RESOLVED-" + document.title), 50))',
        awaitPromise: true,
      });
      assert.equal(r.ok, true);
      assert.equal(r.value, 'RESOLVED-Home');
    } finally {
      await h.json('tab_close', { tabId: tab });
    }
  },
);

test('eval reports a thrown error instead of a value', { skip }, async () => {
  const tab = await h.open('/');
  // Contract (docs/BLUEPRINT.md): a page exception is { ok:false, error }, not a
  // transport-level tool error, so the agent can read the message.
  const r = await h.call('eval', { tabId: tab, expression: 'throw new Error("E2E-BOOM")' });
  assert.equal(r.isError, undefined, textOf(r));
  const parsed = JSON.parse(textOf(r)) as { ok: boolean; error?: string; value?: unknown };
  assert.equal(parsed.ok, false);
  assert.match(parsed.error ?? '', /Error: E2E-BOOM/);
  assert.equal(parsed.value, undefined);
  await h.json('tab_close', { tabId: tab });
});
