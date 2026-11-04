import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { WebSocketServer } from 'ws';

import { RelayPassError, connectRelay, sharedPassProvider } from '../src/remote/relay';
import { parseArgs } from '../src/config';

const DAY = 86_400_000;

test('the shared pass is cached until a day before it expires, and refusals back off', async () => {
  let clock = 1_000_000;
  const results: any[] = [{ ok: true, pass: 'p1', expiresAt: clock + 7 * DAY }, { ok: true, pass: 'p2', expiresAt: clock + 14 * DAY }];
  let calls = 0;
  const provider = sharedPassProvider(async () => { calls++; return results.shift(); }, () => clock);
  assert.equal(await provider.get(), 'p1');
  clock += 5 * DAY;
  assert.equal(await provider.get(), 'p1', 'still more than a day left');
  assert.equal(calls, 1);
  clock += 1.5 * DAY;
  assert.equal(await provider.get(), 'p2', 'renewed within the last day');
  provider.invalidate();
  results.push({ ok: false, status: 403, message: 'This email is not invited to the shared relay yet. Ask the owner for an invite.' });
  await assert.rejects(provider.get(), (err: unknown) => err instanceof RelayPassError && err.retryMs === 10 * 60_000 && /not invited/.test(err.message));
  results.push({ ok: false, status: 403, message: 'Access revoked or not verified.' });
  await assert.rejects(provider.get(), /verify this computer's email/);
  results.push({ ok: false, status: 0, message: 'could not reach mcp-browser-extension.com' });
  await assert.rejects(provider.get(), (err: unknown) => err instanceof RelayPassError && err.retryMs === 30_000);
});

test('a refused pass is replaced by a fresh one and the link comes up with the shared address', async () => {
  const http = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const seen: string[] = [];
  http.on('upgrade', (req, socket, head) => {
    seen.push(String(req.headers.authorization));
    if (req.headers.authorization !== 'Bearer good') return void socket.end('HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n');
    wss.handleUpgrade(req, socket, head, (ws) => ws.send(JSON.stringify({ t: 'hello', publicUrl: 'https://example.com/remote/c/AAAAAAAAAAAAAAAAAAAAAA' })));
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const passes = ['stale', 'good'];
  let invalidated = 0;
  const logs: string[] = [];
  let ready = '';
  const link = connectRelay({
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
    token: { get: async () => passes[0], invalidate: () => { invalidated++; passes.shift(); } },
    localPort: 1, log: (m) => logs.push(m), onReady: (url) => { ready = url; },
  });
  try {
    const deadline = Date.now() + 10_000;
    while (!ready && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.equal(ready, 'https://example.com/remote/c/AAAAAAAAAAAAAAAAAAAAAA');
    assert.deepEqual(seen, ['Bearer stale', 'Bearer good']);
    assert.equal(invalidated, 1);
    assert.match(logs.join('\n'), /refused this computer's pass; fetching a new one/);
  } finally {
    link.stop();
    for (const c of wss.clients) c.terminate();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});

test('--shared-relay implies --http and cannot be combined with another public address or a verification bypass', () => {
  const cfg = parseArgs(['--shared-relay']);
  assert.equal(cfg.sharedRelay, true);
  assert.equal(cfg.http, true);
  assert.throws(() => parseArgs(['--shared-relay', '--relay', 'https://relay.example.com']), /use one/);
  assert.throws(() => parseArgs(['--shared-relay', '--tunnel']), /use one/);
  assert.throws(() => parseArgs(['--shared-relay', '--no-email-verification']), /--no-email-verification/);
});
