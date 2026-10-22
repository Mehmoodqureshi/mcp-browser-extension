import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RUN_E2E, startHarness, type Harness } from './harness';
import { createClientIdentity, withClientIdentity } from '../../src/bridge/client-identity';
import type { ActivityEntry } from '../../shared/activity';
import type { Page } from 'playwright';

// Available only inside Playwright's extension/page evaluate callbacks.
declare const chrome: any;
const skip = !RUN_E2E;
async function ui(h: Harness, file = 'popup.html'): Promise<Page> {
  const page = await h.ctx.newPage();
  await page.goto(new URL(file, h.sw.url()).href);
  return page;
}
async function history(page: Page): Promise<ActivityEntry[]> {
  return page.evaluate(async () => (await chrome.storage.session.get('recentActivity')).recentActivity ?? []);
}
async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Error('Timed out waiting for dashboard state');
}

test('history shows real outcomes and app keys, excludes page secrets, filters and clears in both views', { skip }, async () => {
  const h = await startHarness();
  try {
    const popup = await ui(h), settings = await ui(h, 'options.html');
    const tab = await h.open('/form?token=SECRET_QUERY');
    await h.bridge.sendCommand('type', { selector: '#name', text: 'SECRET_TYPED' }, { tabId: tab });
    await h.bridge.sendCommand('get_text', { selector: 'body' }, { tabId: tab });
    await h.bridge.sendCommand('eval', { expression: 'throw new Error("SECRET_ERROR")' }, { tabId: tab }).catch(() => undefined);
    await assert.rejects(h.bridge.sendCommand('tab_new', { url: 'https://example.org/private?secret=SECRET_URL' }));
    const stranger = createClientIdentity(() => '<img src=x onerror=alert(1)>');
    await assert.rejects(withClientIdentity(stranger, () => h.bridge.sendCommand('tabs_list', {})), /Please approve/);
    await assert.rejects(h.bridge.sendCommand('get_text', {}, { tabId: 'ext:default:99999999' }));
    await waitUntil(async () => (await history(popup)).some((e) => e.outcome === 'failed'));
    const rows = await history(popup);
    assert.ok(rows.some((e) => e.method === 'type' && e.outcome === 'done' && e.host === '127.0.0.1'));
    assert.ok(rows.some((e) => e.method === 'eval' && e.outcome === 'failed'));
    assert.ok(rows.some((e) => e.outcome === 'blocked' && e.key === stranger.id));
    assert.doesNotMatch(JSON.stringify(rows), /SECRET_QUERY|SECRET_TYPED|SECRET_URL|SECRET_ERROR|selector|quick brown|<input|params/);
    assert.equal(await popup.locator('#activity-list img').count(), 0);
    assert.ok(await popup.locator('#activity-list li').count() <= 5);
    await settings.selectOption('#activity-filter', 'blocked');
    await waitUntil(async () => await settings.locator('#activity-list li').count() === 2);
    assert.equal(await settings.locator('#activity-list li:not([data-outcome="blocked"])').count(), 0);
    // Synthetic DOM clicks cannot erase history.
    await popup.locator('#activity-clear').evaluate((b) => (b as HTMLButtonElement).click());
    assert.equal((await history(popup)).length, rows.length);
    await popup.locator('#activity-clear').click();
    await waitUntil(async () => (await history(settings)).length === 0);
    await settings.getByText('No matching requests.', { exact: true }).waitFor();
  } finally { await h.close(); }
});

