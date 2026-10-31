import '../client-connections';
import '../site-protection-ui';
import { SITE_CHECKS_KEY } from '../../../shared/site-risk';
import '../activity-dashboard';
import { ACCESS_STOPPED_KEY } from '../../../shared/activity';
import '../extra-permissions';
import { changeSiteAccess, permittedSites } from '../site-access';
import { busyButton, renderList } from '../ui-controls';
import { normalizeDomainPattern } from '../../../shared/policy';
/**
 * extension/src/options/options.ts — the manual pairing UI. Persists {wsPort,
 * token} to chrome.storage.local (which the background SW watches) and asks it
 * to (re)connect. Also reflects the live connection state.
 */

import { DEFAULT_WS_PORT, type ProxyWireStatus } from '../../../shared/protocol';
import { connectWithOneClick } from '../connect';
import { PROXY_STORAGE_KEY, parseProxyConfig, parseProxyLine } from '../../../shared/proxy';
import { IP_LOOKUP_ORIGINS, PROXY_AUTH_PERMISSIONS } from '../../../shared/browser-permissions';

const portEl = document.getElementById('port') as HTMLInputElement;
const tokenEl = document.getElementById('token') as HTMLInputElement;
const profileEl = document.getElementById('profile') as HTMLInputElement;
const saveEl = document.getElementById('save') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLDivElement;

const sourceEl = document.getElementById('source') as HTMLParagraphElement;
const pairedAsEl = document.getElementById('paired-as') as HTMLParagraphElement;
const borderEl = document.getElementById('tab-border') as HTMLInputElement;

// Takes effect at once: the service worker clears every border when this turns off.
void chrome.storage.local.get('tabBorder').then(({ tabBorder }) => (borderEl.checked = tabBorder !== false));
borderEl.addEventListener('change', () => void chrome.storage.local.set({ tabBorder: borderEl.checked }));

function renderPairedAs(name: unknown): void {
  pairedAsEl.textContent = typeof name === 'string' && name ? `This browser is paired as "${name}".` : '';
}

async function loadExisting(): Promise<void> {
  const { wsPort, profile, connState, pairingSource, pairedProfile } = await chrome.storage.local.get([
    'wsPort',
    'profile',
    'connState',
    'pairingSource',
    'pairedProfile',
  ]);
  renderPairedAs(pairedProfile);
  sourceEl.textContent =
    pairingSource === 'auto'
      ? 'Paired automatically from the pairing.json the server wrote into this extension folder. Saving here overrides it.'
      : pairingSource === 'manual'
        ? 'Paired by hand. Saved values take precedence over the bundled pairing.json.'
        : typeof wsPort === 'number' && wsPort > 0 && connState !== 'idle'
          ? 'Paired with values saved by an earlier version. Saving here keeps them manual.'
          : 'Not paired yet. If you loaded this extension from the MCP Browser Extension package folder, start the server once and it pairs itself; otherwise paste the values below.';
  // Prefill a real value (not just the placeholder) so an empty Save can never
  // store port 0 → ws://127.0.0.1:0 → ERR_UNSAFE_PORT. Defaults to the server's port.
  portEl.value = typeof wsPort === 'number' && wsPort > 0 ? String(wsPort) : String(DEFAULT_WS_PORT);
  profileEl.value = typeof profile === 'string' ? profile : '';
  render(typeof connState === 'string' ? connState : 'idle');
}

const quickEl = document.getElementById('quick') as HTMLDivElement;
const connectEl = document.getElementById('connect') as HTMLButtonElement;
const connectMsgEl = document.getElementById('connect-msg') as HTMLParagraphElement;

connectEl.addEventListener('click', async (event) => {
  if (!event.isTrusted) return;
  connectEl.disabled = true;
  connectEl.textContent = 'Connecting…';
  const res = await connectWithOneClick();
  connectEl.disabled = false;
  connectMsgEl.className = res.ok ? 'hint' : 'hint error';
  connectMsgEl.textContent = res.ok ? '' : (res.message ?? 'Could not connect.');
  // The connection may already be up by now: show the live state, not a guess.
  const { connState } = await chrome.storage.local.get('connState');
  render(typeof connState === 'string' ? connState : 'connecting');
});

