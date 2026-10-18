/**
 * Page interaction: every tool that changes a page (click, type, press, hover,
 * scroll, select_option, fill_form, draw, upload_file) is driven through the
 * real extension, and each test reads the DOM back to prove the effect landed
 * rather than trusting the tool's own { ok: true }.
 *
 * Pages the shared harness does not have are served from a small server in
 * this file on 127.0.0.1 (the allowlist matches the host, not the port).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';

import { RUN_E2E, startHarness, textOf, type Harness } from './harness';

let h: Harness;
let extra: Server;
let xbase = '';
const skip = !RUN_E2E;

/** Extra fixture pages, served on a second 127.0.0.1 port. */
const EXTRA: Record<string, string> = {
  '/clicks': `<!doctype html><title>Clicks</title>
    <button id="count" onclick="document.getElementById('log').textContent += (event.isTrusted ? 'T' : 'S')">Count</button>
    <button id="twin1" onclick="document.getElementById('log').textContent += '1'">Twin</button>
    <button id="twin2" onclick="document.getElementById('log').textContent += '2'">Twin</button>
    <div id="log"></div>`,
  '/shadow-click': `<!doctype html><title>ShadowClick</title><div id="host"></div><div id="out"></div>
    <script>const r = document.getElementById('host').attachShadow({mode:'open'});
    r.innerHTML = '<button id="sb">shadow-btn</button>';
    r.getElementById('sb').addEventListener('click', () => { document.getElementById('out').textContent = 'SHADOW-CLICKED'; });</script>`,
  '/editors': `<!doctype html><title>Editors</title>
    <input id="field" aria-label="Field">
    <textarea id="ta"></textarea>
    <div id="ce" contenteditable="true">old text</div>
    <div id="log"></div>
    <script>
      const log = (s) => { document.getElementById('log').textContent += s + ';'; };
      const f = document.getElementById('field');
      f.addEventListener('keydown', (e) => log('kd:' + e.key));
      f.addEventListener('input', (e) => log('in:' + (e.isTrusted ? 'T' : 'S')));
    </script>`,
  '/enter-form': `<!doctype html><title>EnterForm</title>
    <form id="ef" onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'SUBMITTED:' + document.getElementById('q').value;">
      <input id="q" name="q">
    </form>
    <div id="out"></div>
    <script>document.getElementById('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('out').dataset.enter = 'yes'; });</script>`,
  '/mods': `<!doctype html><title>Mods</title><input id="k">
    <div id="kout"></div>
    <script>document.getElementById('k').addEventListener('keydown', (e) => {
      document.getElementById('kout').textContent = e.key + ':' + (e.ctrlKey ? 'C' : '') + (e.shiftKey ? 'S' : '') + (e.altKey ? 'A' : '') + (e.metaKey ? 'M' : '');
    });</script>`,
  '/multi': `<!doctype html><title>Multi</title>
    <select id="m" multiple><option value="a">Alpha</option><option value="b">Beta</option><option value="g">Gamma</option></select>`,
  '/canvas': `<!doctype html><title>Canvas</title><style>body{margin:0}</style>
    <canvas id="c" width="400" height="300" style="display:block"></canvas>
    <div id="ev"></div>
    <script>
      const c = document.getElementById('c'); const ctx = c.getContext('2d');
      const st = { down: 0, moves: 0, up: 0, pts: [] }; let drawing = false;
      const out = () => { document.getElementById('ev').textContent = JSON.stringify(st); };
      c.addEventListener('mousedown', (e) => { drawing = true; st.down++; st.pts.push([e.offsetX, e.offsetY]); ctx.beginPath(); ctx.moveTo(e.offsetX, e.offsetY); out(); });
      c.addEventListener('mousemove', (e) => { if (!drawing) return; st.moves++; ctx.lineWidth = 4; ctx.lineTo(e.offsetX, e.offsetY); ctx.stroke(); out(); });
      window.addEventListener('mouseup', (e) => { if (drawing) { st.up++; st.pts.push([e.offsetX, e.offsetY]); } drawing = false; out(); });
    </script>`,
};

const evalValue = async <T = unknown>(expression: string, tabId: string, extraArgs: Record<string, unknown> = {}): Promise<T> => {
  const r = await h.json<{ ok: boolean; value?: T; error?: string }>('eval', { expression, tabId, ...extraArgs });
  assert.equal(r.ok, true, `eval failed: ${r.error}`);
  return r.value as T;
};

