import type { Feature } from '../../../types';
import type { FeatureHitPayload } from '../shared/hit-targets';

export interface HitRecord extends FeatureHitPayload {
  kind?: 'annotation-callout';
  pts: number[];
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

export function featureHitPayload(
  feature: Feature,
  start = feature.start,
  end = feature.end
): FeatureHitPayload {
  return {
    id: feature.id,
    start,
    end,
    ...(feature.canonicalIdentity === undefined
      ? {}
      : { canonicalIdentity: feature.canonicalIdentity }),
    displayName: feature.displayName,
    type: feature.type,
    ...(feature.transcriptId === undefined ? {} : { transcriptId: feature.transcriptId }),
    ...(feature.sourceId === undefined ? {} : { sourceId: feature.sourceId }),
    lane: feature.lane,
    direction: feature.direction,
  };
}

export function hitRecordPayload(record: HitRecord): FeatureHitPayload {
  return {
    id: record.id,
    start: record.start,
    end: record.end,
    ...(record.canonicalIdentity === undefined
      ? {}
      : { canonicalIdentity: record.canonicalIdentity }),
    ...(record.displayName === undefined ? {} : { displayName: record.displayName }),
    ...(record.type === undefined ? {} : { type: record.type }),
    ...(record.transcriptId === undefined ? {} : { transcriptId: record.transcriptId }),
    ...(record.sourceId === undefined ? {} : { sourceId: record.sourceId }),
    ...(record.lane === undefined ? {} : { lane: record.lane }),
    ...(record.direction === undefined ? {} : { direction: record.direction }),
  };
}

export function pointInPolygon(x: number, y: number, pts: number[]): boolean {
  const n = pts.length / 2;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[i * 2],
      yi = pts[i * 2 + 1];
    const xj = pts[j * 2],
      yj = pts[j * 2 + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

export interface TranscriptHitGeometry {
  cy: number;
  halfHeight: number;
  exons: ReadonlyArray<{ x1: number; x2: number }>;
  intronGaps: ReadonlyArray<{ x1: number; x2: number }>;
}

export const EXON_HIT_GRAB_PAD_PX = 3;
export const INTRON_HIT_GRAB_PAD_PX = 2;
export const INTRON_HIT_MAX_HALF_Y_PX = 4;

export function transcriptHitTest(
  screenX: number,
  screenY: number,
  geo: TranscriptHitGeometry
): boolean {
  const exonHalfY = geo.halfHeight;
  const intronHalfY = Math.min(geo.halfHeight, INTRON_HIT_MAX_HALF_Y_PX);
  const dy = Math.abs(screenY - geo.cy);
  if (dy > exonHalfY) return false;
  for (const e of geo.exons) {
    const lo = Math.min(e.x1, e.x2) - EXON_HIT_GRAB_PAD_PX;
    const hi = Math.max(e.x1, e.x2) + EXON_HIT_GRAB_PAD_PX;
    if (screenX >= lo && screenX <= hi) return true;
  }
  if (dy > intronHalfY) return false;
  for (const g of geo.intronGaps) {
    const lo = Math.min(g.x1, g.x2) - INTRON_HIT_GRAB_PAD_PX;
    const hi = Math.max(g.x1, g.x2) + INTRON_HIT_GRAB_PAD_PX;
    if (screenX >= lo && screenX <= hi) return true;
  }
  return false;
}

export function computeBBox(pts: number[]): {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
} {
  let xMin = Infinity,
    xMax = -Infinity,
    yMin = Infinity,
    yMax = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i],
      y = pts[i + 1];
    if (x < xMin) xMin = x;
    if (x > xMax) xMax = x;
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  }
  return { xMin, xMax, yMin, yMax };
}
