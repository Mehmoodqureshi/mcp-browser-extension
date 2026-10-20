import { FEATURE_REQUESTS_KEY, OPTIONAL_FEATURES, type OptionalFeature } from '../../shared/browser-permissions';
import { busyButton, renderList } from './ui-controls';

const section = document.getElementById('extra-permissions');
const list = document.getElementById('extra-permissions-list');
const note = document.getElementById('extra-permissions-note');
let rendering = 0;

async function render(): Promise<void> {
  if (!section || !list || !note) return;
  const generation = ++rendering;
  const saved = (await chrome.storage.local.get(FEATURE_REQUESTS_KEY))[FEATURE_REQUESTS_KEY];
  const pending = Array.isArray(saved) ? saved : [];
  const features: Array<{ feature: OptionalFeature; granted: boolean }> = [];
  for (const feature of Object.keys(OPTIONAL_FEATURES) as OptionalFeature[]) {
    const granted = await chrome.permissions.contains({ permissions: [feature] }).catch(() => false);
    if (!granted && !pending.includes(feature)) continue;
    features.push({ feature, granted });
  }
  if (generation !== rendering) return;
  renderList(list, features, ({ feature }) => feature, ({ granted }) => String(granted), ({ feature, granted }) => {
    const { label, explanation } = OPTIONAL_FEATURES[feature];
    const row = document.createElement('li');
    row.className = 'client-row';
    row.dataset.feature = feature;
    const title = document.createElement('strong');
    title.textContent = label;
    const description = document.createElement('p');
    description.className = 'note hint';
    description.textContent = explanation;
    const button = document.createElement('button');
    button.className = granted ? 'ghost' : 'primary';
    button.textContent = granted ? `Remove ${label.toLowerCase()}` : `Allow ${label.toLowerCase()}`;
    button.addEventListener('click', async (event) => {
      if (!event.isTrusted) return;
      try {
        await busyButton(button, async () => {
          const result = await chrome.runtime.sendMessage({ type: 'feature_access', feature, allow: !granted });
          note.textContent = result?.ok ? '' : (result?.error ?? 'Could not change this permission. Please try again.');
        });
      } catch { note.textContent = 'Could not change this permission. Please try again.'; }
      await render();
    });
    row.append(title, description, button);
    return row;
  });
  section.hidden = features.length === 0;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[FEATURE_REQUESTS_KEY]) void render();
});
chrome.permissions.onAdded.addListener(() => void render());
chrome.permissions.onRemoved.addListener(() => void render());
void render();
