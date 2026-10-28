import { ClientApprovals, isApprovalPage } from './client-approvals';
import { CLIENT_STORAGE_KEY, type ClientConnection } from '../../../shared/client-auth';
import { ACCESS_STOPPED_KEY, ACTIVITY_KEY } from '../../../shared/activity';
import { AccessSwitch } from './access-switch';
import { ActivityLog } from './activity';
/**
 * extension/src/sw/background.ts — the MV3 service-worker entry.
 *
 * MV3 reality: a service worker is evicted after ~30s idle and an open
 * WebSocket does NOT keep it alive. So:
 *   - ALL listeners are registered synchronously at top level (so a wake always
 *     re-arms them),
 *   - config + connection intent live in chrome.storage (not SW memory),
 *   - while connected, a 30s alarm + an awaited storage.get keep the worker warm
 *     (the server's 15s ping/pong also resets the idle timer on Chrome >= 116),
 *   - a dropped socket is redialled on a short backoff (1s, 2s, 4s, 8s, 10s...)
 *     while the worker is alive, so a server restart costs seconds, not the
 *     next alarm tick; the alarm remains the fallback if the worker is evicted,
 *   - on any wake we call ensureConnected().
 */

import { WsClient, type ConnState } from './ws-client';
import { CommandRouter } from './router';
import { ChromeExecutor } from './executor';
import { syncObserverScript } from './observers';
import { TabBorder } from './tab-border';
import { PROTOCOL_VERSION, type SiteGrantFrame, type WirePolicy } from '../../../shared/protocol';
import { isDomainAllowed, normalizeDomainPattern } from '../../../shared/policy';
import { FEATURE_REQUESTS_KEY, OPTIONAL_FEATURES, siteOrigins, isGlobalOrigin } from '../../../shared/browser-permissions';
import { initializeBrowserPermissions, removeGlobalOrigins } from './browser-permissions';
import { permittedSites } from '../site-access';
import { applyPairing, fetchPairing, requestPairingFromClick } from '../connect';
import { PROXY_STORAGE_KEY, applyProxy, onProxyAuth, proxyStatus } from './proxy';

const PAIR_AFTER_RESTART_KEY = 'pairAfterRestart';

// --- store updates -------------------------------------------------------------
// Chrome checks the Web Store for updates only every few hours. When the server
// says a newer extension exists, ask Chrome now, and apply the update as soon as
// no command is running, so nobody has to click Reload or restart Chrome.
let commandsRunning = 0;
let updateReady = false;
let updateCheckedFor = '';

function runningVersion(): string {
  return typeof __MBE_BUILD_VERSION__ === 'string' ? __MBE_BUILD_VERSION__ : chrome.runtime.getManifest().version;
}

function isNewer(a: string, b: string): boolean {
  const parse = (v: string): number[] => (/^(\d+)\.(\d+)\.(\d+)/.exec(v) ?? []).slice(1).map(Number);
  const x = parse(a);
  const y = parse(b);
  if (x.length !== 3 || y.length !== 3) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

function checkForStoreUpdate(latest: string | null): void {
  if (!latest || latest === updateCheckedFor || !isNewer(latest, runningVersion())) return;
  updateCheckedFor = latest;
  // An unpacked copy answers "no_update"; it reloads from disk instead (reloadIfFilesChanged).
  void chrome.runtime.requestUpdateCheck().catch(() => undefined);
}

function applyUpdateWhenIdle(): void {
  updateReady = true;
  if (commandsRunning > 0) return; // the last running command applies it
  console.info('[mcp-browser-extension] applying the downloaded update');
  chrome.runtime.reload();
}

// Listening here means Chrome leaves applying the update to us.
chrome.runtime.onUpdateAvailable.addListener(() => applyUpdateWhenIdle());

/** Set by build-ext.mjs to the manifest version this code was built from. */
declare const __MBE_BUILD_VERSION__: string | undefined;

interface PairConfig {
  wsPort: number;
  token: string;
  /** Routing label typed into Options; empty lets the server name this browser. */
  profile: string;
  /** Name proposed by the pairing helper; the server uses it only if it is free. */
  suggestedProfile: string;
  /** Stable random id for this install (one per Chrome profile). */
  installId: string;
}

let pendingClients = 0;
let pendingFeatures = 0;
// What was already waiting when this worker woke, so a restart (Chrome stops
// idle workers) does not pop the popup again for an old request.
const seenPendingClients: { ids?: Set<string> } = {};
const seenMissingFeatures: { ids?: Set<string> } = {};
function newlyPending(seen: { ids?: Set<string> }, now: string[]): boolean {
  const first = !seen.ids;
  const added = now.some((id) => !seen.ids?.has(id));
  seen.ids = new Set(now);
  return !first && added;
}
const KEEPALIVE_ALARM = 'chrome-mcp-keepalive';

/** A site the server refused, kept so the Options page can offer an Allow. */
interface BlockedSite {
  host: string;
  method: string;
  at: number;
}
/** How many refused sites the Options page lists (newest first). */
const MAX_BLOCKED = 10;

/** The policy delivered by the server in `welcome`; the router mirrors the gate
 *  against it. Null until a welcome arrives (commands only flow after welcome). */
let currentPolicy: WirePolicy | null = null;

// The executor reads the live policy so a frame-scoped command can be gated
// against the FRAME's origin, not just the tab's.
const reportBlocked = (host: string, method: string): void => {
  void rememberBlocked(host, method).catch(() => undefined);
};
const executor = new ChromeExecutor(() => currentPolicy, reportBlocked);
// Outlines the tabs mcp-browser-extension is working in; follows the live policy.
const border = new TabBorder(() => currentPolicy);
// --- reconnect backoff --------------------------------------------------------
// Waiting for the 30s keepalive alarm after a drop (server restart, laptop
// wake) made the first tool call after it stall for up to half a minute. Redial
// promptly instead, backing off so a server that is genuinely down is not hammered.
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 10_000];
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleReconnect(): void {
  if (access.stopped || reconnectTimer) return;
  const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
  reconnectAttempt++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void ensureConnected();
  }, delay);
}

