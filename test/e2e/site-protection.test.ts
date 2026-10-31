import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RUN_E2E, startHarness, textOf, type Harness } from './harness';
import { BridgeServer } from '../../src/bridge/server';
import { ExtensionExecutor } from '../../src/executor/extension-executor';

async function automatic(h: Harness) {
  const popup = await h.ctx.newPage();
  await popup.goto(new URL('popup.html', h.sw.url()).href);
  await popup.setViewportSize({ width: 360, height: 850 });
  const toggle = popup.locator('#site-checks-toggle');
  await toggle.waitFor({ state: 'visible' });
  await popup.getByText('On. Chrome permission needed.', { exact: true }).waitFor();
  assert.equal(await toggle.innerText(), 'Allow website access');
  const setup = await h.call('tab_new', { url: h.base });
  assert.equal(setup.isError, true);
  assert.match(textOf(setup), /needs Chrome permission/);
  assert.equal(await popup.locator('#blocked-section').isVisible(), false, 'ordinary websites never queue in the default mode');
  assert.equal(await popup.locator('#site-warnings li').count(), 0);
  // Programmatic clicks must not widen access.
  await toggle.evaluate((element) => (element as HTMLButtonElement).click());
  assert.equal((await h.inSw(async () => {
    const c = (globalThis as any).chrome;
    return c.storage.local.get('localSiteChecksV1');
  })).localSiteChecksV1, undefined);
  await toggle.click();
  await popup.getByText('On.', { exact: true }).waitFor();
  return popup;
}

test('automatic sites work through the real server without grants or pending rows; blocks and disable work', { skip: !RUN_E2E }, async () => {
  const h = await startHarness({ allowDomains: [] }, { siteGrants: true, browserPermissions: false, automaticPermission: true });
  try {
    const popup = await automatic(h);
    const options = await h.ctx.newPage();
    await options.goto(new URL('options.html', h.sw.url()).href);
    await options.getByText('On.', { exact: true }).waitFor();
    const tabId = await h.open('/website-actions');
    assert.notEqual((await h.call('get_text', { tabId })).isError, true);
    assert.notEqual((await h.call('click', { tabId, selector: '#send' })).isError, true);
    assert.deepEqual(h.policy.allowDomains, [], 'ordinary use does not create permanent named grants');
    assert.equal(await popup.locator('#site-warnings li').count(), 0);
    assert.equal(await popup.locator('#blocked-section').isVisible(), false);
    await options.locator('#site-block-host').fill('127.0.0.1');
    await options.locator('#site-block-add').click();
    await popup.locator('#site-blocks').getByText('127.0.0.1', { exact: true }).waitFor();
    const denied = await h.call('click', { tabId, selector: '#send' });
    assert.equal(denied.isError, true);
    assert.match(textOf(denied), /Access.*removed/);
    await assert.rejects(h.bridge.sendCommand('get_text', {}, { tabId }), /Access.*removed/, 'worker independently enforces removal');
    await popup.locator('#site-blocks').getByRole('button', { name: 'Restore', exact: true }).click();
    await popup.locator('#site-blocks li').waitFor({ state: 'hidden' });
    assert.notEqual((await h.call('get_text', { tabId })).isError, true);
    await options.locator('#site-checks-toggle').click();
    await options.getByText('Off.', { exact: true }).waitFor();
    assert.equal((await h.call('get_text', { tabId })).isError, true);
  } finally { await h.close(); }
});

test('a suspicious address waits before navigation, shows reasons in both views, and approval is revocable', { skip: !RUN_E2E }, async () => {
  const h = await startHarness({ allowDomains: [] }, { siteGrants: true, browserPermissions: false, automaticPermission: true });
  try {
    let visits = 0;
    await h.ctx.route('https://google-login.example/**', async (route) => {
      visits++;
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Fixture</title><h1>Local fixture only</h1>' });
    });
    const popup = await automatic(h);
    const options = await h.ctx.newPage();
    await options.goto(new URL('options.html', h.sw.url()).href);
    const denied = await h.call('tab_new', { url: 'https://google-login.example/' });
    assert.equal(denied.isError, true);
    assert.equal(visits, 0, 'URL warning stops navigation before loading');
    const request = popup.locator('#site-warnings li').filter({ hasText: 'https://google-login.example' });
    await request.waitFor();
    assert.match(await request.innerText(), /login or account wording/);
    await options.locator('#site-warnings li').filter({ hasText: 'https://google-login.example' }).waitFor();
    await request.getByRole('button', { name: 'Allow', exact: true }).evaluate((el) => (el as HTMLButtonElement).click());
    assert.equal((await h.call('tab_new', { url: 'https://google-login.example/' })).isError, true);
    await request.getByRole('button', { name: 'Allow', exact: true }).click();
    await request.waitFor({ state: 'hidden' });
    const opened = await h.json<{ tabId: string }>('tab_new', { url: 'https://google-login.example/' });
    assert.ok(visits > 0);
    assert.notEqual((await h.call('get_text', { tabId: opened.tabId })).isError, true);
    await options.locator('#site-exceptions li').filter({ hasText: 'https://google-login.example' }).getByRole('button', { name: 'Remove', exact: true }).click();
    await options.locator('#site-exceptions li').waitFor({ state: 'hidden' });
    assert.equal((await h.call('get_text', { tabId: opened.tabId })).isError, true);
  } finally { await h.close(); }
});

