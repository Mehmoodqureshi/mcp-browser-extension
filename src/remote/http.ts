/**
 * src/remote/http.ts — serve MCP over Streamable HTTP, for clients that are not
 * on this computer (claude.ai, ChatGPT, Claude Code elsewhere, cloud agents).
 *
 * Binds 127.0.0.1 only; reaching it from the internet is the tunnel's job. Every
 * request must carry the remote key, either in the path (`/mcp/<key>`, for
 * connectors that cannot send headers) or as `Authorization: Bearer <key>` on
 * `/mcp`. Anything else gets a bare 404, so a scanner learns nothing.
 *
 * Each client session gets its own MCP server instance; they share the one
 * browser bridge, the policy, and the active profile, like several stdio
 * sessions sharing a hub.
 */

import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { createServer } from '../mcp/server';
import { requireAccess } from '../access';
import type { Policy } from '../security/policy';
import { keyMatches } from './key';
import type { PhonePairing } from './phone-pairing';
import { CHAT_AGENTS, ChatRequestError, createCodexChatRunner, PhoneChat } from './phone-chat';
import { claudeChatAvailable, createClaudeChatRunner } from './claude-chat';

/** Largest JSON-RPC body accepted; tool calls are small, uploads go by path. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface HttpMcpOptions {
  port: number;
  key: string;
  version: string;
  policy: Policy;
  log: (message: string) => void;
  /** Test seam; production callers use the Firebase-backed gate by default. */
  accessGuard?: typeof requireAccess;
  phonePairing?: PhonePairing;
  /** Personal, opt-in local Codex or Claude companion. Never runs on the relay host. */
  phoneChat?: boolean | PhoneChat;
}

export interface HttpMcp {
  port: number;
  /** Open client sessions. */
  sessions(): number;
  close(): Promise<void>;
}

/** The key a request presents, if any: `/mcp/<key>` or a Bearer header on `/mcp`. */
export function presentedKey(req: Pick<IncomingMessage, 'url' | 'headers'>): string | undefined {
  const path = (req.url ?? '').split('?')[0];
  const inPath = /^\/mcp\/([^/]+)\/?$/.exec(path);
  if (inPath) {
    try { return decodeURIComponent(inPath[1]); } catch { return undefined; }
  }
  if (path === '/mcp' || path === '/mcp/') {
    const auth = req.headers.authorization;
    const bearer = typeof auth === 'string' ? /^Bearer\s+(\S+)$/i.exec(auth) : null;
    return bearer?.[1];
  }
  return undefined;
}

function readJson(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined);
      } catch {
        reject(new Error('body is not JSON'));
      }
    });
    req.on('error', reject);
  });
}

function reply(res: ServerResponse, status: number, body?: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, body === undefined ? {} : { 'content-type': 'application/json' });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

function rpcError(res: ServerResponse, status: number, message: string): void {
  reply(res, status, { jsonrpc: '2.0', error: { code: -32000, message }, id: null });
}