function clearReconnect(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  reconnectAttempt = 0;
}

const ws = new WsClient({
  onCommand: (cmd, reply) => {
    commandsRunning++;
    void router.dispatch(cmd, reply).finally(() => {
      commandsRunning--;
      if (updateReady) applyUpdateWhenIdle();
    });
  },
  onState: (state) => {
    void persistState(state);
    if (state === 'connected') clearReconnect();
    // 'idle' after a dial = the socket closed or the dial failed: redial soon.
    else if (state === 'idle') scheduleReconnect();
    // No server, no agent at work: take the borders down.
    if (state === 'idle' || state === 'unauthorized' || state === 'superseded') void border.clearAll();
    // A reject with an auto-adopted token usually means the server rotated it
    // (no --persist-token) and rewrote pairing.json — re-read and retry once.
    // With one-click pairing granted, fetch the new token from the helper too.
    if (state === 'unauthorized') void adoptBundledPairing().then((took) => (took ? true : healFromHelper()));
  },
  onPolicy: (policy) => {
    if (access.stopped) return;
    if (!policy || !Array.isArray(policy.allowDomains) || policy.allowDomains.some((site) => typeof site !== 'string')) {
      currentPolicy = null;
      void syncObserverScript(null, (m) => console.debug('[mcp-browser-extension]', m));
      void chrome.storage.local.set({ allowedSites: [] });
      return;
    }
    // Old servers may still send catch-all entries. They grant nothing here.
    policy = { ...policy, allowDomains: policy.allowDomains.map(normalizeDomainPattern).filter(Boolean) };
    currentPolicy = policy;
    // The observer hook is registered from the policy, so it covers exactly the
    // allowlisted sites and only when the operator opted in.
    void syncObserverScript(policy, (m) => console.debug('[mcp-browser-extension]', m));
    void onAllowlist(policy);
  },
  // Shown on the Options page, so you can tell which name this browser got.
  onProfile: (profile) => void chrome.storage.local.set({ pairedProfile: profile }),
  onGranted: (granted) => void chrome.storage.local.set({ grantedSites: granted }),
  onBlocked: (host, method) => void rememberBlocked(host, method),
  onLatestExtension: (version) => {
    void chrome.storage.local.set({ latestExtension: version });
    checkForStoreUpdate(version);
  },
  log: (m) => console.debug('[mcp-browser-extension]', m),
});
const approvals = new ClientApprovals({
  read: async () => (await chrome.storage.local.get(CLIENT_STORAGE_KEY))[CLIENT_STORAGE_KEY],
  write: async (clients) => { await chrome.storage.local.set({ [CLIENT_STORAGE_KEY]: clients }); },
  challenge: () => ws.approvalChallenge,
  changed: (clients) => {
    const pending = clients.filter((c) => c.state === 'pending' && c.expiresAt > Date.now());
    pendingClients = pending.length;
    reflectBadge(ws.state);
    // A new app is waiting: show the popup with its Approve button.
    if (newlyPending(seenPendingClients, pending.map((c) => c.id))) void showPopup();
    // Tell the server at once, so a call waiting for this approval retries now.
    if (ws.isConnected()) ws.send({ type: 'approval_changed', v: PROTOCOL_VERSION });
  },
});
const activity = new ActivityLog({
  read: async () => (await chrome.storage.session.get(ACTIVITY_KEY))[ACTIVITY_KEY],
  write: async (entries) => { await chrome.storage.session.set({ [ACTIVITY_KEY]: entries }); },
});
let historyHasFailed = false;
const historyFailed = (): void => {
  if (historyHasFailed) return;
  historyHasFailed = true;
  void chrome.storage.session.set({ activityError: true }).catch(() => undefined);
};
const access = new AccessSwitch({
  read: async () => (await chrome.storage.local.get(ACCESS_STOPPED_KEY))[ACCESS_STOPPED_KEY],
  write: async (stopped) => { await chrome.storage.local.set({ [ACCESS_STOPPED_KEY]: stopped }); },
  revoke: () => approvals.revokeAll(),
  disconnect: () => {
    clearReconnect();
    ws.close();
    ws.state = 'idle';
    currentPolicy = null;
    void persistState('idle');
    void border.clearAll();
    void syncObserverScript(null, (m) => console.debug('[mcp-browser-extension]', m));
    void activity.interrupt().catch(historyFailed);
  },
});
const router = new CommandRouter({
  authorize: (cmd, verified) => approvals.authorize(cmd, verified),
  access: () => access.check(),
  activity: () => {
    const generation = activity.token();
    return (entry) => { void activity.record(entry, generation).catch(historyFailed); };
  },
  exec: executor,
  send: (frame) => ws.send(frame),
  getPolicy: () => currentPolicy,
  onBlocked: reportBlocked,
  log: (m) => console.debug('[mcp-browser-extension]', m),
  border,
});