test('changed login forms are checked before entering data, including direct worker commands and frames', { skip: !RUN_E2E }, async () => {
  const h = await startHarness({ allowDomains: [] }, { siteGrants: true, browserPermissions: false, automaticPermission: true });
  try {
    const popup = await automatic(h);
    const tabId = await h.open('/website-actions');
    const page = h.ctx.pages().find((page) => page.url() === `${h.base}/website-actions`)!;
    await page.evaluate(() => {
      document.title = 'Sign in to Google';
      const form = document.createElement('form');
      form.method = 'post';
      form.innerHTML = '<input id="password" type="password"><button>Sign in</button>';
      document.body.append(form);
    });
    const denied = await h.call('type', { tabId, selector: '#password', text: 'fixture-secret' });
    assert.equal(denied.isError, true);
    assert.match(textOf(denied), /presents itself as google/);
    assert.equal(await page.locator('#password').inputValue(), '', 'refused command never typed');
    const request = popup.locator('#site-warnings li');
    await request.getByRole('button', { name: 'Allow', exact: true }).click();
    await request.waitFor({ state: 'hidden' });
    assert.notEqual((await h.call('type', { tabId, selector: '#password', text: 'fixture-secret' })).isError, true);
    await page.evaluate(() => { document.querySelector('form')!.method = 'get'; });
    await assert.rejects(h.bridge.sendCommand('type', { selector: '#password', text: 'should-not-write' }, { tabId }), /website address/);
    assert.equal(await page.locator('#password').inputValue(), 'fixture-secret');
    const stored = JSON.stringify(await h.inSw(() => (globalThis as any).chrome.storage.local.get(['localSiteWarnings', 'localSiteWarningApprovals'])));
    assert.ok(!stored.includes('fixture-secret') && !stored.includes('should-not-write'));
    // A frame is inspected independently before its password field is touched.
    const other = await h.open('/frames');
    const parent = h.ctx.pages().find((page) => page.url() === `${h.base}/frames`)!;
    const child = parent.frames().find((frame) => frame.url().endsWith('/frame-inner'))!;
    await child.evaluate(() => {
      document.title = 'Sign in to PayPal';
      document.body.innerHTML = '<form method="post"><input id="password" type="password"></form>';
    });
    const frames = await h.json<{ frames: Array<{ frameId: number; url: string }> }>('frames_list', { tabId: other });
    const frameId = frames.frames.find((frame) => frame.url.endsWith('/frame-inner'))!.frameId;
    assert.equal((await h.call('type', { tabId: other, frameId, selector: '#password', text: 'blocked' })).isError, true);
    assert.equal(await child.locator('#password').inputValue(), '');
  } finally { await h.close(); }
});

test('untrusted pages cannot switch site checking or approve warnings', { skip: !RUN_E2E }, async () => {
  const h = await startHarness({}, { siteGrants: true, automaticPermission: true });
  try {
    const popup = await automatic(h);
    const tabId = await h.open('/');
    const id = Number(tabId.split(':').at(-1));
    const replies = await h.inSw(async () => {
      const c = (globalThis as any).chrome;
      const tabs = await c.tabs.query({});
      const fixture = tabs.find((tab: any) => tab.url?.startsWith('http://127.0.0.1:'));
      return c.scripting.executeScript({ target: { tabId: fixture.id }, func: async () => {
        const chromeApi = (globalThis as any).chrome;
        return Promise.all([
          { type: 'site_checks_mode', allow: false },
          { type: 'site_warning_allow', origin: 'https://google-login.example', reasons: ['brand-login:google'] },
          { type: 'site_block', host: 'ordinary.test', block: false },
        ].map((message) => chromeApi.runtime.sendMessage(message)));
      } });
    });
    assert.ok(id >= 0);
    for (const reply of replies[0].result) assert.equal(reply.ok, false);
    await popup.getByText('On.', { exact: true }).waitFor();
  } finally { await h.close(); }
});

