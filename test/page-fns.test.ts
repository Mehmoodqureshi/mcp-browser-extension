/**
 * shared/page-fns.ts (`pageOp`) against a real DOM (headless Chromium, see
 * page-harness): every op the extension dispatches through it, including the
 * in-page waits, the miss suggestions, contenteditable handling, and the frame
 * offsets that let a CDP click land inside a same-origin iframe.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Frame } from 'playwright';

import type { PageOpArgs } from '../shared/page-fns';
import { ORIGIN, OTHER_ORIGIN, doc, hasChromium, openHarness, type PageHarness } from './page-harness';

let h: PageHarness;

before(async () => {
  if (hasChromium) h = await openHarness();
});
after(async () => {
  await h?.close();
});

type Out = Record<string, unknown> & { found: boolean };

function op(a: PageOpArgs, frame?: Frame): Promise<Out> {
  const target = frame ?? h.page;
  return target.evaluate(
    (args) =>
      (window as unknown as { __mcp: Record<string, { pageOp: (a: unknown) => unknown }> }).__mcp['page-fns'].pageOp(args) as Out,
    a,
  );
}

const evalPage = <T>(fn: () => T): Promise<T> => h.page.evaluate(fn);

test('probe, text and html read the page', { skip: !hasChromium }, async () => {
  await h.load('<div id="box" class="card"><p>Hello <b>world</b></p></div>', { title: 'Reads' });
  const probe = await op({ op: 'probe' });
  assert.equal(probe.found, true);
  assert.equal(probe.title, 'Reads');
  assert.match(String(probe.url), /^http:\/\/mcp\.test\/page/);

  assert.equal((await op({ op: 'text' })).text, 'Hello world');
  assert.equal((await op({ op: 'text', selector: '#box b' })).text, 'world');

  const inner = await op({ op: 'html', selector: '#box' });
  assert.equal(inner.html, '<p>Hello <b>world</b></p>');
  const outer = await op({ op: 'html', selector: '#box', outer: true });
  assert.match(String(outer.html), /^<div id="box" class="card">/);
  const whole = await op({ op: 'html' });
  assert.match(String(whole.html), /^<html>/, 'no selector: the whole document, outer');
});

test('a miss carries selector suggestions built from ids, test ids, names, labels and classes', { skip: !hasChromium }, async () => {
  await h.load(`
    <button id="submit-order">Order</button>
    <div data-testid="order-summary"></div>
    <input name="order_note">
    <span aria-label="order total"></span>
    <p class="order-footer x"></p>
    <i class="unrelated"></i>`);
  const miss = await op({ op: 'text', selector: '#order' });
  assert.equal(miss.found, false);
  assert.deepEqual(miss.suggestions, [
    '#submit-order',
    '[data-testid="order-summary"]',
    'input[name="order_note"]',
    'span[aria-label="order total"]',
    'p.order-footer',
  ]);

  const generic = await op({ op: 'html', selector: 'div > span' });
  assert.deepEqual(generic.suggestions, [], 'only tag-like words: nothing to match on');

  const noSel = await op({ op: 'click' });
  assert.deepEqual(noSel, { found: false }, 'no selector: a plain miss without suggestions');
});

test('suggestions stop at five and match words case-insensitively', { skip: !hasChromium }, async () => {
  await h.load(Array.from({ length: 8 }, (_, i) => `<div id="Menu-${i}"></div>`).join(''));
  const miss = await op({ op: 'text', selector: '.MENU' });
  assert.deepEqual(miss.suggestions, ['#Menu-0', '#Menu-1', '#Menu-2', '#Menu-3', '#Menu-4']);
});

test('a malformed selector is a miss, not an exception', { skip: !hasChromium }, async () => {
  await h.load('<button id="b">B</button>');
  const res = await op({ op: 'click', selector: ':::' });
  assert.equal(res.found, false);
});

test('click scrolls the element in and fires a real click', { skip: !hasChromium }, async () => {
  await h.load('<div style="height:3000px"></div><button id="b" onclick="this.dataset.n = String(Number(this.dataset.n || 0) + 1)">B</button>');
  assert.deepEqual(await op({ op: 'click', selector: '#b' }), { found: true });
  assert.equal(await evalPage(() => (document.getElementById('b') as HTMLElement).dataset.n), '1');
  assert.ok((await evalPage(() => window.scrollY)) > 0, 'scrolled into view');
});

test('type appends or clears, and fires input/change the way frameworks listen for them', { skip: !hasChromium }, async () => {
  await h.load('<input id="i" value="abc"><textarea id="t">x</textarea>');
  await evalPage(() => {
    const w = window as unknown as { events: string[] };
    w.events = [];
    const i = document.getElementById('i') as HTMLInputElement;
    i.addEventListener('input', () => w.events.push(`input:${i.value}`));
    i.addEventListener('change', () => w.events.push(`change:${i.value}`));
  });
  assert.equal((await op({ op: 'type', selector: '#i', text: 'def' })).found, true);
  assert.equal(await evalPage(() => (document.getElementById('i') as HTMLInputElement).value), 'abcdef');
  await op({ op: 'type', selector: '#i', text: 'new', clear: true });
  assert.equal(await evalPage(() => (document.getElementById('i') as HTMLInputElement).value), 'new');
  assert.deepEqual(await evalPage(() => (window as unknown as { events: string[] }).events), [
    'input:abcdef',
    'change:abcdef',
    'input:new',
    'change:new',
  ]);
  await op({ op: 'type', selector: '#t', clear: true });
  assert.equal(await evalPage(() => (document.getElementById('t') as HTMLTextAreaElement).value), '', 'clear with no text empties it');
  assert.equal(await evalPage(() => document.activeElement?.id), 't', 'the field is focused');
});

test('type goes through the prototype value setter (React-style instance overrides are bypassed)', { skip: !hasChromium }, async () => {
  await h.load('<input id="i">');
  await evalPage(() => {
    const i = document.getElementById('i') as HTMLInputElement;
    // A framework that shadows `value` on the instance would never see a plain assignment.
    Object.defineProperty(i, 'value', { configurable: true, get: () => 'shadowed', set: () => undefined });
  });
  await op({ op: 'type', selector: '#i', text: 'real', clear: true });
  const real = await evalPage(() => {
    const i = document.getElementById('i') as HTMLInputElement;
    return Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.get?.call(i);
  });
  assert.equal(real, 'real');
});

test('type into a contenteditable appends at the end, or replaces with clear', { skip: !hasChromium }, async () => {
  await h.load('<div id="ed" contenteditable="true">Hello</div>');
  await op({ op: 'type', selector: '#ed', text: ' there' });
  assert.equal(await evalPage(() => document.getElementById('ed')?.textContent), 'Hello there');
  await op({ op: 'type', selector: '#ed', text: 'Fresh', clear: true });
  assert.equal(await evalPage(() => document.getElementById('ed')?.textContent), 'Fresh');
  await op({ op: 'type', selector: '#ed', clear: true });
  assert.equal(await evalPage(() => document.getElementById('ed')?.textContent), '', 'clear with no text');
});

test('check clicks only when the state differs, and reports the resulting state', { skip: !hasChromium }, async () => {
  await h.load('<input type="checkbox" id="c"><input type="radio" name="r" id="r1" checked><input type="radio" name="r" id="r2">');
  await evalPage(() => {
    const w = window as unknown as { clicks: number };
    w.clicks = 0;
    document.getElementById('c')?.addEventListener('click', () => w.clicks++);
  });
  assert.deepEqual(await op({ op: 'check', selector: '#c' }), { found: true, checked: true }, 'checked defaults to true');
  assert.deepEqual(await op({ op: 'check', selector: '#c', checked: true }), { found: true, checked: true });
  assert.equal(await evalPage(() => (window as unknown as { clicks: number }).clicks), 1, 'already checked: no second click');
  assert.deepEqual(await op({ op: 'check', selector: '#c', checked: false }), { found: true, checked: false });
  assert.deepEqual(await op({ op: 'check', selector: '#r2' }), { found: true, checked: true });
  assert.equal(await evalPage(() => (document.getElementById('r1') as HTMLInputElement).checked), false, 'the radio group moved');
  assert.equal((await op({ op: 'check', selector: '#nope' })).found, false);
});

test('type with keyEvents sends key events per character and honours a cancelled keydown', { skip: !hasChromium }, async () => {
  await h.load('<input id="i" value="old">');
  await evalPage(() => {
    const w = window as unknown as { keys: string[] };
    w.keys = [];
    const i = document.getElementById('i') as HTMLInputElement;
    i.addEventListener('keydown', (e) => {
      w.keys.push(`down:${e.key}`);
      if (e.key === 'x') e.preventDefault();
    });
    i.addEventListener('keyup', (e) => w.keys.push(`up:${e.key}`));
  });
  await op({ op: 'type', selector: '#i', text: 'axb', clear: true, keyEvents: true });
  assert.equal(await evalPage(() => (document.getElementById('i') as HTMLInputElement).value), 'ab', 'the cancelled key is not typed');
  assert.deepEqual(await evalPage(() => (window as unknown as { keys: string[] }).keys), ['down:a', 'up:a', 'down:x', 'up:x', 'down:b', 'up:b']);
});

test('type with pressEnter submits the field form like a person would', { skip: !hasChromium }, async () => {
  await h.load('<form id="f"><input id="q" name="q"></form><input id="loose">');
  await evalPage(() => {
    const w = window as unknown as { submitted: string[] };
    w.submitted = [];
    (document.getElementById('f') as HTMLFormElement).addEventListener('submit', (e) => {
      e.preventDefault();
      w.submitted.push((document.getElementById('q') as HTMLInputElement).value);
    });
  });
  assert.deepEqual(await op({ op: 'type', selector: '#q', text: 'search me', pressEnter: true }), { found: true });
  assert.deepEqual(await evalPage(() => (window as unknown as { submitted: string[] }).submitted), ['search me']);
  assert.deepEqual(await op({ op: 'type', selector: '#loose', text: 'x', pressEnter: true }), { found: true }, 'no form: nothing to submit');
});

test('focus focuses, and with clear empties an input or a contenteditable', { skip: !hasChromium }, async () => {
  await h.load('<input id="i" value="old"><div id="ed" contenteditable="true">old text</div>');
  assert.equal((await op({ op: 'focus', selector: '#i' })).found, true);
  assert.equal(await evalPage(() => document.activeElement?.id), 'i');
  assert.equal(await evalPage(() => (document.getElementById('i') as HTMLInputElement).value), 'old', 'no clear: untouched');
  await op({ op: 'focus', selector: '#i', clear: true });
  assert.equal(await evalPage(() => (document.getElementById('i') as HTMLInputElement).value), '');

  await op({ op: 'focus', selector: '#ed' });
  assert.equal(await evalPage(() => document.activeElement?.id), 'ed');
  assert.equal(await evalPage(() => document.getElementById('ed')?.textContent), 'old text');
  await op({ op: 'focus', selector: '#ed', clear: true });
  assert.equal(await evalPage(() => document.getElementById('ed')?.textContent), '');
  // The caret is left inside the editor, so following keystrokes land there.
  await h.page.keyboard.insertText('typed');
  assert.equal(await evalPage(() => document.getElementById('ed')?.textContent), 'typed');
});

test('point returns the element centre in top-viewport coordinates', { skip: !hasChromium }, async () => {
  await h.load('<button id="b" style="position:absolute;left:100px;top:50px;width:40px;height:20px">B</button>');
  const p = await op({ op: 'point', selector: '#b' });
  assert.deepEqual(p, { found: true, x: 120, y: 60, exact: true });
});

test('point inside a same-origin iframe adds the frame offset; a cross-origin parent is not exact', { skip: !hasChromium }, async () => {
  const frameBody = '<button id="fb" style="position:absolute;left:10px;top:10px;width:20px;height:20px">F</button>';
  h.serve(`${ORIGIN}/frame`, doc(frameBody));
  h.serve(`${OTHER_ORIGIN}/frame`, doc(frameBody));
  await h.load(`
    <iframe src="${ORIGIN}/frame" style="position:absolute;left:200px;top:100px;width:300px;height:200px;border:0"></iframe>
    <iframe src="${OTHER_ORIGIN}/frame" style="position:absolute;left:600px;top:100px;width:300px;height:200px;border:0"></iframe>`);
  const same = h.page.frames().find((f) => f.url() === `${ORIGIN}/frame`);
  const cross = h.page.frames().find((f) => f.url() === `${OTHER_ORIGIN}/frame`);
  assert.ok(same && cross);
  await same.waitForFunction(() => !!(window as unknown as { __mcp?: unknown }).__mcp);
  await cross.waitForFunction(() => !!(window as unknown as { __mcp?: unknown }).__mcp);

  assert.deepEqual(await op({ op: 'point', selector: '#fb' }, same), { found: true, x: 220, y: 120, exact: true });
  const x = await op({ op: 'point', selector: '#fb' }, cross);
  assert.equal(x.exact, false, 'a cross-origin parent hides frameElement, so the point is frame-local');
  assert.equal(x.x, 20);

  const m = await op({ op: 'measure', selector: '#fb' }, same);
  assert.deepEqual(m.element, { x: 210, y: 110, w: 20, h: 20 });
  assert.equal(m.exact, true);
});

test('hover dispatches mouseover and mouseenter', { skip: !hasChromium }, async () => {
  await h.load('<div id="h">H</div>');
  await evalPage(() => {
    const w = window as unknown as { seen: string[] };
    w.seen = [];
    const el = document.getElementById('h') as HTMLElement;
    el.addEventListener('mouseover', () => w.seen.push('over'));
    el.addEventListener('mouseenter', () => w.seen.push('enter'));
  });
  assert.deepEqual(await op({ op: 'hover', selector: '#h' }), { found: true });
  assert.deepEqual(await evalPage(() => (window as unknown as { seen: string[] }).seen), ['over', 'enter']);
  assert.deepEqual(await op({ op: 'hover', selector: '#gone' }), { found: false, suggestions: [] });
});

test('select matches options by value, label or text and reports when nothing matched', { skip: !hasChromium }, async () => {
  await h.load(`
    <select id="s" multiple>
      <option value="pk">Pakistan</option>
      <option value="de" label="Germany (DE)">Germany</option>
      <option value="fr">France</option>
    </select>
    <div id="notselect"></div>`);
  const r = await op({ op: 'select', selector: '#s', values: ['pk', 'Germany (DE)'] });
  assert.deepEqual(r, { found: true, matched: true });
  assert.deepEqual(
    await evalPage(() => Array.from((document.getElementById('s') as HTMLSelectElement).selectedOptions).map((o) => o.value)),
    ['pk', 'de'],
  );
  await op({ op: 'select', selector: '#s', values: ['France'] });
  assert.deepEqual(
    await evalPage(() => Array.from((document.getElementById('s') as HTMLSelectElement).selectedOptions).map((o) => o.value)),
    ['fr'],
    'by visible text, and previous choices are cleared',
  );
  assert.deepEqual(await op({ op: 'select', selector: '#s', values: ['Narnia'] }), { found: true, matched: false });
  assert.equal((await op({ op: 'select', selector: '#notselect', values: ['x'] })).found, false, 'not a select element');
});

test('measure reports viewport and document dimensions, and an element box in document coordinates', { skip: !hasChromium }, async () => {
  await h.page.setViewportSize({ width: 800, height: 600 });
  await h.load('<div style="height:2000px;width:10px"></div><div id="m" style="width:50px;height:30px">M</div>');
  const plain = await op({ op: 'measure' });
  const dims = plain.dims as Record<string, number>;
  assert.equal(dims.w, 800);
  assert.equal(dims.h, 600);
  assert.ok(dims.fullH >= 2000);
  assert.equal(dims.dpr, 1);
  assert.equal(plain.element, null);
  assert.equal(plain.missing, false);

  const missing = await op({ op: 'measure', selector: '#nope' });
  assert.equal(missing.found, true, 'measure always answers with dims');
  assert.equal(missing.missing, true);

  const el = await op({ op: 'measure', selector: '#m' });
  const box = el.element as Record<string, number>;
  assert.equal(box.w, 50);
  assert.equal(box.h, 30);
  assert.equal(box.y, 2008, 'document y = viewport top + scroll (body margin 8px)');
  assert.equal(el.exact, true);
});

test('scroll by element, to coordinates, or by a delta', { skip: !hasChromium }, async () => {
  await h.page.setViewportSize({ width: 800, height: 600 });
  await h.load('<div style="height:5000px;width:5000px"></div><div id="end">End</div>');
  assert.deepEqual(await op({ op: 'scroll', x: 0, y: 1000 }), { found: true });
  assert.equal(await evalPage(() => window.scrollY), 1000);
  await op({ op: 'scroll', deltaY: 250 });
  assert.equal(await evalPage(() => window.scrollY), 1250);
  await op({ op: 'scroll', y: 10 });
  assert.equal(await evalPage(() => window.scrollY), 10, 'missing x defaults to 0');
  await op({ op: 'scroll', deltaX: 30 });
  assert.equal(await evalPage(() => window.scrollX), 30);
  assert.deepEqual(await op({ op: 'scroll', selector: '#end' }), { found: true });
  assert.ok((await evalPage(() => window.scrollY)) > 4000);
  const miss = await op({ op: 'scroll', selector: '#nope' });
  assert.equal(miss.found, false);
});

test('storage: set, get, list, remove and clear, in local and session storage', { skip: !hasChromium }, async () => {
  await h.load('');
  await evalPage(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  assert.deepEqual(await op({ op: 'storage', storageOp: 'set', key: 'a', value: '1' }), { found: true, ok: true });
  await op({ op: 'storage', storageOp: 'set', key: 'b', value: null });
  await op({ op: 'storage', storageOp: 'set', key: 's', value: 'sess', session: true });
  assert.deepEqual(await op({ op: 'storage', storageOp: 'get', key: 'a' }), { found: true, ok: true, value: '1' });
  assert.deepEqual(await op({ op: 'storage', storageOp: 'get', key: 'missing' }), { found: true, ok: true, value: null });
  assert.deepEqual(await op({ op: 'storage', storageOp: 'get' }), { found: true, ok: true, entries: { a: '1', b: '' } });
  assert.deepEqual(await op({ op: 'storage', storageOp: 'get', session: true }), { found: true, ok: true, entries: { s: 'sess' } });
  await op({ op: 'storage', storageOp: 'remove', key: 'a' });
  assert.deepEqual((await op({ op: 'storage', storageOp: 'get' })).entries, { b: '' });
  await op({ op: 'storage', storageOp: 'clear' });
  assert.deepEqual((await op({ op: 'storage', storageOp: 'get' })).entries, {});
  assert.deepEqual((await op({ op: 'storage', storageOp: 'get', session: true })).entries, { s: 'sess' }, 'session untouched');
});

test('waitSelector resolves when the element appears, and misses with suggestions on timeout', { skip: !hasChromium }, async () => {
  await h.load('<div id="slot-host"></div>');
  await evalPage(() => {
    setTimeout(() => {
      (document.getElementById('slot-host') as HTMLElement).innerHTML = '<span id="late">Late</span>';
    }, 60);
  });
  assert.deepEqual(await op({ op: 'waitSelector', selector: '#late', timeoutMs: 2_000, interval: 10 }), { found: true });
  const miss = await op({ op: 'waitSelector', selector: '.slot', timeoutMs: 40, interval: 10 });
  assert.equal(miss.found, false);
  assert.deepEqual(miss.suggestions, ['#slot-host']);
});

test('waitFor: text appearing, a selector going away, and a timeout that reports matched false', { skip: !hasChromium }, async () => {
  await h.load('<div id="spinner">Loading</div>');
  await evalPage(() => {
    setTimeout(() => {
      document.getElementById('spinner')?.remove();
      document.body.insertAdjacentHTML('beforeend', '<p>Ready now</p>');
    }, 60);
  });
  assert.deepEqual(await op({ op: 'waitFor', textContains: 'Ready', timeoutMs: 2_000, interval: 10 }), { found: true, matched: true });
  assert.deepEqual(await op({ op: 'waitFor', selector: '#spinner', gone: true, timeoutMs: 2_000, interval: 10 }), { found: true, matched: true });
  assert.deepEqual(await op({ op: 'waitFor', selector: 'p', timeoutMs: 500, interval: 10 }), { found: true, matched: true });
  assert.deepEqual(await op({ op: 'waitFor', textContains: 'Never', timeoutMs: 40, interval: 10 }), { found: true, matched: false });
  assert.deepEqual(await op({ op: 'waitFor', timeoutMs: 40 }), { found: true, matched: true }, 'nothing to wait for: matched at once');
  assert.deepEqual(await op({ op: 'waitFor', gone: true, timeoutMs: 40, interval: 10 }), { found: true, matched: false });
});

test('element ops wait for a late target in the same injection when timeoutMs is set', { skip: !hasChromium }, async () => {
  await h.load('<div id="slot"></div>');
  await evalPage(() => {
    setTimeout(() => {
      (document.getElementById('slot') as HTMLElement).innerHTML = '<button id="later" onclick="this.textContent=\'clicked\'">Go</button>';
    }, 60);
  });
  assert.deepEqual(await op({ op: 'click', selector: '#later', timeoutMs: 2_000, interval: 10 }), { found: true });
  assert.equal(await evalPage(() => document.getElementById('later')?.textContent), 'clicked');

  const miss = await op({ op: 'text', selector: '.slot', timeoutMs: 40, interval: 10 });
  assert.equal(miss.found, false);
  assert.deepEqual(miss.suggestions, ['#slot']);
});

test('elements inside open shadow roots are reachable by every op', { skip: !hasChromium }, async () => {
  await h.load('<div id="host"></div>');
  await evalPage(() => {
    const root = (document.getElementById('host') as HTMLElement).attachShadow({ mode: 'open' });
    root.innerHTML = '<input id="deep" value="">';
  });
  await op({ op: 'type', selector: '#deep', text: 'shadow text' });
  assert.equal(
    await evalPage(() => ((document.getElementById('host') as HTMLElement).shadowRoot?.getElementById('deep') as HTMLInputElement).value),
    'shadow text',
  );
});

test('an unknown op is reported, not thrown', { skip: !hasChromium }, async () => {
  await h.load('');
  const res = await op({ op: 'explode' as PageOpArgs['op'] });
  assert.deepEqual(res, { found: false, error: 'unknown page op: explode' });
});
