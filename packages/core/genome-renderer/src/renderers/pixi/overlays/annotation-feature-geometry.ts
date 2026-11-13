import type { Feature } from '../../../types';
import { cdsConnectorCenterOffset } from '@waypoint/platform';
import type { PathMapper } from '../shared/path-mapper';
import { LANE_HEIGHT } from '../shared/track-layout';
import {
  advanceBpByScreenWidth,
  laneCdsLabelStripOutlinePolygon,
  laneRoundedPillPolygon,
  normalizeBp,
  rangeLength,
  splitWrappedRange,
} from '../shared/lane-path';
import type { Point2 } from '../shared/dashed-line';

export type OutlineCommand =
  | { kind: 'poly'; pts: number[] }
  | { kind: 'polyline'; pts: number[] }
  | { kind: 'roundRect'; x: number; y: number; width: number; height: number; radius: number };

export function flatPolygonToPolyline(pts: number[]): Point2[] {
  const points: Point2[] = [];
  for (let i = 0; i + 1 < pts.length; i += 2) {
    points.push({ x: pts[i], y: pts[i + 1] });
  }
  if (points.length > 0) {
    points.push({ ...points[0] });
  }
  return points;
}

export function screenDistanceFromFeatureStart(
  featureStartBp: number,
  bp: number,
  genomeLength: number,
  pixelsPerBp: number
): number {
  let delta = bp - featureStartBp;
  if (delta < -0.5) delta += genomeLength;
  return Math.max(0, delta) * pixelsPerBp;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.max(0, Math.min(1, t));
}

export function lerpBp(
  a: number,
  b: number,
  t: number,
  genomeLength: number,
  circular: boolean
): number {
  const clamped = Math.max(0, Math.min(1, t));
  if (!circular || genomeLength <= 0) return lerp(a, b, clamped);
  let delta = ((b - a + genomeLength / 2) % genomeLength) - genomeLength / 2;
  if (delta < -genomeLength / 2) delta += genomeLength;
  return normalizeBp(a + delta * clamped, genomeLength);
}

export function buildDirectionalPolygon(
  path: PathMapper,
  feature: Feature,
  endBp: number,
  offset: number,
  arrowWidth: number,
  halfHeight: number = LANE_HEIGHT / 2
): number[] {
  const hh = halfHeight;

  if (!path.isArcMode) {
    const x1 = path.bpLeftX(feature.start);
    const x2 = path.bpLeftX(endBp);
    const cy = path.featureLabelPosAt(feature.start, offset).y;
    if (feature.direction === 'forward') {
      return [x1, cy - hh, x2 - arrowWidth, cy - hh, x2, cy, x2 - arrowWidth, cy + hh, x1, cy + hh];
    }
    return [x1 + arrowWidth, cy - hh, x2, cy - hh, x2, cy + hh, x1 + arrowWidth, cy + hh, x1, cy];
  }

  const basePoints = path.featurePolygonAt(feature.start, endBp, offset, hh);
  const totalPoints = basePoints.length / 2;
  const outerCount = totalPoints / 2;
  if (outerCount < 2) return basePoints;

  const tipBp = feature.direction === 'forward' ? endBp : feature.start;
  const tip = path.featureLabelPosAt(tipBp, offset);
  const outerTipIndex = feature.direction === 'forward' ? outerCount - 1 : 0;
  const innerTipIndex = totalPoints - 1 - outerTipIndex;
  const ribbonTipX = (basePoints[outerTipIndex * 2] + basePoints[innerTipIndex * 2]) / 2;
  const ribbonTipY = (basePoints[outerTipIndex * 2 + 1] + basePoints[innerTipIndex * 2 + 1]) / 2;
  if (Math.hypot(tip.x - ribbonTipX, tip.y - ribbonTipY) > 1e-4) return basePoints;

  const walkBack = (startIndex: number, step: number, count: number, targetDistance: number) => {
    let distance = 0;
    let index = startIndex;
    for (let n = 0; n < count - 1; n++) {
      const nextIndex = index + step;
      const dx = basePoints[nextIndex * 2] - basePoints[index * 2];
      const dy = basePoints[nextIndex * 2 + 1] - basePoints[index * 2 + 1];
      const segmentLength = Math.sqrt(dx * dx + dy * dy);
      if (segmentLength <= 1e-9) continue;
      if (distance + segmentLength >= targetDistance) {
        const fraction = (targetDistance - distance) / segmentLength;
        return {
          x: basePoints[index * 2] + fraction * dx,
          y: basePoints[index * 2 + 1] + fraction * dy,
          nearIndex: index,
          farIndex: nextIndex,
        };
      }
      distance += segmentLength;
      index = nextIndex;
    }
    return {
      x: basePoints[index * 2],
      y: basePoints[index * 2 + 1],
      nearIndex: index,
      farIndex: index,
    };
  };

  const result: number[] = [];
  if (feature.direction === 'forward') {
    const outerCut = walkBack(outerCount - 1, -1, outerCount, arrowWidth);
    const innerCut = walkBack(outerCount, 1, outerCount, arrowWidth);
    for (let i = 0; i <= outerCut.farIndex; i++) {
      result.push(basePoints[i * 2], basePoints[i * 2 + 1]);
    }
    result.push(outerCut.x, outerCut.y);
    result.push(tip.x, tip.y);
    result.push(innerCut.x, innerCut.y);
    for (let i = innerCut.nearIndex + 1; i < totalPoints; i++) {
      result.push(basePoints[i * 2], basePoints[i * 2 + 1]);
    }
  } else {
    const outerCut = walkBack(0, 1, outerCount, arrowWidth);
    const innerCut = walkBack(totalPoints - 1, -1, outerCount, arrowWidth);
    result.push(outerCut.x, outerCut.y);
    for (let i = outerCut.nearIndex + 1; i < outerCount; i++) {
      result.push(basePoints[i * 2], basePoints[i * 2 + 1]);
    }
    for (let i = outerCount; i <= innerCut.farIndex; i++) {
      result.push(basePoints[i * 2], basePoints[i * 2 + 1]);
    }
    result.push(innerCut.x, innerCut.y);
    result.push(tip.x, tip.y);
  }
  return result;
}