test('automatic access retains app approvals through peers, Stop access, and native permission revocation', { skip: !RUN_E2E }, async () => {
  const h = await startHarness({ allowDomains: [] }, { siteGrants: true, browserPermissions: false, automaticPermission: true });
  const peer = new BridgeServer({ token: 'e2e-token', serverVersion: 'peer', port: h.port, heartbeatMs: 0 });
  try {
    const popup = await automatic(h);
    await peer.start();
    const executor = new ExtensionExecutor(peer);
    await assert.rejects(executor.checkSiteAccess(h.base), /Please approve/);
    await h.approveClient(peer);
    assert.equal(await executor.checkSiteAccess(h.base), true, 'peer negotiates checks for its paired browser');
    const tabId = await h.open('/');
    await popup.locator('#access-stop').click();
    await popup.locator('#access-resume').waitFor({ state: 'visible' });
    assert.equal((await h.call('get_text', { tabId })).isError, true, 'Stop access remains effective');
    await popup.locator('#access-resume').click();
    await popup.getByText('On.', { exact: true }).waitFor();
    const restore = popup.getByRole('button', { name: 'Approve again for 8 hours', exact: true });
    assert.equal(await restore.count(), 2, 'Stop revokes both the hub and peer app');
    for (let remaining = 2; remaining > 0; remaining--) {
      await restore.first().click();
      await restore.nth(remaining - 1).waitFor({ state: 'hidden' });
    }
    const resumed = await h.call('get_text', { tabId });
    assert.notEqual(resumed.isError, true, textOf(resumed));
    await h.inSw(() => (globalThis as any).chrome.permissions.remove({ origins: ['http://*/*', 'https://*/*'] }));
    await popup.getByText('On. Chrome permission needed.', { exact: true }).waitFor();
    const denied = await h.call('get_text', { tabId });
    assert.equal(denied.isError, true);
    assert.match(textOf(denied), /needs Chrome permission/);
    assert.equal(await popup.locator('#blocked-section').isVisible(), false);
  } finally { await peer.stop(); await h.close(); }
});

test('redirect destinations are checked and late warnings do not replay a navigation', { skip: !RUN_E2E }, async () => {
  const h = await startHarness({ allowDomains: [] }, { siteGrants: true, browserPermissions: false, automaticPermission: true });
  try {
    let redirects = 0;
    await h.ctx.route('https://ordinary.example/**', async (route) => {
      redirects++;
      await route.fulfill({ status: 302, headers: { location: 'https://paypal-login.example/' } });
    });
    await h.ctx.route('https://paypal-login.example/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Fixture</title>Fixture only' }));
    const popup = await automatic(h);
    const denied = await h.call('tab_new', { url: 'https://ordinary.example/' });
    assert.equal(denied.isError, true);
    assert.match(textOf(denied), /Website access paused after the command started/);
    await popup.locator('#site-warnings li').filter({ hasText: 'https://paypal-login.example' }).waitFor();
    assert.equal(redirects, 1);
    assert.equal(await popup.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'warning reasons fit the popup');
  } finally { await h.close(); }
});

test('automatic access and its native grant survive a worker reload without granting new app access', { skip: !RUN_E2E }, async () => {
  const h = await startHarness({ allowDomains: [] }, { siteGrants: true, browserPermissions: false, automaticPermission: true });
  try {
    await automatic(h);
    await h.open('/');
    const installId = await h.inSw(async () => (await (globalThis as any).chrome.storage.local.get('installId')).installId);
    const loaded = h.ctx.waitForEvent('serviceworker', { predicate: (worker) => worker !== h.sw });
    await h.inSw(() => (globalThis as any).chrome.runtime.reload()).catch(() => {});
    const worker = await loaded;
    // Reload closes extension pages and retires the previous worker's tab handles.
    const popup = await h.ctx.newPage();
    await popup.goto(new URL('popup.html', worker.url()).href);
    await popup.getByText('On.', { exact: true }).waitFor();
    assert.equal(await worker.evaluate(async () => (await (globalThis as any).chrome.storage.local.get('installId')).installId), installId);
    assert.deepEqual(h.bridge.pairedProfiles().map(profile => profile.name), ['default'], 'reload retains the original browser profile');
    const permission = await worker.evaluate(() => (globalThis as any).chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] }));
    assert.equal(permission, true);
    const tabs = await h.json<Array<{ tabId: string; url: string }>>('tabs_list');
    const tab = tabs.find((entry) => entry.url === `${h.base}/`);
    assert.ok(tab);
    const read = await h.call('get_text', { tabId: tab.tabId });
    assert.notEqual(read.isError, true, textOf(read));
    assert.equal(await popup.locator('#site-warnings li').count(), 0);
  } finally { await h.close(); }
});
