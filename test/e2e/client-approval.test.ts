import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { WebSocket } from 'ws';
import { once } from 'node:events';
import { RUN_E2E, startHarness } from './harness';
import { createClientIdentity, withClientIdentity } from '../../src/bridge/client-identity';
import { BridgeServer } from '../../src/bridge/server';
import { createServer } from '../../src/mcp/server';
import { setProfileBridge } from '../../src/mcp/tools';
import { bypassEmailVerification } from '../../src/access';
import { PROTOCOL_VERSION } from '../../shared/protocol';

const skip = !RUN_E2E;

test('Chrome approval, separate app keys, self-approval denial and individual revocation', { skip }, async () => {
  const h = await startHarness({}, { approveClient: false });
  const a = createClientIdentity(() => 'First app'), b = createClientIdentity(() => 'Second app');
  const read = (identity = a) => withClientIdentity(identity, () => h.bridge.sendCommand('tabs_list', {}));
  try {
    await assert.rejects(read(), /Please approve/);
    const options = await h.ctx.newPage();
    await options.goto(new URL('options.html', h.sw.url()).href);
    const rowA = options.locator(`[data-client-id="${a.id}"]`);
    await rowA.getByRole('button', { name: 'Approve for 8 hours', exact: true }).waitFor();
    // Untrusted page code cannot press the approval button for the person.
    await rowA.getByRole('button', { name: 'Approve for 8 hours', exact: true }).evaluate((button) => (button as HTMLButtonElement).click());
    await assert.rejects(read(), /Please approve/);
    await rowA.getByRole('button', { name: 'Approve for 8 hours', exact: true }).click();
    await rowA.getByRole('button', { name: 'Remove access', exact: true }).waitFor();
    assert.ok(Array.isArray(await read()));
    const opened = await withClientIdentity(a, () => h.bridge.sendCommand('tab_new', { url: `${h.base}/website-actions` })) as { tabId: string };
    const act = (identity = a) => withClientIdentity(identity, () =>
      h.bridge.sendCommand('click', { selector: '#send' }, { tabId: opened.tabId }));
    await act();
    await act();
    await assert.rejects(act(b), /Please approve/, 'website access cannot approve another app');
    await assert.rejects(read(b), /Please approve/);
    const rowB = options.locator(`[data-client-id="${b.id}"]`);
    await rowB.getByRole('button', { name: 'Approve for 8 hours', exact: true }).click();
    await rowB.getByRole('button', { name: 'Remove access', exact: true }).waitFor();
    // Even an approved app cannot drive the approval page through the extension.
    await options.bringToFront();
    await assert.rejects(withClientIdentity(a, () => h.bridge.sendCommand('eval', { expression: 'document.body.textContent' })), /own pages/);
    for (const method of ['tab_select', 'tab_close'] as const) {
      await assert.rejects(withClientIdentity(a, () => h.bridge.sendCommand(method, {})), /own pages/);
    }
    await rowA.getByRole('button', { name: 'Remove access', exact: true }).click();
    await rowA.getByText('Access removed', { exact: true }).waitFor();
    await assert.rejects(read(), /revoked/);
    await assert.rejects(act(), /revoked/, 'app revocation also blocks actions on an allowed website');
    const fixture = h.ctx.pages().find((page) => page.url() === `${h.base}/website-actions`)!;
    assert.equal(await fixture.locator('#count').textContent(), '2');
    assert.ok(Array.isArray(await read(b)));
    await options.reload();
    await rowA.getByText('Access removed', { exact: true }).waitFor();
    await assert.rejects(read(), /revoked/);
  } finally { await h.close(); }
});

