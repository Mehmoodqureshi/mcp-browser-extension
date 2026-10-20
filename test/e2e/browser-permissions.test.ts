import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RUN_E2E, startHarness, textOf } from './harness';

type ChromePermissions = {
  permissions: {
    getAll(): Promise<{ permissions?: string[]; origins?: string[] }>;
    remove(request: { permissions?: string[]; origins?: string[] }): Promise<boolean>;
  };
};

test('upgrading a broad-permission install removes inherited hosts and optional features', { skip: !RUN_E2E }, async () => {
  const h = await startHarness({}, { legacyPermissions: true, browserPermissions: false });
  try {
    const permissions = await h.inSw(() => (globalThis as unknown as { chrome: ChromePermissions }).chrome.permissions.getAll());
    assert.deepEqual(permissions.origins ?? [], []);
    for (const permission of ['cookies', 'downloads', 'webRequest', 'webRequestAuthProvider']) {
      assert.ok(!permissions.permissions?.includes(permission), permission);
    }
    const saved = await h.inSw(() => (globalThis as unknown as { chrome: {
      storage: { local: { get(key: string): Promise<Record<string, unknown>> } };
    } }).chrome.storage.local.get('migrationSentinel'));
    assert.equal(saved.migrationSentinel, 'keep-existing-settings');
    assert.equal((await h.call('tab_new', { url: h.base })).isError, true);
  } finally { await h.close(); }
});

test('an upgrade preserves an existing active proxy rather than switching traffic to a direct connection', { skip: !RUN_E2E }, async () => {
  const h = await startHarness({}, { legacyPermissions: true, legacyProxy: true, browserPermissions: false });
  try {
    const permissions = await h.inSw(() => (globalThis as unknown as { chrome: ChromePermissions }).chrome.permissions.getAll());
    assert.deepEqual(permissions.origins ?? [], []);
    assert.ok(permissions.permissions?.includes('webRequestAuthProvider'));
    assert.ok(!permissions.permissions?.includes('cookies'));
    const settings = await h.inSw(() => new Promise<{ value: { mode: string }; levelOfControl: string }>((resolve) => {
      (globalThis as unknown as { chrome: {
        proxy: { settings: { get(details: object, callback: typeof resolve): void } };
      } }).chrome.proxy.settings.get({ incognito: false }, resolve);
    }));
    assert.equal(settings.value.mode, 'fixed_servers');
    assert.equal(settings.levelOfControl, 'controlled_by_this_extension');
  } finally { await h.close(); }
});

test('proxy authentication permissions are requested from Settings and removed when the proxy is switched off', { skip: !RUN_E2E }, async () => {
  const h = await startHarness({}, { browserPermissions: false });
  try {
    const options = await h.ctx.newPage();
    await options.goto(new URL('options.html', h.sw.url()).href);
    await options.locator('#proxy-enabled').check();
    await options.locator('#proxy-host').fill('127.0.0.1');
    await options.locator('#proxy-port').fill('9');
    await options.locator('#proxy-user').fill('fixture');
    await options.locator('#proxy-pass').fill('fixture');
    await options.locator('#proxy-save').click();
    await options.getByText('Proxy: on (http://127.0.0.1:9). Click Check IP to confirm.', { exact: true }).waitFor();
    let permissions = await h.inSw(() => (globalThis as unknown as { chrome: ChromePermissions }).chrome.permissions.getAll());
    assert.ok(permissions.permissions?.includes('webRequestAuthProvider'));
    assert.ok(permissions.permissions?.includes('webRequest'));
    assert.deepEqual(permissions.origins ?? [], [], 'saving a proxy does not grant any website');
    await options.locator('#proxy-enabled').uncheck();
    await options.locator('#proxy-save').click();
    await options.getByText('Proxy: off', { exact: true }).waitFor();
    permissions = await h.inSw(() => (globalThis as unknown as { chrome: ChromePermissions }).chrome.permissions.getAll());
    assert.ok(!permissions.permissions?.includes('webRequestAuthProvider'));
    assert.ok(!permissions.permissions?.includes('webRequest'));
  } finally { await h.close(); }
});

