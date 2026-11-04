/** Private loopback channel used only by the extension's native messaging helper. */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, unlinkSync, writeFileSync, renameSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { join } from 'node:path';
import { PHONE_ACTIONS, type PhoneAction, type PhoneReply } from '../../shared/phone-pairing';
import { keyMatches } from './key';
import type { PhonePairing } from './phone-pairing';

const controlPath = (dir: string, profile: string): string =>
  join(dir, 'phone-pairing', `control-${createHash('sha256').update(profile).digest('hex')}.json`);

export async function startPhoneControl(pairing: PhonePairing): Promise<{ close(): Promise<void> }> {
  const secret = randomBytes(32).toString('base64url');
  const server = createServer((req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-type', 'application/json');
    const provided = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (req.method !== 'POST' || req.url !== '/' || req.headers.origin || !keyMatches(provided, secret)) {
      res.writeHead(404).end(); return;
    }
    let body = '';
    req.setTimeout(5_000, () => req.destroy());
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
      if (Buffer.byteLength(body) > 4096) req.destroy();
    });
    req.on('end', () => {
      try {
        const message = JSON.parse(body) as { action?: PhoneAction; id?: unknown };
        if (!message || !PHONE_ACTIONS.includes(message.action!) ||
          (['approve', 'deny', 'remove'].includes(message.action!) && typeof message.id !== 'string')) throw new Error('Invalid phone action.');
        const id = typeof message.id === 'string' ? message.id : '';
        if (message.action === 'create') pairing.create();
        else if (message.action === 'cancel') pairing.cancel();
        else if (message.action === 'approve') pairing.approve(id);
        else if (message.action === 'deny') pairing.deny(id);
        else if (message.action === 'remove') pairing.remove(id);
        res.end(JSON.stringify({ ok: true, state: pairing.state() } satisfies PhoneReply));
      } catch (err) {
        const message = err instanceof Error && !/JSON|ENOENT|EACCES|ENOSPC/.test(err.message)
          ? err.message : 'Could not save phone access. Try again.';
        res.end(JSON.stringify({ ok: false, message } satisfies PhoneReply));
      }
    });
    req.on('error', () => { if (!res.writableEnded) res.destroy(); });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not start phone pairing.');
  const path = controlPath(pairing.dataDir, pairing.profile);
  const contents = JSON.stringify({ port: address.port, token: secret, pid: process.pid });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, contents, { mode: 0o600 });
    renameSync(temporary, path);
  } catch (err) { server.close(); throw err; }
  return { close: async () => {
    pairing.cancel();
    try { if (readFileSync(path, 'utf8') === contents) unlinkSync(path); } catch { /* another process owns it now */ }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  } };
}

export async function phoneControlReply(dataDir: string, message: unknown): Promise<PhoneReply> {
  const m = message as { profile?: unknown; action?: PhoneAction; id?: unknown } | null;
  if (!m || typeof m.profile !== 'string' || m.profile.length > 100 || !PHONE_ACTIONS.includes(m.action!)) {
    return { ok: false, message: 'Invalid phone pairing request.' };
  }
  try {
    const config = JSON.parse(readFileSync(controlPath(dataDir, m.profile), 'utf8')) as { port: number; token: string; pid: number };
    if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535 ||
      typeof config.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(config.token) || !Number.isInteger(config.pid)) throw new Error('invalid');
    process.kill(config.pid, 0);
    return await new Promise<PhoneReply>((resolve, reject) => {
      const body = JSON.stringify({ action: m.action, id: m.id });
      const req = request({ hostname: '127.0.0.1', port: config.port, path: '/', method: 'POST',
        headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      }, (res) => {
        let answer = '';
        res.on('data', (chunk: Buffer) => {
          answer += chunk.toString('utf8');
          if (Buffer.byteLength(answer) > 64 * 1024) { res.destroy(); reject(new Error('too large')); }
        });
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) throw new Error('unavailable');
            const parsed = JSON.parse(answer) as PhoneReply;
            if (typeof parsed.ok !== 'boolean') throw new Error('invalid');
            resolve(parsed);
          } catch (err) { reject(err); }
        });
        res.on('error', reject);
      });
      req.setTimeout(5_000, () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end(body);
    });
  } catch { return { ok: false, message: 'Phone pairing is not running for this browser. Start or update its remote connection first.' }; }
}