/** Shape of the auto-pairing file the server writes next to this extension. */
interface BundledPairing {
  wsPort: number;
  token: string;
}

/**
 * Read `pairing.json` from this extension's own folder. The mcp-browser-extension server
 * writes it into its bundled `extension-dist/` on every boot, so an extension
 * loaded unpacked from that folder can pair with no Options-page paste. Absent
 * (a copied folder, a read-only install, or the server never ran) → null.
 */
async function readBundledPairing(): Promise<BundledPairing | null> {
  try {
    const res = await fetch(chrome.runtime.getURL('pairing.json'), { cache: 'no-store' });
    if (!res.ok) return null;
    const j = (await res.json()) as { port?: unknown; token?: unknown };
    if (typeof j.port === 'number' && j.port > 0 && typeof j.token === 'string' && j.token.length > 0) {
      return { wsPort: j.port, token: j.token };
    }
  } catch {
    /* no bundled file — manual pairing only */
  }
  return null;
}

/**
 * Adopt the bundled pairing unless the user pinned values by hand in Options
 * (`pairingSource: 'manual'`). Only writes when something actually changed, so
 * a stale reject retries exactly once per new file — never in a loop. Returns
 * true when storage was updated (the onChanged listener then reconnects).
 */
async function adoptBundledPairing(): Promise<boolean> {
  const { wsPort, token, pairingSource } = await chrome.storage.local.get(['wsPort', 'token', 'pairingSource']);
  if (pairingSource === 'manual') return false;
  const bundled = await readBundledPairing();
  if (!bundled) return false;
  if (bundled.wsPort === wsPort && bundled.token === token) return false;
  await chrome.storage.local.set({ wsPort: bundled.wsPort, token: bundled.token, pairingSource: 'auto' });
  return true;
}

/**
 * Self-update for unpacked installs. The server mirrors a new extension build
 * into this folder on every boot; Chrome keeps running the old one until the
 * extension is reloaded. An unpacked extension reads its own files from disk,
 * so compare the manifest on disk with the version this code was built as and
 * reload once per new version. Not getManifest(): Chrome can report the new
 * manifest while this worker still runs an older build. A packed (Web Store)
 * install always matches its own manifest, so this is a no-op there. Guarded
 * by storage so a broken manifest on disk cannot cause a reload loop.
 */