test('Chrome host access is separate from app and server approval, including debugger commands', { skip: !RUN_E2E }, async () => {
  const h = await startHarness({}, { browserPermissions: false, siteGrants: true });
  try {
    const initial = await h.inSw(() => (globalThis as unknown as { chrome: ChromePermissions }).chrome.permissions.getAll());
    assert.deepEqual(initial.origins ?? [], []);
    for (const permission of ['cookies', 'downloads', 'webRequest', 'webRequestAuthProvider']) {
      assert.ok(!initial.permissions?.includes(permission), permission);
    }
    const popup = await h.ctx.newPage();
    await popup.goto(new URL('popup.html', h.sw.url()).href);
    const request = popup.locator('#blocked .row').filter({ hasText: '127.0.0.1' });
    const before = await h.call('tab_new', { url: h.base });
    assert.equal(before.isError, true);
    assert.match(textOf(before), /Please allow access to 127\.0\.0\.1/);

    await request.getByRole('button', { name: 'Allow', exact: true }).click();
    await popup.locator('#allowed .row').filter({ hasText: '127.0.0.1' }).waitFor();
    const tabId = await h.open('/storage');
    assert.notEqual((await h.call('get_text', { tabId })).isError, true);

    await h.inSw(() => (globalThis as unknown as { chrome: ChromePermissions }).chrome.permissions.remove({
      origins: ['http://127.0.0.1/*', 'https://127.0.0.1/*'],
    }));
    for (const method of ['get_text', 'screenshot', 'print_pdf', 'type']) {
      await assert.rejects(h.bridge.sendCommand(method as 'get_text', { text: 'blocked' }, { tabId }), /Please allow access to 127\.0\.0\.1/, method);
    }
    assert.ok(h.policy.allowDomains.includes('127.0.0.1'), 'server approval alone does not restore Chrome permission');
    await request.getByRole('button', { name: 'Allow', exact: true }).click();
    await popup.locator('#allowed .row').filter({ hasText: '127.0.0.1' }).waitFor();
    assert.notEqual((await h.call('get_text', { tabId })).isError, true);
    assert.equal((await h.call('tab_new', { url: h.base.replace('127.0.0.1', 'localhost') })).isError, true);
  } finally { await h.close(); }
});

test('cookies and downloads need their own optional permission and removal takes effect immediately', { skip: !RUN_E2E }, async () => {
  const h = await startHarness({}, { browserPermissions: false });
  try {
    await h.grantBrowserPermissions({ origins: ['http://127.0.0.1/*', 'https://127.0.0.1/*'] });
    const tabId = await h.open('/storage');
    const popup = await h.ctx.newPage();
    await popup.goto(new URL('popup.html', h.sw.url()).href);
    const options = await h.ctx.newPage();
    await options.goto(new URL('options.html', h.sw.url()).href);

    await assert.rejects(h.bridge.sendCommand('get_cookies', {}, { tabId }), /Extra permissions → Allow cookies/);
    const cookies = popup.getByRole('button', { name: 'Allow cookies', exact: true });
    await cookies.waitFor();
    assert.equal(await h.inSw(() => (globalThis as unknown as { chrome: {
      action: { getBadgeText(details: object): Promise<string> };
    } }).chrome.action.getBadgeText({})), '?', 'an optional permission request is visible on the toolbar');
    await cookies.evaluate((element) => (element as HTMLButtonElement).click());
    await assert.rejects(h.bridge.sendCommand('get_cookies', {}, { tabId }), /Extra permissions/);
    await cookies.click();
    await popup.getByRole('button', { name: 'Remove cookies', exact: true }).waitFor();
    await options.getByRole('button', { name: 'Remove cookies', exact: true }).waitFor();
    assert.ok(JSON.stringify(await h.bridge.sendCommand('get_cookies', {}, { tabId })).includes('e2e'));
    await popup.getByRole('button', { name: 'Remove cookies', exact: true }).click();
    await popup.getByRole('button', { name: 'Allow cookies', exact: true }).waitFor();
    await assert.rejects(h.bridge.sendCommand('get_cookies', {}, { tabId }), /Extra permissions/);

    await assert.rejects(h.bridge.sendCommand('download_file', { url: h.base + '/file.txt' }), /Extra permissions → Allow downloads/);
    const downloads = popup.getByRole('button', { name: 'Allow downloads', exact: true });
    await downloads.waitFor();
    await downloads.evaluate((element) => (element as HTMLButtonElement).click());
    await assert.rejects(h.bridge.sendCommand('download_file', { url: h.base + '/file.txt' }), /Extra permissions/);
  } finally { await h.close(); }
});

