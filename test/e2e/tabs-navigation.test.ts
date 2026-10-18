/**
 * Tabs and navigation against the real extension: opening, picking and closing
 * tabs, moving through history, waiting on pages, listing frames and spotting a
 * sign-in wall. Throughout, calls without a tabId must land on the agent's own
 * tab and the tab the person is looking at must never change on its own.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';

import { RUN_E2E, startHarness, textOf, type Harness } from './harness';
import { resetWorkTab } from '../../src/mcp/tools';

let h: Harness;
const skip = !RUN_E2E;

/**
 * A second fixture server on 127.0.0.1 (the allowlist matches the host, not the
 * port) for pages whose timing the shared harness does not control: /dcl parses
 * at once but its load event waits on a slow image, so domcontentloaded and
 * load finish at clearly different times.
 */
let extra: Server;
let extraBase = '';
const IMG_DELAY_MS = 1500;

function startExtra(): Promise<void> {
  extra = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/slow-img') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'image/gif', 'cache-control': 'no-store' });
        res.end(Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'));
      }, IMG_DELAY_MS);
      return;
    }
    if (path === '/dcl') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(`<!doctype html><title>DCL</title><p id="dcl">DCL-PAGE</p><img src="/slow-img?${Date.now()}">`);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  return new Promise((resolve) =>
    extra.listen(0, '127.0.0.1', () => {
      const addr = extra.address();
      extraBase = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      resolve();
    }),
  );
}

/** The id of the tab the person is looking at, read from Chrome itself. */
const activeTabId = (): Promise<number | undefined> =>
  h.inSw(async () => {
    type Tabs = { tabs: { query(q: object): Promise<{ id?: number }[]> } };
    const c = (globalThis as unknown as { chrome: Tabs }).chrome;
    const [t] = await c.tabs.query({ active: true, lastFocusedWindow: true });
    return t?.id;
  });

/** Every open tab id, including about:blank ones that tabs_list leaves out. */
const allTabIds = (): Promise<number[]> =>
  h.inSw(async () => {
    type Tabs = { tabs: { query(q: object): Promise<{ id?: number }[]> } };
    const c = (globalThis as unknown as { chrome: Tabs }).chrome;
    return (await c.tabs.query({})).map((t) => t.id ?? -1);
  });

/** Chrome's own numeric id inside a minted "ext:<session>:<id>" handle. */
const rawId = (tabId: string): number => Number(tabId.split(':').pop());

/** Put the person on a real page of their own, so a misrouted call is visible. */
async function personOn(path: string): Promise<void> {
  const [page] = h.ctx.pages();
  await page.goto(h.base + path);
  await page.bringToFront();
}

const personUrl = (): string => h.ctx.pages()[0].url();

interface TabInfo {
  tabId: string;
  url: string;
  title: string;
  active: boolean;
  index: number;
}

/**
 * Wait until the tab really shows `url` and has finished loading. Tests that are
 * about something else settle the tab first, so a slow fixture cannot make them
 * depend on navigation timing that other tests cover.
 */