async function reloadIfFilesChanged(): Promise<void> {
  try {
    const res = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' });
    if (!res.ok) return;
    const onDisk = (await res.json()) as { version?: unknown };
    const loaded = typeof __MBE_BUILD_VERSION__ === 'string' ? __MBE_BUILD_VERSION__ : chrome.runtime.getManifest().version;
    if (typeof onDisk.version !== 'string' || onDisk.version === loaded) return;
    const { reloadedFor } = await chrome.storage.local.get('reloadedFor');
    if (reloadedFor === onDisk.version) return; // already tried this version once
    await chrome.storage.local.set({ reloadedFor: onDisk.version });
    console.info(`[mcp-browser-extension] extension files updated on disk (${loaded} -> ${onDisk.version}); reloading`);
    chrome.runtime.reload();
  } catch {
    /* packed install, or the folder is unreadable — nothing to do */
  }
}

/**
 * This install's id, created on first use. chrome.storage.local is per Chrome
 * profile, so each profile's copy of the extension gets its own — the server
 * names browsers from it, since Chrome won't tell an extension which profile
 * it is running in.
 */
async function ensureInstallId(installId: unknown): Promise<string> {
  if (typeof installId === 'string' && installId.length > 0) return installId;
  const fresh = crypto.randomUUID();
  await chrome.storage.local.set({ installId: fresh });
  return fresh;
}

async function getConfig(): Promise<PairConfig | null> {
  const { wsPort, token, profile, suggestedProfile, pairingSource, installId } = await chrome.storage.local.get([
    'wsPort',
    'token',
    'profile',
    'suggestedProfile',
    'pairingSource',
    'installId',
  ]);
  // wsPort must be > 0 — a stored 0 would dial ws://127.0.0.1:0 (ERR_UNSAFE_PORT).
  if (typeof wsPort === 'number' && wsPort > 0 && typeof token === 'string' && token.length > 0) {
    const label = typeof profile === 'string' ? profile.trim() : '';
    const suggested = typeof suggestedProfile === 'string' ? suggestedProfile.trim() : '';
    // Before suggestions existed, Connect saved the helper's name as `profile`.
    // That name was never typed by the person, so it must not take names over.
    const fromHelper = pairingSource === 'native' && label !== '';
    return {
      wsPort, token,
      profile: fromHelper ? '' : label,
      suggestedProfile: suggested || (fromHelper ? label : ''),
      installId: await ensureInstallId(installId),
    };
  }
  return null;
}

/** Mirror the live allowlist for the Options page, and drop refused sites it now covers. */
async function onAllowlist(policy: WirePolicy): Promise<void> {
  await initializeBrowserPermissions();
  const effective = { ...policy, allowDomains: await permittedSites(policy.allowDomains) };
  const { blockedSites } = await chrome.storage.local.get('blockedSites');
  const still = (Array.isArray(blockedSites) ? (blockedSites as BlockedSite[]) : []).filter(
    (b) => !isDomainAllowed(`https://${b.host}/`, effective),
  );
  await chrome.storage.local.set({ allowedSites: policy.allowDomains, blockedSites: still });
  pendingBlocked = still.length;
  reflectBadge(ws.state);
}

/** The server refused `host`: list it on the Options page, flag the toolbar icon and show the popup. */
// Refusals arrive back to back (the server re-asks while it waits). One at a
// time, so a second refusal never reads the list before the first one's write
// lands and pops the popup again or drops an entry.
let blockedQueue: Promise<void> = Promise.resolve();

function rememberBlocked(host: string, method: string): Promise<void> {
  const next = blockedQueue.then(() => recordBlocked(host, method));
  blockedQueue = next.catch(() => undefined);
  return next;
}

async function recordBlocked(host: string, method: string): Promise<void> {
  const { blockedSites, dismissedSites } = await chrome.storage.local.get(['blockedSites', 'dismissedSites']);
  const listed = Array.isArray(blockedSites) ? (blockedSites as BlockedSite[]) : [];
  const prior = listed.filter((b) => b.host !== host);
  const next = [{ host, method, at: Date.now() }, ...prior].slice(0, MAX_BLOCKED);
  await chrome.storage.local.set({ blockedSites: next,
    dismissedSites: (Array.isArray(dismissedSites) ? dismissedSites : []).filter((site) => site !== host),
  });
  pendingBlocked = next.length;
  reflectBadge(ws.state);
  // A new install sits in the puzzle-piece menu where the badge is hidden, so
  // open the popup with its Allow button. Only for a newly listed site: the
  // server re-asks every poll while it waits, and that must not pop it again.
  if (prior.length === listed.length) void showPopup();
}

const POPUP_OWED_KEY = 'popupOwed';

