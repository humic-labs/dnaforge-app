import type { Feature } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import { advanceBpByScreenWidth, clampedLanePillPlacement, rangeLength } from '../shared/lane-path';
import { isCompositeFeature, isSplicedFeature } from './annotation-feature-semantics';

const APPROXIMATE_LABEL_CHARACTER_WIDTH_PX = 6.5;

export interface VisiblePolygonLabelPlacement {
  readonly cx: number;
  readonly cy: number;
  readonly visibleWidth: number;
  readonly fraction: number;
}

export interface LabelTruncationCacheEntry {
  readonly text: string;
  readonly width: number;
}

export interface VisiblePolygonLabelCandidate extends VisiblePolygonLabelPlacement {
  readonly candidateIndex: number;
}

export interface VisibleFeatureLabelPlacement {
  readonly candidateIndex: number;
  readonly rangeStartBp: number;
  readonly rangeEndBp: number;
  readonly startBp: number;
  readonly widthPx: number;
}

export function visibleCenterFromPolygon(
  pts: number[],
  viewportWidth: number,
  viewportHeight: number
): VisiblePolygonLabelPlacement {
  const totalPoints = pts.length / 2;
  const outerCount = totalPoints / 2;

  const left = 0;
  const top = 0;
  const right = viewportWidth;
  const bottom = viewportHeight;

  const clipSegment = (ax: number, ay: number, bx: number, by: number): [number, number] | null => {
    let t0 = 0;
    let t1 = 1;
    const dx = bx - ax;
    const dy = by - ay;
    const edges = [
      { p: -dx, q: ax - left },
      { p: dx, q: right - ax },
      { p: -dy, q: ay - top },
      { p: dy, q: bottom - ay },
    ];

    for (const { p, q } of edges) {
      if (Math.abs(p) < 1e-10) {
        if (q < 0) return null;
      } else {
        const r = q / p;
        if (p < 0) {
          if (r > t1) return null;
          if (r > t0) t0 = r;
        } else {
          if (r < t0) return null;
          if (r < t1) t1 = r;
        }
      }
    }
    return [t0, t1];
  };

  const visiblePoints: Array<{ x: number; y: number; dist: number }> = [];
  let cumulativeDistance = 0;

  for (let i = 0; i < outerCount - 1; i++) {
    const ax = pts[i * 2];
    const ay = pts[i * 2 + 1];
    const bx = pts[(i + 1) * 2];
    const by = pts[(i + 1) * 2 + 1];
    const segmentLength = Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2);

    const clipped = clipSegment(ax, ay, bx, by);
    if (clipped) {
      const [t0, t1] = clipped;
      const entryX = ax + (bx - ax) * t0;
      const entryY = ay + (by - ay) * t0;
      const exitX = ax + (bx - ax) * t1;
      const exitY = ay + (by - ay) * t1;
      const entryDistance = cumulativeDistance + segmentLength * t0;
      const exitDistance = cumulativeDistance + segmentLength * t1;

      if (visiblePoints.length === 0) {
        visiblePoints.push({ x: entryX, y: entryY, dist: entryDistance });
      }
      visiblePoints.push({ x: exitX, y: exitY, dist: exitDistance });
    }

    cumulativeDistance += segmentLength;
  }

  if (visiblePoints.length < 2) {
    const midpointIndex = Math.floor(outerCount / 2);
    const innerIndex = totalPoints - 1 - midpointIndex;
    return {
      cx: (pts[midpointIndex * 2] + pts[innerIndex * 2]) / 2,
      cy: (pts[midpointIndex * 2 + 1] + pts[innerIndex * 2 + 1]) / 2,
      visibleWidth: 0,
      fraction: outerCount > 1 ? midpointIndex / (outerCount - 1) : 0.5,
    };
  }

  const firstVisible = visiblePoints[0];
  const lastVisible = visiblePoints[visiblePoints.length - 1];
  const visibleWidth = lastVisible.dist - firstVisible.dist;
  const targetDistance = firstVisible.dist + visibleWidth / 2;

  let outerCx = firstVisible.x;
  let outerCy = firstVisible.y;
  for (let i = 1; i < visiblePoints.length; i++) {
    if (visiblePoints[i].dist >= targetDistance) {
      const previous = visiblePoints[i - 1];
      const fraction =
        (targetDistance - previous.dist) / (visiblePoints[i].dist - previous.dist || 1);
      outerCx = previous.x + (visiblePoints[i].x - previous.x) * fraction;
      outerCy = previous.y + (visiblePoints[i].y - previous.y) * fraction;
      break;
    }
  }

  const outerFraction = cumulativeDistance > 0 ? targetDistance / cumulativeDistance : 0.5;
  const innerIndexFloat = outerCount + (1 - outerFraction) * (outerCount - 1);
  const innerFloor = Math.min(totalPoints - 2, Math.max(outerCount, Math.floor(innerIndexFloat)));
  const innerFraction = innerIndexFloat - Math.floor(innerIndexFloat);
  const ix1 = pts[innerFloor * 2];
  const iy1 = pts[innerFloor * 2 + 1];
  const ix2 = pts[(innerFloor + 1) * 2];
  const iy2 = pts[(innerFloor + 1) * 2 + 1];
  const innerCx = ix1 + (ix2 - ix1) * innerFraction;
  const innerCy = iy1 + (iy2 - iy1) * innerFraction;

  return {
    cx: (outerCx + innerCx) / 2,
    cy: (outerCy + innerCy) / 2,
    visibleWidth,
    fraction: outerFraction,
  };
}

