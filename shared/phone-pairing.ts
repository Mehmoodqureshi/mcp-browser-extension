/** Versioned contract shared by the extension and the future phone client. */
export const PHONE_PAIRING_VERSION = 1;
export const PHONE_INVITATION_MS = 2 * 60_000;
export const PHONE_ACCESS_MS = 30 * 24 * 60 * 60_000;
export const PHONE_MAX_DEVICES = 10;

export interface PhoneDevice {
  id: string;
  name: string;
  clientId: string;
  publicKey: string;
  requestedAt: number;
  expiresAt: number;
  state: 'pending' | 'paired';
  confirmation: string;
  /** Added by Chrome when presenting a saved pairing to the person. */
  browserApproved?: boolean;
}

export interface PhonePairingState {
  online: boolean;
  profile: string;
  invitation?: { payload: string; expiresAt: number };
  devices: PhoneDevice[];
}

export type PhoneAction = 'state' | 'create' | 'cancel' | 'approve' | 'deny' | 'remove';
export const PHONE_ACTIONS: readonly PhoneAction[] = ['state', 'create', 'cancel', 'approve', 'deny', 'remove'];
export type PhoneReply = { ok: true; state: PhonePairingState } | { ok: false; message: string };
