import type { WirePolicy } from '../../../shared/protocol';
import {
  AUTOMATIC_SITE_ORIGINS, SITE_CHECKS_KEY, SITE_CHECKS_PENDING_KEY, SITE_CHECKS_APPROVALS_KEY,
  SITE_CHECKS_BLOCKED_KEY, siteUrlWarnings, loginWarnings, collectLoginSignals,
  type SiteWarning, type SiteWarningRequest,
} from '../../../shared/site-risk';
import { CmdError } from './cmd-error';

let enabled = false;
let configured = false;
let supported = true;
let requesting = false;
let blocked: string[] = [];
let generation = 0;
let queue: Promise<unknown> = Promise.resolve();
let changed: (count: number, fresh: boolean) => void = () => {};

export function onSiteWarnings(callback: typeof changed): void { changed = callback; }
export function setSiteChecksSupported(value: boolean): void { supported = value; }
export function siteChecksEnabled(): boolean { return supported && enabled; }
export function siteChecksConfigured(): boolean { return supported && configured; }
export function requireSiteChecksReady(): void {
  if (siteChecksConfigured() && !enabled) throw new CmdError('POLICY_DENIED', 'Automatic website access needs Chrome permission. Open MCP Browser Extension and click Allow website access.');
}

export async function keepAutomaticPermissions(): Promise<boolean> {
  return requesting || (await chrome.storage.local.get(SITE_CHECKS_KEY))[SITE_CHECKS_KEY] === true;
}

export async function refreshSiteChecks(): Promise<void> {
  const mine = ++generation;
  const saved = await chrome.storage.local.get([SITE_CHECKS_KEY, SITE_CHECKS_BLOCKED_KEY, SITE_CHECKS_PENDING_KEY]);
  const wantsChecks = saved[SITE_CHECKS_KEY] !== false;
  const permitted = wantsChecks && await chrome.permissions.contains({ origins: AUTOMATIC_SITE_ORIGINS });
  if (mine !== generation) return;
  configured = wantsChecks;
  enabled = permitted;
  blocked = Array.isArray(saved[SITE_CHECKS_BLOCKED_KEY]) ? saved[SITE_CHECKS_BLOCKED_KEY].filter((s: unknown) => typeof s === 'string') : [];
  changed(siteChecksEnabled() && Array.isArray(saved[SITE_CHECKS_PENDING_KEY]) ? saved[SITE_CHECKS_PENDING_KEY].length : 0, false);
}

/** Only called by the trusted popup/Settings handler, synchronously with its click. */
export async function changeSiteChecks(allow: boolean): Promise<void> {
  if (requesting) throw new Error('A website permission request is already open.');
  requesting = allow;
  try {
    const permission = allow ? chrome.permissions.request({ origins: AUTOMATIC_SITE_ORIGINS }) : Promise.resolve(true);
    if (!await permission) throw new Error('Automatic website access was not enabled. Accept Chrome’s permission request to turn it on.');
    await chrome.storage.local.set({ [SITE_CHECKS_KEY]: allow });
    if (!allow) {
      enabled = false;
      await chrome.permissions.remove({ origins: AUTOMATIC_SITE_ORIGINS });
    }
    await refreshSiteChecks();
  } finally { requesting = false; }
}

/** Server-delivered fields can never enable automatic access in this browser. */
export function localSitePolicy(policy: WirePolicy | null): WirePolicy | null {
  const active = siteChecksEnabled();
  return policy ? { ...policy, automaticSites: active, blockedDomains: active ? blocked : [] } : null;
}

function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const next = queue.then(operation);
  queue = next.catch(() => {});
  return next;
}

async function warn(url: URL, warnings: SiteWarning[]): Promise<SiteWarning[]> {
  return serialized(async () => {
    const saved = await chrome.storage.local.get([SITE_CHECKS_PENDING_KEY, SITE_CHECKS_APPROVALS_KEY]);
    const approved = saved[SITE_CHECKS_APPROVALS_KEY]?.[url.origin];
    warnings = warnings.filter((warning) => !Array.isArray(approved) || !approved.includes(warning.id));
    if (!warnings.length) return [];
    const prior: SiteWarningRequest[] = Array.isArray(saved[SITE_CHECKS_PENDING_KEY]) ? saved[SITE_CHECKS_PENDING_KEY] : [];
    const old = prior.find((entry) => entry.origin === url.origin);
    const fresh = !old || warnings.some((warning) => !old.warnings.some((w) => w.id === warning.id));
    const request: SiteWarningRequest = { origin: url.origin, host: url.hostname, warnings, at: Date.now() };
    const next = [request, ...prior.filter((entry) => entry.origin !== url.origin)].slice(0, 100);
    await chrome.storage.local.set({ [SITE_CHECKS_PENDING_KEY]: next });
    changed(next.length, fresh);
    return warnings;
  });
}

