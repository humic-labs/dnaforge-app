import { viewerCache, type CachedViewer } from '../viewerCache';
import { requestMolstarFrame } from './viewerFrameKicks';

const previewPosterByLoadedViewerCacheKey = new Map<string, string>();
const MAX_PREVIEW_POSTERS = 16;

export function setCachedViewerCanvasVisibility(
  container: HTMLDivElement,
  visibility: 'hidden' | 'visible'
): void {
  container.querySelectorAll('canvas').forEach((canvas) => {
    (canvas as HTMLCanvasElement).style.visibility = visibility;
  });
}

export function detachCachedViewerContainer(
  cached: { container?: HTMLDivElement } | undefined,
  wrapper: HTMLDivElement | null
): void {
  const container = cached?.container;
  if (!container || !wrapper) return;
  if (container.parentElement === wrapper) {
    wrapper.removeChild(container);
  }
}

export function clearViewerWrapper(wrapper: HTMLDivElement): void {
  while (wrapper.firstChild) {
    wrapper.removeChild(wrapper.firstChild);
  }
}

function isPreviewViewerCacheKey(viewerCacheKey: string): boolean {
  return viewerCacheKey.endsWith(':preview');
}

export function shouldKeepExistingViewerUntilReveal(
  prevCacheKey: string,
  nextCacheKey: string
): boolean {
  return (
    prevCacheKey !== nextCacheKey &&
    isPreviewViewerCacheKey(prevCacheKey) &&
    !isPreviewViewerCacheKey(nextCacheKey)
  );
}

function previewCompanionCacheKey(viewerCacheKey: string): string | null {
  if (!viewerCacheKey || isPreviewViewerCacheKey(viewerCacheKey)) return null;
  return `${viewerCacheKey}:preview`;
}

function loadedCompanionCacheKeyForPreview(previewViewerCacheKey: string): string | null {
  return isPreviewViewerCacheKey(previewViewerCacheKey)
    ? previewViewerCacheKey.slice(0, -':preview'.length)
    : null;
}

export function previewCompanionCacheEntry(
  viewerCacheKey: string,
  viewerInstanceId: string
): [string, CachedViewer] | undefined {
  const directPreviewKey = previewCompanionCacheKey(viewerCacheKey);
  const directPreview = directPreviewKey ? viewerCache.get(directPreviewKey) : undefined;
  if (directPreview && directPreviewKey) return [directPreviewKey, directPreview];

  const instancePreviewSuffix = `::instance:${viewerInstanceId}:preview`;
  for (const [key, cached] of viewerCache.entries()) {
    if (key.endsWith(instancePreviewSuffix)) return [key, cached];
  }
  return undefined;
}

function rememberPreviewPosterForLoadedViewer(loadedViewerCacheKey: string, posterDataUrl: string) {
  previewPosterByLoadedViewerCacheKey.delete(loadedViewerCacheKey);
  previewPosterByLoadedViewerCacheKey.set(loadedViewerCacheKey, posterDataUrl);
  while (previewPosterByLoadedViewerCacheKey.size > MAX_PREVIEW_POSTERS) {
    const oldestKey = previewPosterByLoadedViewerCacheKey.keys().next().value;
    if (!oldestKey) break;
    previewPosterByLoadedViewerCacheKey.delete(oldestKey);
  }
}

export function getPreviewPosterForLoadedViewer(loadedViewerCacheKey: string): string | undefined {
  return previewPosterByLoadedViewerCacheKey.get(loadedViewerCacheKey);
}

function canvasHasPaintedContent(canvas: HTMLCanvasElement): boolean {
  const width = canvas.width || canvas.offsetWidth;
  const height = canvas.height || canvas.offsetHeight;
  if (width < 40 || height < 40) return false;

  const probe = document.createElement('canvas');
  probe.width = 32;
  probe.height = 32;
  const ctx = probe.getContext('2d', { willReadFrequently: true });
  if (!ctx) return false;

  try {
    ctx.drawImage(canvas, 0, 0, probe.width, probe.height);
    const data = ctx.getImageData(0, 0, probe.width, probe.height).data;
    const unique = new Set<string>();
    let nonWhitePixels = 0;
    for (let offset = 0; offset < data.length; offset += 16) {
      const r = data[offset] ?? 255;
      const g = data[offset + 1] ?? 255;
      const b = data[offset + 2] ?? 255;
      const a = data[offset + 3] ?? 255;
      unique.add(`${r},${g},${b},${a}`);
      if (a > 0 && (r < 245 || g < 245 || b < 245)) nonWhitePixels += 1;
    }
    return nonWhitePixels >= 3 && unique.size >= 2;
  } catch {
    return false;
  }
}

