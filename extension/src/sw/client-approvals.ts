import {
  CLIENT_CLOCK_SKEW_MS, CLIENT_GRANT_MS, CLIENT_REQUEST_MS, clientName, clientSigningPayload,
  isHealthProbe, type ClientConnection,
} from '../../../shared/client-auth';
import { PROTOCOL_VERSION, type CommandFrame } from '../../../shared/protocol';
import { CmdError } from './cmd-error';

const MAX_CLIENTS = 64;
const MAX_NONCES = 4096;
const MAX_QUEUED_COMMANDS = 64;
const denied = (message: string): never => { throw new CmdError('POLICY_DENIED', message); };

function decode(value: string): Uint8Array<ArrayBuffer> {
  const raw = atob(value);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export interface ApprovalDeps {
  read(): Promise<unknown>;
  write(clients: ClientConnection[]): Promise<void>;
  challenge(): string;
  now?: () => number;
  changed?: (clients: ClientConnection[]) => void;
}

/** Only this worker owns grants. A bridge token or a claimed app name cannot grant access. */
export class ClientApprovals {
  private clients: ClientConnection[] = [];
  private loaded = false;
  private storageFault = false;
  private revokingAll = false;
  private queuedCommands = 0;
  private readonly revoking = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly nonces = new Map<string, Map<string, number>>();
  private readonly now: () => number;

  constructor(private readonly deps: ApprovalDeps) { this.now = deps.now ?? Date.now; }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    const saved = await this.deps.read();
    if (saved !== undefined && (!Array.isArray(saved) || saved.length > MAX_CLIENTS || saved.some((c) =>
      !c || typeof c.id !== 'string' || !/^[a-f0-9]{64}$/.test(c.id) ||
      typeof c.publicKey !== 'string' || typeof c.name !== 'string' ||
      !['pending', 'approved', 'revoked'].includes(c.state) ||
      !Number.isFinite(c.requestedAt) || !Number.isFinite(c.expiresAt)))) {
      denied('Client approval storage is invalid. Browser access is blocked.');
    }
    this.clients = (saved ?? []) as ClientConnection[];
    this.loaded = true;
    this.deps.changed?.(this.clients);
  }

  private async save(clients: ClientConnection[]): Promise<void> {
    // Persist before granting; a failed write must never grant temporary access.
    await this.deps.write(clients);
    this.clients = clients;
    this.deps.changed?.(clients);
  }

  /** The returned check runs again immediately before execution, after tab/policy awaits. */
  async authorize(cmd: CommandFrame, verified?: (id: string, name: string) => void): Promise<() => void> {
    if (isHealthProbe(cmd)) return () => undefined;
    if (this.queuedCommands >= MAX_QUEUED_COMMANDS) return denied('Too many pending client commands. Retry after the current commands finish.');
    this.queuedCommands++;
    return this.serial(async () => {
      if (this.storageFault) return denied('Client approval storage failed. Save the decision again in the extension popup or Settings before continuing.');
      try { await this.load(); } catch { return denied('Cannot load client approvals. Browser access is blocked.'); }
      const p = cmd.authorization;
      const now = this.now();
      if (cmd.v !== PROTOCOL_VERSION || !p || typeof p.publicKey !== 'string' || p.publicKey.length !== 124 ||
        typeof p.signature !== 'string' || p.signature.length !== 88 ||
        typeof p.name !== 'string' || p.name !== clientName(p.name) ||
        typeof p.nonce !== 'string' || !/^[a-f0-9-]{36}$/.test(p.nonce) ||
        !Number.isSafeInteger(p.issuedAt) || Math.abs(now - p.issuedAt) > CLIENT_CLOCK_SKEW_MS ||
        !this.deps.challenge() || p.challenge !== this.deps.challenge()) {
        return denied('Client authorization is missing, stale or invalid. Update the server and extension, then reconnect.');
      }
      let id: string;
      try {
        const der = decode(p.publicKey);
        const key = await crypto.subtle.importKey('spki', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
        const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key,
          decode(p.signature), new TextEncoder().encode(clientSigningPayload(cmd, p)));
        if (!valid) return denied('Client signature is invalid. Browser access is blocked.');
        id = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', der)), (b) => b.toString(16).padStart(2, '0')).join('');
      } catch { return denied('Client signature is invalid. Browser access is blocked.'); }
      let client = this.clients.find((c) => c.id === id);
      if (client && (client.publicKey !== p.publicKey || client.name !== p.name)) {
        return denied('Client identity changed. Start a new connection and approve it in Chrome.');
      }
      verified?.(id, p.name);
      if (this.revokingAll) return denied('Browser access is being stopped.');
      if (this.revoking.has(id) || client?.state === 'revoked') return denied(`Client access was revoked (${id.slice(0, 12)}). Only you can restore it in the extension popup or Settings.`);
      if (!client || client.expiresAt <= now) {
        // Old records can be forgotten safely: their next command still needs approval.
        const live = this.clients.filter((c) => c.id !== id && c.expiresAt > now);
        if (live.length >= MAX_CLIENTS) return denied('Too many client connections. Remove access for unused apps in the extension popup or Settings and retry later.');
        client = { id, publicKey: p.publicKey, name: p.name, state: 'pending', requestedAt: now, expiresAt: now + CLIENT_REQUEST_MS };
        try { await this.save([...live, client]); } catch { return denied('Cannot save the approval request. Browser access is blocked.'); }
      }
      // Only persisted client records get replay buckets. This keeps arbitrary
      // signed identities from occupying slots before the MAX_CLIENTS gate.
      for (const [clientId, seen] of this.nonces) {
        for (const [nonce, expires] of seen) if (expires < now) seen.delete(nonce);
        if (!seen.size) this.nonces.delete(clientId);
      }
      let seen = this.nonces.get(id);
      if (!seen) { seen = new Map(); this.nonces.set(id, seen); }
      if (seen.has(p.nonce)) return denied('Replayed client command refused.');
      if (seen.size >= MAX_NONCES) return denied('Too many client commands from this app. Wait two minutes and retry.');
      seen.set(p.nonce, p.issuedAt + CLIENT_CLOCK_SKEW_MS);
      if (client.state !== 'approved') {
        return denied(`Please approve "${client.name}" (check key ${id.slice(0, 12)}): Chrome → MCP Browser Extension icon → App connections → Approve for 8 hours.`);
      }
      const authorizedGrant = client;
      const check = (): void => {
        const grant = this.clients.find((c) => c.id === id);
        if (this.storageFault || this.revokingAll || this.revoking.has(id) || p.challenge !== this.deps.challenge() || grant !== authorizedGrant || grant.state !== 'approved' || grant.expiresAt <= this.now()) {
          denied('Client access expired, was revoked or disconnected. Approve the connection in Chrome before retrying.');
        }
      };
      check();
      return check;
    }).finally(() => { this.queuedCommands--; });
  }

  revokeAll(): Promise<void> {
    this.revokingAll = true;
    return this.serial(async () => {
      try {
        await this.load();
        this.clients = this.clients.map((c) => ({ ...c, state: 'revoked', expiresAt: this.now() + CLIENT_GRANT_MS }));
        await this.save(this.clients);
        this.storageFault = false;
        this.revokingAll = false;
      } catch (err) {
        this.storageFault = true;
        throw err;
      }
    });
  }

  /** Called exclusively by messages from the extension's own approval UI. */
  decide(id: string, allow: boolean): Promise<void> {
    if (!allow) this.revoking.add(id);
    return this.serial(async () => {
      await this.load();
      const client = this.clients.find((c) => c.id === id);
      if (!client) { this.revoking.delete(id); return denied('That connection no longer exists.'); }
      if (allow && client.state === 'pending' && client.expiresAt <= this.now()) {
        return denied('This request expired. Retry the tool to request access again.');
      }
      const next: ClientConnection = { ...client, state: allow ? 'approved' : 'revoked', expiresAt: this.now() + CLIENT_GRANT_MS };
      // Revocation is immediate even if persisting it fails. Block all further
      // access in this worker if the durable write fails. Report failure to the UI.
      if (!allow) this.clients = this.clients.map((c) => c.id === id ? next : c);
      try {
        await this.save(this.clients.map((c) => c.id === id ? next : c));
        this.storageFault = false;
        this.revoking.delete(id);
      } catch (err) {
        // Keep the in-memory revoke and refuse commands until a decision can
        // be saved. Report failure rather than claiming a durable revocation.
        this.storageFault = true;
        throw err;
      }
    });
  }
}

export function isApprovalPage(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id &&
    [chrome.runtime.getURL('options.html'), chrome.runtime.getURL('popup.html')].includes(sender.url ?? '') &&
    (sender.frameId === undefined || sender.frameId === 0);
}
