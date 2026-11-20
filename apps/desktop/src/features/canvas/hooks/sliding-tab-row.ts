export function startSlidingTabRow(row: HTMLElement, tabId: string, grabOffsetX: number) {
  const source = Array.from(row.querySelectorAll<HTMLElement>('[data-tab-id]')).find(
    (tab) => tab.dataset.tabId === tabId
  );
  const strip = source?.parentElement;
  if (!source || !strip) return null;

  const origin = strip.getBoundingClientRect().left - strip.scrollLeft;
  const slots = Array.from(strip.querySelectorAll<HTMLElement>('[data-tab-id]'), (tab) => {
    const { left, width } = tab.getBoundingClientRect();
    return { tab, left: left - origin, width };
  });
  const sourceIndex = slots.findIndex(({ tab }) => tab === source);
  const grabbed = slots[sourceIndex];
  const last = slots[slots.length - 1];
  strip.dataset.sliding = '';
  source.dataset.grabbed = '';

  return {
    move(clientX: number) {
      const x = clientX - strip.getBoundingClientRect().left + strip.scrollLeft;
      const left = Math.max(
        slots[0].left,
        Math.min(x - grabOffsetX, last.left + last.width - grabbed.width)
      );
      const right = left + grabbed.width;
      const boundary = slots.findIndex((slot, index) => {
        const midpoint = slot.left + slot.width / 2;
        if (index < sourceIndex) return left < midpoint;
        return index > sourceIndex && right <= midpoint;
      });
      const insertIndex = boundary === -1 ? slots.length : boundary;
      source.style.setProperty('--tab-slide-x', `${left - grabbed.left}px`);
      for (const [index, slot] of slots.entries()) {
        if (index === sourceIndex) continue;
        if (index > sourceIndex && index < insertIndex) {
          slot.tab.style.setProperty('--tab-slide-x', `${-grabbed.width}px`);
        } else if (index < sourceIndex && index >= insertIndex) {
          slot.tab.style.setProperty('--tab-slide-x', `${grabbed.width}px`);
        } else {
          slot.tab.style.removeProperty('--tab-slide-x');
        }
      }
      return insertIndex;
    },
    clear() {
      delete strip.dataset.sliding;
      delete source.dataset.grabbed;
      for (const { tab } of slots) tab.style.removeProperty('--tab-slide-x');
    },
  };
}
