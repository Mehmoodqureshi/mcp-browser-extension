/** Email-link access gate for the MCP tool surface. */
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { ProgressNotification } from '@modelcontextprotocol/sdk/types.js';
import { runtimeEnv } from './compat';
import { createBrowserEmailPrompt, openBrowserEmailPrompt, type BrowserEmailPrompt } from './access-browser';

type AccessState = { deviceId: string; deviceSecret: string; challengeId?: string; verified?: boolean };
const SITE = (runtimeEnv('ACCESS_API') ?? 'https://mcp-browser-extension.com/api/access').replace(/\/$/, '');
let accessPollMs = 2_000;
let accessWaitMs = 45_000;
type AccessOutcome = { status: 'verified' | 'pending' | 'input-required' | 'expired' | 'denied' | 'unavailable' | 'cancelled'; message: string };
type AccessCheck = AccessOutcome | { challengeId: string } | null;
type VerificationWatcher = { promise: Promise<AccessOutcome>; waiting: AccessOutcome };
export type AccessRequest = {
  signal?: AbortSignal;
  requestId?: string | number;
  progressToken?: string | number;
  sendNotification?: (notification: ProgressNotification) => Promise<void>;
  onVerified?: () => void;
};
const EMAIL_SCHEMA = {
  type: 'object' as const,
  properties: { email: { type: 'string' as const, title: 'Email address', description: 'The address where you want to receive the verification link.' } },
  required: ['email'],
};
const validUntil = new Map<string, number>();
const currentChecks = new Map<string, Promise<AccessCheck>>();
const pendingEmailStarts = new Map<string, Promise<AccessCheck>>();
const pollingChallenges = new Map<string, VerificationWatcher>();
const completionToReport = new Map<string, AccessOutcome>();
const browserPrompts = new Map<string, BrowserEmailPrompt>();
const VERIFIED: AccessOutcome = { status: 'verified', message: 'Email verified. MCP Browser Extension access is active.' };
const PENDING: AccessOutcome = { status: 'pending', message: '[ACCESS_PENDING] Email verification is still pending. Open the sign-in link sent to your email and click Verify this device. Continue waiting by calling chrome_status; no new email or chat reply is needed.' };
const CANCELLED: AccessOutcome = { status: 'cancelled', message: 'Email verification wait was cancelled. The browser action was not run.' };
const UNAVAILABLE: AccessOutcome = { status: 'unavailable', message: 'Email verification could not be confirmed because the verification service is unavailable. Access remains blocked. Retry chrome_status shortly.' };

/** @internal Test seam for the verification watcher. */
export function setAccessPollIntervalForTesting(ms: number, waitMs = 45_000): void {
  accessPollMs = Math.max(1, ms);
  accessWaitMs = Math.max(1, waitMs);
}

/** Close a pending form when verification finishes or its owner shuts down. */
export function closeAccessBrowserPrompt(dataDir: string): void {
  browserPrompts.get(dataDir)?.close();
}

function statePath(dataDir: string): string { return join(dataDir, 'access.json'); }

function loadOrCreate(dataDir: string): AccessState {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try {
    const parsed = JSON.parse(readFileSync(statePath(dataDir), 'utf8')) as Partial<AccessState>;
    if (/^[a-f0-9]{32}$/.test(parsed.deviceId ?? '') && /^[A-Za-z0-9_-]{42,50}$/.test(parsed.deviceSecret ?? '')) {
      return parsed as AccessState;
    }
  } catch { /* create a new local identity */ }
  const state = { deviceId: randomBytes(16).toString('hex'), deviceSecret: randomBytes(32).toString('base64url') };
  saveState(dataDir, state);
  return state;
}