test('observers follow concrete Chrome host grants and unregister on removal', { skip: !RUN_E2E }, async () => {
  const h = await startHarness({}, { browserPermissions: false });
  try {
    const popup = await h.ctx.newPage();
    await popup.goto(new URL('popup.html', h.sw.url()).href);
    const readRegistered = async (): Promise<string[]> => h.inSw(async () => {
      const c = (globalThis as unknown as { chrome: {
        scripting: { getRegisteredContentScripts(): Promise<Array<{ matches: string[] }>> };
      } }).chrome;
      return (await c.scripting.getRegisteredContentScripts()).flatMap((s) => s.matches);
    });
    assert.deepEqual(await readRegistered(), []);
    await popup.locator('#blocked .row').filter({ hasText: '127.0.0.1' }).getByRole('button', { name: 'Allow', exact: true }).click();
    await popup.waitForFunction(async () => {
      const c = (globalThis as unknown as { chrome: {
        scripting: { getRegisteredContentScripts(): Promise<Array<{ matches: string[] }>> };
      } }).chrome;
      return (await c.scripting.getRegisteredContentScripts()).some((s) => s.matches.includes('http://127.0.0.1/*'));
    });
    assert.deepEqual((await readRegistered()).sort(), ['http://127.0.0.1/*', 'https://127.0.0.1/*']);
    await popup.locator('#allowed .row').filter({ hasText: '127.0.0.1' }).getByRole('button', { name: 'Remove', exact: true }).click();
    await popup.waitForFunction(async () => {
      const c = (globalThis as unknown as { chrome: {
        scripting: { getRegisteredContentScripts(): Promise<unknown[]> };
      } }).chrome;
      return (await c.scripting.getRegisteredContentScripts()).length === 0;
    });
  } finally { await h.close(); }
});

test('an existing optional Downloads grant works and can be revoked from the popup', { skip: !RUN_E2E }, async () => {
  const h = await startHarness();
  try {
    const popup = await h.ctx.newPage();
    await popup.goto(new URL('popup.html', h.sw.url()).href);
    const download = await h.bridge.sendCommand('download_file', { url: h.base + '/file.txt' }) as { bytes: number };
    assert.equal(download.bytes, 'E2E-DOWNLOAD-BODY'.length);
    await popup.getByRole('button', { name: 'Remove downloads', exact: true }).click();
    await assert.rejects(h.bridge.sendCommand('download_file', { url: h.base + '/file.txt' }), /Extra permissions/);
    await popup.getByRole('button', { name: 'Allow downloads', exact: true }).waitFor();
  } finally { await h.close(); }
});

test('a refused Chrome request never adds a website grant', { skip: !RUN_E2E }, async () => {
  const h = await startHarness({ allowDomains: [] }, { browserPermissions: false, siteGrants: true });
  try {
    const popup = await h.ctx.newPage();
    await popup.goto(new URL('popup.html', h.sw.url()).href);
    await assert.rejects(h.bridge.sendCommand('tab_new', { url: h.base }), /Please allow access/);
    // Model Chrome returning false (dismissed or enterprise-denied) in this isolated worker.
    await h.sw.evaluate(() => {
      const c = (globalThis as unknown as { chrome: { permissions: { request: (value: unknown) => Promise<boolean> } } }).chrome;
      c.permissions.request = async () => false;
    });
    await popup.locator('#blocked .row').filter({ hasText: '127.0.0.1' }).getByRole('button', { name: 'Allow', exact: true }).click();
    await popup.getByText('No access was added. You can click Allow whenever you are ready.', { exact: true }).waitFor();
    assert.deepEqual(h.policy.allowDomains, []);
    assert.equal((await h.call('tab_new', { url: h.base })).isError, true);
    const direct = await popup.evaluate(async () => {
      const c = (globalThis as unknown as { chrome: { runtime: { sendMessage(value: unknown): Promise<{ ok: boolean }> } } }).chrome;
      return c.runtime.sendMessage({ type: 'site_grant', host: '127.0.0.1', allow: true });
    });
    assert.equal(direct.ok, false, 'background independently checks Chrome permission');
  } finally { await h.close(); }
});
