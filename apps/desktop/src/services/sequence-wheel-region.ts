import type { SequenceWheelZoomRegion } from '../shared/sequence-wheel-ownership';

const selector = '[data-sequence-wheel-zoom-viewport]';

export function installSequenceWheelRegionPublisher(
  publish: (regions: SequenceWheelZoomRegion[]) => void
): () => void {
  let viewports: HTMLElement[] = [];
  const send = () => {
    publish(
      viewports.flatMap((viewport) => {
        if (!viewport.isConnected) return [];
        for (let owner: HTMLElement | null = viewport; owner; owner = owner.parentElement) {
          if (owner.hasAttribute('inert') || owner.hidden) return [];
          const style = getComputedStyle(owner);
          if (
            style.display === 'none' ||
            style.visibility === 'hidden' ||
            style.visibility === 'collapse'
          )
            return [];
        }
        const { x, y, width, height } = viewport.getBoundingClientRect();
        return width > 0 && height > 0 ? [{ x, y, width, height }] : [];
      })
    );
  };
  const resize = new ResizeObserver(send);
  const reconcile = () => {
    resize.disconnect();
    viewports = Array.from(document.querySelectorAll<HTMLElement>(selector));
    for (const viewport of viewports) resize.observe(viewport);
    send();
  };
  const containsViewport = (node: Node) =>
    node instanceof Element && (node.matches(selector) || node.querySelector(selector) !== null);
  const mutations = new MutationObserver((records) => {
    if (
      records.some((record) =>
        record.type === 'attributes'
          ? record.attributeName === 'data-sequence-wheel-zoom-viewport' ||
            viewports.some((viewport) => record.target.contains(viewport))
          : [...record.addedNodes, ...record.removedNodes].some(containsViewport)
      )
    )
      reconcile();
  });
  mutations.observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-sequence-wheel-zoom-viewport', 'class', 'style', 'hidden', 'inert'],
  });
  const onScroll = (event: Event) => {
    if (!viewports.includes(event.target as HTMLElement)) send();
  };
  window.addEventListener('resize', send, { passive: true });
  window.addEventListener('scroll', onScroll, { capture: true, passive: true });
  reconcile();
  return () => {
    mutations.disconnect();
    resize.disconnect();
    window.removeEventListener('resize', send);
    window.removeEventListener('scroll', onScroll, { capture: true });
    publish([]);
  };
}
