import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, createPublicKey, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { clientName, clientSigningPayload, type ClientProof } from '../../shared/client-auth';
import type { CommandFrame } from '../../shared/protocol';
import type { Workspace } from './datadir';
import { withWorkspace } from './workspace';

export interface ClientIdentity {
  id: string;
  publicKey: string;
  profile?: string;
  workspace?: Workspace;
  assertAccess?: () => void;
  sign(cmd: Pick<CommandFrame, 'v' | 'method' | 'params' | 'tabId' | 'timeoutMs'>, challenge: string): ClientProof;
}

/** Ordinary app keys are ephemeral; paired phones supply their privately stored key. */
export function createClientIdentity(name: () => string, savedKey?: KeyObject): ClientIdentity {
  const privateKey = savedKey ?? generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
  const publicKey = createPublicKey(privateKey);
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const encoded = der.toString('base64');
  return {
    id: createHash('sha256').update(der).digest('hex'),
    publicKey: encoded,
    sign(cmd: Pick<CommandFrame, 'v' | 'method' | 'params' | 'tabId' | 'timeoutMs'>, challenge: string): ClientProof {
      const proof = { publicKey: encoded, name: clientName(name()), challenge, issuedAt: Date.now(), nonce: randomUUID() };
      return { ...proof, signature: sign('sha256', Buffer.from(clientSigningPayload(cmd, proof)), {
        key: privateKey, dsaEncoding: 'ieee-p1363',
      }).toString('base64') };
    },
  };
}
const current = new AsyncLocalStorage<ClientIdentity>();
export const withClientIdentity = <T>(identity: ClientIdentity, fn: () => T): T =>
  current.run(identity, () => identity.workspace ? withWorkspace(identity.workspace, fn) : fn());
export const currentClientIdentity = (): ClientIdentity | undefined => current.getStore();