async function settle(url: string, tabId?: string): Promise<void> {
  const want = `${url} complete`;
  let seen = '';
  for (const deadline = Date.now() + 10_000; Date.now() < deadline; ) {
    const r = await h.call('eval', { expression: 'location.href + " " + document.readyState', ...(tabId ? { tabId } : {}) });
    if (!r.isError) {
      seen = String((JSON.parse(textOf(r)) as { value: unknown }).value);
      if (seen === want) return;
    }
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error(`tab never settled on ${url} (last saw "${seen}")`);
}

/** navigate the agent tab, then settle on the destination. */
async function go(url: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const nav = await h.json('navigate', { url, ...args });
  await settle(url, args.tabId as string | undefined);
  return nav;
}

/** A fresh agent tab settled on `path`. */
async function agentTabAt(path: string): Promise<string> {
  const tab = await h.json<{ tabId: string }>('tab_new', {});
  await go(h.base + path);
  return tab.tabId;
}

/** Close every tab the agent opened, so each test starts from the person's tab alone. */
async function closeAgentTabs(): Promise<void> {
  const mine = await activeTabId();
  const ids = await allTabIds();
  for (const id of ids) {
    if (id === mine) continue;
    await h.sw.evaluate((i: number) => (globalThis as unknown as { chrome: { tabs: { remove(i: number): Promise<void> } } }).chrome.tabs.remove(i).catch(() => undefined), id);
  }
  resetWorkTab();
}

before(async () => {
  if (skip) return;
  await startExtra();
  h = await startHarness();
});
after(async () => {
  await h?.close();
  extra?.close();
});

test('tabs_list reports open pages with minted ids, urls, titles and which one is active', { skip }, async () => {
  await personOn('/form');
  const tab = await agentTabAt('/');
  const tabs = await h.json<TabInfo[]>('tabs_list');

  const agent = tabs.find((t) => t.tabId === tab);
  assert.ok(agent, 'the agent tab is listed');
  assert.equal(agent.url, `${h.base}/`);
  assert.equal(agent.title, 'Home');
  assert.equal(agent.active, false, 'a background tab is not the active one');
  assert.match(agent.tabId, /^ext:[^:]+:\d+$/);

  const person = tabs.find((t) => t.url === `${h.base}/form`);
  assert.ok(person, "the person's tab is listed too");
  assert.equal(person.active, true);
  assert.equal(rawId(person.tabId), await activeTabId());
  await closeAgentTabs();
});

test('tab_new with a url opens in the background and becomes the agent tab', { skip }, async () => {
  await personOn('/form');
  const mine = await activeTabId();
  const tab = await h.json<TabInfo & { reused: boolean }>('tab_new', { url: `${h.base}/links` });
  assert.equal(tab.reused, false);
  assert.equal(tab.active, false);
  assert.equal(await activeTabId(), mine, 'tab_new does not take the person off their tab');

  const text = await h.json<{ text: string }>('get_text', {});
  assert.match(text.text, /External/, 'a call without tabId reads the new tab');
  assert.equal(personUrl(), `${h.base}/form`);
  await closeAgentTabs();
});

test('tab_new with active:true brings the new tab to the front', { skip }, async () => {
  await personOn('/form');
  const tab = await h.json<TabInfo>('tab_new', { url: `${h.base}/`, active: true });
  assert.equal(tab.active, true);
  assert.equal(await activeTabId(), rawId(tab.tabId));
  await closeAgentTabs();
  await personOn('/form');
});

test(
  'tab_new({url}) returns once the tab is on that page, so tabs_list lists it at once',
  { skip },
  async () => {
    try {
      const tab = await h.json<TabInfo>('tab_new', { url: `${h.base}/slow` });
      assert.equal(tab.url, `${h.base}/slow`, 'the result names the page the tab is on');
      const listed = (await h.json<TabInfo[]>('tabs_list')).find((t) => t.tabId === tab.tabId);
      assert.ok(listed, 'the new agent tab is listed straight away');
    } finally {
      await closeAgentTabs();
    }
  },
);

test('tab_new without a url opens a blank background tab that navigate then fills', { skip }, async () => {
  await personOn('/form');
  const mine = await activeTabId();
  const before = await allTabIds();
  const tab = await h.json<TabInfo & { reused: boolean }>('tab_new', {});
  assert.equal(tab.reused, false);
  assert.ok(!before.includes(rawId(tab.tabId)), 'a brand-new Chrome tab');
  assert.equal(await activeTabId(), mine);

  const nav = await go(`${h.base}/`);
  assert.equal(nav.openedNewTab, undefined, 'navigate reused the agent tab rather than opening another');
  const listed = (await h.json<TabInfo[]>('tabs_list')).find((t) => t.tabId === tab.tabId);
  assert.equal(listed?.url, `${h.base}/`);
  assert.equal(personUrl(), `${h.base}/form`);
  await closeAgentTabs();
});

test('two tab_new calls give two tabs, even while the first is still blank', { skip }, async () => {
  // An agent that opens two tabs to work in parallel needs two handles; handing
  // back the first blank tab would make both point at one page.
  const first = await h.json<TabInfo & { reused: boolean }>('tab_new', {});
  const second = await h.json<TabInfo & { reused: boolean }>('tab_new', {});
  try {
    assert.notEqual(second.tabId, first.tabId);
    assert.equal(second.reused, false);
  } finally {
    await closeAgentTabs();
  }
});

test("tab_new never takes over a blank tab the person opened", { skip }, async () => {
  // The person's own starting tab is about:blank here.
  const [page] = h.ctx.pages();
  await page.goto('about:blank');
  const mine = await activeTabId();
  const tab = await h.json<TabInfo & { reused: boolean }>('tab_new', {});
  assert.notEqual(rawId(tab.tabId), mine);
  assert.equal(tab.reused, false);
  await closeAgentTabs();
});

test('tab_select picks a tab in the background; show:true brings it forward', { skip }, async () => {
  await personOn('/form');
  const mine = await activeTabId();
  const a = await agentTabAt('/');
  const b = await agentTabAt('/links');

  const picked = await h.json<TabInfo & { shown: boolean }>('tab_select', { tabId: a });
  assert.equal(picked.shown, false);
  assert.equal(picked.url, `${h.base}/`);
  assert.equal(await activeTabId(), mine);
  assert.match((await h.json<{ text: string }>('get_text', {})).text, /E2E-HOME/, 'calls follow the picked tab');

  const shown = await h.json<TabInfo>('tab_select', { tabId: b, show: true });
  assert.equal(shown.active, true);
  assert.equal(await activeTabId(), rawId(b));
  assert.match((await h.json<{ text: string }>('get_text', {})).text, /External/);
  await closeAgentTabs();
  await personOn('/form');
});

test('tab_select on an unknown or malformed tab id fails with a helpful message', { skip }, async () => {
  const live = await agentTabAt('/');
  const session = live.split(':')[1];
  const ghost = `ext:${session}:999999`;

  const missing = await h.call('tab_select', { tabId: ghost });
  assert.equal(missing.isError, true);
  assert.match(textOf(missing), /no open tab with tabId .*tabs_list/);

  const missingShown = await h.call('tab_select', { tabId: ghost, show: true });
  assert.equal(missingShown.isError, true);
  assert.match(textOf(missingShown), /999999/);

  const malformed = await h.call('tab_select', { tabId: 'not-a-tab', show: true });
  assert.equal(malformed.isError, true);
  assert.match(textOf(malformed), /malformed tab handle/);

  const none = await h.call('tab_select', {});
  assert.equal(none.isError, true);
  assert.match(textOf(none), /"tabId" is required/);

  // A failed pick leaves the agent where it was.
  assert.match((await h.json<{ text: string }>('get_text', {})).text, /E2E-HOME/);
  await closeAgentTabs();
});

test('tab_close removes the tab and the agent stops sending calls to it', { skip }, async () => {
  await personOn('/form');
  const tab = await h.open('/');
  const res = await h.json<{ closed: boolean; tabId: string }>('tab_close', { tabId: tab });
  assert.deepEqual(res, { closed: true, tabId: tab });
  assert.ok(!(await allTabIds()).includes(rawId(tab)), 'Chrome no longer has the tab');
  assert.ok(!(await h.json<TabInfo[]>('tabs_list')).some((t) => t.tabId === tab));

  // With no agent tab left, navigate opens a fresh one rather than reusing the closed id.
  const nav = (await go(`${h.base}/links`)) as { tabId: string; openedNewTab: boolean };
  assert.equal(nav.openedNewTab, true);
  assert.notEqual(nav.tabId, tab);
  assert.equal(personUrl(), `${h.base}/form`);

  const again = await h.call('tab_close', { tabId: tab });
  assert.equal(again.isError, true, 'closing an already-closed tab is an error');
  const noArg = await h.call('tab_close', {});
  assert.equal(noArg.isError, true);
  assert.match(textOf(noArg), /"tabId" is required/);
  await closeAgentTabs();
});

test("navigate with no agent tab opens one in the background, leaving the person's page alone", { skip }, async () => {
  await personOn('/form');
  resetWorkTab();
  const mine = await activeTabId();
  const nav = (await go(`${h.base}/`)) as { tabId: string; openedNewTab: boolean };
  assert.equal(nav.openedNewTab, true);
  assert.notEqual(rawId(nav.tabId), mine);
  const listed = (await h.json<TabInfo[]>('tabs_list')).find((t) => t.tabId === nav.tabId);
  assert.equal(listed?.url, `${h.base}/`, 'the new tab is the one that went to the page');
  assert.equal(listed?.active, false);
  assert.equal(await activeTabId(), mine);
  assert.equal(personUrl(), `${h.base}/form`, "the person's page was not replaced");

  // A second navigate reuses that tab.
  const next = await go(`${h.base}/links`);
  assert.equal(next.openedNewTab, undefined);
  assert.equal((await h.json<TabInfo[]>('tabs_list')).find((t) => t.tabId === nav.tabId)?.url, `${h.base}/links`);
  assert.equal(personUrl(), `${h.base}/form`);
  await closeAgentTabs();
});

test("an explicit tabId is the only way to act on the person's own tab", { skip }, async () => {
  await personOn('/form');
  const mine = await activeTabId();
  const tabs = await h.json<TabInfo[]>('tabs_list');
  const person = tabs.find((t) => rawId(t.tabId) === mine);
  assert.ok(person);

  await agentTabAt('/');
  // Without a tabId the agent tab answers, not the person's.
  assert.match((await h.json<{ text: string }>('get_text', {})).text, /E2E-HOME/);
  // With one, the person's page is read and navigated, and stays in front.
  assert.match((await h.json<{ text: string }>('get_text', { tabId: person.tabId })).text, /Agree/);
  await go(`${h.base}/links`, { tabId: person.tabId });
  assert.equal(personUrl(), `${h.base}/links`);
  assert.equal(await activeTabId(), mine);
  // The explicit target did not change which tab is the agent's.
  assert.match((await h.json<{ text: string }>('get_text', {})).text, /E2E-HOME/);
  await closeAgentTabs();
});

test('navigate waits for load by default and only for DOMContentLoaded on request', { skip }, async () => {
  await agentTabAt('/');
  let t = Date.now();
  const dcl = await h.json<{ url: string }>('navigate', { url: `${extraBase}/dcl?a`, waitUntil: 'domcontentloaded' });
  const dclMs = Date.now() - t;
  assert.equal(dcl.url, `${extraBase}/dcl?a`);
  assert.ok(dclMs < IMG_DELAY_MS - 300, `domcontentloaded returns before the slow image (took ${dclMs}ms)`);
  // The image is still pending, so the document has not finished loading.
  const state = await h.json<{ value: unknown }>('eval', { expression: 'document.readyState' });
  assert.equal(state.value, 'interactive');
  await settle(`${extraBase}/dcl?a`);

  t = Date.now();
  await h.json('navigate', { url: `${extraBase}/dcl?b` });
  const loadMs = Date.now() - t;
  assert.ok(loadMs >= IMG_DELAY_MS - 100, `the default (load) waits for the image (took ${loadMs}ms)`);
  assert.equal((await h.json<{ value: unknown }>('eval', { expression: 'document.readyState' })).value, 'complete');
  await settle(`${extraBase}/dcl?b`);

  t = Date.now();
  await h.json('navigate', { url: `${extraBase}/dcl?c`, waitUntil: 'load' });
  const loadExplicitMs = Date.now() - t;
  assert.ok(loadExplicitMs >= IMG_DELAY_MS - 100, `waitUntil:'load' waits for the image too (took ${loadExplicitMs}ms)`);
  await closeAgentTabs();
});

test(
  "navigate with waitUntil:'networkidle' waits for a quiet period after load",
  { skip },
  async () => {
    await agentTabAt('/');
    try {
      let t = Date.now();
      await h.json('navigate', { url: `${extraBase}/dcl?idle-a`, waitUntil: 'load' });
      const loadMs = Date.now() - t;
      await settle(`${extraBase}/dcl?idle-a`);
      t = Date.now();
      await h.json('navigate', { url: `${extraBase}/dcl?idle-b`, waitUntil: 'networkidle' });
      const idleMs = Date.now() - t;
      assert.ok(idleMs >= loadMs + 400, `networkidle (${idleMs}ms) should take ~500ms longer than load (${loadMs}ms)`);
    } finally {
      await closeAgentTabs();
    }
  },
);

test('navigate waits out a slow server response before returning', { skip }, async () => {
  await agentTabAt('/');
  const t = Date.now();
  const nav = await h.json<{ url: string; title: string }>('navigate', { url: `${h.base}/slow` });
  assert.ok(Date.now() - t >= 1400, 'the 1.5s response was waited for');
  assert.equal(nav.title, 'Slow');
  assert.match((await h.json<{ text: string }>('get_text', {})).text, /SLOW-DONE/);
  await closeAgentTabs();
});

test(
  'navigate straight after tab_new({url}) returns only once its own page has loaded',
  { skip },
  async () => {
    await h.open('/');
    const t = Date.now();
    const nav = await h.json<{ url: string; title: string }>('navigate', { url: `${h.base}/slow` });
    const took = Date.now() - t;
    try {
      assert.equal(nav.url, `${h.base}/slow`, 'navigate reports its own destination');
      assert.equal(nav.title, 'Slow');
      assert.ok(took >= 1400, `the 1.5s response was waited for (took ${took}ms)`);
    } finally {
      await closeAgentTabs();
    }
  },
);

test(
  'back-to-back navigates each return their own destination',
  { skip },
  async () => {
    const want = ['/', '/links', '/slow', '/form', '/slow'];
    const got: string[] = [];
    try {
      for (let round = 0; round < 3; round++) {
        await h.json('tab_new', {});
        for (const path of want) {
          const nav = await h.json<{ url: string }>('navigate', { url: h.base + path });
          got.push(nav.url.slice(h.base.length));
        }
      }
      assert.deepEqual(got, [...want, ...want, ...want]);
    } finally {
      await closeAgentTabs();
    }
  },
);

test('navigate to a 404 page lands on it and reports the url, not an error', { skip }, async () => {
  await agentTabAt('/');
  const nav = await h.json<{ url: string }>('navigate', { url: `${h.base}/no-such-page` });
  assert.equal(nav.url, `${h.base}/no-such-page`);
  assert.match((await h.json<{ text: string }>('get_text', {})).text, /not found/);
  await closeAgentTabs();
});

test('navigate rejects a missing url and a site outside the allowlist', { skip }, async () => {
  await personOn('/form');
  const tab = await h.open('/');
  const before = (await allTabIds()).length;

  const noUrl = await h.call('navigate', {});
  assert.equal(noUrl.isError, true);
  assert.match(textOf(noUrl), /"url" is required/);

  const denied = await h.call('navigate', { url: 'https://example.org/' });
  assert.equal(denied.isError, true);
  assert.match(textOf(denied), /POLICY_DENIED|not allowed|allowlist/i);
  assert.match(textOf(denied), /example\.org/);

  const badType = await h.call('navigate', { url: `${h.base}/`, tabId: 42 });
  assert.equal(badType.isError, true);
  assert.match(textOf(badType), /"tabId" must be a string/);

  assert.equal((await allTabIds()).length, before, 'a refused navigate opens no tab');
  const listed = (await h.json<TabInfo[]>('tabs_list')).find((t) => t.tabId === tab);
  assert.equal(listed?.url, `${h.base}/`, 'and leaves the agent tab where it was');
  assert.equal(personUrl(), `${h.base}/form`);
  await closeAgentTabs();
});

test('back and forward walk the agent tab history', { skip }, async () => {
  await personOn('/form');
  await agentTabAt('/');
  // Build the history with real clicks (user-activated entries); the test below
  // covers stepping back through entries navigate made.
  await h.json('click', { selector: '#to-links', trusted: true });
  await settle(`${h.base}/links`);
  await h.json('click', { selector: 'a[href="/form"]', trusted: true });
  await settle(`${h.base}/form`);

  /** One history step; checks what it reported and that the tab really got there. */
  const step = async (tool: 'back' | 'forward', path: string, title?: string): Promise<void> => {
    const r = await h.json<{ url: string; title: string }>(tool, {});
    assert.equal(r.url, h.base + path, `${tool} reports ${path}`);
    if (title) assert.equal(r.title, title);
    await settle(h.base + path);
  };
  await step('back', '/links', 'Links');
  await step('back', '/', 'Home');
  assert.match((await h.json<{ text: string }>('get_text', {})).text, /E2E-HOME/);
  await step('forward', '/links', 'Links');
  await step('forward', '/form', 'Form');
  // No entry after the last page: forward stays put.
  await step('forward', '/form');

  assert.equal(personUrl(), `${h.base}/form`, "the person's tab did not move");
  await closeAgentTabs();
});

test(
  'back returns to the page an earlier navigate left',
  {
    skip,
  },
  async () => {
    await agentTabAt('/');
    await go(`${h.base}/links`);
    try {
      // history.back() in the page proves the entry exists.
      assert.equal((await h.json<{ value: unknown }>('eval', { expression: 'history.length' })).value, 3);
      const r = await h.call('back', {});
      assert.equal(r.isError, undefined, textOf(r));
      assert.equal((JSON.parse(textOf(r)) as { url: string }).url, `${h.base}/`, 'back reports the previous page');
      await settle(`${h.base}/`);
    } finally {
      await closeAgentTabs();
    }
  },
);

test('reload reloads the agent tab and drops in-page state', { skip }, async () => {
  await agentTabAt('/');
  await h.json('eval', { expression: 'window.__marker = "kept?"; document.title = "Changed"' });
  assert.equal((await h.json<{ value: unknown }>('eval', { expression: 'window.__marker' })).value, 'kept?');

  const r = await h.json<{ url: string; title: string }>('reload', {});
  assert.equal(r.url, `${h.base}/`);
  assert.equal(r.title, 'Home', 'the title comes back from the server copy');
  const after = await h.json<{ value: unknown }>('eval', { expression: 'typeof window.__marker' });
  assert.equal(after.value, 'undefined');

  await settle(`${h.base}/`);
  await h.json('eval', { expression: 'window.__marker = 2' });
  const r2 = await h.json<{ url: string }>('reload', { waitUntil: 'domcontentloaded' });
  assert.equal(r2.url, `${h.base}/`);
  assert.equal((await h.json<{ value: unknown }>('eval', { expression: 'typeof window.__marker' })).value, 'undefined');
  await closeAgentTabs();
});

test('wait_for sees an element that appears late, by selector and by text', { skip }, async () => {
  await agentTabAt('/delayed');
  const bySel = await h.json<{ matched: boolean; waitedMs: number }>('wait_for', { selector: '#late', timeoutMs: 5000 });
  assert.equal(bySel.matched, true);
  assert.ok(bySel.waitedMs > 100, `it actually waited for the element (waited ${bySel.waitedMs}ms)`);
  assert.ok(bySel.waitedMs < 4000);

  await h.json('reload', {});
  const byText = await h.json<{ matched: boolean; waitedMs: number }>('wait_for', { textContains: 'LATE-ARRIVAL', timeoutMs: 5000 });
  assert.equal(byText.matched, true);
  assert.ok(byText.waitedMs > 100);

  // Already present: matches at once.
  const now = await h.json<{ matched: boolean; waitedMs: number }>('wait_for', { selector: '#late' });
  assert.equal(now.matched, true);
  assert.ok(now.waitedMs < 1000);
  await closeAgentTabs();
});

test('wait_for gone:true waits for an element to disappear', { skip }, async () => {
  await agentTabAt('/');
  await h.json('eval', { expression: 'setTimeout(() => document.getElementById("title").remove(), 500)' });
  const gone = await h.json<{ matched: boolean; waitedMs: number }>('wait_for', { selector: '#title', gone: true, timeoutMs: 5000 });
  assert.equal(gone.matched, true);
  assert.ok(gone.waitedMs >= 300, `it waited for the removal (waited ${gone.waitedMs}ms)`);
  await closeAgentTabs();
});

test('wait_for gives up after timeoutMs with matched:false, and rejects bad arguments', { skip }, async () => {
  await agentTabAt('/');
  const t = Date.now();
  const miss = await h.json<{ matched: boolean; waitedMs: number }>('wait_for', { selector: '#never', timeoutMs: 400 });
  const took = Date.now() - t;
  assert.equal(miss.matched, false);
  assert.ok(miss.waitedMs >= 400, `waited the full timeout (waited ${miss.waitedMs}ms)`);
  assert.ok(took < 3000, `and not much longer (took ${took}ms)`);

  const textMiss = await h.json<{ matched: boolean }>('wait_for', { textContains: 'NOT-ON-PAGE', timeoutMs: 300 });
  assert.equal(textMiss.matched, false);

  const negative = await h.call('wait_for', { selector: '#x', timeoutMs: -1 });
  assert.equal(negative.isError, true);
  assert.match(textOf(negative), /"timeoutMs" must be >= 0/);
  const huge = await h.call('wait_for', { selector: '#x', timeoutMs: 10_000_000 });
  assert.equal(huge.isError, true);
  assert.match(textOf(huge), /"timeoutMs" must be <= 120000/);
  const notNumber = await h.call('wait_for', { selector: '#x', timeoutMs: '300' });
  assert.equal(notNumber.isError, true);
  assert.match(textOf(notNumber), /"timeoutMs" must be a finite number/);
  await closeAgentTabs();
});

test('frames_list lists the top document and its iframe, with a hint to target them', { skip }, async () => {
  await agentTabAt('/frames');
  type Frames = { frames: { frameId: number; top: boolean; url: string; title: string }[]; count: number; hint?: string };
  // The iframe document can trail the outer load by a moment; poll briefly.
  let res = await h.json<Frames>('frames_list', {});
  for (const deadline = Date.now() + 5000; res.count < 2 && Date.now() < deadline; ) {
    await new Promise((r) => setTimeout(r, 100));
    res = await h.json<Frames>('frames_list', {});
  }
  assert.equal(res.count, 2);
  const top = res.frames.find((f) => f.top);
  const inner = res.frames.find((f) => !f.top);
  assert.equal(top?.frameId, 0);
  assert.equal(top?.url, `${h.base}/frames`);
  assert.equal(inner?.url, `${h.base}/frame-inner`);
  assert.equal(inner?.title, 'Inner');
  assert.ok((inner?.frameId ?? 0) > 0);
  assert.match(res.hint ?? '', /frameId/);

  // The listed frameId really targets the iframe.
  const text = await h.json<{ text: string }>('get_text', { frameId: inner?.frameId });
  assert.match(text.text, /inner/);

  await go(`${h.base}/`);
  const single = await h.json<{ count: number; hint?: string }>('frames_list', {});
  assert.equal(single.count, 1);
  assert.equal(single.hint, undefined);
  await closeAgentTabs();
});

test('auth_check flags a sign-in page and clears an ordinary one', { skip }, async () => {
  await agentTabAt('/login');
  const wall = await h.json<{ url: string; title: string; authRequired: boolean; confidence?: string; signals?: string[] }>('auth_check', {});
  assert.equal(wall.authRequired, true);
  assert.equal(wall.url, `${h.base}/login`);
  assert.equal(wall.title, 'Sign in');
  assert.ok(wall.confidence, 'a confidence level is given');
  assert.ok(Array.isArray(wall.signals) && wall.signals.length > 0, 'and the signals behind it');

  const strict = await h.call('auth_check', { failOnAuthWall: true });
  assert.equal(strict.isError, true);
  assert.match(textOf(strict), /AUTH_REQUIRED/);

  // A navigation tool with the guard on fails when it ends on the wall.
  const guarded = await h.call('reload', { failOnAuthWall: true });
  assert.equal(guarded.isError, true);
  assert.match(textOf(guarded), /AUTH_REQUIRED/);

  await go(`${h.base}/`);
  const home = await h.json<{ authRequired: boolean; confidence?: string }>('auth_check', {});
  assert.equal(home.authRequired, false);
  assert.equal(home.confidence, undefined);
  assert.equal((await h.call('auth_check', { failOnAuthWall: true })).isError, undefined);
  await closeAgentTabs();
});

test('a whole tabs-and-navigation session never moves the person off their tab', { skip }, async () => {
  await personOn('/form');
  const mine = await activeTabId();
  const a = await agentTabAt('/');
  await go(`${h.base}/links`);
  await h.json('back', {});
  await h.json('forward', {});
  await h.json('reload', {});
  await settle(`${h.base}/links`);
  await h.json('wait_for', { selector: 'a' });
  await h.json('frames_list', {});
  await h.json('auth_check', {});
  const b = await agentTabAt('/frames');
  await h.json('tab_select', { tabId: a });
  await h.json('tab_close', { tabId: b });
  await h.json('tabs_list');
  assert.equal(await activeTabId(), mine);
  assert.equal(personUrl(), `${h.base}/form`);

  // Once the agent's tab is gone, a read without tabId falls back to the person's page.
  await h.json('tab_close', { tabId: a });
  assert.match((await h.json<{ text: string }>('get_text', {})).text, /Agree/);
  assert.equal(await activeTabId(), mine);
  await closeAgentTabs();
});
