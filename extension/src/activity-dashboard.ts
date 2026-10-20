import { ACCESS_STOPPED_KEY, ACTIVITY_KEY, activityLabel, activityRows, type ActivityEntry } from '../../shared/activity';
import { renderList } from './ui-controls';

const stop = document.getElementById('access-stop') as HTMLButtonElement;
const resume = document.getElementById('access-resume') as HTMLButtonElement;
const accessNote = document.getElementById('access-note')!;
const historyNote = document.getElementById('activity-note')!;
const list = document.getElementById('activity-list')!;
const filter = document.getElementById('activity-filter') as HTMLSelectElement | null;
const popup = document.body.dataset.view === 'popup';
let accessGeneration = 0;
let historyGeneration = 0;

async function renderAccess(): Promise<void> {
  const generation = ++accessGeneration;
  try {
    const saved = await chrome.storage.local.get(ACCESS_STOPPED_KEY);
    if (generation !== accessGeneration) return;
    const stopped = saved[ACCESS_STOPPED_KEY] !== undefined && saved[ACCESS_STOPPED_KEY] !== false;
    stop.hidden = stopped && accessNote.dataset.error !== 'true';
    resume.hidden = !stopped;
    document.getElementById('connect')!.hidden = stopped;
    if (accessNote.dataset.error !== 'true') accessNote.textContent = stopped
      ? 'All apps are disconnected. Resume, then approve your app again.'
      : 'Stop disconnects all apps. An action already running may finish.';
  } catch {
    accessNote.textContent = 'Could not read access settings. Reopen this page to try again.';
  }
}

const OUTCOMES: Record<ActivityEntry['outcome'], string> = {
  running: 'Running', done: 'Done', blocked: 'Blocked', failed: 'Failed', interrupted: 'Interrupted',
};

async function renderHistory(): Promise<void> {
  const generation = ++historyGeneration;
  try {
    const saved = await chrome.storage.session.get([ACTIVITY_KEY, 'activityError']);
    if (generation !== historyGeneration) return;
    const entries = (Array.isArray(saved[ACTIVITY_KEY]) ? saved[ACTIVITY_KEY] : []) as ActivityEntry[];
    const selected = filter?.value ?? 'all';
    const visible = activityRows(entries).filter((e) => selected === 'all' || e.outcome === selected).reverse().slice(0, popup ? 5 : 100);
    renderList(list, visible, (entry) => entry.opened?.id ?? entry.id, (entry) => JSON.stringify(entry), (entry) => {
      const item = document.createElement('li');
      item.className = 'activity-item';
      item.dataset.outcome = entry.outcome;
      const details = document.createElement('details');
      const heading = document.createElement('summary');
      heading.className = 'activity-row';
      const host = document.createElement('span');
      host.className = 'activity-host';
      host.textContent = entry.host || (entry.method === 'tabs_list' ? 'All tabs' : entry.method === 'proxy_status' ? 'Proxy' : 'No website');
      host.title = host.textContent;
      const label = document.createElement('span');
      label.className = 'activity-label';
      const completedTab = entry.outcome === 'done' && (entry.method === 'tab_new' || entry.method === 'tab_close');
      label.textContent = entry.opened ? 'Opened → Closed' : completedTab
        ? (entry.method === 'tab_new' ? 'Opened' : 'Closed') : activityLabel(entry.method);
      const outcome = document.createElement('span');
      outcome.className = 'activity-outcome';
      outcome.textContent = OUTCOMES[entry.outcome] ?? 'Unknown';
      outcome.hidden = completedTab;
      heading.append(host, label, outcome);
      const meta = document.createElement('div');
      meta.className = 'activity-meta';
      const app = document.createElement('span');
      app.textContent = entry.key ? `${entry.app} · ${entry.key.slice(0, 12)}` : 'Unverified app';
      const time = document.createElement('time');
      time.dateTime = new Date(entry.at).toISOString();
      time.textContent = new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      time.title = new Date(entry.at).toLocaleString();
      meta.append(app, time);
      if (entry.opened) {
        const opened = document.createElement('span');
        opened.className = 'activity-opened';
        opened.textContent = `Opened ${new Date(entry.opened.at).toLocaleString()} · Closed ${new Date(entry.at).toLocaleString()}`;
        meta.append(opened);
      }
      details.append(heading, meta);
      item.append(details);
      return item;
    });
    historyNote.textContent = saved.activityError
      ? 'Some activity could not be saved. This history may be incomplete.'
      : visible.length ? (popup ? `Latest ${visible.length} ${visible.length === 1 ? 'activity' : 'activities'}.` : `${visible.length} activities shown.`)
      : selected === 'all' ? 'No activity yet.' : 'No matching requests.';
    (document.getElementById('activity-clear') as HTMLButtonElement).disabled = entries.length === 0 && !saved.activityError;
  } catch {
    historyNote.textContent = 'Activity is unavailable. Reopen this page to try again.';
  }
}

function control(id: string, type: string, note: HTMLElement): void {
  const button = document.getElementById(id) as HTMLButtonElement;
  button.addEventListener('click', async (event) => {
    if (!event.isTrusted) return;
    button.disabled = true;
    try {
      const result = await chrome.runtime.sendMessage({ type });
      note.dataset.error = String(!result?.ok);
      note.textContent = result?.ok ? '' : (result?.error ?? 'Could not save this change. Please try again.');
    } catch {
      note.dataset.error = 'true';
      note.textContent = 'Could not reach the extension. Reopen this page and try again.';
    } finally {
      button.disabled = false;
    }
    if (type !== 'activity_clear') await renderAccess();
    else if (note.dataset.error !== 'true') await renderHistory();
  });
}

control('access-stop', 'access_stop', accessNote);
control('access-resume', 'access_resume', accessNote);
control('activity-clear', 'activity_clear', historyNote);
document.getElementById('activity-all')?.addEventListener('click', () => void chrome.runtime.openOptionsPage());
filter?.addEventListener('change', () => void renderHistory());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[ACCESS_STOPPED_KEY]) void renderAccess();
  if (area === 'session' && (changes[ACTIVITY_KEY] || changes.activityError)) void renderHistory();
});
void renderAccess();
void renderHistory();
