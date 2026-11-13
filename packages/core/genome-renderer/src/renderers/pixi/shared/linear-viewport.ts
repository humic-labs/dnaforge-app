export const LINEAR_EDGE_OVERSCROLL_VIEWPORT_FRACTION = 0.5;

function safeZoom(zoom: number): number {
  return Math.max(0.0001, zoom);
}

export function linearEdgeOverscrollOffset(zoom: number): number {
  return LINEAR_EDGE_OVERSCROLL_VIEWPORT_FRACTION / safeZoom(zoom);
}

export function linearMaxViewOffset(zoom: number): number {
  return Math.max(0, 1 - 1 / safeZoom(zoom));
}

export function clampLinearViewOffset(viewOffset: number, zoom: number): number {
  const overscroll = linearEdgeOverscrollOffset(zoom);
  return Math.max(-overscroll, Math.min(linearMaxViewOffset(zoom) + overscroll, viewOffset));
}

export function linearGenomeXOffset(viewportWidth: number, zoom: number): number {
  const genomePixelWidth = viewportWidth * safeZoom(zoom);
  return genomePixelWidth < viewportWidth ? (viewportWidth - genomePixelWidth) / 2 : 0;
}
