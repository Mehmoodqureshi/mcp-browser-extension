import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clientName } from '../../shared/client-auth';
import { PHONE_ACCESS_MS, PHONE_INVITATION_MS, PHONE_MAX_DEVICES, type PhoneDevice, type PhonePairingState } from '../../shared/phone-pairing';
import { createClientIdentity, type ClientIdentity } from '../bridge/client-identity';
import { ensureWorkspace } from '../bridge/datadir';

interface SavedPhone extends PhoneDevice { tokenHash: string; privateKey: string }
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const token = (): string => randomBytes(32).toString('base64url');
const validToken = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const matches = (value: unknown, expected: string): boolean => validToken(value) && timingSafeEqual(Buffer.from(hash(value)), Buffer.from(expected));

/** Secrets are local; the public relay never receives the browser's master key. */
export class PhonePairing {
  private readonly path: string;
  private readonly now: () => number;
  private devices: SavedPhone[] = [];
  private pending: SavedPhone | undefined;
  private invitation: { code: string; expiresAt: number } | undefined;
  private publicUrl: string | undefined;
  private readonly identities = new Map<string, ClientIdentity>();
  private readonly revoked = new Set<string>();
  private readonly listeners = new Set<(id: string) => void>();

  constructor(readonly dataDir: string, readonly profile: string, now = Date.now) {
    this.now = now;
    const dir = join(dataDir, 'phone-pairing');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.path = join(dir, `${hash(profile)}.json`);
    if (!existsSync(this.path)) return;
    const saved: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
    if (!Array.isArray(saved) || saved.length > PHONE_MAX_DEVICES) throw new Error('Phone pairing storage is invalid.');
    for (const d of saved) {
      if (!d || typeof d.id !== 'string' || !/^[a-f0-9-]{36}$/.test(d.id) ||
          typeof d.name !== 'string' || d.name !== clientName(d.name) || d.state !== 'paired' ||
          !/^[a-f0-9]{64}$/.test(d.tokenHash) || typeof d.privateKey !== 'string' ||
          !Number.isSafeInteger(d.requestedAt) || !Number.isSafeInteger(d.expiresAt) ||
          typeof d.confirmation !== 'string' || !/^\d{6}$/.test(d.confirmation)) throw new Error('Phone pairing storage is invalid.');
      const identity = createClientIdentity(() => d.name, createPrivateKey(d.privateKey));
      if (identity.id !== d.clientId || identity.publicKey !== d.publicKey) throw new Error('Phone identity storage is invalid.');
    }
    this.devices = saved as SavedPhone[];
  }

  setPublicUrl(value?: string): void {
    if (value !== undefined) {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Phone pairing needs a secure public address.');
      value = url.toString().replace(/\/+$/, '');
    }
    if (this.publicUrl !== value) this.cancel();
    this.publicUrl = value;
  }

  private expire(): void {
    if (this.invitation && this.invitation.expiresAt <= this.now()) this.invitation = undefined;
    if (this.pending && this.pending.expiresAt <= this.now()) this.pending = undefined;
  }

  state(): PhonePairingState {
    this.expire();
    const expose = ({ tokenHash: _tokenHash, privateKey: _privateKey, ...device }: SavedPhone): PhoneDevice => device;
    return {
      online: !!this.publicUrl,
      profile: this.profile,
      ...(this.invitation && this.publicUrl ? { invitation: {
        payload: JSON.stringify({ type: 'mbe-pairing', v: 1, url: `${this.publicUrl}/pair`, code: this.invitation.code, expiresAt: this.invitation.expiresAt }),
        expiresAt: this.invitation.expiresAt,
      } } : {}),
      devices: [...(this.pending ? [this.pending] : []), ...this.devices.filter((d) => d.expiresAt > this.now() && !this.revoked.has(d.id))].map(expose),
    };
  }

