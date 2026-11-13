import { LODTier } from '../types';

export function computeLODTier(
  featureLength: number,
  visibleBp: number,
  circumferencePixels: number
): LODTier {
  const pixelWidth = (featureLength / visibleBp) * circumferencePixels;
  if (pixelWidth < 0.5) return LODTier.Hidden;
  if (pixelWidth < 2) return LODTier.Rect;
  if (pixelWidth < 8) return LODTier.Arrow;
  return LODTier.Detailed;
}

const SMOOTH_POLYGON_SEGMENT_PX = 1.5;
const MIN_POLYGON_SEGMENTS = 8;
const MAX_POLYGON_SEGMENTS = 2048;

export function computeSegmentCount(
  featureLength: number,
  visibleBp: number,
  circumferencePixels: number
): number {
  const pixelArc = (featureLength / visibleBp) * circumferencePixels;
  if (!Number.isFinite(pixelArc) || pixelArc <= 0) return MIN_POLYGON_SEGMENTS;
  return Math.max(
    MIN_POLYGON_SEGMENTS,
    Math.min(MAX_POLYGON_SEGMENTS, Math.ceil(pixelArc / SMOOTH_POLYGON_SEGMENT_PX))
  );
}

export function shouldRenderSequence(bpPerPixel: number): boolean {
  return bpPerPixel < 5;
}

export function sequenceOpacity(bpPerPixel: number): number {
  if (bpPerPixel >= 5) return 0;
  if (bpPerPixel <= 2) return 1;
  return 1 - (bpPerPixel - 2) / 3;
}

export function isInViewport(
  featureStart: number,
  genomeLength: number,
  viewOffset: number,
  zoom: number
): boolean {
  const startFrac = featureStart / genomeLength;
  const relative = (startFrac - viewOffset + 1) % 1;
  const visibleFraction = Math.min(1, 1 / zoom);
  return relative < visibleFraction + 0.05;
}
