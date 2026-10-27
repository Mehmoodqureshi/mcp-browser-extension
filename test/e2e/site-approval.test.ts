import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RUN_E2E, startHarness, textOf } from './harness';
import { setProfileBridge } from '../../src/mcp/tools';

test('a live website-list refresh between press and release does not swallow Allow', { skip: !RUN_E2E }, async () => {
  const h = await startHarness({ allowDomains: [] }, { siteGrants: true });
  try {
    const popup = await h.ctx.newPage();
    await popup.goto(new URL('popup.html', h.sw.url()).href);
    await assert.rejects(h.bridge.sendCommand('tab_new', { url: h.base }));
    const allow = popup.locator('#blocked .row').filter({ hasText: '127.0.0.1' }).getByRole('button', { name: 'Allow', exact: true });
    await allow.waitFor();
    const original = await allow.elementHandle();
    await allow.scrollIntoViewIfNeeded();
    const box = (await allow.boundingBox())!;
    await popup.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await popup.mouse.down();
    await popup.evaluate(async () => {
      const c = (globalThis as any).chrome;
      const saved = await c.storage.local.get('blockedSites');
      await c.storage.local.set({ blockedSites: [
        { host: 'example.org', method: 'navigate', at: Date.now() },
        ...saved.blockedSites.map((s: any) => ({ ...s, at: s.at + 1 })),
      ] });
    });
    await popup.waitForTimeout(150);
    assert.equal(await original!.evaluate((b) => b.isConnected), true, 'the button must survive a status-only refresh');
    assert.deepEqual(await original!.boundingBox(), box, 'a new request must not move the button during the click');
    await popup.mouse.up();
    await popup.locator('#allowed .row').filter({ hasText: '127.0.0.1' }).waitFor();
    assert.ok(h.policy.allowDomains.includes('127.0.0.1'));
  } finally { await h.close(); }
});

test('Allow finishes in the worker when the popup closes during Chrome permission confirmation', { skip: !RUN_E2E }, async () => {
  const h = await startHarness({ allowDomains: [] }, { browserPermissions: false, siteGrants: true });
  try {
    const popup = await h.ctx.newPage();
    await popup.goto(new URL('popup.html', h.sw.url()).href);
    await assert.rejects(h.bridge.sendCommand('tab_new', { url: h.base }));
    // Use the actual trusted Chrome request, but delay its returned result to model
    // the native confirmation outliving the popup. This is a disposable profile.
    await h.sw.evaluate(() => {
      const g = globalThis as any;
      const request = g.chrome.permissions.request.bind(g.chrome.permissions);
      g.chrome.permissions.request = (value: unknown) => {
        const permission = request(value);
        return permission.then((granted: boolean) => new Promise((resolve) => {
          g.finishPermission = () => resolve(granted);
        }));
      };
      // Record the popup coming back instead of opening a real toolbar popup.
      g.reopened = 0;
      g.chrome.action.openPopup = async () => { g.reopened++; };
    });
    await popup.locator('#blocked .row').filter({ hasText: '127.0.0.1' }).getByRole('button', { name: 'Allow', exact: true }).click();
    for (let i = 0; i < 100 && !await h.sw.evaluate(() => typeof (globalThis as any).finishPermission === 'function'); i++) {
      await popup.waitForTimeout(20);
    }
    assert.equal(await h.sw.evaluate(() => typeof (globalThis as any).finishPermission), 'function');
    // Only count the reopen after Chrome's prompt, not the popup the block itself opened.
    await h.sw.evaluate(() => { (globalThis as any).reopened = 0; });
    await popup.close();
    await h.sw.evaluate(() => (globalThis as any).finishPermission());
    const options = await h.ctx.newPage();
    await options.goto(new URL('options.html', h.sw.url()).href);
    await options.locator('#allowed li').filter({ hasText: '127.0.0.1' }).waitFor();
    assert.ok(h.policy.allowDomains.includes('127.0.0.1'), 'server approval completes without another popup click');
    for (let i = 0; i < 100 && await h.sw.evaluate(() => (globalThis as any).reopened) === 0; i++) await options.waitForTimeout(20);
    assert.equal(await h.sw.evaluate(() => (globalThis as any).reopened), 1, 'the popup reopens once Chrome\'s prompt is answered');
    const tab = await h.open('/');
    await h.bridge.sendCommand('tab_close', {}, { tabId: tab });
  } finally { await h.close(); }
});