export function captureViewerPosterDataUrl(container: HTMLDivElement): string | null {
  const canvas = container.querySelector('canvas') as HTMLCanvasElement | null;
  if (!canvas || !canvasHasPaintedContent(canvas)) return null;
  try {
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

export function schedulePreviewPosterCapture(viewerCacheKey: string, cached: CachedViewer): void {
  const loadedViewerCacheKey = loadedCompanionCacheKeyForPreview(viewerCacheKey);
  if (!loadedViewerCacheKey || !cached.plugin || cached.isLoading || cached.error) return;
  if (!cached.container.querySelector('canvas')) return;

  let attempts = 0;
  const capture = () => {
    if (!cached.container.isConnected && attempts > 0) return;
    requestMolstarFrame(cached.plugin);
    const poster = captureViewerPosterDataUrl(cached.container);
    if (poster) {
      rememberPreviewPosterForLoadedViewer(loadedViewerCacheKey, poster);
      return;
    }
    attempts += 1;
    if (attempts < 8) setTimeout(capture, 100);
  };

  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => requestAnimationFrame(capture));
  } else {
    setTimeout(capture, 32);
  }
}

function removeHandoffPosters(wrapper: HTMLDivElement): void {
  wrapper.querySelectorAll('[data-testid="molstar-viewer-handoff-poster"]').forEach((node) => {
    node.remove();
  });
}

export function hasHandoffPoster(wrapper: HTMLDivElement): boolean {
  return !!wrapper.querySelector('[data-testid="molstar-viewer-handoff-poster"]');
}

export function attachHandoffPoster(wrapper: HTMLDivElement, posterDataUrl: string | null): void {
  removeHandoffPosters(wrapper);
  void posterDataUrl;
}

export function releaseHandoffPosterAfterLoadedPaint(
  wrapper: HTMLDivElement,
  container: HTMLDivElement
): void {
  const releaseNotBefore = Date.now() + 2000;
  let paintedStreak = 0;

  const tick = () => {
    if (!wrapper.isConnected || container.parentElement !== wrapper) return;
    if (!hasHandoffPoster(wrapper)) return;

    const canvas = container.querySelector('canvas') as HTMLCanvasElement | null;
    if (canvas && canvasHasPaintedContent(canvas)) {
      paintedStreak += 1;
    } else {
      paintedStreak = 0;
    }

    if (paintedStreak >= 3 && Date.now() >= releaseNotBefore) {
      removeHandoffPosters(wrapper);
      return;
    }

    setTimeout(tick, 100);
  };

  setTimeout(tick, 100);
}

function raiseHandoffPoster(wrapper: HTMLDivElement): void {
  const poster = wrapper.querySelector('[data-testid="molstar-viewer-handoff-poster"]');
  if (poster) wrapper.appendChild(poster);
}

function stageViewerContainerUntilReveal(container: HTMLDivElement): void {
  container.dataset.viewerTransitionStage = 'staged';
  container.style.position = 'absolute';
  container.style.inset = '0';
  container.style.opacity = '0';
  container.style.pointerEvents = 'none';
  container.style.zIndex = '1';
}

export function revealViewerContainer(
  wrapper: HTMLDivElement,
  container: HTMLDivElement,
  options: { preserveHandoffPoster?: boolean } = {}
): void {
  if (container.parentElement !== wrapper) {
    wrapper.appendChild(container);
  }
  Array.from(wrapper.children).forEach((child) => {
    if (child === container) return;
    if (
      options.preserveHandoffPoster &&
      child instanceof HTMLElement &&
      child.dataset.testid === 'molstar-viewer-handoff-poster'
    ) {
      return;
    }
    child.remove();
  });
  delete container.dataset.viewerTransitionStage;
  container.style.position = 'relative';
  container.style.inset = '';
  container.style.opacity = '';
  container.style.pointerEvents = '';
  container.style.zIndex = '';
  if (options.preserveHandoffPoster) raiseHandoffPoster(wrapper);
}

export function attachViewerContainer(
  wrapper: HTMLDivElement,
  container: HTMLDivElement,
  options: { keepExistingUntilReveal: boolean }
): void {
  if (options.keepExistingUntilReveal) {
    stageViewerContainerUntilReveal(container);
    if (container.parentElement !== wrapper) wrapper.appendChild(container);
    raiseHandoffPoster(wrapper);
    return;
  }
  revealViewerContainer(wrapper, container);
}

export function attachLoadingViewerContainer(
  wrapper: HTMLDivElement | null,
  cached: CachedViewer,
  options: { keepExistingUntilReveal: boolean }
): void {
  if (!wrapper) return;
  if (cached.container.parentElement === wrapper) return;
  attachViewerContainer(wrapper, cached.container, options);
}
