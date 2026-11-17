import {
  INDEXED_SEQUENCE_ZOOM,
  indexedSequenceFontSize,
  indexedSequenceFullViewportDensity,
} from '@waypoint/platform';
export const SEQUENCE_FONT_SIZE = INDEXED_SEQUENCE_ZOOM.fontSize;
export const SEQUENCE_CHAR_WIDTH = INDEXED_SEQUENCE_ZOOM.charWidth;
export const MIN_SEQUENCE_FONT_SIZE = INDEXED_SEQUENCE_ZOOM.minFontSize;
export const MAX_SEQUENCE_FONT_SIZE = INDEXED_SEQUENCE_ZOOM.maxFontSize;
export const MAX_SEQUENCE_PIXELS_PER_BP =
  (MAX_SEQUENCE_FONT_SIZE / SEQUENCE_FONT_SIZE) * SEQUENCE_CHAR_WIDTH;
export const SEQUENCE_VISIBLE_PIXELS_PER_BP = INDEXED_SEQUENCE_ZOOM.visiblePixelsPerBp;
export const SEQUENCE_MAX_RENDERED_BASES = INDEXED_SEQUENCE_ZOOM.maxRenderedBases;
export const SEQUENCE_REVEAL_OVERSCAN_SCREEN_PX = INDEXED_SEQUENCE_ZOOM.overscanScreenPx;
export const SEQUENCE_FULL_OPACITY_MULTIPLIER = INDEXED_SEQUENCE_ZOOM.fullOpacityMultiplier;
export const LARGE_GENOME_STABILITY_LENGTH_BP = 500_000;
export const STABILITY_SEQUENCE_DETAIL_FRACTION = 0.4;

export const MAX_INDEXED_LINEAR_SEQUENCE_PIXELS_PER_BP = 7.336778568509653;

export function linearSequenceMaxPixelsPerBp(requested?: number): number {
  return requested !== undefined && Number.isFinite(requested) && requested > 0
    ? requested
    : MAX_INDEXED_LINEAR_SEQUENCE_PIXELS_PER_BP;
}

export function sequenceFontSizeForPixelsPerBp(pixelsPerBp: number): number {
  return indexedSequenceFontSize(pixelsPerBp);
}

export function sequenceRowHeightForFontSize(fontSize: number): number {
  return fontSize + 2;
}

const RASTER_LADDER_MIN = 4;

export function stableRasterSize(fontSize: number): number {
  const f = Math.max(RASTER_LADDER_MIN, fontSize);
  const steps = Math.ceil(Math.log2(f / RASTER_LADDER_MIN) * 2);
  return RASTER_LADDER_MIN * Math.pow(Math.SQRT2, Math.max(0, steps));
}

export function maxZoomForSequencePixelsPerBp(
  genomeLength: number,
  screenPathLengthPx: number,
  maxPixelsPerBp = MAX_SEQUENCE_PIXELS_PER_BP
): number {
  if (genomeLength <= 0 || screenPathLengthPx <= 0) return 1;
  return (genomeLength * maxPixelsPerBp) / screenPathLengthPx;
}

export function sequenceFullViewportPixelsPerBp(sequenceViewportSpanPx: number): number {
  return indexedSequenceFullViewportDensity(sequenceViewportSpanPx);
}

export function stabilityMaxZoomBeforeSequenceDetail(params: {
  genomeLength: number;
  screenPathLengthPx: number;
  sequenceViewportSpanPx: number;
}): number {
  const { genomeLength, screenPathLengthPx, sequenceViewportSpanPx } = params;
  if (genomeLength <= 0 || screenPathLengthPx <= 0) return 1;
  const maxPixelsPerBp =
    sequenceFullViewportPixelsPerBp(sequenceViewportSpanPx) * STABILITY_SEQUENCE_DETAIL_FRACTION;
  return (genomeLength * maxPixelsPerBp) / screenPathLengthPx;
}

export function capMaxZoomForStabilityMode(params: {
  genomeLength: number;
  screenPathLengthPx: number;
  sequenceViewportSpanPx: number;
  readableMaxZoom: number;
  performanceMode?: 'default' | 'stability';
}): number {
  const { genomeLength, readableMaxZoom, performanceMode } = params;
  if (performanceMode !== 'stability' || genomeLength < LARGE_GENOME_STABILITY_LENGTH_BP) {
    return readableMaxZoom;
  }
  return Math.max(0.01, Math.min(readableMaxZoom, stabilityMaxZoomBeforeSequenceDetail(params)));
}