function render(state: string): void {
  // Always offered: "Connect" while unpaired, "Connect again" to re-pair on purpose.
  quickEl.hidden = false;
  if (!connectEl.disabled) connectEl.textContent = state === 'connected' ? 'Connect again' : 'Connect';
  // Follow the live state; a Connect error stays until the next click.
  if (!connectMsgEl.classList.contains('error')) {
    connectMsgEl.textContent = state === 'connected' ? 'Connected.' : state === 'connecting' ? 'Connecting…' : '';
  }
  const labels: Record<string, string> = {
    connected: 'connected',
    connecting: '… connecting',
    unauthorized: 'rejected (bad/stale token — re-paste)',
    superseded: 'another browser connected under the same profile name. Type a different Profile name above and Save & connect.',
    idle: '○ not connected',
  };
  statusEl.textContent = `Status: ${labels[state] ?? state}`;
  void chrome.storage.local.get(ACCESS_STOPPED_KEY).then((saved) => {
    if (saved[ACCESS_STOPPED_KEY]) statusEl.textContent = 'Status: access stopped';
  });
}

saveEl.addEventListener('click', async (event) => {
  if (!event.isTrusted) return;
  const wsPort = Number(portEl.value);
  // The token field is never prefilled (it's a secret), so a blank one means
  // "keep the token I already have" — e.g. when only the Profile changes.
  const stored = await chrome.storage.local.get('token');
  const token = tokenEl.value.trim() || (typeof stored.token === 'string' ? stored.token : '');
  // Blank = let the server name this browser ("default", "profile-2", ...).
  const profile = profileEl.value.trim();
  if (!Number.isInteger(wsPort) || wsPort <= 0 || !token) {
    statusEl.textContent = 'Status: enter a valid port (> 0) and token';
    return;
  }
  await chrome.storage.local.set({ wsPort, token, profile, pairingSource: 'manual' });
  const result = await chrome.runtime.sendMessage({ type: 'reconnect' }).catch(() => undefined);
  statusEl.textContent = result?.ok === false ? `Status: ${result.error}` : 'Status: … connecting';
});

// -- allowed sites ------------------------------------------------------------

const blockedWrapEl = document.getElementById('blocked-wrap') as HTMLDivElement;
const blockedEl = document.getElementById('blocked') as HTMLUListElement;
const allowedEl = document.getElementById('allowed') as HTMLUListElement;
const sitesNoteEl = document.getElementById('sites-note') as HTMLParagraphElement;
const newSiteEl = document.getElementById('new-site') as HTMLInputElement;
const addSiteEl = document.getElementById('add-site') as HTMLButtonElement;

interface BlockedSite {
  host: string;
  method: string;
  at: number;
}

/** Send an Allow / Remove to the server through the service worker. */
async function grant(host: string, allow: boolean): Promise<void> {
  const res = await changeSiteAccess(host, allow);
  await renderSites();
  sitesNoteEl.textContent = res.ok ? '' : (res.error ?? 'Could not change website access. Please try again.');
}

function button(label: string, onClick: () => unknown | Promise<unknown>): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', (event) => {
    if (event.isTrusted) void busyButton(b, onClick).catch(() => {
      sitesNoteEl.textContent = 'Could not finish that action. Please try again.';
    });
  });
  return b;
}

function siteRow(host: string, extra: Array<HTMLElement>): HTMLLIElement {
  const li = document.createElement('li');
  const name = document.createElement('span');
  name.textContent = host;
  li.append(name, ...extra);
  return li;
}

function tag(text: string): HTMLSpanElement {
  const t = document.createElement('span');
  t.className = 'tag';
  t.textContent = text;
  return t;
}

let sitesGeneration = 0;
async function renderSites(): Promise<void> {
  const generation = ++sitesGeneration;
  const { allowedSites, grantedSites, blockedSites, dismissedSites, connState, siteChecksSupported, [SITE_CHECKS_KEY]: selected } = await chrome.storage.local.get([
    SITE_CHECKS_KEY,
    'siteChecksSupported',
    'allowedSites',
    'grantedSites',
    'blockedSites',
    'dismissedSites',
    'connState',
  ]);
  const automatic = selected !== false && siteChecksSupported === true;
  const allowed = Array.isArray(allowedSites) ? (allowedSites as string[]).map(normalizeDomainPattern).filter(Boolean) : [];
  // null = a server too old to take grants from here.
  const granted = Array.isArray(grantedSites) ? (grantedSites as string[]) : null;
  const permitted = await permittedSites(allowed);
  if (generation !== sitesGeneration) return;
  const pending = Array.isArray(blockedSites) ? (blockedSites as BlockedSite[]) : [];
  const blocked = [...new Set([...pending.map((b) => b.host), ...allowed.filter((site) => !permitted.includes(site))])]
    .filter((host) => !permitted.includes(host) && (!Array.isArray(dismissedSites) || !dismissedSites.includes(host)));

  renderList(blockedEl, blocked, (host) => host, (host) => host, (host) =>
      siteRow(host, [
        tag('needs permission'),
        button('Allow', () => grant(host, true)),
        button('Dismiss', () => chrome.runtime.sendMessage({ type: 'dismiss_blocked', host })),
      ]),
  );
  blockedWrapEl.hidden = !!automatic || blocked.length === 0 || connState !== 'connected';
  document.getElementById('sites-section')!.hidden = !!automatic;

  renderList(allowedEl, permitted, (host) => host, (host) => JSON.stringify([host, granted?.includes(host)]), (host) =>
      siteRow(host, [...(granted?.includes(host) ? [] : [tag('set by server flags')]), button('Remove', () => grant(host, false))]),
  );
  if (connState !== 'connected') {
    sitesNoteEl.textContent = 'Connect to the MCP Browser Extension server to see and change the allowed sites.';
  } else if (granted === null) {
    sitesNoteEl.textContent =
      'This MCP Browser Extension server does not take sites from here (it is older, or runs with --no-site-grants). Use --allow-domain instead.';
  } else if (permitted.length === 0) {
    sitesNoteEl.textContent = 'No sites are allowed yet.';
  } else {
    sitesNoteEl.textContent = '';
  }
  const canGrant = connState === 'connected' && granted !== null;
  addSiteEl.disabled = !canGrant;
  newSiteEl.disabled = !canGrant;
}

