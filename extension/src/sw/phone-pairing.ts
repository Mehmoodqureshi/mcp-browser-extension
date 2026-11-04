import { PHONE_ACTIONS, type PhoneAction, type PhoneReply } from '../../../shared/phone-pairing';
import { NATIVE_HOST } from '../connect';
import type { ClientApprovals } from './client-approvals';
import { CLIENT_STORAGE_KEY, type ClientConnection } from '../../../shared/client-auth';

export async function phonePairingAction(
  action: PhoneAction, id: unknown, deps: { approvals: ClientApprovals; stopped(): boolean; connected(): boolean },
): Promise<PhoneReply> {
  if (!PHONE_ACTIONS.includes(action)) return { ok: false, message: 'Invalid phone pairing action.' };
  if (['create', 'approve'].includes(action) && (deps.stopped() || !deps.connected())) {
    return { ok: false, message: 'Connect this browser and resume access before pairing a phone.' };
  }
  const { pairedProfile } = await chrome.storage.local.get('pairedProfile');
  if (typeof pairedProfile !== 'string' || !pairedProfile) return { ok: false, message: 'Connect this browser first, then pair your phone.' };
  if (typeof chrome.runtime.sendNativeMessage !== 'function') return { ok: false, message: 'Click Connect in the extension, then reopen Pair phone.' };
  const send = async (action: PhoneAction): Promise<PhoneReply> => {
    const reply = await chrome.runtime.sendNativeMessage(NATIVE_HOST, { type: 'phone_pairing', profile: pairedProfile, action, id }) as PhoneReply;
    if (reply?.ok) {
      const stored = (await chrome.storage.local.get(CLIENT_STORAGE_KEY))[CLIENT_STORAGE_KEY];
      const clients: ClientConnection[] = Array.isArray(stored) ? stored : [];
      for (const phone of reply.state.devices) {
        if (phone.state === 'paired') phone.browserApproved = clients.some((c) => c.id === phone.clientId && c.state === 'approved' && c.expiresAt > Date.now());
      }
    }
    return reply;
  };
  try {
    if (action === 'approve' || action === 'remove') {
      const current = await send('state');
      if (!current?.ok) return current ?? { ok: false, message: 'Phone pairing did not answer.' };
      const phone = current.state.devices.find((d) => d.id === id);
      if (!phone) return { ok: false, message: 'That phone request has expired or was removed.' };
      if (action === 'approve') {
        if (deps.stopped() || !deps.connected()) return { ok: false, message: 'Resume browser access before approving this phone.' };
        await deps.approvals.approvePairedPhone(phone);
        if (deps.stopped() || !deps.connected()) {
          await deps.approvals.decide(phone.clientId, false);
          return { ok: false, message: 'Browser access stopped. Pair your phone again after resuming.' };
        }
        try {
          const result = await send('approve');
          if (!result?.ok) await deps.approvals.decide(phone.clientId, false);
          return result ?? { ok: false, message: 'Could not approve this phone.' };
        } catch (err) {
          // A lost helper response must not leave an invisible Chrome grant.
          await deps.approvals.decide(phone.clientId, false).catch(() => undefined);
          throw err;
        }
      }
      // Revoke in Chrome first; even a helper failure must not leave browser access active.
      await deps.approvals.decide(phone.clientId, false).catch(() => undefined);
      return await send('remove');
    }
    return await send(action);
  } catch {
    return { ok: false, message: 'Could not reach phone pairing. Update the local server and try again.' };
  }
}