async function showPopup(): Promise<void> {
  try {
    const open = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.POPUP] });
    if (open.length) return;
    // Chrome shows the popup only in the window the person is using. While they
    // are in another app (often the terminal running the agent), show it the
    // moment they switch back to Chrome instead.
    if (!(await chrome.windows.getLastFocused()).focused) {
      await chrome.storage.session.set({ [POPUP_OWED_KEY]: true });
      return;
    }
    await chrome.action.openPopup();
  } catch { /* Older Chrome: the badge still flags it. */ }
}

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  void (async () => {
    if (!(await chrome.storage.session.get(POPUP_OWED_KEY))[POPUP_OWED_KEY]) return;
    await chrome.storage.session.remove(POPUP_OWED_KEY);
    // The badge outlives a worker restart: '?' means something still waits on the person.
    if (await chrome.action.getBadgeText({}) !== '?') return;
    await chrome.action.openPopup({ windowId });
  })().catch(() => undefined);
});

/** Refused sites not yet allowed or dismissed; non-zero flags the toolbar icon. */
let pendingBlocked = 0;
void chrome.storage.local.get('blockedSites').then(({ blockedSites }) => {
  pendingBlocked = Array.isArray(blockedSites) ? blockedSites.length : 0;
});

const BLOCKED_BADGE = {
  text: '?',
  color: '#ea580c',
  title: 'MCP Browser Extension — a site was blocked. Click to allow it.',
};

const BADGE: Record<ConnState, { text: string; color: string; title: string }> = {
  connected: { text: '●', color: '#16a34a', title: 'MCP Browser Extension — connected' },
  connecting: { text: '…', color: '#ca8a04', title: 'MCP Browser Extension — connecting' },
  unauthorized: { text: '!', color: '#dc2626', title: 'MCP Browser Extension — rejected (bad/stale token; re-pair)' },
  idle: { text: '○', color: '#6b7280', title: 'MCP Browser Extension — not connected (open options to pair)' },
  superseded: {
    text: '!',
    color: '#dc2626',
    title: 'MCP Browser Extension — another browser took this profile name; give this one its own name in Settings',
  },
};

function reflectBadge(state: ConnState): void {
  const b = access.stopped
    ? { text: 'OFF', color: '#b91c1c', title: 'MCP Browser Extension — access stopped' }
    : pendingClients > 0
    ? { text: '?', color: '#b45309', title: 'App connection awaiting approval. Open Settings to review.' }
    : state === 'connected' && pendingBlocked > 0 ? BLOCKED_BADGE
    : pendingFeatures > 0 ? { text: '?', color: '#b45309', title: 'Permission needed. Open the extension popup → Extra permissions.' }
    : (BADGE[state] ?? BADGE.idle);
  // Best-effort: chrome.action may be unavailable in some contexts.
  try {
    void chrome.action.setBadgeText({ text: b.text });
    void chrome.action.setBadgeBackgroundColor({ color: b.color });
    void chrome.action.setTitle({ title: b.title });
  } catch {
    /* no action surface */
  }
}

async function persistState(state: ConnState): Promise<void> {
  reflectBadge(state);
  await chrome.storage.local.set({ connState: state });
}

/** How Chrome installed this copy: "normal" from the store, "development" when loaded unpacked. */
async function installType(): Promise<string | undefined> {
  try {
    return (await chrome.management.getSelf()).installType;
  } catch {
    return undefined;
  }
}

/** Connect if we have config and aren't already connected (and weren't rejected). */
async function ensureConnected(): Promise<void> {
  try { await access.initialize(); }
  catch { reflectBadge('idle'); return; }
  if (access.stopped) { reflectBadge('idle'); return; }
  if (ws.isConnected() || ws.state === 'unauthorized' || ws.state === 'superseded') return;
  const cfg = await getConfig();
  if (!cfg) return;
  const install = await installType();
  if (!access.stopped) ws.connect(cfg.wsPort, cfg.token, cfg.profile, cfg.installId, install, cfg.suggestedProfile);
}

// --- keepalive: an awaited extension-API call resets the 30s idle timer -----
async function keepalivePulse(): Promise<void> {
  await chrome.storage.local.get('connState'); // the await is what keeps us warm
  await reloadIfFilesChanged();
  // Not paired yet (extension loaded before the server first ran)? The server
  // may have written pairing.json since — pick it up without a reload.
  if (!ws.isConnected() && !(await getConfig())) await adoptBundledPairing();
  await ensureConnected();
}

// --- top-level listeners (synchronous registration) -------------------------
chrome.runtime.onInstalled.addListener((details) => {
  void bootstrap();
  // A fresh install opens Settings, whose first thing is the Connect button.
  if (details.reason === 'install') void chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(() => void bootstrap());

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) void keepalivePulse();
});