function addSite(event: Event): void {
  if (!event.isTrusted) return;
  const host = newSiteEl.value.trim();
  if (!host) return;
  newSiteEl.value = '';
  void grant(host, true);
}
addSiteEl.addEventListener('click', addSite);
newSiteEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); addSite(e); }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[ACCESS_STOPPED_KEY]) {
    void chrome.storage.local.get('connState').then((saved) => render(String(saved.connState ?? 'idle')));
  }
  if (area === 'local' && changes.connState) render(String(changes.connState.newValue));
  if (area === 'local' && changes.pairedProfile) renderPairedAs(changes.pairedProfile.newValue);
  if (area === 'local' && (changes[SITE_CHECKS_KEY] || changes.siteChecksSupported || changes.allowedSites || changes.grantedSites || changes.blockedSites || changes.dismissedSites || changes.connState)) {
    void renderSites();
  }
});

void renderSites();
chrome.permissions.onAdded.addListener(() => void renderSites());
chrome.permissions.onRemoved.addListener(() => void renderSites());

void loadExisting();

// -- proxy --------------------------------------------------------------------

const proxyEnabledEl = document.getElementById('proxy-enabled') as HTMLInputElement;
const proxySchemeEl = document.getElementById('proxy-scheme') as HTMLSelectElement;
const proxyHostEl = document.getElementById('proxy-host') as HTMLInputElement;
const proxyPortEl = document.getElementById('proxy-port') as HTMLInputElement;
const proxyUserEl = document.getElementById('proxy-user') as HTMLInputElement;
const proxyPassEl = document.getElementById('proxy-pass') as HTMLInputElement;
const proxyWebrtcEl = document.getElementById('proxy-webrtc') as HTMLInputElement;
const proxySaveEl = document.getElementById('proxy-save') as HTMLButtonElement;
const proxyCheckEl = document.getElementById('proxy-check') as HTMLButtonElement;
const proxyStatusEl = document.getElementById('proxy-status') as HTMLDivElement;

function proxyNote(text: string, kind: '' | 'on' | 'err' = ''): void {
  proxyStatusEl.textContent = text;
  proxyStatusEl.className = kind ? `status proxy-${kind}` : 'status';
}

async function loadProxy(): Promise<void> {
  const cfg = parseProxyConfig((await chrome.storage.local.get(PROXY_STORAGE_KEY))[PROXY_STORAGE_KEY]);
  proxyWebrtcEl.checked = await chrome.permissions.contains({ permissions: ['privacy'] }).catch(() => false);
  if (!cfg) return proxyNote('Proxy: off');
  proxyEnabledEl.checked = cfg.enabled;
  proxySchemeEl.value = cfg.scheme;
  proxyHostEl.value = cfg.host;
  proxyPortEl.value = String(cfg.port);
  proxyUserEl.value = cfg.username;
  proxyNote(cfg.enabled ? `Proxy: on (${cfg.scheme}://${cfg.host}:${cfg.port})` : 'Proxy: saved but off', cfg.enabled ? 'on' : '');
}

