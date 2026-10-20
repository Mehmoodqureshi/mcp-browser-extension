import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';

const source = buildSync({ entryPoints: ['extension/src/sw/ws-client.ts'], bundle: true, write: false, format: 'cjs', platform: 'browser' }).outputFiles[0].text;

test('connection changes rotate challenges, ignore old sockets and never reroute late results', () => {
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 0;
    sent: any[] = [];
    onopen = () => {};
    onmessage = (_ev: { data: string }) => {};
    onclose = (_ev: { code: number }) => {};
    constructor(_url: string) { sockets.push(this); }
    send(text: string) { this.sent.push(JSON.parse(text)); }
    open() { this.readyState = 1; this.onopen(); }
    close() { this.readyState = 3; }
    receive(frame: unknown) { this.onmessage({ data: JSON.stringify(frame) }); }
  }
  const module = { exports: {} as any };
  runInNewContext(source, { module, exports: module.exports, crypto: webcrypto, WebSocket: FakeSocket,
    navigator: { userAgent: 'Chrome/116' }, chrome: { runtime: { id: 'test', getManifest: () => ({ version: 'test' }) } } });
  const replies: Array<(frame: unknown) => void> = [];
  const client = new module.exports.WsClient({ onCommand: (_cmd: unknown, reply: (frame: unknown) => void) => replies.push(reply),
    onState() {}, onPolicy() {}, log() {} });
  const command = { type: 'command', v: 1, id: '1', method: 'tabs_list', params: {} };
  client.connect(38017, 'test-token');
  const old = sockets[0]; old.open();
  old.receive(command);
  assert.equal(replies.length, 0, 'no commands before the welcome');
  old.receive({ type: 'welcome', v: 1, policy: {} });
  old.receive(command);
  assert.equal(replies.length, 1);
  const oldChallenge = client.approvalChallenge;
  client.close();
  client.connect(38018, 'new-token');
  const fresh = sockets[1]; fresh.open();
  fresh.receive({ type: 'welcome', v: 1, policy: {} });
  assert.notEqual(client.approvalChallenge, oldChallenge);
  old.onclose({ code: 1000 });
  assert.equal(client.state, 'connected', 'late close cannot disable the new connection');
  old.receive(command);
  fresh.receive({ ...command, v: 999 });
  assert.equal(replies.length, 1, 'stale sockets and wrong protocols are ignored');
  replies[0]({ type: 'result', id: '1', data: 'private old page' });
  assert.equal(fresh.sent.length, 1, 'old results cannot travel on the new socket');
  fresh.receive(command);
  replies[1]({ type: 'result', id: '1', data: 'new page' });
  assert.equal(fresh.sent[1].data, 'new page');
});