async function requireWarningApproval(url: URL, warnings: SiteWarning[]): Promise<void> {
  if (!warnings.length) return;
  const missing = await warn(url, warnings);
  if (!missing.length) return;
  throw new CmdError('POLICY_DENIED', `Suspicious website ${url.hostname}: ${missing.map((w) => w.reason).join(' ')} ` +
    'Review the warning in the MCP Browser Extension popup or Settings, then click Allow if you want to continue.');
}

/** URL checks run before navigation; form checks run before reading or acting on a loaded page. */
export async function checkLocalSite(input: string, tabId?: number, frameId = 0): Promise<void> {
  requireSiteChecksReady();
  if (!siteChecksEnabled() || input === 'about:blank') return;
  let url: URL;
  try { url = new URL(input); } catch { throw new CmdError('POLICY_DENIED', 'This website address cannot be checked.'); }
  if (!/^https?:$/.test(url.protocol)) throw new CmdError('POLICY_DENIED', 'Automatic website access only covers HTTP and HTTPS pages.');
  if (blocked.some((host) => url.hostname === host || (host.startsWith('*.') &&
      (url.hostname === host.slice(2) || url.hostname.endsWith(`.${host.slice(2)}`))))) {
    throw new CmdError('POLICY_DENIED', `Access to ${url.hostname} was removed. Restore it under Blocked websites in extension Settings.`);
  }
  await requireWarningApproval(url, siteUrlWarnings(input));
  if (tabId !== undefined) {
    let warnings: SiteWarning[];
    try {
      const results = await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func: collectLoginSignals });
      const signals = results[0]?.result;
      if (!signals || signals.url !== input) throw new Error('The page changed during the check.');
      warnings = loginWarnings(signals);
    } catch {
      throw new CmdError('CDP_ERROR', 'Could not finish the local website check. The page may have changed; retry the request.');
    }
    await requireWarningApproval(url, warnings);
  }
}

/** Approve only the reasons actually shown, for one exact origin. New reasons require review. */
export function allowSiteWarning(origin: string, expected: string[]): Promise<void> {
  return serialized(async () => {
    const saved = await chrome.storage.local.get([SITE_CHECKS_PENDING_KEY, SITE_CHECKS_APPROVALS_KEY]);
    const pending: SiteWarningRequest[] = Array.isArray(saved[SITE_CHECKS_PENDING_KEY]) ? saved[SITE_CHECKS_PENDING_KEY] : [];
    const request = pending.find((entry) => entry.origin === origin);
    if (!request || request.warnings.some((w) => !expected.includes(w.id)) || expected.some((id) => !request.warnings.some((w) => w.id === id))) {
      throw new Error('The warning changed. Review the current reasons and try again.');
    }
    const approvals = saved[SITE_CHECKS_APPROVALS_KEY] ?? {};
    const previous = Array.isArray(approvals[origin]) ? approvals[origin] : [];
    const next = pending.filter((entry) => entry.origin !== origin);
    await chrome.storage.local.set({
      [SITE_CHECKS_APPROVALS_KEY]: { ...approvals, [origin]: [...new Set([...previous, ...expected])] },
      [SITE_CHECKS_PENDING_KEY]: next,
    });
    changed(next.length, false);
  });
}

export function blockLocalSite(host: string, block: boolean): Promise<void> {
  return serialized(async () => {
    const saved = await chrome.storage.local.get([SITE_CHECKS_BLOCKED_KEY, SITE_CHECKS_APPROVALS_KEY, SITE_CHECKS_PENDING_KEY]);
    const list: string[] = Array.isArray(saved[SITE_CHECKS_BLOCKED_KEY]) ? saved[SITE_CHECKS_BLOCKED_KEY] : [];
    const next = list.filter((entry) => entry !== host);
    if (block) next.push(host);
    const approvals = { ...(saved[SITE_CHECKS_APPROVALS_KEY] ?? {}) };
    for (const origin of Object.keys(approvals)) {
      if (new URL(origin).hostname === host) delete approvals[origin];
    }
    const pending: SiteWarningRequest[] = Array.isArray(saved[SITE_CHECKS_PENDING_KEY]) ? saved[SITE_CHECKS_PENDING_KEY] : [];
    await chrome.storage.local.set({ [SITE_CHECKS_BLOCKED_KEY]: next, [SITE_CHECKS_APPROVALS_KEY]: approvals,
      [SITE_CHECKS_PENDING_KEY]: pending.filter((entry) => entry.host !== host) });
    await refreshSiteChecks();
  });
}

export function revokeSiteWarning(origin: string): Promise<void> {
  return serialized(async () => {
    const saved = await chrome.storage.local.get(SITE_CHECKS_APPROVALS_KEY);
    const approvals = { ...(saved[SITE_CHECKS_APPROVALS_KEY] ?? {}) };
    delete approvals[origin];
    await chrome.storage.local.set({ [SITE_CHECKS_APPROVALS_KEY]: approvals });
  });
}
