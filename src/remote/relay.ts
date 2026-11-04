/**
 * src/remote/relay.ts — a permanent public address for the local HTTP endpoint,
 * through a relay server the person runs (for example on AWS).
 *
 * This computer dials out to the relay over a WebSocket, so no inbound port is
 * opened here, and the relay hands each public request down that socket. Every
 * request is replayed against the local `--http` server, so the remote key, app
 * approval and site approval all still apply on this computer; the relay only
 * carries bytes. The link itself is guarded by the relay token, kept in
 * `<dataDir>/relay-token` (mode 0600) and configured on the relay server.
 *
 * Frames are JSON text; bodies and chunks are base64:
 *   relay -> here: hello {publicUrl}, req {id, method, path, headers, body?}, cancel {id}
 *   here -> relay: head {id, status, headers}, data {id, chunk}, end {id}, fail {id, message}
 */

import { request as httpRequest, type ClientRequest, type IncomingHttpHeaders } from 'node:http';
import { join } from 'node:path';

import { WebSocket } from 'ws';

import { resolveSecret } from './key';

const TOKEN_FILE = 'relay-token';
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;
/** Pings keep idle proxies from closing the link and notice a dead one. */
const PING_MS = 25_000;
const PONG_TIMEOUT_MS = 60_000;

/** Headers that describe one hop rather than the request; never carried across. */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer',
  'host', 'content-length',
]);

export type Headers = Record<string, string | string[]>;

export interface RelayLink {
  stop(): void;
}

export interface RelayOptions {
  /** The relay's base URL, e.g. https://relay.example.com; the link dials `<url>/connect`. */
  url: string;
  token: string;
  localPort: number;
  log: (message: string) => void;
  /** Each time the relay accepts this computer, with the address clients use. */
  onReady?: (publicUrl: string) => void;
  onOffline?: () => void;
}

export function relayTokenPath(dataDir: string): string {
  return join(dataDir, TOKEN_FILE);
}

export function resolveRelayToken(dataDir: string): string {
  return resolveSecret(relayTokenPath(dataDir));
}

/** The relay's WebSocket address for a base URL given as http(s) or ws(s). */
export function connectUrl(base: string): string {
  const url = new URL(base);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol !== 'wss:' && url.protocol !== 'ws:') {
    throw new Error(`--relay needs an http(s) URL, got ${base}`);
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/connect`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

/** Lower-cased headers without the hop-by-hop ones. */
export function endToEndHeaders(headers: IncomingHttpHeaders | Headers): Headers {
  const out: Headers = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (value === undefined || HOP_BY_HOP.has(key)) continue;
    out[key] = value;
  }
  return out;
}

interface RequestFrame {
  t: 'req';
  id: string;
  method: string;
  path: string;
  headers: Headers;
  body?: string;
}

/** Only an origin-relative path may reach the local server, never an absolute URL. */
function safePath(path: unknown): path is string {
  return typeof path === 'string' && path.startsWith('/') && !path.startsWith('//');
}

export function connectRelay(opts: RelayOptions): RelayLink {
  const target = connectUrl(opts.url);
  const inflight = new Map<string, ClientRequest>();
  let socket: WebSocket | null = null;
  let stopped = false;
  let retryMs = RETRY_MIN_MS;
  let retryTimer: NodeJS.Timeout | undefined;
  // Log changes, not every retry: a long outage would otherwise fill the log.
  let up = false;
  let outageLogged = false;

  const dropInflight = (): void => {
    for (const req of inflight.values()) req.destroy();
    inflight.clear();
  };

  const send = (ws: WebSocket, frame: object): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  };

  const forward = (ws: WebSocket, frame: RequestFrame): void => {
    const { id } = frame;
    if (!safePath(frame.path)) return send(ws, { t: 'fail', id, message: 'bad path' });
    const body = frame.body ? Buffer.from(frame.body, 'base64') : undefined;
    const headers = endToEndHeaders(frame.headers ?? {});
    if (body) headers['content-length'] = String(body.length);
    const req = httpRequest(
      { host: '127.0.0.1', port: opts.localPort, method: frame.method, path: frame.path, headers },
      (res) => {
        send(ws, { t: 'head', id, status: res.statusCode ?? 502, headers: endToEndHeaders(res.headers) });
        res.on('data', (chunk: Buffer) => send(ws, { t: 'data', id, chunk: chunk.toString('base64') }));
        res.on('end', () => {
          inflight.delete(id);
          send(ws, { t: 'end', id });
        });
        res.on('error', () => {
          inflight.delete(id);
          send(ws, { t: 'fail', id, message: 'local response failed' });
        });
      },
    );
    req.on('error', (err) => {
      if (!inflight.delete(id)) return; // cancelled: the relay already let go
      send(ws, { t: 'fail', id, message: `local server unreachable: ${err.message}` });
    });
    inflight.set(id, req);
    req.end(body);
  };

  const scheduleRetry = (): void => {
    if (stopped) return;
    retryTimer = setTimeout(open, retryMs);
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
  };

  function open(): void {
    if (stopped) return;
    const ws = new WebSocket(target, { headers: { authorization: `Bearer ${opts.token}` } });
    socket = ws;
    let alive = true;
    let ping: NodeJS.Timeout | undefined;

    ws.on('unexpected-response', (_req, res) => {
      if (!outageLogged) {
        outageLogged = true;
        opts.log(res.statusCode === 401 || res.statusCode === 403
          ? 'the relay refused this computer: its relay token does not match the one set on the relay server.'
          : `the relay answered ${res.statusCode}; retrying`);
      }
      ws.terminate();
    });

    ws.on('open', () => {
      ping = setInterval(() => {
        if (!alive) return ws.terminate();
        alive = false;
        ws.ping();
      }, PING_MS);
      ping.unref();
    });
    ws.on('pong', () => {
      alive = true;
    });

    ws.on('message', (data) => {
      let frame: { t?: string; id?: string; publicUrl?: string };
      try {
        frame = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (frame.t === 'hello' && typeof frame.publicUrl === 'string') {
        retryMs = RETRY_MIN_MS;
        up = true;
        outageLogged = false;
        opts.onReady?.(frame.publicUrl);
      } else if (frame.t === 'req' && typeof frame.id === 'string') {
        forward(ws, frame as RequestFrame);
      } else if (frame.t === 'cancel' && typeof frame.id === 'string') {
        const req = inflight.get(frame.id);
        inflight.delete(frame.id);
        req?.destroy();
      }
    });

    ws.on('close', () => {
      clearInterval(ping);
      if (socket === ws) socket = null;
      dropInflight();
      opts.onOffline?.();
      if (up && !stopped) opts.log('relay link lost; reconnecting');
      up = false;
      scheduleRetry();
    });
    // 'close' follows every 'error', and is where the retry is scheduled.
    ws.on('error', (err) => {
      if (outageLogged) return;
      outageLogged = true;
      opts.log(`cannot reach the relay (${err.message}); retrying`);
    });
  }

  open();

  return {
    stop: () => {
      stopped = true;
      clearTimeout(retryTimer);
      dropInflight();
      socket?.close();
    },
  };
}
