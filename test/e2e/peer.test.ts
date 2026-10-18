/**
 * A second AI session's server joins the first as a peer and relays through it
 * to the browser. That is the everyday setup (Claude Code and Codex open at
 * once), and a peer cannot see the extension's advertised capabilities, so
 * every tool has to work without them.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { RUN_E2E, startHarness, textOf, type Harness } from './harness';
import { BridgeServer } from '../../src/bridge/server';
import { ExtensionExecutor } from '../../src/executor/extension-executor';
import { configureManager, resetManagerForTesting } from '../../src/executor/manager';
import { toWirePolicy } from '../../src/security/policy';
import { resetWorkTab } from '../../src/mcp/tools';

let h: Harness;
let peer: BridgeServer;
const skip = !RUN_E2E;

before(async () => {
  if (skip) return;
  h = await startHarness();
  peer = new BridgeServer({ token: 'e2e-token', serverVersion: 'e2e-peer', port: h.port, heartbeatMs: 0, policy: toWirePolicy(h.policy), siteGrants: false });
  await peer.start();
  // Route every tool call through the peer instead of the hub.
  resetManagerForTesting();
  configureManager({ policy: h.policy, makeExecutor: () => new ExtensionExecutor(peer) });
});
after(async () => {
  resetWorkTab();
  await peer?.stop().catch(() => undefined);
  await h?.close();
});

test('the second server really is a peer', { skip }, () => {
  assert.equal(peer.role, 'peer');
});

test('fill_form through a peer sets checkbox state, never toggles it', { skip }, async () => {
  const tab = await h.open('/form');
  const ticked = async (): Promise<boolean> =>
    (await h.json<{ value: boolean }>('eval', { tabId: tab, expression: "document.getElementById('agree').checked" })).value;

  // Each pair is (state before, value asked): a blind click gets two of them wrong.
  for (const [before, asked] of [[false, false], [true, true], [true, false], [false, true]] as const) {
    if ((await ticked()) !== before) await h.json('click', { selector: '#agree', tabId: tab });
    assert.equal(await ticked(), before);
    const filled = await h.json<{ filled: number }>('fill_form', { tabId: tab, fields: { '#name': 'Peer', '#agree': asked } });
    assert.equal(filled.filled, 2);
    assert.equal(await ticked(), asked, `asked ${asked} with the box ${before ? 'ticked' : 'unticked'}`);
  }
  await h.json('fill_form', { tabId: tab, fields: { '#agree': false }, submitSelector: '#send' });
  assert.equal((await h.json<{ text: string }>('get_text', { tabId: tab, selector: '#out' })).text, 'SENT:Peer:red:no');
  await h.json('tab_close', { tabId: tab });
});

test('the everyday tools work through a peer', { skip }, async () => {
  const tab = await h.open('/');
  assert.match((await h.json<{ text: string }>('get_text', { tabId: tab })).text, /E2E-HOME/);
  const shot = await h.call('screenshot', { tabId: tab });
  assert.equal(shot.isError, undefined, textOf(shot));
  const nav = await h.json<{ url: string }>('navigate', { tabId: tab, url: `${h.base}/form` });
  assert.equal(nav.url, `${h.base}/form`);
  const back = await h.json<{ url: string; moved: boolean }>('back', { tabId: tab });
  assert.equal(back.url, `${h.base}/`);
  assert.equal(back.moved, true);
  const picked = await h.json<{ shown: boolean }>('tab_select', { tabId: tab });
  assert.equal(picked.shown, false);
  await h.json('tab_close', { tabId: tab });
});
