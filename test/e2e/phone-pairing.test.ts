import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import jsQR from 'jsqr';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { RUN_E2E, startHarness } from './harness';
import { PhonePairing } from '../../src/remote/phone-pairing';
import { startPhoneControl, phoneControlReply } from '../../src/remote/phone-control';
import { startHttpMcp } from '../../src/remote/http';
import { setProfileBridge } from '../../src/mcp/tools';

test('scan the popup QR, approve the phone, use Chrome, then remove access', { skip: !RUN_E2E }, async () => {
  const h = await startHarness();
  setProfileBridge(h.bridge);
  const pairing = new PhonePairing(h.dataDir, 'default');
  pairing.setPublicUrl('https://relay.example/remote');
  const control = await startPhoneControl(pairing);
  const http = await startHttpMcp({ port: 0, key: randomBytes(32).toString('base64url'), version: 'test', policy: h.policy,
    log: () => {}, accessGuard: async () => null, phonePairing: pairing });
  // The disposable browser has no OS native-host installation. This adapter
  // exercises the real private controller; only native message delivery is replaced.
  const adapterKey = randomBytes(32).toString('hex');
  const adapter = createServer((req, res) => {
    if (req.headers.authorization !== adapterKey) { res.writeHead(404).end(); return; }
    let body = '';
    req.on('data', (chunk) => { body += String(chunk); });
    req.on('end', () => {
      void phoneControlReply(h.dataDir, JSON.parse(body)).then((reply) => res.end(JSON.stringify(reply)));
    });
  });
  await new Promise<void>((resolve) => adapter.listen(0, '127.0.0.1', resolve));
  const address = adapter.address() as { port: number };
  const base = `http://127.0.0.1:${http.port}`;
  const client = new Client({ name: 'Future phone app fixture', version: '1' });
  try {
    await h.sw.evaluate(({ url, key }) => {
      const c = (globalThis as any).chrome;
      const contains = c.permissions.contains.bind(c.permissions);
      const request = c.permissions.request.bind(c.permissions);
      c.permissions.contains = (p: any) => p.permissions?.includes('nativeMessaging') ? Promise.resolve(true) : contains(p);
      c.permissions.request = (p: any) => p.permissions?.includes('nativeMessaging') ? Promise.resolve(true) : request(p);
      c.runtime.sendNativeMessage = async (_host: string, message: unknown) => {
        const response = await fetch(url, { method: 'POST', headers: { authorization: key }, body: JSON.stringify(message) });
        return response.json();
      };
    }, { url: `http://127.0.0.1:${address.port}/`, key: adapterKey });
    const popup = await h.ctx.newPage();
    await popup.setViewportSize({ width: 360, height: 600 });
    await popup.goto(new URL('popup.html', h.sw.url()).href);
    await popup.locator('#phone-open').click();
    await popup.locator('#phone-status').filter({ hasText: 'Ready to pair' }).waitFor();
    await popup.locator('#phone-generate').click();
    await popup.locator('#phone-qr').waitFor({ state: 'visible' });
    const pixels = await popup.locator('#phone-qr').evaluate((node) => {
      const canvas = node as HTMLCanvasElement;
      return { width: canvas.width, height: canvas.height, data: Array.from(canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data) };
    });
    const decoded = jsQR(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height);
    assert.ok(decoded, 'a phone scanner can decode the rendered QR');
    const invitation = JSON.parse(decoded.data);
    assert.equal(invitation.type, 'mbe-pairing');
    assert.equal(invitation.v, 1);
    assert.equal(invitation.url, 'https://relay.example/remote/pair');
    for (const theme of ['light', 'dark'] as const) {
      await popup.emulateMedia({ colorScheme: theme });
      assert.equal(await popup.locator('#phone-dialog').evaluate((d) => d.getBoundingClientRect().right <= innerWidth), true);
    }
    const response = await fetch(`${base}/pair/claim`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: invitation.code, name: 'Test phone' }) });
    assert.equal(response.status, 202);
    const phone = await response.json() as { id: string; token: string; confirmation: string };
    const allow = popup.getByRole('button', { name: 'Allow this phone', exact: true });
    await allow.waitFor();
    assert.equal((await popup.locator('.phone-code').innerText()).replace(/ /g, ''), phone.confirmation);
    assert.equal(pairing.authenticate(phone.token), undefined);
    await allow.evaluate((button) => (button as HTMLButtonElement).click());
    assert.equal(pairing.authenticate(phone.token), undefined, 'a synthetic click cannot approve the phone');
    // Polling must not replace the pressed approval button.
    const original = await allow.elementHandle();
    await allow.scrollIntoViewIfNeeded();
    const box = (await allow.boundingBox())!;
    await popup.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await popup.mouse.down();
    await popup.waitForTimeout(2200);
    assert.equal(await original!.evaluate((button) => button.isConnected), true);
    await popup.mouse.up();
    const remove = popup.locator('#phone-dialog').getByRole('button', { name: 'Remove access', exact: true });
    await remove.waitFor();
    assert.ok(pairing.authenticate(phone.token));
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${phone.token}` } } }));
    const result = await client.callTool({ name: 'tabs_list', arguments: {} });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.equal((await client.listTools()).tools.some((tool) => tool.name === 'profile_use'), false);
    const target = await h.sw.evaluate(async (url) => {
      const c = (globalThis as any).chrome;
      const window = await c.windows.create({ url, focused: false });
      return { nativeId: window.tabs[0].id as number, windowId: window.id as number };
    }, `${h.base}/form`);
    await popup.waitForFunction(async (id) => (await (globalThis as any).chrome.tabs.get(id)).status === 'complete', target.nativeId);
    const listing = await client.callTool({ name: 'tabs_list', arguments: {} });
    const tabs = JSON.parse((listing.content as { type: string; text: string }[]).find((item) => item.type === 'text')!.text) as { tabId: string }[];
    const tabId = tabs.find((tab) => tab.tabId.endsWith(`:${target.nativeId}`))!.tabId;
    const selected = await client.callTool({ name: 'tab_select', arguments: { tabId, show: true } });
    assert.notEqual(selected.isError, true, JSON.stringify(selected));
    const visible = await h.sw.evaluate(async ({ nativeId, windowId }) => {
      const c = (globalThis as any).chrome;
      return { active: (await c.tabs.get(nativeId)).active, focused: (await c.windows.get(windowId)).focused };
    }, target);
    assert.deepEqual(visible, { active: true, focused: true }, 'the phone can bring the chosen Chrome tab and its window to the front');
    await remove.click();
    await remove.waitFor({ state: 'hidden' });
    assert.equal(pairing.authenticate(phone.token), undefined);
    await assert.rejects(client.listTools());
    const connections = await h.sw.evaluate(async () => (await (globalThis as any).chrome.storage.local.get('clientConnections')).clientConnections);
    assert.equal(connections.find((c: any) => c.phoneId === phone.id)?.state, 'revoked');
    // Closing the panel wipes pixels; the escape key also restores normal popup focus.
    await popup.locator('#phone-generate').click();
    await popup.locator('#phone-qr').waitFor({ state: 'visible' });
    await popup.keyboard.press('Escape');
    assert.equal(await popup.locator('#phone-dialog').evaluate((d) => (d as HTMLDialogElement).open), false);
    await popup.waitForFunction(() => {
      const c = document.querySelector<HTMLCanvasElement>('#phone-qr')!;
      return c.hidden && c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data.every((v) => v === 0);
    });
  } finally {
    await client.close();
    adapter.closeAllConnections();
    await new Promise<void>((resolve) => adapter.close(() => resolve()));
    await http.close();
    await control.close();
    setProfileBridge(null);
    await h.close();
  }
});