function saveState(dataDir: string, state: AccessState): void {
  const path = statePath(dataDir);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

async function notifyAccess(server: Server, outcome: AccessOutcome): Promise<void> {
  try {
    await server.sendLoggingMessage({
      level: outcome.status === 'verified' ? 'notice' : outcome.status === 'pending' ? 'info' : 'warning',
      logger: 'email-verification',
      data: outcome,
    });
  } catch { /* A disconnected client must not prevent activation. */ }
}

function watchForEmailApproval(server: Server, dataDir: string, challengeId: string): VerificationWatcher {
  const existing = pollingChallenges.get(challengeId);
  if (existing) return existing;
  const promise = new Promise<AccessOutcome>((resolve) => {
    let delayMs = accessPollMs;
    const finish = (outcome: AccessOutcome) => {
      pollingChallenges.delete(challengeId);
      closeAccessBrowserPrompt(dataDir);
      completionToReport.set(dataDir, outcome);
      void notifyAccess(server, outcome);
      resolve(outcome);
    };
    const poll = async () => {
      try {
        const state = loadOrCreate(dataDir);
        if (!state.verified && state.challengeId !== challengeId) return finish({ status: 'expired', message: 'The email verification request is no longer active. Retry the browser tool to request a fresh link.' });
        // Another local process may have completed activation. Revalidate its
        // grant before resuming this request; a disk flag alone grants no access.
        const status = state.verified
          ? { ok: true, status: 200, data: { status: 'approved' } }
          : await api('status', { challengeId });
        watcher.waiting = status.ok ? PENDING : UNAVAILABLE;
        if (status.ok && status.data.status === 'approved') {
          const validated = await api('validate', { deviceId: state.deviceId, deviceSecret: state.deviceSecret });
          if (validated.ok && validated.data.authorized === true) {
            state.verified = true;
            delete state.challengeId;
            saveState(dataDir, state);
            validUntil.set(dataDir, Date.now() + 60_000);
            return finish(VERIFIED);
          } else if (validated.status === 401 || validated.status === 403) {
            state.verified = false;
            delete state.challengeId;
            saveState(dataDir, state);
            return finish({ status: 'denied', message: 'Email verification did not grant access or access was revoked. Retry the browser tool to request a new email link.' });
          }
          watcher.waiting = UNAVAILABLE;
        }
        if (!status.ok && status.status === 410) {
          delete state.challengeId;
          saveState(dataDir, state);
          return finish({ status: 'expired', message: 'Your email link expired without verification. Retry the browser tool to request a fresh link.' });
        }
      } catch { watcher.waiting = UNAVAILABLE; }
      // Keep checking promptly, including while a tool is waiting for approval.
      // Back off during outages instead of repeatedly hitting an unavailable API.
      delayMs = watcher.waiting.status === 'unavailable' ? Math.min(delayMs * 2, 30_000) : accessPollMs;
      setTimeout(() => { void poll(); }, delayMs).unref();
    };
    setTimeout(() => { void poll(); }, accessPollMs).unref();
  });
  const watcher: VerificationWatcher = { promise, waiting: PENDING };
  pollingChallenges.set(challengeId, watcher);
  return watcher;
}

async function waitForEmailApproval(server: Server, dataDir: string, challengeId: string, request: AccessRequest): Promise<AccessOutcome> {
  const approval = watchForEmailApproval(server, dataDir, challengeId);
  if (request.signal?.aborted) return CANCELLED;
  let progress = 0;
  const report = async (message: string) => {
    if (request.progressToken === undefined || !request.sendNotification || request.signal?.aborted) return;
    try {
      await request.sendNotification({ method: 'notifications/progress', params: { progressToken: request.progressToken, progress: ++progress, message } });
    } catch { /* Progress is optional; the tool result still carries the outcome. */ }
  };
  await report('Sign-in link sent. Open it in your email and click Verify this device; this tool is waiting for verification automatically.');
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const heartbeat = setInterval(() => { void report('Waiting for email verification. Open the sign-in link sent to your email and click Verify this device.'); }, 5_000);
  try {
    const outcome = await Promise.race([
      approval.promise,
      new Promise<AccessOutcome>((resolve) => {
        timeout = setTimeout(() => resolve(approval.waiting), accessWaitMs);
        onAbort = () => resolve(CANCELLED);
        request.signal?.addEventListener('abort', onAbort, { once: true });
        if (request.signal?.aborted) onAbort();
      }),
    ]);
    clearInterval(heartbeat);
    await report(outcome.message);
    return outcome;
  } finally {
    clearInterval(heartbeat);
    clearTimeout(timeout);
    if (onAbort) request.signal?.removeEventListener('abort', onAbort);
  }
}

async function api(path: string, body: Record<string, unknown>): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const response = await fetch(`${SITE}/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
  });
  let data: Record<string, unknown> = {};
  try { const value: unknown = await response.json(); if (value && typeof value === 'object') data = value as Record<string, unknown>; } catch { /* handled as service failure */ }
  return { ok: response.ok, status: response.status, data };
}

function result(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

const inputRequired = (url: string): AccessOutcome => ({
  status: 'input-required',
  message: '[ACCESS_INPUT_REQUIRED] Complete email verification in the browser form. It opens automatically when the client does not display its email prompt. ' +
    `If no form appeared, open this local page on the computer running MCP Browser Extension:\n${url}\n` +
    'Enter your email there, open the sign-in link from your inbox, and click Verify this device. This page expires in 10 minutes. ' +
    'Show this link only as a backup. Do not open it again or ask for the email in chat while this form is active. ' +
    'Do not fill the form or open their email for them. After they submit their email, call chrome_status to wait for verification. Access remains blocked until verification succeeds.',
});

function startEmail(server: Server, dataDir: string, state: AccessState, input: string): Promise<AccessCheck> {
  const existing = pendingEmailStarts.get(dataDir);
  if (existing) return existing;
  const sending = sendVerificationEmail(server, dataDir, state, input)
    .finally(() => { pendingEmailStarts.delete(dataDir); });
  pendingEmailStarts.set(dataDir, sending);
  return sending;
}

async function sendVerificationEmail(server: Server, dataDir: string, state: AccessState, input: string): Promise<AccessCheck> {
  const email = input.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { status: 'denied', message: 'Enter a valid email address.' };
  }
  state.challengeId = randomBytes(32).toString('hex');
  let started;
  try {
    started = await api('start', { email, challengeId: state.challengeId, deviceId: state.deviceId, deviceSecret: state.deviceSecret });
  } catch {
    delete state.challengeId;
    saveState(dataDir, state);
    return { status: 'unavailable', message: 'The verification service could not be reached. Please try again.' };
  }
  if (!started.ok) {
    delete state.challengeId;
    saveState(dataDir, state);
    const message = typeof started.data.error === 'string' ? started.data.error : 'The verification email could not be sent. Check your connection and try again.';
    return { status: 'unavailable', message };
  }
  // Other tool calls and local processes must not poll a challenge before the
  // backend creates it; a premature 410 would discard a valid sign-in request.
  saveState(dataDir, state);
  await notifyAccess(server, { status: 'pending', message: 'A sign-in link has been sent. Open it from your email; the browser tool is waiting for verification.' });
  return { challengeId: state.challengeId };
}

async function offerBrowserPrompt(server: Server, dataDir: string, request: AccessRequest): Promise<AccessOutcome> {
  if (request.signal?.aborted) return CANCELLED;
  const existing = browserPrompts.get(dataDir);
  if (existing) return inputRequired(existing.url);
  const prompt = await createBrowserEmailPrompt(async (email) => {
    const state = loadOrCreate(dataDir);
    if (state.verified || state.challengeId) return { ok: false, message: 'A verification request is already active. Return to your assistant and call chrome_status.' };
    const outcome = await startEmail(server, dataDir, state, email);
    if (outcome && 'challengeId' in outcome) {
      watchForEmailApproval(server, dataDir, outcome.challengeId);
      return { ok: true, message: '' };
    }
    return { ok: false, message: outcome?.message ?? UNAVAILABLE.message };
  }, { onClose: () => { browserPrompts.delete(dataDir); } });
  browserPrompts.set(dataDir, prompt);
  if (request.signal?.aborted) { prompt.close(); return CANCELLED; }
  openBrowserEmailPrompt(prompt.url);
  return inputRequired(prompt.url);
}

/** Returns null when authorized, otherwise a user-facing tool error. */
export async function requireAccess(server: Server, dataDir: string, request: AccessRequest = {}): Promise<ReturnType<typeof result> | null> {
  if (request.signal?.aborted) return result(CANCELLED.message);
  const completion = completionToReport.get(dataDir);
  if (completion && completion.status !== 'verified') {
    completionToReport.delete(dataDir);
    return result(completion.message);
  }
  if (Date.now() < (validUntil.get(dataDir) ?? 0)) {
    if (completionToReport.delete(dataDir)) request.onVerified?.();
    return null;
  }
  let current = currentChecks.get(dataDir);
  if (!current) {
    current = check(server, dataDir, request).finally(() => { currentChecks.delete(dataDir); });
    currentChecks.set(dataDir, current);
  }
  const checked = await current;
  const outcome = checked && 'challengeId' in checked
    ? await waitForEmailApproval(server, dataDir, checked.challengeId, request)
    : checked;
  if (request.signal?.aborted) return result(CANCELLED.message);
  if (outcome?.status === 'verified') {
    completionToReport.delete(dataDir);
    request.onVerified?.();
    return null;
  }
  if (outcome && completionToReport.get(dataDir) === outcome) completionToReport.delete(dataDir);
  return outcome ? result(outcome.message) : null;
}

/** Explicit local-only opt-out; the CLI rejects it when a public tunnel is enabled. */
export const bypassEmailVerification: typeof requireAccess = async () => null;

async function check(server: Server, dataDir: string, request: AccessRequest): Promise<AccessCheck> {
  const sending = pendingEmailStarts.get(dataDir);
  if (sending) return sending;
  const state = loadOrCreate(dataDir);
  try {
    if (state.verified) {
      const revalidated = await api('validate', { deviceId: state.deviceId, deviceSecret: state.deviceSecret });
      if (revalidated.ok && revalidated.data.authorized === true) {
        closeAccessBrowserPrompt(dataDir);
        validUntil.set(dataDir, Date.now() + 60_000);
        if (completionToReport.delete(dataDir)) return VERIFIED;
        return null;
      }
      if (revalidated.status === 401 || revalidated.status === 403) {
        state.verified = false;
        delete state.challengeId;
        saveState(dataDir, state);
        const outcome: AccessOutcome = { status: 'denied', message: 'Access was revoked or needs verification again. Retry the browser tool to verify your email.' };
        await notifyAccess(server, outcome);
        return outcome;
      }
      return { status: 'unavailable', message: 'Access could not be checked right now. Retry the browser tool shortly.' };
    }
    if (!state.challengeId) {
      const existing = browserPrompts.get(dataDir);
      if (existing) return inputRequired(existing.url);
      let elicitation;
      // The SDK retains the signal listener after an elicitation completes.
      // Detach our forwarding listener so later cancellation cannot cancel a finished prompt.
      const prompt = new AbortController();
      const cancelPrompt = () => prompt.abort(request.signal?.reason);
      request.signal?.addEventListener('abort', cancelPrompt, { once: true });
      if (request.signal?.aborted) cancelPrompt();
      try {
        elicitation = await server.elicitInput({
          mode: 'form',
          message: 'Enter your email to receive a one-time sign-in link for MCP Browser Extension. After submitting, open that link from your inbox. This tool will wait for verification and continue automatically. The email is used to verify and manage access.',
          requestedSchema: EMAIL_SCHEMA,
        }, { signal: prompt.signal, relatedRequestId: request.requestId });
      } catch {
        if (request.signal?.aborted) return CANCELLED;
        return await offerBrowserPrompt(server, dataDir, request);
      } finally {
        request.signal?.removeEventListener('abort', cancelPrompt);
      }
      if (request.signal?.aborted) return CANCELLED;
      if (elicitation.action !== 'accept' || typeof elicitation.content?.email !== 'string' || !elicitation.content.email.trim()) {
        return await offerBrowserPrompt(server, dataDir, request);
      }
      return await startEmail(server, dataDir, state, elicitation.content.email);
    }
    return { challengeId: state.challengeId };
  } catch {
    return { status: 'unavailable', message: 'Access verification is temporarily unavailable. Check your connection and retry the browser tool.' };
  }
}