test('popup approvals, denial and revocation stay in sync with Settings', { skip }, async () => {
  const h = await startHarness({}, { approveClient: false });
  const a = createClientIdentity(() => 'codex-mcp-client 0.163.0'), b = createClientIdentity(() => 'Second app');
  const read = (identity = a) => withClientIdentity(identity, () => h.bridge.sendCommand('tabs_list', {}));
  const popup = await h.ctx.newPage();
  try {
    await popup.setViewportSize({ width: 360, height: 600 });
    await popup.goto(new URL('popup.html', h.sw.url()).href);
    await popup.getByText('No requests yet.', { exact: false }).waitFor();
    assert.equal(await popup.locator('#client-help').isVisible(), false);
    assert.equal(await popup.locator('#client-limits').isVisible(), false);
    await assert.rejects(read(), /Please approve/);
    const rowA = popup.locator(`[data-client-id="${a.id}"]`);
    await rowA.getByRole('button', { name: 'Approve for 8 hours', exact: true }).waitFor();
    assert.equal(await popup.locator('#client-help').isVisible(), true);
    assert.equal(await popup.locator('#client-limits').isVisible(), true);
    assert.equal(await rowA.locator('code').textContent(), `Key ${a.id.slice(0, 12)}`);
    assert.equal(await rowA.locator('code').isVisible(), true, 'the key stays visible before approval');
    assert.equal(await rowA.locator('strong').textContent(), 'Codex');
    // The popup must enforce the same human-click boundary as Settings.
    await rowA.getByRole('button', { name: 'Approve for 8 hours', exact: true }).evaluate((button) => (button as HTMLButtonElement).click());
    await assert.rejects(read(), /Please approve/);
    await rowA.getByRole('button', { name: 'Approve for 8 hours', exact: true }).click();
    await rowA.getByRole('button', { name: 'Remove access', exact: true }).waitFor();
    await rowA.getByText('Access allowed · 8 hours left', { exact: true }).waitFor();
    assert.equal(await popup.locator('#client-count').textContent(), '1 connection');
    assert.equal(await rowA.locator('code').isVisible(), false, 'approved connections keep technical information in Details');
    await rowA.locator('summary').focus();
    await popup.keyboard.press('Enter');
    await rowA.locator('code').waitFor();
    assert.equal(await rowA.getByText('Reported app: codex-mcp-client 0.163.0', { exact: true }).isVisible(), true);
    assert.equal(await rowA.getByText('Access ends:', { exact: false }).isVisible(), true);
    assert.ok(Array.isArray(await read()));

    const options = await h.ctx.newPage();
    await options.goto(new URL('options.html', h.sw.url()).href);
    const settingsA = options.locator(`[data-client-id="${a.id}"]`);
    await settingsA.getByRole('button', { name: 'Remove access', exact: true }).waitFor();
    await assert.rejects(read(b), /Please approve/);
    const rowB = popup.locator(`[data-client-id="${b.id}"]`);
    await rowB.getByRole('button', { name: 'Deny', exact: true }).waitFor();
    assert.equal(await popup.locator('#client-connections li').first().getAttribute('data-client-id'), b.id);
    assert.equal(await popup.locator('#client-count').textContent(), '1 waiting');
    assert.equal(await rowA.locator('details').evaluate((details) => (details as HTMLDetailsElement).open), true,
      'a new connection must not collapse details being read');
    await popup.bringToFront();
    await popup.emulateMedia({ colorScheme: 'light' });
    await popup.emulateMedia({ colorScheme: 'dark' });
    await assert.rejects(withClientIdentity(a, () => h.bridge.sendCommand('eval', { expression: 'document.body.textContent' })), /own pages/);
    await rowB.getByRole('button', { name: 'Deny', exact: true }).click();
    await rowB.getByText('Access removed', { exact: true }).waitFor();
    await assert.rejects(read(b), /revoked/);
    assert.ok(Array.isArray(await read()));
    await rowB.getByRole('button', { name: 'Approve again for 8 hours', exact: true }).click();
    await rowB.getByRole('button', { name: 'Remove access', exact: true }).waitFor();
    assert.ok(Array.isArray(await read(b)));

    // Decisions made in either view update the other view immediately.
    await settingsA.getByRole('button', { name: 'Remove access', exact: true }).click();
    await rowA.getByText('Access removed', { exact: true }).waitFor();
    await assert.rejects(read(), /revoked/);
    await rowB.getByRole('button', { name: 'Remove access', exact: true }).click();
    await options.locator(`[data-client-id="${b.id}"]`).getByText('Access removed', { exact: true }).waitFor();
    await assert.rejects(read(b), /revoked/);
    await popup.reload();
    await rowA.getByText('Access removed', { exact: true }).waitFor();
    await rowB.getByText('Access removed', { exact: true }).waitFor();

    const longName = createClientIdentity(() => 'A'.repeat(80));
    await assert.rejects(read(longName), /Please approve/);
    await popup.locator(`[data-client-id="${longName.id}"]`).waitFor();
    assert.equal(await popup.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'long names fit the popup width');
  } finally { await h.close(); }
});