test('stop disconnects all app keys, resists ordinary reconnect and reload, and resume requires fresh approval', { skip }, async () => {
  const h = await startHarness();
  try {
    const other = createClientIdentity(() => 'Second app');
    const readOther = () => withClientIdentity(other, () => h.bridge.sendCommand('tabs_list', {}));
    await assert.rejects(readOther(), /Please approve/);
    const popup = await ui(h), settings = await ui(h, 'options.html');
    await settings.locator(`[data-client-id="${other.id}"]`).getByRole('button', { name: 'Approve for 8 hours', exact: true }).click();
    await readOther();
    await popup.locator('#access-stop').evaluate((b) => (b as HTMLButtonElement).click());
    assert.equal(h.bridge.hasActiveExtension(), true, 'synthetic Stop is ignored');
    await popup.locator('#access-stop').click();
    await popup.locator('#access-resume').waitFor();
    await waitUntil(() => !h.bridge.hasActiveExtension());
    const saved = await settings.evaluate(async () => chrome.storage.local.get(['accessStopped', 'clientConnections']));
    assert.equal(saved.accessStopped, true);
    assert.ok(saved.clientConnections.every((c: { state: string }) => c.state === 'revoked'));
    assert.equal(await settings.locator('#access-resume').isVisible(), true);
    const reconnect = await settings.evaluate(() => chrome.runtime.sendMessage({ type: 'reconnect' }));
    assert.equal(reconnect.ok, false);
    await settings.evaluate(() => chrome.alarms.create('chrome-mcp-keepalive', { when: Date.now() + 50 }));
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(h.bridge.hasActiveExtension(), false);
    const scripts = await settings.evaluate(() => chrome.scripting.getRegisteredContentScripts());
    assert.equal(scripts.length, 0, 'Stop also unregisters future observers');
    // Reload the real extension in this throwaway profile; the durable stop survives.
    const reload = h.ctx.waitForEvent('serviceworker', { predicate: (w) => w !== h.sw });
    await settings.evaluate(() => chrome.runtime.reload()).catch(() => undefined);
    const wake = await h.ctx.newPage();
    await wake.goto(new URL('options.html', h.sw.url()).href);
    await reload;
    await wake.locator('#access-resume').waitFor();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(h.bridge.hasActiveExtension(), false, 'startup must not reconnect');
    await wake.locator('#access-resume').evaluate((b) => (b as HTMLButtonElement).click());
    assert.equal(h.bridge.hasActiveExtension(), false, 'synthetic Resume is ignored');
    await wake.locator('#access-resume').click();
    await waitUntil(() => h.bridge.hasActiveExtension());
    await assert.rejects(h.bridge.sendCommand('tabs_list', {}), /revoked/);
    await assert.rejects(readOther(), /revoked/);
    const secondRow = wake.locator(`[data-client-id="${other.id}"]`);
    await secondRow.getByRole('button', { name: 'Approve again for 8 hours', exact: true }).click();
    assert.ok(Array.isArray(await readOther()));
    await assert.rejects(h.bridge.sendCommand('tabs_list', {}), /revoked/, 'restoring one key does not restore others');
  } finally { await h.close(); }
});

test('ordinary page messages and frames cannot resume, stop or erase history', { skip }, async () => {
  const h = await startHarness();
  try {
    const tab = await h.open('/');
    const popup = await ui(h);
    const numericId = Number(tab.split(':').at(-1));
    const messages = [
      { type: 'access_stop' }, { type: 'access_resume' }, { type: 'activity_clear' },
      { type: 'site_access', host: '127.0.0.1', allow: true },
      { type: 'feature_access', feature: 'cookies', allow: true },
      { type: 'connect_with_click' }, { type: 'dismiss_blocked', host: '127.0.0.1' },
    ];
    for (const message of messages) {
      const results = await h.sw.evaluate(async ({ message, tabId }) => chrome.scripting.executeScript({
        target: { tabId }, func: async (message: unknown) => chrome.runtime.sendMessage(message), args: [message],
      }), { message, tabId: numericId });
      assert.equal(results[0].result.ok, false);
    }
    // The top-level popup restriction also excludes an extension iframe.
    await popup.evaluate(() => {
      const iframe = document.createElement('iframe'); iframe.src = 'options.html'; document.body.append(iframe);
    });
    const frame = popup.frameLocator('iframe');
    await frame.locator('#access-stop').waitFor();
    for (const message of messages) {
      const result = await frame.locator('body').evaluate((_, message) => chrome.runtime.sendMessage(message), message);
      assert.equal(result.ok, false);
    }
    assert.equal(h.bridge.hasActiveExtension(), true);
    await popup.bringToFront();
    await assert.rejects(h.bridge.sendCommand('eval', { expression: 'document.querySelector("#access-resume").click()' }), /own pages/);
  } finally { await h.close(); }
});

