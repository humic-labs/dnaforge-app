export interface BpInterval {
  start: number;
  end: number;
}

export function cullFeaturesToViewport<T extends BpInterval>(
  features: ReadonlyArray<T>,
  viewport: BpInterval
): T[] {
  if (viewport.end <= viewport.start) return [];
  const out: T[] = [];
  for (const f of features) {
    if (f.start < viewport.end && f.end > viewport.start) out.push(f);
  }
  return out;
}

export function featureLaneY(
  laneIndex: number,
  laneHeightPx: number,
  trackHeightPx: number
): number {
  if (laneHeightPx <= 0) return 0;
  const idealY = laneIndex * laneHeightPx;
  const maxY = Math.max(0, trackHeightPx - laneHeightPx);
  return Math.min(idealY, maxY);
}

export function featureRowHeight(
  rowY: number,
  laneHeightPx: number,
  trackHeightPx: number
): number {
  const headroom = trackHeightPx - rowY;
  return Math.max(0, Math.min(laneHeightPx - 1, headroom));
}
