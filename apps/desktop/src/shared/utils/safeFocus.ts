export function safeFocus(el: HTMLElement | null | undefined, options?: FocusOptions): boolean {
  if (el?.isConnected) {
    el.focus(options);
    return true;
  }
  return false;
}

export function safeScrollIntoView(
  el: Element | null | undefined,
  options?: ScrollIntoViewOptions | boolean
): boolean {
  if (el && 'isConnected' in el && el.isConnected && typeof el.scrollIntoView === 'function') {
    el.scrollIntoView(options);
    return true;
  }
  return false;
}

function findOverflowingScrollAncestor(el: Element): HTMLElement | null {
  let node = el.parentElement;
  while (node) {
    const overflowY = getComputedStyle(node).overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

export function scrollIntoNearestScrollContainer(
  el: Element | null | undefined,
  options: { block?: 'center' | 'nearest' } = {}
): boolean {
  if (!el || !el.isConnected) return false;
  const container = findOverflowingScrollAncestor(el);
  if (!container) return false;

  const elRect = el.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  const elTop = elRect.top - containerRect.top + container.scrollTop;
  const elBottom = elTop + elRect.height;
  const maxScrollTop = container.scrollHeight - container.clientHeight;

  let target: number;
  if (options.block === 'center') {
    target = elTop - (container.clientHeight - elRect.height) / 2;
  } else {
    const visibleTop = container.scrollTop;
    const visibleBottom = container.scrollTop + container.clientHeight;
    if (elTop >= visibleTop && elBottom <= visibleBottom) return true;
    target = elTop < visibleTop ? elTop : elBottom - container.clientHeight;
  }

  container.scrollTop = Math.max(0, Math.min(target, maxScrollTop));
  return true;
}
