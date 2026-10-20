/** Per-session authorization, enforced by the extension independently of the bridge token. */
import type { CommandFrame } from './protocol';

export const CLIENT_APPROVAL_CAP = 'client-approval-v1';
export const CLIENT_GRANT_MS = 8 * 60 * 60 * 1000;
export const CLIENT_CLOCK_SKEW_MS = 2 * 60 * 1000;
export const CLIENT_REQUEST_MS = 10 * 60 * 1000;
export const CLIENT_STORAGE_KEY = 'clientConnections';

export interface ClientProof {
  publicKey: string;
  name: string;
  challenge: string;
  issuedAt: number;
  nonce: string;
  signature: string;
}

export interface ClientConnection {
  id: string;
  publicKey: string;
  name: string;
  state: 'pending' | 'approved' | 'revoked';
  requestedAt: number;
  expiresAt: number;
}

export function clientName(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 80) || 'Unnamed app';
}

/** Normalize as JSON first: omitted properties must sign identically across the wire. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Correlation id is assigned by the hub; every executable field is signed. */
export function clientSigningPayload(
  cmd: Pick<CommandFrame, 'v' | 'method' | 'params' | 'tabId' | 'timeoutMs'>,
  proof: Omit<ClientProof, 'signature'>,
): string {
  return canonical(JSON.parse(JSON.stringify({
    domain: CLIENT_APPROVAL_CAP, v: cmd.v, method: cmd.method, params: cmd.params,
    tabId: cmd.tabId ?? null, timeoutMs: cmd.timeoutMs,
    publicKey: proof.publicKey, name: proof.name, challenge: proof.challenge,
    issuedAt: proof.issuedAt, nonce: proof.nonce,
  })));
}

/** The only unsigned command allowed returns a fixed health response, without a tab lookup. */
export function isHealthProbe(cmd: Pick<CommandFrame, 'method' | 'params'>): boolean {
  return cmd.method === 'ping_probe' && Object.keys(cmd.params ?? {}).length === 0;
}
