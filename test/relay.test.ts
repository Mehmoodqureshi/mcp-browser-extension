/**
 * The relay link: this computer dials out to a relay server, which hands public
 * requests down the socket to be replayed against the local HTTP endpoint.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import { WebSocketServer, type WebSocket } from 'ws';

import { connectRelay, connectUrl, endToEndHeaders, relayTokenPath, resolveRelayToken } from '../src/remote/relay';
import { parseArgs } from '../src/config';

const TOKEN = 'T'.repeat(43);

interface Frame {
  t: string;
  id?: string;
  status?: number;
  headers?: Record<string, string>;
  chunk?: string;
  message?: string;
}

/** A stand-in relay: accepts one link with TOKEN, records what the computer sends. */
async function fakeRelay(port = 0): Promise<{
  url: string;
  port: number;
  link: () => Promise<WebSocket>;
  frames: Frame[];
  close: () => Promise<void>;
}> {
  const http = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const frames: Frame[] = [];
  let current: WebSocket | null = null;
  const waiting: ((ws: WebSocket) => void)[] = [];
  http.on('upgrade', (req, socket, head) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      socket.end('HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      current = ws;
      ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
      ws.send(JSON.stringify({ t: 'hello', publicUrl: 'https://example.com/remote' }));
      for (const w of waiting.splice(0)) w(ws);
    });
  });
  await new Promise<void>((resolve) => http.listen(port, '127.0.0.1', resolve));
  const actual = (http.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${actual}`,
    port: actual,
    link: () => (current ? Promise.resolve(current) : new Promise((resolve) => waiting.push(resolve))),
    frames,
    close: async () => {
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

/** The local MCP endpoint stand-in. */
async function localServer(handler: (req: IncomingMessage, body: string, res: import('node:http').ServerResponse) => void): Promise<Server> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => handler(req, body, res));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

const portOf = (s: Server): number => (s.address() as AddressInfo).port;

async function until(pred: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('condition never became true');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('the relay address becomes its WebSocket /connect address', () => {
  assert.equal(connectUrl('https://relay.example.com'), 'wss://relay.example.com/connect');
  assert.equal(connectUrl('https://example.com/base/'), 'wss://example.com/base/connect');
  assert.equal(connectUrl('http://127.0.0.1:8080?x=1'), 'ws://127.0.0.1:8080/connect');
  assert.throws(() => connectUrl('ftp://example.com'), /needs an http/);
});

test('hop-by-hop headers are not carried across', () => {
  assert.deepEqual(
    endToEndHeaders({ Host: 'a', Connection: 'keep-alive', 'Content-Length': '3', 'Content-Type': 'x', 'MCP-Session-Id': 's' }),
    { 'content-type': 'x', 'mcp-session-id': 's' },
  );
});

test('the relay token is made once and kept private', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbe-relay-'));
  const token = resolveRelayToken(dir);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(resolveRelayToken(dir), token);
  if (process.platform !== 'win32') assert.equal(statSync(relayTokenPath(dir)).mode & 0o777, 0o600);
});

test('--relay implies --http and needs https (http only for this computer)', () => {
  const cfg = parseArgs(['--relay', 'https://relay.example.com']);
  assert.equal(cfg.http, true);
  assert.equal(cfg.relay, 'https://relay.example.com');
  assert.equal(parseArgs(['--relay', 'http://127.0.0.1:8080']).relay, 'http://127.0.0.1:8080');
  assert.throws(() => parseArgs(['--relay', 'http://relay.example.com']), /needs an https URL/);
  assert.throws(() => parseArgs(['--relay', 'http://localhost.evil.com']), /needs an https URL/);
  assert.throws(() => parseArgs(['--relay']), /--relay/);
  assert.throws(() => parseArgs(['--relay', 'https://r.example.com', '--tunnel']), /use one/);
  assert.throws(() => parseArgs(['--relay', 'https://r.example.com', '--no-email-verification']), /cannot be used with --relay/);
});

test('a request from the relay reaches the local server and its streamed answer goes back', async () => {
  let seen: { method?: string; url?: string; body?: string; headers?: IncomingMessage['headers'] } = {};
  const local = await localServer((req, body, res) => {
    seen = { method: req.method, url: req.url, body, headers: req.headers };
    res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'sid' });
    res.write('event: message\n');
    res.end('data: {}\n\n');
  });
  const relay = await fakeRelay();
  const ready: string[] = [];
  const link = connectRelay({ url: relay.url, token: TOKEN, localPort: portOf(local), log: () => {}, onReady: (u) => ready.push(u) });
  try {
    const ws = await relay.link();
    await until(() => ready.length === 1);
    assert.equal(ready[0], 'https://example.com/remote');
    ws.send(JSON.stringify({
      t: 'req', id: 'r1', method: 'POST', path: '/mcp/KEY',
      headers: { 'content-type': 'application/json', host: 'evil.example' },
      body: Buffer.from('{"a":1}').toString('base64'),
    }));
    await until(() => relay.frames.some((f) => f.t === 'end'));
    assert.equal(seen.method, 'POST');
    assert.equal(seen.url, '/mcp/KEY');
    assert.equal(seen.body, '{"a":1}');
    assert.equal(seen.headers?.host, `127.0.0.1:${portOf(local)}`, 'the relay cannot pick the Host');
    const head = relay.frames.find((f) => f.t === 'head');
    assert.equal(head?.status, 200);
    assert.equal(head?.headers?.['mcp-session-id'], 'sid');
    const text = relay.frames.filter((f) => f.t === 'data').map((f) => Buffer.from(f.chunk!, 'base64').toString()).join('');
    assert.equal(text, 'event: message\ndata: {}\n\n');
  } finally {
    link.stop();
    await relay.close();
    local.close();
  }
});

test('absolute or protocol-relative paths are refused, never fetched', async () => {
  let hits = 0;
  const local = await localServer((_req, _b, res) => {
    hits++;
    res.end();
  });
  const relay = await fakeRelay();
  const link = connectRelay({ url: relay.url, token: TOKEN, localPort: portOf(local), log: () => {} });
  try {
    const ws = await relay.link();
    for (const [id, path] of [['a', 'http://169.254.169.254/'], ['b', '//evil.example/x'], ['c', 'mcp']]) {
      ws.send(JSON.stringify({ t: 'req', id, method: 'GET', path, headers: {} }));
    }
    await until(() => relay.frames.filter((f) => f.t === 'fail').length === 3);
    assert.equal(hits, 0);
  } finally {
    link.stop();
    await relay.close();
    local.close();
  }
});

test('cancel from the relay ends the local request', async () => {
  let closed = false;
  const local = await localServer((req, _b, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': open\n\n');
    req.socket.on('close', () => (closed = true));
  });
  const relay = await fakeRelay();
  const link = connectRelay({ url: relay.url, token: TOKEN, localPort: portOf(local), log: () => {} });
  try {
    const ws = await relay.link();
    ws.send(JSON.stringify({ t: 'req', id: 'long', method: 'GET', path: '/mcp', headers: {} }));
    await until(() => relay.frames.some((f) => f.t === 'head'));
    ws.send(JSON.stringify({ t: 'cancel', id: 'long' }));
    await until(() => closed);
  } finally {
    link.stop();
    await relay.close();
    local.close();
  }
});

test('a wrong relay token is reported once, not on every retry', async () => {
  const relay = await fakeRelay();
  const logs: string[] = [];
  const link = connectRelay({ url: relay.url, token: 'W'.repeat(43), localPort: 1, log: (m) => logs.push(m) });
  try {
    await until(() => logs.length >= 1);
    await new Promise((r) => setTimeout(r, 1_500)); // past the first retry
    assert.equal(logs.length, 1);
    assert.match(logs[0], /relay token does not match/);
  } finally {
    link.stop();
    await relay.close();
  }
});

test('the link comes back on its own after the relay restarts', async () => {
  const local = await localServer((_req, _b, res) => res.end('ok'));
  let relay = await fakeRelay();
  const port = relay.port;
  const ready: string[] = [];
  const logs: string[] = [];
  const link = connectRelay({ url: relay.url, token: TOKEN, localPort: portOf(local), log: (m) => logs.push(m), onReady: (u) => ready.push(u) });
  try {
    await relay.link();
    await until(() => ready.length === 1);
    await relay.close();
    await until(() => logs.some((m) => /relay link lost/.test(m)));
    relay = await fakeRelay(port);
    await relay.link();
    await until(() => ready.length === 2, 10_000);
  } finally {
    link.stop();
    await relay.close();
    local.close();
  }
});

test('stop() closes the link and does not reconnect', async () => {
  const relay = await fakeRelay();
  const link = connectRelay({ url: relay.url, token: TOKEN, localPort: 1, log: () => {} });
  try {
    const ws = await relay.link();
    const closed = once(ws, 'close');
    link.stop();
    await closed;
    await new Promise((r) => setTimeout(r, 1_500));
    assert.equal(relay.frames.length, 0);
  } finally {
    await relay.close();
  }
});
