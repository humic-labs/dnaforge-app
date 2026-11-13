export function sequenceViewer1DIsCircular(
  isGapped: boolean,
  circular: boolean | undefined
): boolean {
  return isGapped ? false : (circular ?? false);
}

export function sequenceViewer1DHasCutSites(
  showCutSites: boolean | undefined,
  cutSiteCount: number | undefined,
  scannedCount: number | undefined
): boolean {
  return !!showCutSites && ((cutSiteCount ?? 0) > 0 || (scannedCount ?? 0) > 0);
}

export function sequenceViewer1DGappedSequenceForLayout<T>(
  isGapped: boolean,
  gappedSequence: T | null | undefined
): T | undefined {
  return isGapped && gappedSequence ? gappedSequence : undefined;
}

export function sequenceViewer1DHasMutationTrack(
  mutationCount: number | undefined,
  alignedQuery: unknown
): boolean {
  return (mutationCount ?? 0) > 0 || !!alignedQuery;
}

export function sequenceViewer1DCanvasBackground(transparentBackground: boolean): string {
  return transparentBackground ? 'transparent' : 'hsl(var(--color-bg))';
}

export function sequenceViewer1DBoolAttr(value: boolean): 'true' | 'false' {
  return value ? 'true' : 'false';
}

export function sequenceViewer1DCursor(
  pointerInteractionsEnabled: boolean,
  passiveCursor: string
): string {
  return pointerInteractionsEnabled ? 'text' : passiveCursor;
}

export function sequenceViewer1DContentWidth(
  isCircular: boolean,
  columnCount: number,
  pxPerBase: number
): number | undefined {
  return isCircular ? columnCount * pxPerBase : undefined;
}

export function sequenceViewer1DExtraLaneHeight(
  extraLanes: ReadonlyArray<{ height: number }> | undefined
): number {
  return extraLanes && extraLanes.length > 0
    ? extraLanes.reduce((sum, lane) => sum + Math.max(0, lane.height), 0)
    : 0;
}

export function sequenceViewer1DPrimerDirectionLabel(
  direction: 'forward' | 'reverse' | string
): string {
  return direction === 'forward' ? '→ Forward' : '← Reverse';
}

export function sequenceViewer1DOptionalCount(value: number | undefined): number | '' {
  return value ?? '';
}

export function sequenceViewer1DShouldTrackScroll(
  showScrollbar: boolean,
  onViewportChange: unknown
): boolean {
  return showScrollbar || Boolean(onViewportChange);
}