test('live updates preserve controls and expanded history throughout the popup', { skip }, async () => {
  const h = await startHarness();
  try {
    await h.open('/form');
    const popup = await ui(h);
    await h.sw.evaluate(() => chrome.storage.local.set({ browserPermissionRequests: ['cookies'] }));
    const selectors = ['#client-connections button', '#allowed button', '#extra-permissions-list button',
      '#activity-list summary', '#connect', '#access-stop', '#activity-clear', '#activity-all', '#settings', '#tab-border'];
    const originals = [];
    for (const selector of selectors) {
      const locator = popup.locator(selector).first();
      await locator.waitFor();
      originals.push(await locator.elementHandle());
    }
    await popup.locator('#activity-list summary').first().click();
    await h.sw.evaluate(async () => {
      const saved = await chrome.storage.local.get('clientConnections');
      await chrome.storage.local.set({
        clientConnections: saved.clientConnections.map((c: any) => ({ ...c, requestedAt: c.requestedAt + 1 })),
        blockedSites: [{ host: 'example.org', at: Date.now(), method: 'navigate' }],
        browserPermissionRequests: ['cookies', 'downloads'],
      });
      const history = (await chrome.storage.session.get('recentActivity')).recentActivity;
      await chrome.storage.session.set({ recentActivity: [...history, {
        ...history[0], id: 'fixture-next', method: 'tabs_list', at: Date.now(), tabId: undefined,
      }] });
    });
    await popup.locator('#blocked .row').filter({ hasText: 'example.org' }).waitFor();
    await waitUntil(async () => await popup.locator('#activity-list li').count() === 2);
    for (const original of originals) assert.equal(await original!.evaluate((element) => element.isConnected), true);
    assert.equal(await popup.locator('#activity-list details[open]').count(), 1, 'new history does not collapse what the user opened');
    await popup.locator('#tab-border').uncheck();
    await waitUntil(async () => await h.sw.evaluate(async () => (await chrome.storage.local.get('tabBorder')).tabBorder === false));
    await popup.locator('#activity-all').click();
    await waitUntil(() => h.ctx.pages().some((page) => page.url().endsWith('/options.html#activity-section')));
  } finally { await h.close(); }
});

test('stop withholds a running request result and clear prevents its late history entry returning', { skip }, async () => {
  const h = await startHarness();
  try {
    const tab = await h.open('/');
    const popup = await ui(h);
    const delayed = h.bridge.sendCommand('eval', {
      expression: 'new Promise(resolve => setTimeout(() => resolve("PRIVATE_LATE_RESULT"), 1800))',
      awaitPromise: true,
    }, { tabId: tab }).then(
      () => ({ delivered: true }),
      () => ({ delivered: false }),
    );
    await popup.locator('#activity-list [data-outcome="running"]').waitFor();
    await popup.locator('#access-stop').click();
    assert.equal((await delayed).delivered, false);
    await popup.locator('#access-resume').waitFor();
    await popup.locator('#activity-clear').click();
    await new Promise((resolve) => setTimeout(resolve, 2200));
    assert.equal((await history(popup)).length, 0);
    assert.equal(h.bridge.hasActiveExtension(), false);
  } finally { await h.close(); }
});