// A new page drops the border's CSS; repaint it (the theme may differ too).
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'complete') void border.loaded(tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => void border.closed(tabId));

// Logs in to the proxy set on the Options page. 'asyncBlocking' because the
// credentials are read from storage; needs the webRequestAuthProvider permission.
// (The bundled @types/chrome predates 'asyncBlocking', hence the cast.)
function syncProxyAuthListener(): void {
  const event = chrome.webRequest?.onAuthRequired;
  if (!event) return;
  void chrome.permissions.contains({ permissions: ['webRequest', 'webRequestAuthProvider'] }).then((granted) => {
    if (event.hasListener(onProxyAuth)) event.removeListener(onProxyAuth);
    if (granted) event.addListener(onProxyAuth, { urls: ['http://*/*', 'https://*/*'] }, ['asyncBlocking'] as unknown as string[]);
  });
}
syncProxyAuthListener();

async function permissionsChanged(): Promise<void> {
  syncProxyAuthListener();
  await refreshFeatureBadge();
  if (currentPolicy) {
    await onAllowlist(currentPolicy);
    await syncObserverScript(currentPolicy, (m) => console.debug('[mcp-browser-extension]', m));
  }
  await border.clearAll();
}
let featureBadgeGeneration = 0;
async function refreshFeatureBadge(): Promise<void> {
  const generation = ++featureBadgeGeneration;
  const saved = (await chrome.storage.local.get(FEATURE_REQUESTS_KEY))[FEATURE_REQUESTS_KEY];
  const requested = Array.isArray(saved) ? saved.filter((p): p is string => typeof p === 'string' && p in OPTIONAL_FEATURES) : [];
  const missing = await Promise.all(requested.map(async (permission) =>
    !await chrome.permissions.contains({ permissions: [permission] })));
  if (generation !== featureBadgeGeneration) return;
  const stillMissing = requested.filter((_, i) => missing[i]);
  pendingFeatures = stillMissing.length;
  reflectBadge(ws.state);
  if (newlyPending(seenMissingFeatures, stillMissing)) void showPopup();
}
chrome.permissions.onAdded.addListener((permissions) => {
  void (async () => {
    if (permissions.origins?.some(isGlobalOrigin)) await removeGlobalOrigins();
    await permissionsChanged();
  })().catch((err) => console.warn('[mcp-browser-extension] permission change failed', err));
});
chrome.permissions.onRemoved.addListener(() => {
  void permissionsChanged().catch((err) => console.warn('[mcp-browser-extension] permission change failed', err));
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[FEATURE_REQUESTS_KEY]) void refreshFeatureBadge();
  if (area === 'local' && changes.tabBorder?.newValue === false) void border.clearAll();
  if (area === 'local' && changes[PROXY_STORAGE_KEY]) void syncProxy();
  if (area === 'local' && (changes.wsPort || changes.token || changes.profile || changes.suggestedProfile)) {
    // New pairing config (e.g. from the options page) → clear any prior reject and
    // reconnect so a changed profile re-pairs under the new routing label.
    if (ws.state === 'unauthorized' || ws.state === 'superseded') ws.state = 'idle';
    if (changes.profile || changes.suggestedProfile) ws.close(); // force a fresh hello with the new profile
    clearReconnect();
    void ensureConnected();
  }
});