test('Dismiss hides a setup website until another request needs it, without granting access', { skip: !RUN_E2E }, async () => {
  const h = await startHarness({}, { browserPermissions: false });
  try {
    const popup = await h.ctx.newPage();
    await popup.goto(new URL('popup.html', h.sw.url()).href);
    const row = popup.locator('#blocked .row').filter({ hasText: '127.0.0.1' });
    await row.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await row.waitFor({ state: 'hidden' });
    await popup.reload();
    await popup.locator('#state-text').getByText('Connected', { exact: true }).waitFor();
    assert.equal(await row.count(), 0);
    await assert.rejects(h.bridge.sendCommand('tab_new', { url: h.base }), /Please allow access/);
    await row.getByRole('button', { name: 'Allow', exact: true }).waitFor();
    const origins = await h.sw.evaluate(async () => (await (globalThis as any).chrome.permissions.getAll()).origins);
    assert.deepEqual(origins ?? [], []);
  } finally { await h.close(); }
});

test('Connect completes after its popup closes and a delayed helper replies', { skip: !RUN_E2E }, async () => {
  const h = await startHarness();
  try {
    await h.sw.evaluate(() => {
      const g = globalThis as any;
      // No native host or additional permission in this disposable fixture.
      g.chrome.permissions.request = async () => true;
      g.chrome.runtime.sendNativeMessage = async () => {
        const saved = await g.chrome.storage.local.get(['wsPort', 'token']);
        return new Promise((resolve) => { g.finishPairing = () => resolve({ ok: true, port: saved.wsPort, token: saved.token }); });
      };
    });
    const popup = await h.ctx.newPage();
    await popup.goto(new URL('popup.html', h.sw.url()).href);
    await popup.locator('#connect').click();
    for (let i = 0; i < 100 && !await h.sw.evaluate(() => typeof (globalThis as any).finishPairing === 'function'); i++) await popup.waitForTimeout(20);
    assert.equal(await h.sw.evaluate(() => typeof (globalThis as any).finishPairing), 'function');
    await popup.close();
    await h.sw.evaluate(() => (globalThis as any).finishPairing());
    const options = await h.ctx.newPage();
    await options.goto(new URL('options.html', h.sw.url()).href);
    await options.waitForFunction(async () => {
      const state = await (globalThis as any).chrome.storage.local.get(['pairingSource', 'connState']);
      return state.pairingSource === 'native' && state.connState === 'connected';
    });
    assert.equal(h.bridge.hasActiveExtension(), true);
  } finally { await h.close(); }
});

