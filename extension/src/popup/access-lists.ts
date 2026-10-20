/** Show two app connections or three sites without clipping wrapped names/statuses. */
for (const list of Array.from(document.querySelectorAll<HTMLElement>('.access-list'))) {
  const visibleCount = list.id === 'client-connections' ? 2 : 3;
  let frame = 0;

  function measure(): void {
    frame = 0;
    const items = Array.from(list.children);
    if (items.length <= visibleCount) {
      delete list.dataset.overflow;
      list.style.removeProperty('--list-height');
      list.removeAttribute('tabindex');
      return;
    }

    list.dataset.overflow = 'true';
    list.tabIndex = 0;
    // Relative row positions work even while the user has scrolled the list.
    // Measure after adding the scrollbar gutter so wrapped text fits completely.
    const height = items[visibleCount - 1].getBoundingClientRect().bottom - items[0].getBoundingClientRect().top;
    if (height > 0) list.style.setProperty('--list-height', `${height}px`);
  }

  function schedule(): void {
    if (!frame) frame = requestAnimationFrame(measure);
  }

  const sizes = new ResizeObserver(schedule);
  function observeEntries(): void {
    sizes.disconnect();
    for (const item of Array.from(list.children).slice(0, visibleCount)) sizes.observe(item);
    schedule();
  }

  new MutationObserver(observeEntries).observe(list, { childList: true });
  observeEntries();
}