test('background blank tabs and browser-wide requests never inherit the active website label', { skip }, async () => {
  const h = await startHarness();
  try {
    const target = await h.open('/form');
    const popup = await ui(h);
    const fixture = h.ctx.pages().find((page) => page.url() === `${h.base}/form`)!;
    await fixture.bringToFront();
    await popup.locator('#activity-clear').click();
    await fixture.bringToFront();
    const opened = await h.bridge.sendCommand('tab_new', { url: 'about:blank', active: false }) as { tabId: string };
    await waitUntil(async () => (await history(popup)).some((e) => e.method === 'tab_new' && e.outcome === 'done'));
    assert.equal((await history(popup)).find((e) => e.method === 'tab_new')?.host, 'about:blank', 'the blank tab never inherits the active website');
    await h.bridge.sendCommand('tabs_list', {});
    await waitUntil(async () => (await history(popup)).some((e) => e.method === 'tabs_list'));
    assert.equal((await history(popup)).find((e) => e.method === 'tabs_list')?.host, '', 'listing tabs is browser-wide');
    await h.bridge.sendCommand('tab_close', {}, { tabId: opened.tabId });
    await waitUntil(async () => (await history(popup)).some((e) => e.method === 'tab_close'));
    assert.equal((await history(popup)).find((e) => e.method === 'tab_close')?.host, 'about:blank');
    await h.bridge.sendCommand('tab_close', {}, { tabId: target });
    await waitUntil(async () => (await history(popup)).filter((e) => e.method === 'tab_close').length === 2);
    assert.equal((await history(popup)).filter((e) => e.method === 'tab_close').at(-1)?.host, '127.0.0.1', 'a closed website is captured before its tab disappears');
  } finally { await h.close(); }
});

test('open and close share one compact website row without merging different tabs on that site', { skip }, async () => {
  const h = await startHarness();
  try {
    const popup = await ui(h), settings = await ui(h, 'options.html');
    await popup.setViewportSize({ width: 360, height: 600 });
    const first = await h.open('/form?secret=PRIVATE_PATH');
    const second = await h.open('/links');
    await h.bridge.sendCommand('tab_close', {}, { tabId: first });
    await waitUntil(async () => await popup.locator('.activity-label').filter({ hasText: 'Opened → Closed' }).count() === 1);
    assert.equal(await popup.locator('#activity-list li').count(), 2);
    assert.deepEqual(await popup.locator('.activity-host').allTextContents(), ['127.0.0.1', '127.0.0.1']);
    const combined = popup.locator('#activity-list li').filter({ has: popup.locator('.activity-label', { hasText: 'Opened → Closed' }) });
    assert.equal(await combined.locator('details').getAttribute('open'), null);
    await combined.locator('summary').focus();
    await popup.keyboard.press('Enter');
    assert.equal(await combined.locator('.activity-meta').isVisible(), true);
    assert.match(await combined.locator('.activity-opened').innerText(), /Opened .+ · Closed /);
    assert.doesNotMatch(await popup.locator('#activity-list').innerText(), /PRIVATE_PATH|Browser/);
    await h.bridge.sendCommand('tab_close', {}, { tabId: second });
    await waitUntil(async () => await settings.locator('.activity-label').filter({ hasText: 'Opened → Closed' }).count() === 2);
    assert.equal(await settings.locator('#activity-list li').count(), 2);
    assert.equal((await history(popup)).length, 4, 'keep the original requests in bounded history');
    for (const theme of ['light', 'dark'] as const) {
      await popup.emulateMedia({ colorScheme: theme });
      const sizing = await popup.locator('.activity-row').evaluateAll((rows) => rows.map((row) => ({
        height: row.getBoundingClientRect().height, right: row.getBoundingClientRect().right,
      })));
      assert.ok(sizing.every((row) => row.height < 45 && row.right <= 360), 'each collapsed summary stays on one line');
      assert.equal(await popup.evaluate(() => document.documentElement.scrollWidth), 360);
    }
    await settings.selectOption('#activity-filter', 'failed');
    await settings.getByText('No matching requests.', { exact: true }).waitFor();
    await settings.selectOption('#activity-filter', 'done');
    await waitUntil(async () => await settings.locator('#activity-list li').count() === 2);
    await popup.locator('#activity-clear').click();
    await waitUntil(async () => await settings.locator('#activity-list li').count() === 0);
  } finally { await h.close(); }
});