/** Providers often hand out "host:port" or "host:port:user:pass"; split it into the fields. */
function splitPastedProxy(): void {
  const p = parseProxyLine(proxyHostEl.value);
  if (!p) return;
  if (p.scheme) proxySchemeEl.value = p.scheme;
  proxyHostEl.value = p.host;
  proxyPortEl.value = String(p.port);
  if (p.username !== undefined) {
    proxyUserEl.value = p.username;
    proxyPassEl.value = p.password ?? '';
  }
}
proxyHostEl.addEventListener('change', splitPastedProxy);
// Split right after a paste too, so the fields show what was understood before Save.
proxyHostEl.addEventListener('paste', () => setTimeout(splitPastedProxy, 0));

proxyWebrtcEl.addEventListener('change', async (event) => {
  if (!event.isTrusted) return;
  // Must run inside the click: Chrome only asks for a permission on a user gesture.
  if (proxyWebrtcEl.checked) {
    proxyWebrtcEl.checked = await chrome.permissions.request({ permissions: ['privacy'] }).catch(() => false);
  } else {
    // Hand the setting back to Chrome before the permission to touch it goes.
    await new Promise<void>((done) => chrome.privacy.network.webRTCIPHandlingPolicy.clear({}, () => done()));
    await chrome.permissions.remove({ permissions: ['privacy'] }).catch(() => false);
  }
  // Re-apply so a granted permission takes effect for a proxy that is already on.
  await chrome.runtime.sendMessage({ type: 'proxy_apply' }).catch(() => undefined);
});

proxySaveEl.addEventListener('click', async (event) => {
  if (!event.isTrusted) return;
  splitPastedProxy();
  const host = proxyHostEl.value.trim();
  const port = Number(proxyPortEl.value);
  const enabled = proxyEnabledEl.checked;
  if (enabled && (!host || !Number.isInteger(port) || port <= 0 || port > 65535)) {
    return proxyNote('Proxy: enter a host and a port (1-65535) first', 'err');
  }
  const username = proxyUserEl.value.trim();
  const scheme = proxySchemeEl.value;
  if (enabled && username && scheme.startsWith('socks')) {
    return proxyNote('Proxy: Chrome cannot log in to a SOCKS proxy. Pick HTTP or HTTPS, or use a proxy without a login.', 'err');
  }
  if (enabled && username && !await chrome.permissions.request({ permissions: PROXY_AUTH_PERMISSIONS }).catch(() => false)) {
    return proxyNote('Proxy access was not added. Click Save proxy whenever you are ready.', 'err');
  }
  const stored = parseProxyConfig((await chrome.storage.local.get(PROXY_STORAGE_KEY))[PROXY_STORAGE_KEY]);
  // Never prefilled (a secret): blank keeps the saved password while the username stays.
  const password = proxyPassEl.value || (stored && stored.username === username ? stored.password : '');
  await chrome.storage.local.set({ [PROXY_STORAGE_KEY]: { enabled, scheme, host, port, username, password } });
  if (!enabled) {
    // Clear the setting before revoking permission so it cannot remain active.
    if (await chrome.permissions.contains({ permissions: ['proxy'] })) await chrome.proxy.settings.clear({ scope: 'regular' });
    await chrome.permissions.remove({ permissions: PROXY_AUTH_PERMISSIONS });
  }
  proxyPassEl.value = '';
  proxyNote(enabled ? `Proxy: on (${scheme}://${host}:${port}). Click Check IP to confirm.` : 'Proxy: off', enabled ? 'on' : '');
});

proxyCheckEl.addEventListener('click', async (event) => {
  if (!event.isTrusted) return;
  if (!await chrome.permissions.request({ origins: IP_LOOKUP_ORIGINS }).catch(() => false)) {
    return proxyNote('IP lookup permission was not added. You can try again whenever you are ready.', 'err');
  }
  proxyCheckEl.disabled = true;
  proxyNote('Proxy: checking…');
  const res = (await chrome.runtime.sendMessage({ type: 'proxy_status' }).catch(() => null)) as ProxyWireStatus | null;
  proxyCheckEl.disabled = false;
  if (!res) return proxyNote('Proxy: could not reach the extension. Reload it and try again.', 'err');
  const where = [res.city, res.country].filter(Boolean).join(', ');
  const via = res.enabled ? `through ${res.server}` : 'with no proxy (your real IP)';
  if (!res.exitIp) return proxyNote(`Proxy: ${res.error ?? 'IP lookup failed'}`, 'err');
  const override =
    res.enabled && res.control !== 'controlled_by_this_extension'
      ? ' Another extension or a policy controls the proxy, so this one is not in use.'
      : '';
  proxyNote(`Sites see ${res.exitIp}${where ? ` (${where})` : ''}, ${via}.${override}`, override ? 'err' : res.enabled ? 'on' : '');
});

void loadProxy();
