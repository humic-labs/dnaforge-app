import { CDS_GLYPH_STYLE } from './cds-glyph';

export const INDEXED_SEQUENCE_ZOOM = {
  fontSize: 11,
  charWidth: 7,
  minFontSize: 4,
  maxFontSize: 22,
  visiblePixelsPerBp: 0.2,
  maxRenderedBases: 3000,
  overscanScreenPx: 128,
  fullOpacityMultiplier: 1.25,
  revealStartFraction: 0.45,
  opacityStartFraction: 0.95,
  bodyMorphEnd: 0.85,
  residueMinCellWidth: 8,
} as const;

const smoothstep = (start: number, end: number, value: number) => {
  const p = Math.max(0, Math.min(1, (value - start) / (end - start)));
  return p * p * (3 - 2 * p);
};

export function indexedSequenceFontSize(pixelsPerBp: number): number {
  return Math.max(
    INDEXED_SEQUENCE_ZOOM.minFontSize,
    Math.min(
      INDEXED_SEQUENCE_ZOOM.maxFontSize,
      (INDEXED_SEQUENCE_ZOOM.fontSize * pixelsPerBp) / INDEXED_SEQUENCE_ZOOM.charWidth
    )
  );
}

export function indexedSequenceFullViewportDensity(viewportSpanPx: number): number {
  return Math.max(
    INDEXED_SEQUENCE_ZOOM.visiblePixelsPerBp,
    (Math.max(0, viewportSpanPx) + 2 * INDEXED_SEQUENCE_ZOOM.overscanScreenPx) /
      INDEXED_SEQUENCE_ZOOM.maxRenderedBases
  );
}

export function indexedSequenceRevealMetrics(
  hasSequence: boolean,
  pixelsPerBp: number,
  viewportSpanPx: number
) {
  const sequenceFullViewportPixelsPerBp = indexedSequenceFullViewportDensity(viewportSpanPx);
  const sequenceRevealStartPixelsPerBp =
    sequenceFullViewportPixelsPerBp * INDEXED_SEQUENCE_ZOOM.revealStartFraction;
  const sequenceVisible = hasSequence && pixelsPerBp >= sequenceFullViewportPixelsPerBp;
  return {
    sequenceFullViewportPixelsPerBp,
    sequenceRevealStartPixelsPerBp,
    sequenceVisible,
    sequenceOpacity: sequenceVisible
      ? smoothstep(
          sequenceFullViewportPixelsPerBp * INDEXED_SEQUENCE_ZOOM.opacityStartFraction,
          sequenceFullViewportPixelsPerBp * INDEXED_SEQUENCE_ZOOM.fullOpacityMultiplier,
          pixelsPerBp
        )
      : 0,
    sequenceRevealProgress: hasSequence
      ? smoothstep(sequenceRevealStartPixelsPerBp, sequenceFullViewportPixelsPerBp, pixelsPerBp)
      : 0,
    sequenceFontSize: indexedSequenceFontSize(pixelsPerBp),
  };
}

export function indexedCdsBodyHeight(progress: number): number {
  return (
    CDS_GLYPH_STYLE.labelHeight +
    (CDS_GLYPH_STYLE.replacementTopEdgeHeight - CDS_GLYPH_STYLE.labelHeight) *
      smoothstep(0, INDEXED_SEQUENCE_ZOOM.bodyMorphEnd, progress)
  );
}

export function indexedCodonLettersVisible(cellWidthPx: number): boolean {
  return cellWidthPx > INDEXED_SEQUENCE_ZOOM.residueMinCellWidth;
}

export function canvasCdsMetrics(pixelsPerBp: number) {
  return {
    aaHeight: ((pixelsPerBp * 20) / 8) * 0.9,
    aaFontSize: Math.max(1, Math.round(((pixelsPerBp * 11) / 8) * 1.27)),
  };
}

export function cdsReplacementZoomPresentation(pixelsPerBp: number, viewportSpanPx: number) {
  const onset = indexedSequenceFullViewportDensity(viewportSpanPx);
  const bandProgress = smoothstep(onset * 0.75, onset * 0.875, pixelsPerBp);
  const progress = smoothstep(
    onset,
    onset * INDEXED_SEQUENCE_ZOOM.fullOpacityMultiplier,
    pixelsPerBp
  );
  const { aaHeight, aaFontSize } = canvasCdsMetrics(pixelsPerBp);
  const colorEnd = onset * INDEXED_SEQUENCE_ZOOM.fullOpacityMultiplier;
  const topLineHeight =
    CDS_GLYPH_STYLE.replacementTopEdgeHeight *
    smoothstep(colorEnd, colorEnd + onset * 0.125, pixelsPerBp);
  const height = Math.max(14 - topLineHeight, aaHeight);
  return {
    progress,
    bandProgress,
    topLineHeight,
    bandHeight: height + topLineHeight,
    barHeight: height,
    colorAlpha: progress,
    chevronProgress: progress > 0 ? 1 : 0,
    residueAlpha: indexedCodonLettersVisible(pixelsPerBp * 3) ? progress : 0,
    aaHeight: height,
    aaFontSize,
    viewportSpanPx,
  };
}

export type CdsZoomPresentation = ReturnType<typeof cdsReplacementZoomPresentation>;

export function cdsZoomBandCenterOffset(pose: CdsZoomPresentation): number {
  return CDS_GLYPH_STYLE.labelHeight * (pose.bandProgress - 0.5) + pose.aaHeight / 2;
}