test('sharing the bridge token does not confer the hub app approval', { skip }, async () => {
  const h = await startHarness();
  assert.equal(h.bridge.lastActiveUrl('default', Infinity), null, 'approval probes do not look up the active tab');
  const peer = new BridgeServer({ token: 'e2e-token', serverVersion: 'peer', port: h.port, heartbeatMs: 0 });
  let raw: WebSocket | undefined;
  try {
    await peer.start();
    await assert.rejects(peer.sendCommand('tabs_list', {}), /Please approve/);
    // A raw peer knows the shared transport token but holds no approved key.
    raw = new WebSocket(`ws://127.0.0.1:${h.port}`);
    await once(raw, 'open');
    const welcome = once(raw, 'message');
    raw.send(JSON.stringify({ type: 'peer_hello', v: PROTOCOL_VERSION, token: 'e2e-token', pid: 123 }));
    await welcome;
    const result = new Promise<any>((resolve) => raw!.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === 'relay_result' && frame.id === 'attack') resolve(frame);
    }));
    raw.send(JSON.stringify({ type: 'relay', id: 'attack', method: 'tabs_list', params: {} }));
    const denied = await result;
    assert.equal(denied.ok, false);
    assert.match(JSON.stringify(denied), /Signed client authorization/);
    await h.approveClient(peer);
    assert.ok(Array.isArray(await peer.sendCommand('tabs_list', {})));
    assert.ok(Array.isArray(await h.bridge.sendCommand('tabs_list', {})));
  } finally { raw?.terminate(); await peer.stop(); await h.close(); }
});

test('MCP sessions still need Chrome approval when email verification is bypassed', { skip }, async () => {
  const h = await startHarness({}, { approveClient: false });
  setProfileBridge(h.bridge);
  const sessions: Array<{ client: Client; server: ReturnType<typeof createServer> }> = [];
  try {
    for (const name of ['First client', 'Second client']) {
      const server = createServer('test', h.policy, bypassEmailVerification);
      const client = new Client({ name, version: '1' });
      const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTx), client.connect(clientTx)]);
      sessions.push({ client, server });
    }
    for (const s of sessions) {
      const denied = await s.client.callTool({ name: 'chrome_status', arguments: {} });
      assert.equal(denied.isError, true);
      assert.match(JSON.stringify(denied), /Please approve/);
    }
    const options = await h.ctx.newPage();
    await options.goto(new URL('options.html', h.sw.url()).href);
    const first = options.locator('#client-connections li').filter({ hasText: 'First client 1' });
    await first.getByRole('button', { name: 'Approve for 8 hours', exact: true }).click();
    await first.getByRole('button', { name: 'Remove access', exact: true }).waitFor();
    const allowed = await sessions[0].client.callTool({ name: 'tabs_list', arguments: {} });
    assert.notEqual(allowed.isError, true, JSON.stringify(allowed));
    assert.equal((await sessions[1].client.callTool({ name: 'tabs_list', arguments: {} })).isError, true);
    await first.getByRole('button', { name: 'Remove access', exact: true }).click();
    await first.getByText('Access removed', { exact: true }).waitFor();
    assert.equal((await sessions[0].client.callTool({ name: 'chrome_status', arguments: {} })).isError, true);
  } finally {
    setProfileBridge(null);
    for (const s of sessions) { await s.client.close(); await s.server.close(); }
    await h.close();
  }
});

test('a new app waiting for approval opens the popup once, not on every retry', { skip }, async () => {
  const h = await startHarness({}, { approveClient: false });
  const app = createClientIdentity(() => 'Popup app');
  const read = () => withClientIdentity(app, () => h.bridge.sendCommand('tabs_list', {}));
  try {
    await h.sw.evaluate(() => {
      const g = globalThis as any;
      g.opened = 0;
      g.chrome.action.openPopup = async () => { g.opened++; };
    });
    for (let i = 0; i < 3; i++) await assert.rejects(read(), /Please approve/);
    for (let i = 0; i < 100 && await h.sw.evaluate(() => (globalThis as any).opened) === 0; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(await h.sw.evaluate(() => (globalThis as any).opened), 1, 'one popup for the new app, none for its retries');
  } finally { await h.close(); }
});