export async function startHttpMcp(opts: HttpMcpOptions): Promise<HttpMcp> {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const principals = new Map<string, string>();
  const chats = opts.phoneChat instanceof PhoneChat ? opts.phoneChat : opts.phoneChat && opts.phonePairing
    ? new PhoneChat((id, agent) => (agent === 'claude' ? createClaudeChatRunner : createCodexChatRunner)(opts.phonePairing!, id, opts.version, opts.policy, opts.accessGuard),
      (id) => opts.phonePairing!.identity(id).assertAccess?.(), undefined, claudeChatAvailable() ? CHAT_AGENTS : ['codex']) : undefined;
  const removeListener = opts.phonePairing?.onRemove((id) => {
    chats?.remove(id);
    for (const [session, principal] of principals) {
      if (principal !== id) continue;
      const transport = transports.get(session);
      transports.delete(session);
      principals.delete(session);
      void transport?.close().catch(() => undefined);
    }
  });

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    res.setHeader('cache-control', 'no-store');
    const path = (req.url ?? '').split('?')[0];
    if (opts.phonePairing && path === '/pair/chat') {
      if (req.headers.origin || req.method !== 'POST' || !req.headers['content-type']?.startsWith('application/json')) return reply(res, 404);
      const secret = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '')?.[1];
      const phone = opts.phonePairing.authenticate(secret);
      if (!phone) return reply(res, 404);
      if (!chats) return reply(res, 409, { error: 'Chat is not enabled on this computer yet.' });
      let body: unknown;
      try { body = await readJson(req, 40_000); } catch { return reply(res, 400, { error: 'The chat request is invalid.' }); }
      // Revocation may have happened while the body was arriving.
      if (!opts.phonePairing.authenticate(secret)) return reply(res, 404);
      const abort = new AbortController();
      const disconnected = () => abort.abort();
      res.once('close', disconnected);
      try {
        const snapshot = await chats.poll(phone.id, body, abort.signal);
        if (!opts.phonePairing.authenticate(secret)) return reply(res, 404);
        if (!res.destroyed) return reply(res, 200, snapshot);
      }
      catch (error) {
        if (!res.destroyed) return reply(res, error instanceof ChatRequestError ? error.status : 404,
          { error: error instanceof ChatRequestError ? error.message : 'Phone access was removed or expired.' });
      }
      finally { res.off('close', disconnected); }
      return;
    }
    if (opts.phonePairing && (path === '/pair/claim' || path === '/pair/status')) {
      // Native mobile clients do not send Origin. A website cannot claim a QR
      // through a cross-origin form or fetch, including from the same machine.
      if (req.headers.origin || req.method !== 'POST' || !req.headers['content-type']?.startsWith('application/json')) return reply(res, 404);
      if (path === '/pair/status') {
        const secret = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '')?.[1];
        const status = opts.phonePairing.status(secret);
        return status ? reply(res, 200, status) : reply(res, 404);
      }
      try {
        const body = await readJson(req, 4096) as { code?: unknown; name?: unknown } | null;
        const claim = opts.phonePairing.claim(body?.code, body?.name);
        return reply(res, 202, { state: 'pending', ...claim });
      } catch { return reply(res, 400, { error: 'Pairing request is invalid or expired. Generate a new QR code.' }); }
    }

    const key = presentedKey(req);
    const phone = opts.phonePairing?.authenticate(key);
    const principal = phone?.id ?? (keyMatches(key, opts.key) ? 'owner' : undefined);
    if (!principal) return reply(res, 404);

    const sessionId = req.headers['mcp-session-id'];
    const existing = typeof sessionId === 'string' ? transports.get(sessionId) : undefined;
    if (existing && principals.get(sessionId as string) !== principal) return reply(res, 404);

    if (req.method === 'POST') {
      let body: unknown;
      try {
        body = await readJson(req);
      } catch (err) {
        return rpcError(res, 400, err instanceof Error ? err.message : 'bad request');
      }
      if (existing) return existing.handleRequest(req, res, body);
      if (sessionId !== undefined) return rpcError(res, 404, 'unknown session; initialize again');
      if (!isInitializeRequest(body)) return rpcError(res, 400, 'no session; send initialize first');

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport);
          principals.set(id, principal);
          opts.log(`remote client connected (${transports.size} open)`);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) {
          transports.delete(transport.sessionId);
          principals.delete(transport.sessionId);
        }
      };
      const server = createServer(opts.version, opts.policy, opts.accessGuard ?? requireAccess,
        phone ? opts.phonePairing!.identity(phone.id) : undefined);
      await server.connect(transport);
      return transport.handleRequest(req, res, body);
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      if (!existing) return rpcError(res, 404, 'unknown session');
      return existing.handleRequest(req, res);
    }
    res.setHeader('allow', 'GET, POST, DELETE');
    return reply(res, 405);
  };

  const http: Server = createHttpServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      opts.log(`remote request failed: ${err instanceof Error ? err.message : String(err)}`);
      rpcError(res, 500, 'internal error');
    });
  });

  await new Promise<void>((resolve, reject) => {
    http.once('error', (err: NodeJS.ErrnoException) =>
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(`Couldn't start: port ${opts.port} is in use. Pass --http-port <n> to pick another.`)
          : err,
      ),
    );
    http.listen(opts.port, '127.0.0.1', () => resolve());
  });
  const address = http.address();
  const port = typeof address === 'object' && address ? address.port : opts.port;

  return {
    port,
    sessions: () => transports.size,
    close: async () => {
      removeListener?.();
      chats?.close();
      await Promise.allSettled([...transports.values()].map((t) => t.close()));
      transports.clear();
      principals.clear();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
