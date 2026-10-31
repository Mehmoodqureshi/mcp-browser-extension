import { AUTOMATIC_SITE_ORIGINS, SITE_CHECKS_KEY, SITE_CHECKS_PENDING_KEY, SITE_CHECKS_APPROVALS_KEY,
  SITE_CHECKS_BLOCKED_KEY, type SiteWarningRequest } from '../../shared/site-risk';
import { busyButton, renderList } from './ui-controls';
import { ACCESS_STOPPED_KEY } from '../../shared/activity';

const root = document.getElementById('site-protection');
if (root) {
  root.innerHTML = `
    <h2>Suspicious-site checks</h2>
    <p class="note hint">Normal sites work automatically. Suspicious sites need Allow.</p>
    <p class="note hint" id="site-checks-state" role="status"></p>
    <button id="site-checks-toggle" class="primary">Allow website access</button>
    <button id="site-checks-manual" hidden>Use per-site approval</button>
    <p class="note hint" id="site-checks-scope">Approved apps can read, send, delete and buy on websites.</p>
    <details class="note hint"><summary>About checks</summary><p>Checks stay local and can miss threats. Page scripts run before checks.</p></details>
    <p class="note hint" id="site-checks-error" role="status" aria-live="polite"></p>
    <div id="site-warnings-section" hidden><h3>Waiting for Allow</h3><ul id="site-warnings" class="sites access-list"></ul></div>
    <div id="site-exceptions-section" hidden><h3>Allowed warnings</h3><p class="note hint">New reasons ask again.</p><ul id="site-exceptions" class="sites access-list"></ul></div>
    <div id="site-blocks-section" hidden><h3>Blocked websites</h3><ul id="site-blocks" class="sites access-list"></ul></div>
    <div id="site-block-controls" hidden><button id="site-block-current">Block this website</button><div class="site-block-entry"><input id="site-block-host" aria-label="Website to block" placeholder="example.com"><button id="site-block-add">Block</button></div></div>`;
  const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
  let revision = 0;
  let active = false;

  async function send(message: Record<string, unknown>): Promise<void> {
    el('site-checks-error').textContent = '';
    try {
      const response = await chrome.runtime.sendMessage(message);
      if (!response?.ok) throw new Error(response?.error ?? 'Could not save website access.');
    } catch (error) {
      el('site-checks-error').textContent = error instanceof Error ? error.message : 'Could not save website access.';
    }
    await render();
  }
  function button(label: string, message: Record<string, unknown>): HTMLButtonElement {
    const element = document.createElement('button');
    element.textContent = label;
    element.addEventListener('click', (event) => { if (event.isTrusted) void busyButton(element, () => send(message)); });
    return element;
  }
  function row(label: string, controls: HTMLButtonElement[], reasons: string[] = []): HTMLLIElement {
    const item = document.createElement('li');
    item.className = 'site-warning';
    const name = document.createElement('strong');
    name.textContent = label;
    item.append(name);
    for (const reason of reasons) {
      const line = document.createElement('p');
      line.className = 'note hint';
      line.textContent = reason;
      item.append(line);
    }
    const actions = document.createElement('div');
    actions.className = 'site-warning-actions';
    actions.append(...controls);
    item.append(actions);
    return item;
  }
  async function render(): Promise<void> {
    const mine = ++revision;
    const saved = await chrome.storage.local.get([SITE_CHECKS_KEY, SITE_CHECKS_PENDING_KEY, SITE_CHECKS_APPROVALS_KEY,
      SITE_CHECKS_BLOCKED_KEY, 'siteChecksSupported', 'connState', ACCESS_STOPPED_KEY]);
    const granted = await chrome.permissions.contains({ origins: AUTOMATIC_SITE_ORIGINS });
    if (mine !== revision) return;
    const connected = saved.connState === 'connected' && !saved[ACCESS_STOPPED_KEY];
    const supported = saved.siteChecksSupported === true;
    const configured = saved[SITE_CHECKS_KEY] !== false;
    active = configured && granted && supported;
    const toggle = el<HTMLButtonElement>('site-checks-toggle');
    if (!toggle.disabled) toggle.textContent = active ? 'Turn off' : configured ? 'Allow website access' : 'Turn on';
    toggle.hidden = !connected || !supported;
    el('site-checks-state').textContent = !connected ? 'Connect your app to continue.'
      : !supported ? 'Unavailable with this server. Update it or check its settings.'
      : active ? 'On.'
      : configured ? 'On. Chrome permission needed.' : 'Off.';
    el('site-checks-manual').hidden = !connected || !configured || active;
    el('site-checks-scope').hidden = active || !supported;
    const requests: SiteWarningRequest[] = Array.isArray(saved[SITE_CHECKS_PENDING_KEY]) ? saved[SITE_CHECKS_PENDING_KEY] : [];
    renderList(el('site-warnings'), requests, (r) => r.origin, (r) => JSON.stringify(r.warnings), (request) => row(request.origin, [
      button('Allow', { type: 'site_warning_allow', origin: request.origin, reasons: request.warnings.map((w) => w.id) }),
      button('Block', { type: 'site_block', host: request.host, block: true }),
    ], request.warnings.map((w) => w.reason)));
    el('site-warnings-section').hidden = !active || !connected || !requests.length;
    const approvals = Object.keys(saved[SITE_CHECKS_APPROVALS_KEY] ?? {});
    renderList(el('site-exceptions'), approvals, (s) => s, (s) => s, (origin) => row(origin, [
      button('Remove', { type: 'site_warning_revoke', origin }),
    ]));
    el('site-exceptions-section').hidden = !active || !connected || !approvals.length;
    const blocked: string[] = Array.isArray(saved[SITE_CHECKS_BLOCKED_KEY]) ? saved[SITE_CHECKS_BLOCKED_KEY] : [];
    renderList(el('site-blocks'), blocked, (s) => s, (s) => s, (host) => row(host, [
      button('Restore', { type: 'site_block', host, block: false }),
    ]));
    el('site-blocks-section').hidden = !active || !connected || !blocked.length;
    el('site-block-controls').hidden = !active || !connected;
  }
  el('site-checks-toggle').addEventListener('click', (event) => {
    if (event.isTrusted) void busyButton(el<HTMLButtonElement>('site-checks-toggle'), () => send({ type: 'site_checks_mode', allow: !active }))
      .finally(() => void render());
  });
  el('site-checks-manual').addEventListener('click', (event) => {
    if (event.isTrusted) void busyButton(el<HTMLButtonElement>('site-checks-manual'), () => send({ type: 'site_checks_mode', allow: false }));
  });
  el('site-block-current').addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    void busyButton(el<HTMLButtonElement>('site-block-current'), async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.url && /^https?:\/\//.test(tab.url)) await send({ type: 'site_block', host: new URL(tab.url).hostname, block: true });
      else el('site-checks-error').textContent = 'Open a website or enter its address below.';
    });
  });
  el('site-block-add').addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    const host = el<HTMLInputElement>('site-block-host').value.trim();
    if (host) void busyButton(el<HTMLButtonElement>('site-block-add'), () => send({ type: 'site_block', host, block: true }));
  });
  chrome.storage.onChanged.addListener((_changes, area) => { if (area === 'local') void render(); });
  chrome.permissions.onAdded.addListener(() => void render());
  chrome.permissions.onRemoved.addListener(() => void render());
  void render();
}