export function laneBandOutlineCommands(
  path: PathMapper,
  startBp: number,
  endBp: number,
  offset: number,
  halfHeight: number,
  genomeLength: number
): OutlineCommand[] {
  const ranges = path.isArcMode
    ? ([[startBp, endBp]] as Array<[number, number]>)
    : splitWrappedRange(startBp, endBp, genomeLength);

  return ranges
    .filter(([rangeStart, rangeEnd]) => rangeLength(rangeStart, rangeEnd, genomeLength) > 0)
    .map(([rangeStart, rangeEnd]) => ({
      kind: 'poly' as const,
      pts: path.featurePolygonAt(rangeStart, rangeEnd, offset, halfHeight),
    }));
}

export function lanePillOutlineCommand(
  path: PathMapper,
  startBp: number,
  widthPx: number,
  offset: number,
  halfHeight: number,
  genomeLength: number
): OutlineCommand[] {
  if (widthPx <= 0) return [];
  const endBp = advanceBpByScreenWidth(path, startBp, widthPx, offset);
  if (!path.isArcMode && endBp <= genomeLength) {
    return [
      {
        kind: 'roundRect',
        x: path.bpLeftX(startBp),
        y: path.featureLabelPosAt(startBp, offset).y - halfHeight,
        width: widthPx,
        height: halfHeight * 2,
        radius: Math.min(3, halfHeight, widthPx / 2),
      },
    ];
  }
  return [
    { kind: 'poly', pts: laneRoundedPillPolygon(path, startBp, widthPx, offset, halfHeight) },
  ];
}

export function cdsLabelStripOutlineCommand(
  path: PathMapper,
  pillStartBp: number,
  pillWidthPx: number,
  featureEndBp: number,
  offset: number,
  pillHalfHeight: number,
  connectorHalfHeight: number,
  genomeLength: number,
  connectorOffsetPx = cdsConnectorCenterOffset(pillHalfHeight, connectorHalfHeight)
): OutlineCommand[] {
  if (pillWidthPx <= 0) return [];
  const pillEndBp = advanceBpByScreenWidth(path, pillStartBp, pillWidthPx, offset);
  const connectorWidthPx =
    rangeLength(pillEndBp, featureEndBp, genomeLength) * Math.max(path.pixelsPerBp, 1e-4);
  const pts = laneCdsLabelStripOutlinePolygon(
    path,
    pillStartBp,
    pillWidthPx,
    connectorWidthPx,
    offset,
    pillHalfHeight,
    connectorHalfHeight,
    connectorOffsetPx
  );
  return [{ kind: 'poly', pts }];
}