// Lets the options page trigger an immediate (re)connect after saving config,
// and carries the popup's and options page's Allow / Remove clicks to the server.
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === 'connect_with_click') {
    if (!isApprovalPage(sender) || access.stopped) {
      reply({ ok: false, message: 'Use Resume connection in the extension popup or Settings first.' });
      return;
    }
    // No await before the permission API: messaging carries the click's gesture.
    void requestPairingFromClick().then(async (result) => {
      if (!result.ok && result.error === 'restart_needed') {
        // The permission is granted now; a fresh worker gets the native API.
        await chrome.storage.local.set({ [PAIR_AFTER_RESTART_KEY]: true });
        reply({ ok: true });
        setTimeout(() => chrome.runtime.reload(), 200);
        return;
      }
      if (!result.ok) { reply(result); return; }
      if (access.stopped) { reply({ ok: false, message: 'Access is stopped. Use Resume connection first.' }); return; }
      await applyPairing(result);
      clearReconnect();
      ws.close();
      ws.state = 'idle';
      await ensureConnected();
      reply({ ok: true });
    }).catch(() => reply({ ok: false, message: 'Could not connect. Please try again.' }));
    return true;
  }
  if (msg?.type === 'feature_access') {
    if (!isApprovalPage(sender) || !Object.hasOwn(OPTIONAL_FEATURES, msg.feature) || typeof msg.allow !== 'boolean') {
      reply({ ok: false, error: 'Use Extra permissions in the extension popup or Settings.' });
      return;
    }
    const operation = msg.allow ? chrome.permissions.request({ permissions: [msg.feature] })
      : chrome.permissions.remove({ permissions: [msg.feature] });
    void operation.then((changed) => reply({ ok: changed || !msg.allow,
      ...(!changed && msg.allow ? { error: 'No access was added. You can allow it whenever you are ready.' } : {}),
    }), () => reply({ ok: false, error: 'Could not change this permission. Please try again.' }))
      .finally(() => { if (msg.allow) void reopenPopup(sender); });
    return true;
  }
  if (['access_stop', 'access_resume', 'activity_clear'].includes(msg?.type)) {
    if (!isApprovalPage(sender)) {
      reply({ ok: false, error: 'Use the extension popup or Settings to change browser access or history.' });
      return;
    }
    const operation = msg.type === 'access_stop' ? access.stop()
      : msg.type === 'access_resume' ? access.resume().then(() => ensureConnected())
      : activity.clear().then(async () => {
        await chrome.storage.session.set({ activityError: false });
        historyHasFailed = false;
      });
    void operation.then(() => {
      reflectBadge(ws.state);
      reply({ ok: true });
    }, () => reply({ ok: false, error: msg.type === 'activity_clear'
      ? 'Could not clear history. Please try again.'
      : 'Access is blocked in this session, but the setting could not be saved. Try Stop access again before restarting Chrome.' }));
    return true;
  }
  if (msg?.type === 'client_decision') {
    if (!isApprovalPage(sender) || typeof msg.id !== 'string' || typeof msg.allow !== 'boolean') {
      reply({ ok: false, error: 'Client approval requires the extension popup or Settings page.' });
      return;
    }
    if (msg.allow && access.stopped) {
      reply({ ok: false, error: 'Access is stopped. Use Resume connection first, then approve the app.' });
      return;
    }
    void approvals.decide(msg.id, msg.allow).then(
      () => reply({ ok: true }),
      (err) => reply({ ok: false, error: err instanceof Error ? err.message : 'Could not save the decision.' }),
    );
    return true;
  }
  if (msg?.type === 'reconnect') {
    if (!isApprovalPage(sender)) return;
    if (access.stopped) {
      reply({ ok: false, error: 'Access is stopped. Use Resume connection in the extension popup or Settings.' });
      return;
    }
    clearReconnect();
    ws.close();
    ws.state = 'idle';
    void ensureConnected();
  }
  if (['site_grant', 'site_access'].includes(msg?.type) && typeof msg.host === 'string') {
    // Only this extension's own pages may grant. A script injected into a web
    // page also reports our id, but its url is the page's, never ours.
    if (!isApprovalPage(sender) || typeof msg.allow !== 'boolean') {
      reply({ ok: false, error: 'Please approve this website in the extension popup or Settings.' });
      return;
    }
    if (!ws.isConnected()) {
      reply({ ok: false, error: 'not connected to the MCP Browser Extension server' });
      return;
    }
    const origins = siteOrigins(msg.host);
    if (!origins.length) {
      reply({ ok: false, error: 'Please enter one website. All-site access is not available.' });
      return;
    }
    // Own the entire operation here: Chrome may close the popup for its prompt.
    // Invoke request synchronously while the message still carries the user's click.
    const permission = msg.type === 'site_access' && msg.allow
      ? chrome.permissions.request({ origins }) : Promise.resolve(true);
    void (async () => {
      if (!await permission) {
        reply({ ok: false, error: 'No access was added. You can click Allow whenever you are ready.' });
        return;
      }
      await initializeBrowserPermissions();
      if (!origins.length || (msg.allow && !await chrome.permissions.contains({ origins }))) {
        reply({ ok: false, error: 'Please click Allow for this website and accept Chrome’s permission request.' });
        return;
      }
      if (!msg.allow) await chrome.permissions.remove({ origins });
      if (!ws.isConnected() || (msg.allow && access.stopped)) {
        reply({ ok: false, error: 'Access is stopped or disconnected. Reconnect before allowing this website.' });
        return;
      }
      const frame: SiteGrantFrame = { type: 'site_grant', v: PROTOCOL_VERSION, host: normalizeDomainPattern(msg.host), allow: msg.allow };
      ws.send(frame);
      if (currentPolicy) await onAllowlist(currentPolicy);
      reply({ ok: true });
    })().catch(() => reply({ ok: false, error: 'Could not update this website permission. Please try again.' }))
      .finally(() => { if (msg.type === 'site_access' && msg.allow) void reopenPopup(sender); });
    return true;
  }
  // Options page: re-apply after a permission change, and its Check IP button.
  const fromOwnPage = sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(''));
  if (msg?.type === 'proxy_apply' && fromOwnPage) void syncProxy();
  if (msg?.type === 'proxy_status' && fromOwnPage) {
    void proxyStatus().then(reply, () => reply(null));
    return true; // reply comes later
  }
  if (msg?.type === 'dismiss_blocked' && typeof msg.host === 'string') {
    if (!isApprovalPage(sender)) { reply({ ok: false, error: 'Use the extension popup or Settings.' }); return; }
    const host = normalizeDomainPattern(msg.host);
    if (!siteOrigins(host).length) { reply({ ok: false, error: 'Invalid website.' }); return; }
    void chrome.storage.local.get(['blockedSites', 'dismissedSites']).then(async ({ blockedSites, dismissedSites }) => {
      const still = (Array.isArray(blockedSites) ? (blockedSites as BlockedSite[]) : []).filter((b) => b.host !== msg.host);
      const dismissed = Array.isArray(dismissedSites) ? dismissedSites.filter((site) => typeof site === 'string' && site !== host) : [];
      await chrome.storage.local.set({ blockedSites: still, dismissedSites: [...dismissed, host].slice(-100) });
      pendingBlocked = still.length;
      reflectBadge(ws.state);
      reply({ ok: true });
    }).catch(() => reply({ ok: false, error: 'Could not dismiss this website. Please try again.' }));
    return true;
  }
});

