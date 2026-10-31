import '../client-connections';
import '../site-protection-ui';
import { SITE_CHECKS_KEY } from '../../../shared/site-risk';
import './access-lists';
import '../activity-dashboard';
import { ACCESS_STOPPED_KEY } from '../../../shared/activity';
import '../extra-permissions';
import { changeSiteAccess, permittedSites } from '../site-access';
import { busyButton, renderList } from '../ui-controls';
/**
 * extension/src/popup/popup.ts — the panel that opens under the toolbar icon.
 *
 * At a glance: is this browser paired, may the agent touch the site you are
 * on (with a one-click Allow), which sites it was just refused, and which are
 * allowed. Everything it shows comes from chrome.storage.local, which the
 * service worker keeps current; Allow / Remove / Dismiss go to the worker,
 * which forwards grants to the local server. Pairing details stay on the
 * Options page, one click away.
 */

import { isDomainAllowed, normalizeDomainPattern } from '../../../shared/policy';
import { STORE_EXTENSION_URL, type WirePolicy } from '../../../shared/protocol';
import { connectWithOneClick } from '../connect';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

interface BlockedSite {
  host: string;
  method: string;
  at: number;
}

/** Ask the worker to allow or remove a site; it forwards to the local server. */
async function grant(host: string, allow: boolean): Promise<void> {
  const res = await changeSiteAccess(host, allow);
  await render();
  $('allowed-note').textContent = res.ok ? '' : (res.error ?? 'Could not change website access. Please try again.');
}

function button(label: string, onClick: () => unknown | Promise<unknown>, kind: 'primary' | 'ghost' | '' = ''): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  if (kind) b.className = kind;
  b.addEventListener('click', (event) => {
    if (event.isTrusted) void busyButton(b, onClick).catch(() => {
      $('allowed-note').textContent = 'Could not finish that action. Please try again.';
    });
  });
  return b;
}

/** A stable, pleasant colour per site, so each one is recognisable at a glance
 *  without fetching its favicon (which would tell a third party what you visit). */
function hue(host: string): string {
  let h = 0;
  for (const c of host.replace(/^\*\./, '')) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `linear-gradient(135deg, hsl(${h} 70% 52%), hsl(${(h + 40) % 360} 70% 44%))`;
}

/** The letter badge for a site: its first letter, skipping www. and *. */
function badge(host: string, cls: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = cls;
  const name = host.replace(/^(\*\.|www\.)/, '');
  d.textContent = name.charAt(0) || '?';
  d.style.background = hue(name);
  return d;
}

function tag(text: string): HTMLSpanElement {
  const t = document.createElement('span');
  t.className = 'tag';
  t.textContent = text;
  return t;
}

function row(host: string, extra: HTMLElement[]): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'row';
  const name = document.createElement('span');
  name.className = 'host';
  name.textContent = host;
  name.title = host;
  li.append(badge(host, 'mini'), name, ...extra);
  return li;
}

/** The host of the tab you are looking at, if it is an ordinary web page. */
async function currentHost(): Promise<string | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = new URL(tab?.url ?? '');
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.hostname : null;
  } catch {
    return null;
  }
}

