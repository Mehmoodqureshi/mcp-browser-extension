import { CLIENT_STORAGE_KEY, type ClientConnection } from '../../shared/client-auth';
import { ACCESS_STOPPED_KEY } from '../../shared/activity';
import { renderList } from './ui-controls';

const list = document.getElementById('client-connections') as HTMLUListElement;
const note = document.getElementById('client-note') as HTMLParagraphElement;
const count = document.getElementById('client-count');

function appName(reported: string): string {
  // The name is supplied by the app, not a verified product identity.
  const name = reported.replace(/\s+v?\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/, '');
  return name === 'codex-mcp-client' ? 'Codex' : name;
}

function accessStatus(client: ClientConnection, now: number): string {
  if (client.state === 'revoked') return 'Access removed';
  if (client.expiresAt <= now) return 'Access expired';
  if (client.state === 'pending') return 'Waiting for your approval';
  const minutes = Math.ceil((client.expiresAt - now) / 60_000);
  const hours = Math.floor(minutes / 60);
  const remaining = hours > 0 ? `${hours} ${hours === 1 ? 'hour' : 'hours'}`
    : `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  return `Access allowed · ${remaining} left`;
}

function action(label: string, id: string, allow: boolean): HTMLButtonElement {
  const button = document.createElement('button');
  button.textContent = label;
  button.addEventListener('click', async (event) => {
    // A script-generated DOM click must never approve a connection.
    if (!event.isTrusted) return;
    button.disabled = true;
    try {
      const result = await chrome.runtime.sendMessage({ type: 'client_decision', id, allow });
      note.textContent = result?.ok ? '' : (result?.error ?? 'Could not save the decision.');
      note.dataset.error = String(!result?.ok);
    } catch {
      note.textContent = 'Could not reach the extension. Reopen this page and try again.';
      note.dataset.error = 'true';
    }
    finally { button.disabled = false; }
    await render();
  });
  return button;
}

let renderGeneration = 0;
async function render(): Promise<void> {
  const generation = ++renderGeneration;
  const state = await chrome.storage.local.get([CLIENT_STORAGE_KEY, ACCESS_STOPPED_KEY]);
  if (generation !== renderGeneration) return;
  const saved = state[CLIENT_STORAGE_KEY];
  const stopped = state[ACCESS_STOPPED_KEY] !== undefined && state[ACCESS_STOPPED_KEY] !== false;
  const clients: ClientConnection[] = Array.isArray(saved) ? saved : [];
  const now = Date.now();
  const pending = (client: ClientConnection): boolean => client.state === 'pending' && client.expiresAt > now;
  const waiting = clients.filter(pending).length;
  for (const id of ['client-help', 'client-limits']) {
    const hint = document.getElementById(id);
    if (hint) hint.hidden = clients.length === 0 ||
      (id === 'client-help' && document.body.dataset.view === 'popup' && waiting === 0);
  }
  if (count) {
    count.textContent = waiting ? `${waiting} waiting` : `${clients.length} ${clients.length === 1 ? 'connection' : 'connections'}`;
    count.dataset.pending = String(waiting > 0);
  }
  const sorted = clients.slice().sort((a, b) =>
    Number(pending(b)) - Number(pending(a)) || b.requestedAt - a.requestedAt
  );
  renderList(list, sorted, (client) => client.id,
    (client) => JSON.stringify([client.name, client.state, client.expiresAt, client.expiresAt <= now, stopped]), (client) => {
    const li = document.createElement('li');
    li.dataset.clientId = client.id;
    const name = document.createElement('strong');
    name.textContent = appName(client.name);
    const key = document.createElement('code');
    key.textContent = `Key ${client.id.slice(0, 12)}`;
    key.title = client.id;
    const status = document.createElement('span');
    status.className = 'client-status';
    const expired = client.expiresAt <= now;
    li.dataset.state = client.state === 'revoked' ? 'revoked' : expired ? 'expired' : client.state;
    status.textContent = accessStatus(client, Date.now());
    const info = document.createElement('div');
    info.className = 'client-info';
    info.append(name, status);
    // Keep the key in view whenever the person can grant access.
    const needsApproval = client.state === 'revoked' || (client.state === 'pending' && !expired);
    if (needsApproval) info.append(key);
    const details = document.createElement('details');
    details.className = 'client-details';
    const summary = document.createElement('summary');
    summary.textContent = 'Details';
    details.append(summary);
    for (const [field, text] of [
      ['app', `Reported app: ${client.name}`],
      ['requested', `Requested: ${new Date(client.requestedAt).toLocaleString()}`],
      ...(client.state === 'approved' ? [['expires', `Access ends: ${new Date(client.expiresAt).toLocaleString()}`]] : []),
    ]) {
      const line = document.createElement('p');
      line.className = `client-${field}`;
      line.textContent = text;
      details.append(line);
    }
    if (!needsApproval) details.append(key);
    const controls = document.createElement('div');
    controls.className = 'client-actions';
    if (client.state === 'revoked') controls.append(action('Approve again for 8 hours', client.id, true));
    else if (client.state === 'pending' && !expired) {
      const approve = action('Approve for 8 hours', client.id, true);
      approve.className = 'primary';
      controls.append(approve, action('Deny', client.id, false));
    } else if (client.state === 'approved' && !expired) controls.append(action('Remove access', client.id, false));
    if (stopped) controls.querySelectorAll('button').forEach((button) => { button.disabled = true; });
    li.append(info, controls, details);
    return li;
  });
  // Refresh the countdown without replacing a focused or pressed control.
  const byId = new Map(clients.map((client) => [client.id, client]));
  for (const row of Array.from(list.querySelectorAll<HTMLElement>('[data-client-id]'))) {
    const client = byId.get(row.dataset.clientId!);
    const status = row.querySelector('.client-status');
    if (client && status) {
      const label = accessStatus(client, now);
      if (status.textContent !== label) status.textContent = label;
      const requested = row.querySelector('.client-requested');
      const requestTime = `Requested: ${new Date(client.requestedAt).toLocaleString()}`;
      if (requested && requested.textContent !== requestTime) requested.textContent = requestTime;
    }
  }
  if (clients.length && note.textContent?.startsWith('No requests yet.')) note.textContent = '';
  if (!clients.length) note.textContent = 'No requests yet. Ask your app to use Chrome. Its request will appear here.';
  if (stopped) note.textContent = 'Resume connection above to approve apps.';
  else if (note.textContent === 'Resume connection above to approve apps.') note.textContent = '';
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes[CLIENT_STORAGE_KEY] || changes[ACCESS_STOPPED_KEY])) void render();
});
void render();
setInterval(() => void render(), 30_000);