test('a website stays blocked until a human click and is blocked again after removal', { skip: !RUN_E2E }, async () => {
  // This Chromium profile is temporary; no approval in the owner's Chrome is touched.
  const h = await startHarness({ allowDomains: [] }, { siteGrants: true });
  setProfileBridge(h.bridge);
  try {
    const popup = await h.ctx.newPage();
    await popup.goto(new URL('popup.html', h.sw.url()).href);
    const options = await h.ctx.newPage();
    await options.goto(new URL('options.html', h.sw.url()).href);
    const blocked = await h.call('tab_new', { url: h.base });
    assert.equal(blocked.isError, true);
    assert.match(textOf(blocked), /Please allow access to 127\.0\.0\.1: in Chrome, click the MCP Browser Extension icon .* then click Allow next to/);
    assert.doesNotMatch(textOf(blocked), /[\r\n]/);
    assert.deepEqual(h.policy.allowDomains, []);

    const request = popup.locator('#blocked .row').filter({ hasText: '127.0.0.1' });
    const allow = request.getByRole('button', { name: 'Allow', exact: true });
    await allow.waitFor();
    await allow.evaluate((button) => (button as HTMLButtonElement).click());
    assert.equal((await h.call('tab_new', { url: h.base })).isError, true, 'a synthetic click cannot allow the site');
    assert.deepEqual(h.policy.allowDomains, []);

    await allow.click();
    const allowed = popup.locator('#allowed .row').filter({ hasText: '127.0.0.1' });
    await allowed.getByRole('button', { name: 'Remove', exact: true }).waitFor();
    await options.locator('#allowed li').filter({ hasText: '127.0.0.1' }).waitFor();
    const tab = await h.open('/website-actions');
    assert.notEqual((await h.call('get_text', { tabId: tab })).isError, true);
    // A single website grant covers repeated interactions, including consequential
    // controls. These buttons only increment a counter in this disposable profile.
    for (const selector of ['#send', '#delete', '#buy', '#send']) {
      const result = await h.call('click', { tabId: tab, selector });
      assert.notEqual(result.isError, true, textOf(result));
    }
    assert.equal((await h.json<{ value: number }>('eval', { tabId: tab, expression: 'window.count' })).value, 4);
    assert.equal(await popup.locator('#action-approval').count(), 0);
    assert.equal(await options.locator('#action-approval').count(), 0);
    assert.match(await popup.locator('#allowed-section').innerText(), /Approved apps can read and act/);
    assert.match(await options.locator('#sites-section').innerText(), /sending, deleting and buying/);
    assert.equal((await h.call('tab_new', { url: h.base.replace('127.0.0.1', 'localhost') })).isError, true, 'another site still requires its own approval');
    assert.equal((await h.call('tab_new', { url: 'https://example.com' })).isError, true, 'a third site stays blocked');

    await allowed.getByRole('button', { name: 'Remove', exact: true }).click();
    await allowed.waitFor({ state: 'hidden' });
    assert.equal((await h.call('get_text', { tabId: tab })).isError, true, 'removing access blocks reads of an already-open tab');
    assert.equal((await h.call('click', { tabId: tab, selector: '#send' })).isError, true, 'removing access blocks new actions');
    await assert.rejects(h.bridge.sendCommand('eval', { expression: 'effect()' }, { tabId: tab }), /Please allow access/, 'the extension enforces removal even without the server policy gate');
    const fixture = h.ctx.pages().find((page) => page.url() === `${h.base}/website-actions`)!;
    assert.equal(await fixture.locator('#count').textContent(), '4', 'blocked actions had no effect');

    // Settings cannot add a blanket permission. A normal keyboard Enter still works.
    const input = options.locator('#new-site');
    await input.fill('*');
    await input.press('Enter');
    assert.equal((await h.call('get_text', { tabId: tab })).isError, true);
    await input.fill('127.0.0.1');
    await input.press('Enter');
    await options.locator('#allowed li').filter({ hasText: '127.0.0.1' }).waitFor();
    assert.notEqual((await h.call('get_text', { tabId: tab })).isError, true);
  } finally {
    setProfileBridge(null);
    await h.close();
  }
});