let renderGeneration = 0;
async function render(): Promise<void> {
  const generation = ++renderGeneration;
  const s = await chrome.storage.local.get([
    'connState',
    SITE_CHECKS_KEY,
    'siteChecksSupported',
    'pairedProfile',
    'allowedSites',
    'grantedSites',
    'blockedSites',
    'dismissedSites',
    'tabBorder',
    'latestExtension',
    ACCESS_STOPPED_KEY,
  ]);
  const state = s[ACCESS_STOPPED_KEY] !== undefined && s[ACCESS_STOPPED_KEY] !== false
    ? 'stopped' : typeof s.connState === 'string' ? s.connState : 'idle';
  const connected = state === 'connected';
  const automatic = s[SITE_CHECKS_KEY] !== false && s.siteChecksSupported === true;
  const allowed = Array.isArray(s.allowedSites) ? (s.allowedSites as string[]).map(normalizeDomainPattern).filter(Boolean) : [];
  // null = a server too old for grants, or one run with --no-site-grants.
  const granted = Array.isArray(s.grantedSites) ? (s.grantedSites as string[]) : null;
  const permitted = await permittedSites(allowed);
  const host = connected ? await currentHost() : null;
  const hostPermitted = host ? (await permittedSites([host])).length > 0 : false;
  if (generation !== renderGeneration) return;
  const policy = { allowDomains: allowed } as WirePolicy;
  const pending = Array.isArray(s.blockedSites) ? (s.blockedSites as BlockedSite[]) : [];
  const blocked = [...new Set([
    ...pending.filter((b) => !isDomainAllowed(`https://${b.host}/`, { allowDomains: permitted } as WirePolicy)).map((b) => b.host),
    ...allowed.filter((site) => !permitted.includes(site)),
  ])].filter((site) => !Array.isArray(s.dismissedSites) || !s.dismissedSites.includes(site));
  const canGrant = connected && (granted !== null || allowed.length > 0);

  // -- status --
  const labels: Record<string, [string, string]> = {
    connected: ['Connected', 'ok'],
    connecting: ['Connecting…', 'warn'],
    unauthorized: ['Token rejected', 'bad'],
    superseded: ['Name taken', 'bad'],
    idle: ['Not connected', ''],
    stopped: ['Access stopped', 'bad'],
  };
  const [text, cls] = labels[state] ?? [state, ''];
  $('state-text').textContent = text;
  $('state').className = `pill ${cls}`;
  $('paired-as').textContent =
    connected && typeof s.pairedProfile === 'string' ? `Paired as ${s.pairedProfile}` : 'Lets your AI agent use this Chrome';
  $('version').textContent = `v${chrome.runtime.getManifest().version}`;
  // The Connect button is always here: the main action while not connected,
  // a quiet "Reconnect" once connected (to re-pair after a server change).
  const btn = $('connect') as HTMLButtonElement;
  if (!btn.disabled) {
    btn.textContent = connected ? 'Reconnect' : state === 'unauthorized' || state === 'superseded' ? 'Connect again' : 'Connect';
    btn.className = connected ? 'secondary' : 'primary';
  }
  $('connect-card').className = connected ? 'card connect done' : 'card connect';
  $('connect-text').textContent =
    state === 'stopped' ? '' : state === 'unauthorized'
      ? 'The connection needs to be refreshed. Click Connect again.'
      : state === 'superseded'
        ? `Another browser connected as "${typeof s.pairedProfile === 'string' ? s.pairedProfile : 'this profile'}", so this one stepped aside. Give it its own Profile name in Settings.`
        : 'Connect to your app to start using this browser.';

  // -- this site --
  $('this-site').hidden = !host;
  if (host) {
    const ok = hostPermitted && isDomainAllowed(`https://${host}/`, policy);
    $('site-host').textContent = host;
    $('site-host').title = host;
    const avatar = $('site-avatar');
    const name = host.replace(/^www\./, '');
    avatar.textContent = name.charAt(0);
    avatar.style.background = hue(name);
    $('site-state').textContent = automatic ? 'Checked before access' : ok ? '● Agent can use this site' : '● Blocked for the agent';
    $('site-state').className = `chip ${ok ? 'ok' : 'warn'}`;
    $('site-allow').hidden = automatic || ok || !canGrant;
    $('site-allow').onclick = (event) => {
      if (event.isTrusted) void busyButton($('site-allow') as HTMLButtonElement, () => grant(host, true));
    };
  }

  // -- blocked just now --
  renderList($('blocked'), blocked, (host) => host, (host) => host, (host) =>
      row(host, [
        button('Dismiss', () => chrome.runtime.sendMessage({ type: 'dismiss_blocked', host }), 'ghost'),
        button('Allow', () => grant(host, true), 'primary'),
      ]),
  );
  $('blocked-section').hidden = automatic || !canGrant || blocked.length === 0;
  $('blocked-count').textContent = String(blocked.length);

  // -- allowed sites --
  renderList($('allowed'), permitted, (host) => host, (host) => JSON.stringify([host, granted?.includes(host)]), (h) =>
      row(h, [...(granted?.includes(h) ? [] : [tag('From setup')]), button('Remove', () => grant(h, false), 'ghost')]),
  );
  $('allowed-section').hidden = automatic || !connected;
  $('allowed-count').textContent = String(permitted.length);
  $('allowed-note').textContent = connected && permitted.length === 0 ? 'No sites allowed yet. Click Allow above to give Chrome permission for a website.' : '';

  ($('tab-border') as HTMLInputElement).checked = s.tabBorder !== false;
  void renderUpdate(typeof s.latestExtension === 'string' ? s.latestExtension : null);
}

/** Compare dotted versions numerically: >0 when a is newer. */
function compareVersions(a: string, b: string): number {
  const x = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const y = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * An unpacked copy never updates through Chrome. Point it at the store copy,
 * which does, with the explanation and any version notice in a tooltip.
 */
async function renderUpdate(latest: string | null): Promise<void> {
  const mine = chrome.runtime.getManifest().version;
  // Unpacked builds carry the store key, so ask Chrome how this copy was installed.
  const unpacked = await chrome.management
    .getSelf()
    .then((me) => me.installType === 'development')
    .catch(() => false);
  const behind = latest !== null && compareVersions(latest, mine) > 0;
  $('update').hidden = !unpacked;
  $('update-store').hidden = !unpacked;
  $('update-text').textContent = behind
    ? `Update available: ${latest}. You have ${mine}. This copy was loaded by hand and does not update itself. The Chrome Web Store copy updates automatically.`
    : 'This copy was loaded by hand and does not update itself. Install the Chrome Web Store copy to get every update automatically, then remove this one.';
}

const updateHelp = $('update-help');
updateHelp.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') updateHelp.dataset.dismissed = 'true';
});
updateHelp.addEventListener('mouseleave', () => { delete updateHelp.dataset.dismissed; });
updateHelp.addEventListener('focusout', () => { delete updateHelp.dataset.dismissed; });
$('update-store').addEventListener('click', () => void chrome.tabs.create({ url: STORE_EXTENSION_URL }));

$('tab-border').addEventListener('change', (e) => {
  void chrome.storage.local.set({ tabBorder: (e.target as HTMLInputElement).checked });
});
$('settings').addEventListener('click', () => void chrome.runtime.openOptionsPage());
$('connect').addEventListener('click', async (event) => {
  if (!event.isTrusted) return;
  const btn = $('connect') as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = 'Connecting…';
  $('connect-msg').textContent = '';
  const res = await connectWithOneClick();
  btn.disabled = false;
  if (!res.ok) $('connect-msg').textContent = res.message ?? 'Could not connect.';
  void render();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[SITE_CHECKS_KEY] || changes.siteChecksSupported || changes[ACCESS_STOPPED_KEY] || changes.connState || changes.allowedSites || changes.grantedSites || changes.blockedSites || changes.dismissedSites || changes.pairedProfile || changes.latestExtension) {
    void render();
  }
});

void render();
chrome.permissions.onAdded.addListener(() => void render());
chrome.permissions.onRemoved.addListener(() => void render());
