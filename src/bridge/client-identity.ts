import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { clientName, clientSigningPayload, type ClientProof } from '../../shared/client-auth';
import type { CommandFrame } from '../../shared/protocol';

/** Private keys stay in this MCP session's memory. They never enter pairing files or the hub. */
export function createClientIdentity(name: () => string) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const encoded = der.toString('base64');
  return {
    id: createHash('sha256').update(der).digest('hex'),
    sign(cmd: Pick<CommandFrame, 'v' | 'method' | 'params' | 'tabId' | 'timeoutMs'>, challenge: string): ClientProof {
      const proof = { publicKey: encoded, name: clientName(name()), challenge, issuedAt: Date.now(), nonce: randomUUID() };
      return { ...proof, signature: sign('sha256', Buffer.from(clientSigningPayload(cmd, proof)), {
        key: privateKey, dsaEncoding: 'ieee-p1363',
      }).toString('base64') };
    },
  };
}
export type ClientIdentity = ReturnType<typeof createClientIdentity>;
const current = new AsyncLocalStorage<ClientIdentity>();
export const withClientIdentity = <T>(identity: ClientIdentity, fn: () => T): T => current.run(identity, fn);
export const currentClientIdentity = (): ClientIdentity | undefined => current.getStore();
