export function findScrollParent(el: HTMLElement | null): Element | null {
  let node: HTMLElement | null = el?.parentElement ?? null;
  while (node) {
    const { overflowY, overflow } = getComputedStyle(node);
    const oy = overflowY || overflow;
    if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}
