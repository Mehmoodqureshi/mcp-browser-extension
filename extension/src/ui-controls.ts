interface CachedRow { signature: string; element: HTMLElement }
const lists = new WeakMap<HTMLElement, Map<string, CachedRow>>();
const pending = new Map<HTMLElement, () => void>();
let pressing = false;
let pressGeneration = 0;

// New rows can move a button between pointer-down and click. Apply list changes
// after the click has dispatched, while permission actions still run immediately.
document.addEventListener('pointerdown', () => { pressing = true; pressGeneration++; }, true);
function release(): void {
  const generation = pressGeneration;
  setTimeout(() => {
    if (generation !== pressGeneration) return;
    pressing = false;
    const updates = [...pending.values()];
    pending.clear();
    for (const update of updates) update();
  }, 0);
}
window.addEventListener('pointerup', release, true);
window.addEventListener('pointercancel', release, true);
window.addEventListener('blur', release);

/** Keep unchanged controls mounted through live updates, including during a click. */
export function renderList<T>(
  list: HTMLElement, items: T[], key: (item: T) => string,
  signature: (item: T) => string, create: (item: T) => HTMLElement,
): void {
  if (pressing) { pending.set(list, () => renderList(list, items, key, signature, create)); return; }
  pending.delete(list);
  const previous = lists.get(list) ?? new Map<string, CachedRow>();
  const next = new Map<string, CachedRow>();
  const scrollTop = list.scrollTop;
  let cursor = list.firstElementChild;
  for (const item of items) {
    const id = key(item), version = signature(item), old = previous.get(id);
    const element = old?.signature === version ? old.element : create(item);
    // Updating an activity's result must not collapse its expanded details.
    if (old && element !== old.element) {
      const details = element.querySelector('details');
      if (details) details.open = old.element.querySelector('details')?.open ?? false;
      if (old.element.parentElement === list) {
        if (cursor === old.element) cursor = element;
        old.element.replaceWith(element);
      }
    }
    if (element === cursor) cursor = cursor.nextElementSibling;
    else list.insertBefore(element, cursor);
    next.set(id, { signature: version, element });
  }
  const keep = new Set([...next.values()].map((row) => row.element));
  for (const child of Array.from(list.children)) if (!keep.has(child as HTMLElement)) child.remove();
  list.scrollTop = scrollTop;
  lists.set(list, next);
}

/** Starts the operation synchronously so Chrome retains the trusted click gesture. */
export async function busyButton(button: HTMLButtonElement, operation: () => unknown | Promise<unknown>): Promise<void> {
  if (button.disabled) return;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try { await operation(); }
  finally { button.disabled = false; button.removeAttribute('aria-busy'); }
}
