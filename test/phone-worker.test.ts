import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { runInNewContext } from 'node:vm';
import type { PhoneAction, PhoneReply } from '../shared/phone-pairing';

const source = buildSync({ entryPoints: ['extension/src/sw/phone-pairing.ts'], bundle: true, write: false, platform: 'browser', format: 'cjs' }).outputFiles[0].text;

test('approval rolls back if the native helper throws or access stops during enrollment', async () => {
  for (const stopDuringEnrollment of [false, true]) {
    let stopped = false;
    const actions: string[] = [];
    const module = { exports: {} as { phonePairingAction(action: PhoneAction, id: string, deps: unknown): Promise<PhoneReply> } };
    runInNewContext(source, { module, exports: module.exports,
      chrome: { storage: { local: { get: async () => ({ pairedProfile: 'personal', clientConnections: [] }) } },
        runtime: { sendNativeMessage: async (_host: string, message: { action: string; profile: string }) => {
          assert.equal(message.profile, 'personal');
          actions.push(message.action);
          if (message.action === 'approve') throw new Error('helper disappeared');
          return { ok: true, state: { profile: 'personal', online: true, devices: [{ id: 'phone', clientId: 'key', state: 'pending' }] } };
        } } } });
    const reply = await module.exports.phonePairingAction('approve', 'phone', {
      stopped: () => stopped, connected: () => true,
      approvals: { approvePairedPhone: async () => { actions.push('enroll'); stopped = stopDuringEnrollment; },
        decide: async (id: string, allow: boolean) => { assert.equal(id, 'key'); assert.equal(allow, false); actions.push('revoke'); } },
    });
    assert.equal(reply.ok, false);
    assert.deepEqual(actions, stopDuringEnrollment ? ['state', 'enroll', 'revoke'] : ['state', 'enroll', 'approve', 'revoke']);
  }
});
