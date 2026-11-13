import type { RenderState } from '@waypoint/genome-renderer';

const STABILITY_FRAME_INTERVAL_MS = 100;
const SLOW_FRAME_THRESHOLD_MS = 80;
const SLOW_FRAME_COOLDOWN_FACTOR = 0.75;
const MAX_SLOW_FRAME_COOLDOWN_MS = 250;

function finiteKey(value: number | null | undefined, precision = 1000): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'n';
  return String(Math.round(value * precision) / precision);
}

function cameraOffsetKey(state: RenderState): string {
  const zoom =
    typeof state.zoom === 'number' && Number.isFinite(state.zoom)
      ? Math.max(1, Math.abs(state.zoom))
      : 1;
  return finiteKey(state.viewOffset * zoom, 1_000_000);
}

function rangeKey(range: [number, number] | null | undefined): string {
  if (!range) return '';
  return `${finiteKey(range[0])}:${finiteKey(range[1])}`;
}

function rangesKey(ranges: ReadonlyArray<readonly [number, number]> | null | undefined): string {
  if (!ranges?.length) return '';
  return ranges.map((range) => `${finiteKey(range[0])}:${finiteKey(range[1])}`).join(',');
}

function selectedIdsKey(selectedIds: Set<number>): string {
  if (selectedIds.size === 0) return '';
  return Array.from(selectedIds)
    .sort((a, b) => a - b)
    .join(',');
}

function codonKey(codon: RenderState['hoveredCodon']): string {
  if (!codon) return '';
  return `${codon.start}:${codon.end}:${codon.strand}`;
}

function codonsKey(codons: RenderState['selectedCodons']): string {
  if (!codons?.length) return '';
  return codons.map((codon) => `${codon.start}:${codon.end}:${codon.strand}`).join(',');
}

function orfKey(orf: RenderState['hoveredOrf'] | RenderState['selectedOrf']): string {
  if (!orf) return '';
  return `${orf.start}:${orf.end}:${orf.strand}`;
}

function annotationSearchFocusKey(focus: RenderState['annotationSearchFocus']): string {
  if (!focus) return '';
  return `${focus.trackId.length}:${focus.trackId}${focus.canonicalIdentity.length}:${focus.canonicalIdentity}:${focus.presentation ?? 'ordinary-overlay'}`;
}

function annotationSearchFocusFeatureKey(
  feature: RenderState['annotationSearchFocusFeature']
): string {
  if (!feature) return '';
  const trackId = feature.annotationTrackId ?? feature.type;
  const canonicalIdentity = feature.canonicalIdentity ?? '';
  return `${trackId.length}:${trackId}${canonicalIdentity.length}:${canonicalIdentity}:${finiteKey(feature.start, 1)}:${finiteKey(feature.end, 1)}`;
}

export function minimumFrameIntervalForWebGLState(state: RenderState): number {
  return state.performanceMode === 'stability' ? STABILITY_FRAME_INTERVAL_MS : 0;
}

export function slowFrameCooldownMs(state: RenderState, frameDt: number): number {
  if (state.performanceMode !== 'stability') return 0;
  if (frameDt <= SLOW_FRAME_THRESHOLD_MS) return 0;
  return Math.min(MAX_SLOW_FRAME_COOLDOWN_MS, frameDt * SLOW_FRAME_COOLDOWN_FACTOR);
}

export function webglRenderStateSignature(state: RenderState, renderRevision: number): string {
  return [
    renderRevision,
    state.performanceMode ?? 'default',
    finiteKey(state.morph),
    cameraOffsetKey(state),
    finiteKey(state.zoom, 1_000_000),
    state.width,
    state.height,
    state.geometryHeight ?? state.height,
    state.themeMode ?? 'light',
    selectedIdsKey(state.selectedIds),
    annotationSearchFocusKey(state.annotationSearchFocus),
    annotationSearchFocusFeatureKey(state.annotationSearchFocusFeature),
    state.hoveredId ?? '',
    rangeKey(state.viewportRange),
    state.viewportIndicatorVisible ? 'viewport-brackets' : '',
    rangeKey(state.highlightRange),
    rangesKey(state.proteinSearchHighlightRanges),
    rangeKey(state.digestFocusRange),
    rangeKey(state.residueLinkRange),
    state.cursorPosition ?? '',
    state.cursorBlinking ? 'cursor-blinking' : '',
    finiteKey(state.hoverPosition),
    codonKey(state.hoveredCodon),
    codonsKey(state.selectedCodons),
    orfKey(state.hoveredOrf),
    orfKey(state.selectedOrf),
    state.hoveredCutSiteId ?? '',
    state.showResidueNumbers ? 'residue-numbers' : '',
    state.backboneSegments?.length ?? 0,
  ].join('|');
}