export function bestVisiblePolygonLabelCandidate(
  polygons: readonly number[][],
  viewportWidth: number,
  viewportHeight: number
): VisiblePolygonLabelCandidate | null {
  let best: VisiblePolygonLabelCandidate | null = null;
  let bestDistanceFromViewportCenter = Infinity;

  for (let candidateIndex = 0; candidateIndex < polygons.length; candidateIndex++) {
    const polygon = polygons[candidateIndex];
    if (!polygon || polygon.length < 8) continue;
    const placement = visibleCenterFromPolygon(polygon, viewportWidth, viewportHeight);
    if (placement.visibleWidth <= 0) continue;

    const distanceFromViewportCenter = Math.hypot(
      placement.cx - viewportWidth / 2,
      placement.cy - viewportHeight / 2
    );
    if (
      best === null ||
      placement.visibleWidth > best.visibleWidth + 1e-6 ||
      (Math.abs(placement.visibleWidth - best.visibleWidth) <= 1e-6 &&
        distanceFromViewportCenter < bestDistanceFromViewportCenter - 1e-6)
    ) {
      best = { candidateIndex, ...placement };
      bestDistanceFromViewportCenter = distanceFromViewportCenter;
    }
  }

  return best;
}

function occupiedFeatureLabelRanges(
  feature: Feature,
  genomeLength: number
): Array<{ startBp: number; endBp: number }> {
  const occupiedParts =
    isCompositeFeature(feature) && feature.exons && feature.exons.length > 0
      ? feature.exons
      : isSplicedFeature(feature) && feature.segments && feature.segments.length > 0
        ? feature.segments
        : null;
  if (occupiedParts) {
    return occupiedParts
      .map((part) => ({
        startBp: Math.max(0, part.start - 1),
        endBp: Math.min(genomeLength, part.end),
      }))
      .filter((part) => part.endBp > part.startBp);
  }

  return [{ startBp: feature.start, endBp: feature.end }];
}

export function bestVisibleFeatureLabelPlacement(
  feature: Feature,
  path: PathMapper,
  viewportWidth: number,
  viewportHeight: number,
  offsetPx: number,
  genomeLength: number
): VisibleFeatureLabelPlacement | null {
  const ranges = occupiedFeatureLabelRanges(feature, genomeLength);
  let best: VisibleFeatureLabelPlacement | null = null;
  let bestDistanceFromViewportCenter = Infinity;

  for (let candidateIndex = 0; candidateIndex < ranges.length; candidateIndex++) {
    const range = ranges[candidateIndex];
    const requestedWidthPx =
      rangeLength(range.startBp, range.endBp, genomeLength) * path.pixelsPerBp;
    const placement = clampedLanePillPlacement(
      path,
      viewportWidth,
      viewportHeight,
      range.startBp,
      range.endBp,
      requestedWidthPx,
      offsetPx,
      genomeLength,
      range.startBp
    );
    if (placement.widthPx <= 0) continue;

    const centerBp = advanceBpByScreenWidth(
      path,
      placement.startBp,
      placement.widthPx / 2,
      offsetPx
    );
    const center = path.featureLabelPosAt(centerBp, offsetPx);
    const distanceFromViewportCenter = Math.hypot(
      center.x - viewportWidth / 2,
      center.y - viewportHeight / 2
    );
    if (
      best === null ||
      placement.widthPx > best.widthPx + 1e-6 ||
      (Math.abs(placement.widthPx - best.widthPx) <= 1e-6 &&
        distanceFromViewportCenter < bestDistanceFromViewportCenter - 1e-6)
    ) {
      best = {
        candidateIndex,
        rangeStartBp: range.startBp,
        rangeEndBp: range.endBp,
        startBp: placement.startBp,
        widthPx: placement.widthPx,
      };
      bestDistanceFromViewportCenter = distanceFromViewportCenter;
    }
  }

  return best;
}

export function truncateForWidth(
  name: string,
  availableWidth: number,
  cache: Map<number, LabelTruncationCacheEntry>,
  featureId: number
): string | null {
  if (availableWidth < APPROXIMATE_LABEL_CHARACTER_WIDTH_PX * 4) return null;

  const cached = cache.get(featureId);
  if (cached && Math.abs(availableWidth - cached.width) < APPROXIMATE_LABEL_CHARACTER_WIDTH_PX) {
    const cachedTextWidth = cached.text.length * APPROXIMATE_LABEL_CHARACTER_WIDTH_PX;
    if (cachedTextWidth <= availableWidth) return cached.text;
  }

  const fullWidth = name.length * APPROXIMATE_LABEL_CHARACTER_WIDTH_PX;
  let result: string;
  if (fullWidth <= availableWidth) {
    result = name;
  } else {
    const maxCharacters = Math.floor(
      (availableWidth - APPROXIMATE_LABEL_CHARACTER_WIDTH_PX) / APPROXIMATE_LABEL_CHARACTER_WIDTH_PX
    );
    if (maxCharacters < 4) return null;
    result = `${name.slice(0, maxCharacters)}…`;
  }
  cache.set(featureId, { text: result, width: availableWidth });
  return result;
}