/** Poll an expression until it satisfies `ok` (page effects can trail the tool's return). */
async function evalUntil<T>(expression: string, tabId: string, ok: (v: T) => boolean, ms = 5_000): Promise<T> {
  const end = Date.now() + ms;
  let v = await evalValue<T>(expression, tabId);
  while (!ok(v) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 100));
    v = await evalValue<T>(expression, tabId);
  }
  return v;
}

const textAt = async (selector: string, tabId: string, extraArgs: Record<string, unknown> = {}): Promise<string> =>
  (await h.json<{ text: string }>('get_text', { selector, tabId, ...extraArgs })).text.trim();

const openExtra = async (path: string): Promise<string> => {
  const t = await h.json<{ tabId: string }>('tab_new', { url: xbase + path });
  return t.tabId;
};

before(async () => {
  if (skip) return;
  h = await startHarness();
  extra = createServer((req, res) => {
    const html = EXTRA[(req.url ?? '/').split('?')[0]];
    if (!html) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise<void>((resolve) => extra.listen(0, '127.0.0.1', resolve));
  const addr = extra.address();
  xbase = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
after(async () => {
  await h?.close();
  extra?.close();
});

// ---------------------------------------------------------------- click

test('click by selector fires a synthetic click; trusted:true a real one', { skip }, async () => {
  const tab = await openExtra('/clicks');
  await h.json('click', { selector: '#count', tabId: tab });
  assert.equal(await textAt('#log', tab), 'S');
  await h.json('click', { selector: '#count', tabId: tab, trusted: false });
  assert.equal(await textAt('#log', tab), 'SS');
  await h.json('click', { selector: '#count', tabId: tab, trusted: true });
  assert.equal(await textAt('#log', tab), 'SST', 'trusted:true must reach the page as a real (isTrusted) click');
  await h.json('tab_close', { tabId: tab });
});

test('click by a ref taken from snapshot', { skip }, async () => {
  const tab = await openExtra('/clicks');
  const snap = await h.json<{ nodes: Array<{ ref: string; role: string; name: string }> }>('snapshot', { tabId: tab });
  const node = snap.nodes.find((n) => n.role === 'button' && n.name === 'Count');
  assert.ok(node, `snapshot lists the Count button: ${JSON.stringify(snap.nodes)}`);
  await h.json('click', { ref: node.ref, tabId: tab });
  assert.equal(await textAt('#log', tab), 'S');
  await h.json('tab_close', { tabId: tab });
});

test('click by role+name, with nth to pick among identical names', { skip }, async () => {
  const tab = await openExtra('/clicks');
  await h.json('click', { role: 'button', name: 'Count', tabId: tab });
  assert.equal(await textAt('#log', tab), 'S');

  const ambiguous = await h.call('click', { role: 'button', name: 'Twin', tabId: tab });
  assert.equal(ambiguous.isError, true, 'two buttons named Twin must not silently click the first');
  assert.equal(await textAt('#log', tab), 'S', 'an ambiguous locator clicks nothing');

  await h.json('click', { role: 'button', name: 'Twin', nth: 1, tabId: tab });
  assert.equal(await textAt('#log', tab), 'S2', 'nth:1 is the second Twin');
  await h.json('click', { role: 'button', name: 'Twin', nth: 0, tabId: tab });
  assert.equal(await textAt('#log', tab), 'S21');
  await h.json('tab_close', { tabId: tab });
});

test('click inside an iframe by frameId and by allFrames', { skip }, async () => {
  const tab = await h.open('/frames');
  await h.json('wait_for', { selector: '#in-btn', allFrames: true, tabId: tab });
  const frames = await h.json<{ frames: Array<{ frameId: number; top: boolean; url: string }> }>('frames_list', { tabId: tab });
  const inner = frames.frames.find((f) => !f.top && f.url.endsWith('/frame-inner'));
  assert.ok(inner, `frames_list shows the inner frame: ${JSON.stringify(frames)}`);

  const top = await h.call('click', { selector: '#in-btn', tabId: tab });
  assert.equal(top.isError, true, 'the top frame alone does not have #in-btn');
  assert.match(textOf(top), /SELECTOR_NOT_FOUND/);

  await h.json('click', { selector: '#in-btn', frameId: inner.frameId, tabId: tab });
  assert.equal(await textAt('#in-btn', tab, { frameId: inner.frameId }), 'IN-CLICKED');

  const tab2 = await h.open('/frames');
  await h.json('wait_for', { selector: '#in-btn', allFrames: true, tabId: tab2 });
  await h.json('click', { selector: '#in-btn', allFrames: true, tabId: tab2 });
  assert.equal(await textAt('#in-btn', tab2, { allFrames: true }), 'IN-CLICKED');
  await h.json('tab_close', { tabId: tab });
  await h.json('tab_close', { tabId: tab2 });
});

test('click reaches a button inside an open shadow root', { skip }, async () => {
  const tab = await openExtra('/shadow-click');
  // The page builds its shadow root from an inline script; let it land first.
  await h.json('wait_for', { selector: '#host', tabId: tab, timeoutMs: 5_000 });
  await h.json('click', { selector: '#sb', tabId: tab });
  await h.json('wait_for', { textContains: 'SHADOW-CLICKED', tabId: tab, timeoutMs: 5_000 });
  assert.equal(await textAt('#out', tab), 'SHADOW-CLICKED');
  await h.json('tab_close', { tabId: tab });
});

test('click on a missing element fails with SELECTOR_NOT_FOUND', { skip }, async () => {
  const tab = await h.open('/form');
  const r = await h.call('click', { selector: '#does-not-exist', tabId: tab });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /SELECTOR_NOT_FOUND/);
  const t = await h.call('type', { selector: '#nope', text: 'x', tabId: tab });
  assert.equal(t.isError, true);
  assert.match(textOf(t), /SELECTOR_NOT_FOUND/);
  await h.json('tab_close', { tabId: tab });
});

test('click with snapshotAfter returns what changed on the page', { skip }, async () => {
  const tab = await h.open('/watch');
  await h.json('snapshot', { tabId: tab });
  const r = await h.json<{
    ok: boolean;
    changed: { since: string | null; added: Array<{ name: string }>; removed: Array<{ name: string }>; url: string };
  }>('click', { selector: '#mutate', tabId: tab, snapshotAfter: true });
  assert.equal(r.ok, true);
  assert.ok(r.changed, 'a change summary is attached');
  assert.notEqual(r.changed.since, null, 'diffed against the earlier snapshot');
  assert.ok(r.changed.added.some((n) => n.name === 'Gamma'), `Gamma was added: ${JSON.stringify(r.changed)}`);
  assert.ok(r.changed.removed.some((n) => n.name === 'Beta'), `Beta was removed: ${JSON.stringify(r.changed)}`);
  assert.ok(!r.changed.added.some((n) => n.name === 'Alpha'), 'Alpha did not change');
  assert.match(r.changed.url, /\/watch$/);
  await h.json('tab_close', { tabId: tab });
});

// ---------------------------------------------------------------- type

test('type appends, and clear:true replaces', { skip }, async () => {
  const tab = await h.open('/form');
  await h.json('type', { selector: '#name', text: 'Ada', tabId: tab });
  await h.json('type', { selector: '#name', text: ' Lovelace', tabId: tab });
  assert.equal(await evalValue("document.getElementById('name').value", tab), 'Ada Lovelace');
  await h.json('type', { selector: '#name', text: 'Grace', clear: true, tabId: tab });
  assert.equal(await evalValue("document.getElementById('name').value", tab), 'Grace');
  await h.json('tab_close', { tabId: tab });
});

test('type by role+name into an aria-labelled field', { skip }, async () => {
  const tab = await openExtra('/editors');
  await h.json('type', { role: 'textbox', name: 'Field', text: 'by-role', tabId: tab });
  assert.equal(await evalValue("document.getElementById('field').value", tab), 'by-role');
  await h.json('tab_close', { tabId: tab });
});

test(
  'type by role+name finds an input named by its <label for>',
  { skip },
  async () => {
    const tab = await h.open('/form');
    const r = await h.call('type', { role: 'textbox', name: 'Email', text: 'g@example.com', tabId: tab });
    const value = await evalValue("document.getElementById('email').value", tab);
    await h.json('tab_close', { tabId: tab });
    assert.equal(r.isError, undefined, textOf(r));
    assert.equal(value, 'g@example.com');
  },
);

test('type into a textarea and into a contenteditable', { skip }, async () => {
  const tab = await openExtra('/editors');
  await h.json('type', { selector: '#ta', text: 'line one\nline two', tabId: tab });
  assert.equal(await evalValue("document.getElementById('ta').value", tab), 'line one\nline two');

  await h.json('type', { selector: '#ce', text: ' appended', tabId: tab });
  assert.equal(await evalValue("document.getElementById('ce').textContent", tab), 'old text appended');
  await h.json('type', { selector: '#ce', text: 'fresh', clear: true, tabId: tab });
  assert.equal(await evalValue("document.getElementById('ce').textContent", tab), 'fresh');

  await h.json('type', { selector: '#ce', text: 'trusted', clear: true, trusted: true, tabId: tab });
  assert.equal(await evalUntil<string>("document.getElementById('ce').textContent", tab, (v) => v === 'trusted'), 'trusted');
  await h.json('tab_close', { tabId: tab });
});

test('type trusted:true sends real input; clear works with it', { skip }, async () => {
  const tab = await openExtra('/editors');
  await h.json('type', { selector: '#field', text: 'abc', tabId: tab });
  assert.match(await textAt('#log', tab), /in:S/, 'a plain type is a synthetic input event');
  await h.json('type', { selector: '#field', text: 'xyz', clear: true, trusted: true, tabId: tab });
  assert.equal(await evalUntil<string>("document.getElementById('field').value", tab, (v) => v === 'xyz'), 'xyz');
  assert.match(await textAt('#log', tab), /in:T/, 'trusted:true reaches the page as isTrusted input');
  await h.json('tab_close', { tabId: tab });
});

test('type pressEnter with trusted:true fires a real Enter on the field', { skip }, async () => {
  const tab = await openExtra('/enter-form');
  await h.json('type', { selector: '#q', text: 'query', trusted: true, pressEnter: true, tabId: tab });
  assert.equal(await evalValue("document.getElementById('q').value", tab), 'query');
  assert.equal(await evalUntil<string>("document.getElementById('out').dataset.enter || ''", tab, (v) => v === 'yes'), 'yes');
  await h.json('tab_close', { tabId: tab });
});

test(
  'type pressEnter with trusted:true submits a one-field form',
  { skip },
  async () => {
    const tab = await openExtra('/enter-form');
    await h.json('type', { selector: '#q', text: 'query', trusted: true, pressEnter: true, tabId: tab });
    const out = await evalUntil<string>("document.getElementById('out').textContent", tab, (v) => v !== '', 2_000);
    await h.json('tab_close', { tabId: tab });
    assert.equal(out, 'SUBMITTED:query', 'Enter in the only field of a form submits it');
  },
);

test(
  'type pressEnter without trusted presses Enter after the text',
  { skip },
  async () => {
    const tab = await openExtra('/enter-form');
    await h.json('type', { selector: '#q', text: 'plain', pressEnter: true, tabId: tab });
    assert.equal(await evalValue("document.getElementById('q').value", tab), 'plain');
    const enter = await evalUntil<string>("document.getElementById('out').dataset.enter || ''", tab, (v) => v === 'yes', 1_500);
    await h.json('tab_close', { tabId: tab });
    assert.equal(enter, 'yes', 'pressEnter must fire an Enter keydown on the field');
  },
);

test(
  'type keyEvents:true fires a keydown per character',
  { skip },
  async () => {
    const tab = await openExtra('/editors');
    await h.json('type', { selector: '#field', text: 'hey', keyEvents: true, tabId: tab });
    assert.equal(await evalValue("document.getElementById('field').value", tab), 'hey');
    const log = await textAt('#log', tab);
    await h.json('tab_close', { tabId: tab });
    assert.match(log, /kd:h;.*kd:e;.*kd:y;/, `per-character keydowns expected, log was "${log}"`);
  },
);

// ---------------------------------------------------------------- press

test('press sends the key to the focused element', { skip }, async () => {
  const tab = await h.open('/form');
  await h.json('click', { selector: '#keys', tabId: tab, trusted: true });
  assert.equal(await evalUntil<string>('document.activeElement.id', tab, (v) => v === 'keys'), 'keys');
  await h.json('press', { key: 'a', tabId: tab });
  assert.equal(await textAt('#keyout', tab), 'a');
  await h.json('press', { key: 'Escape', tabId: tab });
  assert.equal(await textAt('#keyout', tab), 'Escape');
  await h.json('tab_close', { tabId: tab });
});

test(
  'press with modifiers sets the modifier flags on the key event',
  { skip },
  async () => {
    const tab = await openExtra('/mods');
    await h.json('click', { selector: '#k', tabId: tab, trusted: true });
    await evalUntil<string>('document.activeElement.id', tab, (v) => v === 'k');
    await h.json('press', { key: 'k', modifiers: ['Control', 'Shift'], tabId: tab });
    const got = await textAt('#kout', tab);
    await h.json('tab_close', { tabId: tab });
    assert.equal(got, 'k:CS', 'Control+Shift must reach the page');
  },
);

// ---------------------------------------------------------------- hover

test('hover fires mouseenter on the element', { skip }, async () => {
  const tab = await h.open('/form');
  await h.json('hover', { selector: '#hoverme', tabId: tab });
  assert.equal(await textAt('#hoverme', tab), 'HOVERED');
  await h.json('tab_close', { tabId: tab });
});

// ---------------------------------------------------------------- scroll

test('scroll by deltaY, to coordinates, and to an element', { skip }, async () => {
  const tab = await h.open('/long');
  assert.equal(await evalValue('window.scrollY', tab), 0);
  await h.json('scroll', { deltaY: 600, tabId: tab });
  assert.equal(await evalUntil<number>('window.scrollY', tab, (v) => v === 600), 600);
  await h.json('scroll', { deltaY: 400, tabId: tab });
  assert.equal(await evalUntil<number>('window.scrollY', tab, (v) => v === 1000), 1000, 'deltaY is relative');
  await h.json('scroll', { x: 0, y: 0, tabId: tab });
  assert.equal(await evalUntil<number>('window.scrollY', tab, (v) => v === 0), 0);

  await h.json('scroll', { selector: '#bottom', tabId: tab });
  const y = await evalUntil<number>('window.scrollY', tab, (v) => v > 4000);
  assert.ok(y > 4000, `scrolled down to #bottom (scrollY=${y})`);
  const inView = await evalValue<boolean>(
    "(() => { const r = document.getElementById('bottom').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()",
    tab,
  );
  assert.equal(inView, true, '#bottom is in the viewport');
  await h.json('tab_close', { tabId: tab });
});

// ---------------------------------------------------------------- select_option

test('select_option by value and by visible label', { skip }, async () => {
  const tab = await h.open('/form');
  await h.json('select_option', { selector: '#color', values: ['blue'], tabId: tab });
  assert.equal(await evalValue("document.getElementById('color').value", tab), 'blue');
  await h.json('select_option', { selector: '#color', values: ['Red'], tabId: tab });
  assert.equal(await evalValue("document.getElementById('color').value", tab), 'red');

  const none = await h.call('select_option', { selector: '#color', values: ['purple'], tabId: tab });
  assert.equal(none.isError, true, 'an option that does not exist is an error');
  assert.match(textOf(none), /SELECTOR_NOT_FOUND/);
  await h.json('tab_close', { tabId: tab });
});

test('select_option selects several options of a multiple select', { skip }, async () => {
  const tab = await openExtra('/multi');
  await h.json('select_option', { selector: '#m', values: ['a', 'Gamma'], tabId: tab });
  const picked = "Array.from(document.getElementById('m').selectedOptions).map((o) => o.value).join(',')";
  assert.equal(await evalValue(picked, tab), 'a,g');
  await h.json('select_option', { selector: '#m', values: ['b'], tabId: tab });
  assert.equal(await evalValue(picked, tab), 'b', 'a new call replaces the selection');
  await h.json('tab_close', { tabId: tab });
});

// ---------------------------------------------------------------- fill_form

test('fill_form fills the whole form, submits it, and the values arrive', { skip }, async () => {
  const tab = await h.open('/form');
  const r = await h.json<{ filled: number; submitted: boolean }>('fill_form', {
    tabId: tab,
    fields: {
      '#name': 'Ada',
      '#email': 'ada@example.com',
      '#color': 'blue',
      '#agree': true,
      '#notes': 'some notes',
    },
    submitSelector: '#send',
  });
  assert.deepEqual(r, { filled: 5, submitted: true });
  assert.equal(await textAt('#out', tab), 'SENT:Ada:blue:yes');
  const vals = await evalValue<string>(
    "['email','notes'].map((id) => document.getElementById(id).value).join('|')",
    tab,
  );
  assert.equal(vals, 'ada@example.com|some notes');
  await h.json('tab_close', { tabId: tab });
});

test('a plain form submit after type/click/select_option carries the values', { skip }, async () => {
  const tab = await h.open('/form');
  await h.json('type', { selector: '#name', text: 'Grace', tabId: tab });
  await h.json('select_option', { selector: '#color', values: ['red'], tabId: tab });
  await h.json('click', { selector: '#send', tabId: tab });
  assert.equal(await textAt('#out', tab), 'SENT:Grace:red:no');
  await h.json('tab_close', { tabId: tab });
});

test(
  'fill_form with a false checkbox leaves an unchecked box unchecked',
  { skip },
  async () => {
    const tab = await h.open('/form');
    await h.json('fill_form', { tabId: tab, fields: { '#name': 'Ada', '#agree': false }, submitSelector: '#send' });
    const out = await textAt('#out', tab);
    await h.json('tab_close', { tabId: tab });
    assert.equal(out, 'SENT:Ada:red:no', 'agree:false must not tick the box');
  },
);

// ---------------------------------------------------------------- draw

test('draw sends real mouse strokes onto a canvas', { skip }, async () => {
  const tab = await openExtra('/canvas');
  const r = await h.json<{ ok: boolean; strokes: number; points: number }>('draw', {
    tabId: tab,
    strokes: [
      { points: [{ x: 20, y: 20 }, { x: 60, y: 40 }, { x: 100, y: 60 }, { x: 140, y: 80 }] },
      { points: [{ x: 200, y: 200 }, { x: 250, y: 150 }] },
    ],
  });
  assert.deepEqual(r, { ok: true, strokes: 2, points: 6 });
  const st = await evalUntil<{ down: number; moves: number; up: number; pts: number[][] }>(
    "JSON.parse(document.getElementById('ev').textContent || '{}')",
    tab,
    (v) => v.up === 2,
  );
  assert.equal(st.down, 2, 'one press per stroke');
  assert.equal(st.up, 2, 'one release per stroke');
  assert.ok(st.moves >= 4, `the pen moved through the points (moves=${st.moves})`);
  assert.deepEqual(st.pts, [[20, 20], [140, 80], [200, 200], [250, 150]], 'strokes start and end where asked');
  const inked = await evalValue<number>(
    "(() => { const d = document.getElementById('c').getContext('2d').getImageData(0, 0, 400, 300).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; })()",
    tab,
  );
  assert.ok(inked > 50, `pixels were drawn on the canvas (${inked})`);

  const bad = await h.call('draw', { tabId: tab, strokes: [{ points: [{ x: 1, y: 1 }] }] });
  assert.equal(bad.isError, true, 'a stroke of one point is refused');
  await h.json('tab_close', { tabId: tab });
});

// ---------------------------------------------------------------- upload_file

test('upload_file sets a file from the uploads dir on the input', { skip }, async () => {
  const tab = await h.open('/upload');
  await h.json('upload_file', { selector: '#file', files: [join(h.uploadsDir, 'hello.txt')], tabId: tab });
  assert.equal(await evalUntil<string>("document.getElementById('picked').textContent", tab, (v) => v !== ''), 'hello.txt:12');
  await evalValue("document.getElementById('file').files[0].text().then((t) => { document.body.dataset.body = t; }), 1", tab);
  assert.equal(await evalUntil<string>("document.body.dataset.body || ''", tab, (v) => v !== ''), 'HELLO-UPLOAD', 'the page reads the real file contents');
  await h.json('tab_close', { tabId: tab });
});

test('upload_file refuses paths outside the uploads dir', { skip }, async () => {
  const tab = await h.open('/upload');
  for (const f of ['/etc/hosts', join(h.uploadsDir, '..', 'escape.txt'), join(h.dataDir, 'uploads-evil', 'x.txt')]) {
    const r = await h.call('upload_file', { selector: '#file', files: [f], tabId: tab });
    assert.equal(r.isError, true, `${f} must be refused`);
    assert.match(textOf(r), /outside the allowed uploads dir/);
  }
  const mixed = await h.call('upload_file', { selector: '#file', files: [join(h.uploadsDir, 'hello.txt'), '/etc/hosts'], tabId: tab });
  assert.equal(mixed.isError, true, 'one bad path refuses the whole call');
  assert.equal(await evalValue("document.getElementById('file').files.length", tab), 0, 'nothing was attached');
  await h.json('tab_close', { tabId: tab });
});