/**
 * Chrome closes the toolbar popup to show its own Allow/Deny prompt. Bring the
 * popup back once that decision is made, so the person stays where they were.
 */
async function reopenPopup(sender: chrome.runtime.MessageSender): Promise<void> {
  if (sender.url !== chrome.runtime.getURL('popup.html')) return;
  await showPopup();
}

/**
 * Refetch the pairing from the native helper without a click, once the person
 * has granted it: after a token rotation, or when nothing is configured yet.
 * Only writes when something changed, so a reject can't loop.
 */
async function healFromHelper(): Promise<boolean> {
  try {
    if (!(await chrome.permissions.contains({ permissions: ['nativeMessaging'] }))) return false;
    const reply = await fetchPairing();
    if (!reply.ok) return false;
    const { wsPort, token } = await chrome.storage.local.get(['wsPort', 'token']);
    if (wsPort === reply.port && token === reply.token) return false;
    await applyPairing(reply);
    return true;
  } catch {
    return false;
  }
}

/** Apply the Options page's proxy setting; a failure is logged, never fatal. */
async function syncProxy(): Promise<void> {
  try {
    await applyProxy((m) => console.debug('[mcp-browser-extension]', m));
  } catch (err) {
    console.warn('[mcp-browser-extension] could not apply the proxy setting', err);
  }
}

let historyInitialized = false;
async function bootstrap(): Promise<void> {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  // Remove the display-only requests left by the former per-action review UI.
  await chrome.storage.session.remove('actionRequests');
  await access.initialize();
  if (!historyInitialized) {
    historyInitialized = true;
    await activity.interrupt().catch(historyFailed);
  }
  await initializeBrowserPermissions();
  await refreshFeatureBadge();
  const savedClients = (await chrome.storage.local.get(CLIENT_STORAGE_KEY))[CLIENT_STORAGE_KEY];
  pendingClients = (Array.isArray(savedClients) ? savedClients as ClientConnection[] : []).filter((c) => c.state === 'pending' && c.expiresAt > Date.now()).length;
  await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  await syncProxy();
  await reloadIfFilesChanged();
  // Connect was clicked just before a restart that enabled the native helper.
  if ((await chrome.storage.local.get(PAIR_AFTER_RESTART_KEY))[PAIR_AFTER_RESTART_KEY]) {
    await chrome.storage.local.remove(PAIR_AFTER_RESTART_KEY);
    if (await healFromHelper()) return; // storage changed: onChanged reconnects
  }
  // Zero-paste pairing: if this folder carries the server's pairing.json, adopt
  // it. When that writes storage, onChanged reconnects; otherwise connect now.
  if (await adoptBundledPairing()) return; // storage changed: onChanged reconnects
  // Nothing configured but one-click pairing was granted before: fetch it.
  if (!(await getConfig()) && (await healFromHelper())) return;
  await ensureConnected();
}

// Eager attempt on worker spin-up (covers wakes not covered by the events above).
void bootstrap();
