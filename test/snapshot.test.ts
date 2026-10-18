/**
 * shared/snapshot.ts against a real DOM (headless Chromium, see page-harness).
 *
 * collectSnapshot is what both backends inject to describe a page to the
 * model, so these pin the parts a model relies on: which elements appear,
 * the role and accessible name each one gets, that hidden elements are left
 * out (by the native check AND the manual fallback walk), that password values
 * never leave the page, that refs are stamped where a later click can find
 * them, and the in-page locator scoring.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

import type { RawSnapshot, SnapshotLocator } from '../shared/snapshot';
import { hasChromium, openHarness, type PageHarness } from './page-harness';

let h: PageHarness;

before(async () => {
  if (hasChromium) h = await openHarness();
});
after(async () => {
  await h?.close();
});

function snap(interactiveOnly = true, max = 200, locator: SnapshotLocator | null = null): Promise<RawSnapshot> {
  return h.page.evaluate(
    ([i, m, l]) =>
      (window as unknown as { __mcp: { snapshot: { collectSnapshot: (...a: unknown[]) => RawSnapshot } } }).__mcp.snapshot.collectSnapshot(i, m, l),
    [interactiveOnly, max, locator] as const,
  );
}

const byName = (s: RawSnapshot, name: string) => s.nodes.find((n) => n.name === name);

const FORM = `
  <a href="/next">Next page</a>
  <button aria-label="  Close dialog ">x</button>
  <span id="l1">Billing</span><span id="l2">address</span>
  <input id="addr" aria-labelledby="l1 l2" value="1 Main St">
  <input placeholder="Search the site">
  <input type="submit" title="Send it" value="Go">
  <input type="button" value="Plain">
  <input type="checkbox" checked aria-label="Remember me">
  <input type="radio" aria-label="Option A">
  <input type="password" aria-label="Password" value="hunter2">
  <select aria-label="Country"><option value="pk" selected>Pakistan</option></select>
  <textarea aria-label="Notes">some notes</textarea>
  <button disabled>Disabled one</button>
  <div role="tab">Tab one</div>
  <div onclick="void 0">Clickable    div
     text</div>
  <div contenteditable="true" aria-label="Editor"></div>
  <a href="/img"><img alt="Logo image" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="10" height="10"></a>
`;

test('snapshot: roles, accessible names, values and state for every interactive kind', { skip: !hasChromium }, async () => {
  await h.load(FORM, { title: 'Form page' });
  const s = await snap();
  assert.equal(s.title, 'Form page');
  assert.match(s.url, /^http:\/\/mcp\.test\/page/);
  assert.equal(s.truncated, false);
  assert.equal(s.nearby, undefined, 'nearby only appears in locator mode');

  assert.deepEqual(
    s.nodes.map((n) => n.ref),
    s.nodes.map((_, i) => `e${i + 1}`),
    'plain snapshot refs are e1..eN in document order',
  );

  assert.equal(byName(s, 'Next page')?.role, 'link');
  assert.equal(byName(s, 'Close dialog')?.role, 'button', 'aria-label wins and is trimmed');
  const addr = byName(s, 'Billing address');
  assert.equal(addr?.role, 'textbox', 'aria-labelledby joins every referenced id');
  assert.equal(addr?.value, '1 Main St');
  assert.equal(byName(s, 'Search the site')?.role, 'textbox');
  assert.equal(byName(s, 'Send it')?.role, 'button', 'submit input is a button named by title');
  assert.equal(s.nodes.find((n) => n.tag === 'input' && n.value === 'Plain')?.role, 'button');
  const remember = byName(s, 'Remember me');
  assert.equal(remember?.role, 'checkbox');
  assert.equal(remember?.checked, true);
  assert.equal(byName(s, 'Option A')?.role, 'radio');
  assert.equal(byName(s, 'Option A')?.checked, undefined);
  assert.equal(byName(s, 'Country')?.role, 'combobox');
  assert.equal(byName(s, 'Country')?.value, 'pk');
  assert.equal(byName(s, 'Notes')?.role, 'textbox');
  assert.equal(byName(s, 'Notes')?.value, 'some notes');
  assert.equal(byName(s, 'Disabled one')?.disabled, true);
  assert.equal(byName(s, 'Tab one')?.role, 'tab', 'explicit role wins');
  const clickable = byName(s, 'Clickable div text');
  assert.ok(clickable, 'innerText whitespace is collapsed');
  assert.equal(clickable.role, 'div', 'an onclick div falls back to its tag as the role');
  assert.equal(byName(s, 'Editor')?.tag, 'div');
  assert.equal(byName(s, 'Logo image')?.role, 'link', 'an image-only link is named by its alt');
});

test('snapshot: a password field is flagged secret and its value never leaves the page', { skip: !hasChromium }, async () => {
  await h.load(FORM);
  const s = await snap();
  const pw = byName(s, 'Password');
  assert.ok(pw);
  assert.equal(pw.secret, true);
  assert.equal(pw.value, undefined);
  assert.ok(!JSON.stringify(s).includes('hunter2'));
});

test('snapshot: refs are stamped on the elements so a selector can find them', { skip: !hasChromium }, async () => {
  await h.load(FORM);
  const s = await snap();
  const close = byName(s, 'Close dialog');
  assert.ok(close);
  const label = await h.page.getAttribute(`[data-mcp-ref="${close.ref}"]`, 'aria-label');
  assert.equal(label?.trim(), 'Close dialog');
  // A second snapshot re-stamps from e1 again.
  const again = await snap();
  assert.equal(again.nodes[0].ref, 'e1');
});

const HIDDEN = `
  <button>Shown</button>
  <button style="display:none">DisplayNone</button>
  <button style="visibility:hidden">VisHidden</button>
  <div style="display:none"><button>InsideHiddenParent</button></div>
  <div style="visibility:hidden"><a href="/x">InsideInvisibleParent</a></div>
  <button style="width:0;height:0;padding:0;border:0;overflow:hidden;display:block"></button>
  <button style="position:fixed;top:0;left:0">FixedOne</button>
`;

test('snapshot: hidden and zero-size elements are left out (native checkVisibility path)', { skip: !hasChromium }, async () => {
  await h.load(HIDDEN);
  const names = (await snap()).nodes.map((n) => n.name);
  assert.deepEqual(names, ['Shown', 'FixedOne']);
});

test('snapshot: the manual visibility walk agrees when checkVisibility is unavailable', { skip: !hasChromium }, async () => {
  await h.load(HIDDEN);
  await h.page.evaluate(() => {
    delete (Element.prototype as unknown as { checkVisibility?: unknown }).checkVisibility;
  });
  const names = (await snap()).nodes.map((n) => n.name);
  assert.deepEqual(names, ['Shown', 'FixedOne']);
});

test('snapshot: a throwing checkVisibility falls through to the manual walk', { skip: !hasChromium }, async () => {
  await h.load(HIDDEN);
  await h.page.evaluate(() => {
    (Element.prototype as unknown as { checkVisibility: () => boolean }).checkVisibility = () => {
      throw new Error('boom');
    };
  });
  const names = (await snap()).nodes.map((n) => n.name);
  assert.deepEqual(names, ['Shown', 'FixedOne']);
});

test('snapshot: landmarks only when interactiveOnly is false', { skip: !hasChromium }, async () => {
  await h.load('<header>Top</header><nav><a href="/a">Home</a></nav><main><h1>Title</h1><h2>Sub</h2><button>Act</button></main>');
  const interactive = await snap(true);
  assert.deepEqual(interactive.nodes.map((n) => n.tag), ['a', 'button']);
  const all = await snap(false);
  const tags = all.nodes.map((n) => n.tag);
  for (const t of ['header', 'nav', 'main', 'h1', 'h2', 'a', 'button']) assert.ok(tags.includes(t), `missing ${t}`);
  assert.equal(all.nodes.find((n) => n.tag === 'h1')?.name, 'Title');
  assert.equal(all.nodes.find((n) => n.tag === 'h1')?.role, 'h1');
});

test('snapshot: walks open shadow roots and stamps refs inside them', { skip: !hasChromium }, async () => {
  await h.load('<div id="host"></div><button>Light</button>');
  await h.page.evaluate(() => {
    const host = document.getElementById('host') as HTMLElement;
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<button>In shadow</button><div id="inner"></div>';
    const inner = root.getElementById('inner') as HTMLElement;
    inner.attachShadow({ mode: 'open' }).innerHTML = '<a href="/deep">Deeper</a>';
  });
  const s = await snap();
  const names = s.nodes.map((n) => n.name);
  assert.ok(names.includes('Light'));
  assert.ok(names.includes('In shadow'), 'one level of shadow DOM');
  assert.ok(names.includes('Deeper'), 'nested shadow DOM');
  const ref = byName(s, 'In shadow')?.ref;
  const stamped = await h.page.evaluate(
    (r) => !!document.getElementById('host')?.shadowRoot?.querySelector(`[data-mcp-ref="${r}"]`),
    ref,
  );
  assert.equal(stamped, true);
});

test('snapshot: max caps the returned nodes', { skip: !hasChromium }, async () => {
  await h.load(Array.from({ length: 6 }, (_, i) => `<button>B${i}</button>`).join(''));
  const s = await snap(true, 3);
  assert.deepEqual(s.nodes.map((n) => n.name), ['B0', 'B1', 'B2']);
});

test(
  'snapshot: truncated is true when the page had more elements than max',
  {
    skip: !hasChromium,
  },
  async () => {
    await h.load(Array.from({ length: 6 }, (_, i) => `<button>B${i}</button>`).join(''));
    const s = await snap(true, 3);
    assert.equal(s.nodes.length, 3);
    assert.equal(s.truncated, true, '3 of 6 visible buttons were returned');
  },
);

const LOCATE = `
  <button>Sign in</button>
  <button>sign in</button>
  <button>Sign in with Google</button>
  <button>Please Sign in now</button>
  <a href="/si">Sign in</a>
  <button aria-label=""></button>
  <button>Cancel</button>
`;

test('snapshot locator: only the strongest tier comes back, with a distinct ref prefix', { skip: !hasChromium }, async () => {
  await h.load(LOCATE);
  const exact = await snap(true, 200, { role: 'button', name: 'Sign in' });
  assert.deepEqual(exact.nodes.map((n) => n.name), ['Sign in'], 'exact match beats case-insensitive, prefix and contains');
  assert.match(exact.nodes[0].ref, /^l[0-9a-z]{1,4}-1$/, 'locator refs never collide with e1..eN');
  assert.equal(exact.truncated, false);
  const stamped = await h.page.textContent(`[data-mcp-ref="${exact.nodes[0].ref}"]`);
  assert.equal(stamped, 'Sign in', 'the locator ref is stamped on the matched element');

  const ci = await snap(true, 200, { role: 'button', name: 'SIGN IN' });
  assert.deepEqual(ci.nodes.map((n) => n.name), ['Sign in', 'sign in'], 'case-insensitive tier');

  const prefix = await snap(true, 200, { role: 'button', name: 'sign in with' });
  assert.deepEqual(prefix.nodes.map((n) => n.name), ['Sign in with Google']);

  const contains = await snap(true, 200, { role: 'button', name: 'in now' });
  assert.deepEqual(contains.nodes.map((n) => n.name), ['Please Sign in now']);

  const anyRole = await snap(true, 200, { name: 'Sign in' });
  assert.deepEqual(anyRole.nodes.map((n) => n.role), ['button', 'link'], 'no role: every role competes');

  const roleOnly = await snap(true, 200, { role: 'LINK' });
  assert.deepEqual(roleOnly.nodes.map((n) => n.name), ['Sign in'], 'role compared case-insensitively; no name means all of that role');
});

test('snapshot locator: a miss returns nothing plus up to 8 same-role neighbours', { skip: !hasChromium }, async () => {
  await h.load(LOCATE + Array.from({ length: 6 }, (_, i) => `<button>Extra ${i}</button>`).join(''));
  const miss = await snap(true, 200, { role: 'button', name: 'Log out' });
  assert.deepEqual(miss.nodes, []);
  assert.ok(miss.nearby);
  assert.equal(miss.nearby.length, 8, 'nearby is capped at 8');
  assert.equal(miss.nearby[0], 'button "Sign in"');
  assert.ok(!miss.nearby.some((n) => n.startsWith('link')), 'only the wanted role');

  const noName = await snap(true, 200, { role: 'checkbox' });
  assert.deepEqual(noName.nodes, []);
  assert.deepEqual(noName.nearby, [], 'no element of that role at all');
});

test('snapshot locator: an empty locator behaves like a plain snapshot', { skip: !hasChromium }, async () => {
  await h.load(LOCATE);
  const s = await snap(true, 200, {});
  assert.equal(s.nodes[0].ref, 'e1');
  assert.equal(s.nearby, undefined);
});