test('an older server catch-all is ignored and extension-side blocks appear in the popup', { skip: !RUN_E2E }, async () => {
  const h = await startHarness({ allowDomains: [] }, { siteGrants: true });
  try {
    const popup = await h.ctx.newPage();
    await popup.goto(new URL('popup.html', h.sw.url()).href);
    // Simulate the policy an older server sends on reconnection.
    h.policy.allowDomains.push('*', 'https://*/*');
    await popup.evaluate(async () => {
      const c = (globalThis as unknown as { chrome: {
        storage: { local: { set(value: unknown): Promise<void> } };
        runtime: { sendMessage(message: unknown): Promise<unknown> };
      } }).chrome;
      await c.storage.local.set({ allowedSites: ['awaiting-policy.invalid'] });
      await c.runtime.sendMessage({ type: 'reconnect' });
    });
    await popup.waitForFunction(async () => {
      const c = (globalThis as unknown as { chrome: {
        storage: { local: { get(keys: string[]): Promise<{ connState: string; allowedSites: string[] }> } };
      } }).chrome;
      const state = await c.storage.local.get(['connState', 'allowedSites']);
      return state.connState === 'connected' && state.allowedSites.length === 0;
    });
    assert.equal(await popup.getByText('Every site', { exact: true }).count(), 0);
    // Skip the server's policy gate, as an older server could.
    await assert.rejects(h.bridge.sendCommand('tab_new', { url: h.base }), /Please allow access to 127\.0\.0\.1/);
    const request = popup.locator('#blocked .row').filter({ hasText: '127.0.0.1' });
    await request.getByRole('button', { name: 'Allow', exact: true }).waitFor();
    await request.getByRole('button', { name: 'Allow', exact: true }).click();
    const allowed = popup.locator('#allowed .row').filter({ hasText: '127.0.0.1' });
    await allowed.waitFor();
    const tab = await h.bridge.sendCommand('tab_new', { url: h.base }) as { tabId: string };
    assert.ok(tab.tabId);
    await allowed.getByRole('button', { name: 'Remove', exact: true }).click();
    await allowed.waitFor({ state: 'hidden' });
    await assert.rejects(h.bridge.sendCommand('get_text', {}, { tabId: tab.tabId }), /Please allow access to 127\.0\.0\.1/);
    await request.getByRole('button', { name: 'Allow', exact: true }).waitFor();
  } finally { await h.close(); }
});

test('a newly blocked website opens the popup once, not on every retry', { skip: !RUN_E2E }, async () => {
  const h = await startHarness({}, { browserPermissions: false });
  try {
    await h.sw.evaluate(() => {
      const g = globalThis as any;
      g.opened = 0;
      g.chrome.action.openPopup = async () => { g.opened++; };
    });
    const url = h.base.replace('127.0.0.1', 'localhost');
    for (let i = 0; i < 3; i++) await assert.rejects(h.bridge.sendCommand('tab_new', { url }), /Please allow access to localhost/);
    for (let i = 0; i < 100 && await h.sw.evaluate(() => (globalThis as any).opened) === 0; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(await h.sw.evaluate(() => (globalThis as any).opened), 1, 'one popup for the new site, none for the retries');
  } finally { await h.close(); }
});

test('a block while the person is in another app shows the popup when they return to Chrome', { skip: !RUN_E2E }, async () => {
  const h = await startHarness({}, { browserPermissions: false });
  try {
    await h.sw.evaluate(() => {
      const g = globalThis as any;
      g.opened = 0;
      g.chrome.action.openPopup = async () => { g.opened++; };
      // The person is in the terminal: no Chrome window has focus.
      g.realLastFocused = g.chrome.windows.getLastFocused.bind(g.chrome.windows);
      g.chrome.windows.getLastFocused = async () => ({ ...(await g.realLastFocused()), focused: false });
    });
    const url = h.base.replace('127.0.0.1', 'localhost');
    await assert.rejects(h.bridge.sendCommand('tab_new', { url }), /Please allow access to localhost/);
    for (let i = 0; i < 100 && !(await h.sw.evaluate(async () => (await (globalThis as any).chrome.storage.session.get('popupOwed')).popupOwed)); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(await h.sw.evaluate(() => (globalThis as any).opened), 0, 'nothing pops up while Chrome is in the background');
    // The person switches back to Chrome.
    await h.sw.evaluate(() => (globalThis as any).chrome.windows.create({ focused: true }));
    for (let i = 0; i < 100 && await h.sw.evaluate(() => (globalThis as any).opened) === 0; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(await h.sw.evaluate(() => (globalThis as any).opened), 1, 'the popup opens on return');
  } finally { await h.close(); }
});