  create(): PhonePairingState {
    if (!this.publicUrl) throw new Error('Remote connection is offline. Try again when this computer reconnects.');
    if (this.devices.filter((d) => d.expiresAt > this.now() && !this.revoked.has(d.id)).length >= PHONE_MAX_DEVICES) {
      throw new Error('Remove a paired phone before adding another.');
    }
    this.pending = undefined;
    this.invitation = { code: token(), expiresAt: this.now() + PHONE_INVITATION_MS };
    return this.state();
  }

  cancel(): void { this.invitation = undefined; this.pending = undefined; }

  claim(code: unknown, name: unknown): { id: string; token: string; confirmation: string; expiresAt: number } {
    this.expire();
    const invitation = this.invitation;
    if (!this.publicUrl || !invitation || !matches(code, hash(invitation.code))) throw new Error('Pairing code is invalid or expired.');
    if (typeof name !== 'string' || !name.trim() || name.length > 80 || name !== clientName(name)) throw new Error('Enter a valid phone name.');
    const secret = token();
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const displayName = clientName(`Phone: ${name}`);
    const identity = createClientIdentity(() => displayName, privateKey);
    const pending: SavedPhone = {
      id: randomUUID(), name: displayName, clientId: identity.id, publicKey: identity.publicKey,
      tokenHash: hash(secret), privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      requestedAt: this.now(), expiresAt: invitation.expiresAt, state: 'pending',
      confirmation: String(randomInt(1_000_000)).padStart(6, '0'),
    };
    // Consume the invitation before replying. A second scanner cannot reuse it.
    this.invitation = undefined;
    this.pending = pending;
    return { id: pending.id, token: secret, confirmation: pending.confirmation, expiresAt: pending.expiresAt };
  }

  approve(id: string): PhonePairingState {
    this.expire();
    if (!this.publicUrl || !this.pending || this.pending.id !== id) throw new Error('That phone request expired. Generate a new QR code.');
    const next = [...this.devices.filter((d) => d.expiresAt > this.now() && !this.revoked.has(d.id)),
      { ...this.pending, state: 'paired' as const, expiresAt: this.now() + PHONE_ACCESS_MS }];
    this.save(next);
    this.pending = undefined;
    return this.state();
  }

  deny(id: string): PhonePairingState {
    if (this.pending?.id === id) this.pending = undefined;
    return this.state();
  }

  remove(id: string): PhonePairingState {
    this.revoked.add(id);
    this.identities.delete(id);
    for (const notify of this.listeners) notify(id);
    this.save(this.devices.filter((d) => d.id !== id));
    return this.state();
  }

  onRemove(fn: (id: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  status(secret: unknown): { state: 'pending' | 'paired'; confirmation: string; expiresAt: number; mcpUrl?: string } | undefined {
    this.expire();
    const d = this.pending && matches(secret, this.pending.tokenHash) ? this.pending : this.authenticate(secret);
    if (!d) return undefined;
    return { state: d.state, confirmation: d.confirmation, expiresAt: d.expiresAt,
      ...(d.state === 'paired' && this.publicUrl ? { mcpUrl: `${this.publicUrl}/mcp` } : {}) };
  }

  authenticate(secret: unknown): PhoneDevice | undefined {
    return this.devices.find((d) => !this.revoked.has(d.id) && d.expiresAt > this.now() && matches(secret, d.tokenHash));
  }

  identity(id: string): ClientIdentity {
    const d = this.devices.find((d) => d.id === id && !this.revoked.has(id) && d.expiresAt > this.now());
    if (!d) throw new Error('Phone access was removed or expired.');
    const cached = this.identities.get(id);
    if (cached) return cached;
    const identity = createClientIdentity(() => d.name, createPrivateKey(d.privateKey));
    identity.profile = this.profile;
    identity.workspace = ensureWorkspace(this.dataDir, this.profile, `phone-${id}`);
    identity.assertAccess = () => {
      if (this.revoked.has(id) || !this.devices.some((x) => x.id === id && x.expiresAt > this.now())) throw new Error('Phone access was removed or expired.');
    };
    this.identities.set(id, identity);
    return identity;
  }

  private save(devices: SavedPhone[]): void {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(devices), { mode: 0o600, flag: 'wx' });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.path);
    this.devices = devices;
  }
}
