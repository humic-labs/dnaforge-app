export type PaneResizeScrollSample = {
  scrollTop: number;
  topBp: number | null;
};

export type PaneResizeScrollFreezeAnchor = {
  scrollTop: number;
  topBp: number | null;
  height: number;
};

export function capturePaneResizeScrollFreezeAnchor(input: {
  scrollTop: number;
  clientHeight: number;
  topBp: number | null;
}): PaneResizeScrollFreezeAnchor {
  return {
    scrollTop: input.scrollTop,
    topBp: input.topBp,
    height: Math.max(0, Math.round(input.clientHeight)),
  };
}

export function maxScrollTopDeltaDuringPaneResizeDrag(
  samples: ReadonlyArray<Pick<PaneResizeScrollSample, 'scrollTop'>>
): number {
  if (samples.length === 0) return 0;
  let min = samples[0]!.scrollTop;
  let max = samples[0]!.scrollTop;
  for (const sample of samples) {
    if (sample.scrollTop < min) min = sample.scrollTop;
    if (sample.scrollTop > max) max = sample.scrollTop;
  }
  return max - min;
}

export function maxFrameScrollTopDeltaDuringPaneResizeDrag(
  samples: ReadonlyArray<Pick<PaneResizeScrollSample, 'scrollTop'>>
): number {
  let maxDelta = 0;
  for (let i = 1; i < samples.length; i++) {
    const delta = Math.abs(samples[i]!.scrollTop - samples[i - 1]!.scrollTop);
    if (delta > maxDelta) maxDelta = delta;
  }
  return maxDelta;
}

export function resolvePaneResizeScrollRestore(input: {
  anchor: PaneResizeScrollFreezeAnchor;
  scrollYForTopBp: number | null | undefined;
  layoutGeometryChanged?: boolean;
}): number {
  if (input.layoutGeometryChanged) {
    const restored = input.scrollYForTopBp;
    if (typeof restored === 'number' && Number.isFinite(restored)) {
      return restored;
    }
  }
  return input.anchor.scrollTop;
}

export function resolveCircularBufferHeightHighWater(input: {
  liveHeight: number;
  highWater: number;
}): number {
  return Math.max(0, Math.round(input.liveHeight), Math.round(input.highWater));
}

export function resolveSequencePaneViewportHeight(input: { sequencePaneHeight: number }): number {
  return Math.max(0, Math.round(input.sequencePaneHeight));
}

export function isInflatedSequenceColumnSpanMeasure(input: {
  sequencePaneHeight: number;
  columnBottomMinusSequenceTop: number;
  epsilon?: number;
}): boolean {
  const epsilon = input.epsilon ?? 2;
  return input.columnBottomMinusSequenceTop > input.sequencePaneHeight + epsilon;
}

export type SequenceMapPlacementForScrollFreeze = 'top' | 'bottom' | 'left' | 'right';

export function canvas2dPositionForMapPlacement(
  mapPlacement: SequenceMapPlacementForScrollFreeze
): SequenceMapPlacementForScrollFreeze {
  if (mapPlacement === 'bottom') return 'top';
  if (mapPlacement === 'top') return 'bottom';
  if (mapPlacement === 'right') return 'left';
  return 'right';
}
