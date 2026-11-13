import type { Graphics } from 'pixi.js';
import type { PathMapper, Pos3 } from './path-mapper';

const LANE_LOCAL_SEGMENT_PX = 1.5;
const MAX_LOCAL_SEGMENT_STEPS = 2048;

export function rangeLength(startBp: number, endBp: number, genomeLength: number): number {
  if (endBp > startBp) return endBp - startBp;
  if (endBp < startBp) return genomeLength - startBp + endBp;
  return 0;
}

export function splitWrappedRange(
  startBp: number,
  endBp: number,
  genomeLength: number
): Array<[number, number]> {
  if (genomeLength <= 0) return [];
  const length = rangeLength(startBp, endBp, genomeLength);
  if (length <= 0) return [];
  if (length >= genomeLength) return [[0, genomeLength]];

  const start = ((startBp % genomeLength) + genomeLength) % genomeLength;
  const end = start + length;
  if (end <= genomeLength) return [[start, end]];
  return [
    [start, genomeLength],
    [0, end - genomeLength],
  ];
}

export function normalizeBp(bp: number, genomeLength: number): number {
  if (genomeLength <= 0) return bp;
  return ((bp % genomeLength) + genomeLength) % genomeLength;
}

export function buildLaneCenterline(
  path: PathMapper,
  startBp: number,
  endBp: number,
  offsetPx: number,
  genomeLength: number,
  targetSegmentPx = LANE_LOCAL_SEGMENT_PX
): Pos3[] {
  const lengthBp = rangeLength(startBp, endBp, genomeLength);
  if (lengthBp <= 0) return [];

  const segmentCount = path.isArcMode
    ? Math.max(
        1,
        Math.min(
          MAX_LOCAL_SEGMENT_STEPS,
          Math.ceil((lengthBp * path.pixelsPerBp) / targetSegmentPx)
        )
      )
    : 1;
  const points: Pos3[] = [];
  for (let i = 0; i <= segmentCount; i++) {
    points.push(path.featureLabelPosAt(startBp + lengthBp * (i / segmentCount), offsetPx));
  }
  return points;
}

export function polylineLength(points: Array<{ x: number; y: number }>): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return total;
}

export function screenWidthToBp(
  path: PathMapper,
  startBp: number,
  widthPx: number,
  offsetPx: number,
  maxLengthBp = Infinity
): number {
  const prev = path.featureLabelPosAt(startBp - 1, offsetPx);
  const next = path.featureLabelPosAt(startBp + 1, offsetPx);
  const sampled = Math.hypot(next.x - prev.x, next.y - prev.y) / 2;
  const pxPerBp = sampled > 1e-4 ? sampled : Math.max(path.pixelsPerBp, 1e-4);
  return Math.min(maxLengthBp, Math.max(0, widthPx) / pxPerBp);
}

export function advanceBpByScreenWidth(
  path: PathMapper,
  startBp: number,
  widthPx: number,
  offsetPx: number,
  maxLengthBp = Infinity
): number {
  return startBp + screenWidthToBp(path, startBp, widthPx, offsetPx, maxLengthBp);
}

type LaneSample = Pos3 & { bp: number; dist: number };

function laneAnchorAt(path: PathMapper, bp: number, offsetPx: number): Pos3 {
  const pos = path.featureLabelPosAt(bp, offsetPx);
  if (path.isArcMode) return pos;
  return { x: path.bpLeftX(bp), y: pos.y, angle: pos.angle };
}

function clipSegmentToViewport(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  viewportWidth: number,
  viewportHeight: number,
  insetPx = 0
): [number, number] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dy = by - ay;
  const left = insetPx;
  const top = insetPx;
  const right = viewportWidth - insetPx;
  const bottom = viewportHeight - insetPx;
  const edges = [
    { p: -dx, q: ax - left },
    { p: dx, q: right - ax },
    { p: -dy, q: ay - top },
    { p: dy, q: bottom - ay },
  ];

  for (const { p, q } of edges) {
    if (Math.abs(p) < 1e-10) {
      if (q < 0) return null;
      continue;
    }

    const r = q / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }

  return [t0, t1];
}

function buildLaneSamples(
  path: PathMapper,
  startBp: number,
  endBp: number,
  offsetPx: number,
  genomeLength: number,
  targetSegmentPx = LANE_LOCAL_SEGMENT_PX
): LaneSample[] {
  const lengthBp = rangeLength(startBp, endBp, genomeLength);
  if (lengthBp <= 0) return [];

  const segmentCount = path.isArcMode
    ? Math.max(
        1,
        Math.min(
          MAX_LOCAL_SEGMENT_STEPS,
          Math.ceil((lengthBp * path.pixelsPerBp) / targetSegmentPx)
        )
      )
    : 1;
  const samples: LaneSample[] = [];
  let cumulative = 0;

  for (let i = 0; i <= segmentCount; i++) {
    const bp = startBp + lengthBp * (i / segmentCount);
    const pos = laneAnchorAt(path, bp, offsetPx);
    if (samples.length > 0) {
      const prev = samples[samples.length - 1];
      cumulative += Math.hypot(pos.x - prev.x, pos.y - prev.y);
    }
    samples.push({ ...pos, bp, dist: cumulative });
  }

  return samples;
}

function distAtBp(samples: LaneSample[], bp: number): number {
  if (samples.length === 0) return 0;
  if (bp <= samples[0].bp) return samples[0].dist;
  const last = samples[samples.length - 1];
  if (bp >= last.bp) return last.dist;

  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const curr = samples[i];
    if (bp > curr.bp) continue;
    const t = (bp - prev.bp) / (curr.bp - prev.bp || 1);
    return prev.dist + (curr.dist - prev.dist) * t;
  }

  return last.dist;
}

function bpAtDist(samples: LaneSample[], dist: number): number {
  if (samples.length === 0) return 0;
  if (dist <= samples[0].dist) return samples[0].bp;
  const last = samples[samples.length - 1];
  if (dist >= last.dist) return last.bp;

  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const curr = samples[i];
    if (dist > curr.dist) continue;
    const t = (dist - prev.dist) / (curr.dist - prev.dist || 1);
    return prev.bp + (curr.bp - prev.bp) * t;
  }

  return last.bp;
}

function unwrapBpFromStart(startBp: number, bp: number, genomeLength: number): number {
  if (genomeLength <= 0) return bp;
  let unwrapped = bp;
  while (unwrapped < startBp - 1e-6) unwrapped += genomeLength;
  return unwrapped;
}

export function clampedLanePillPlacement(
  path: PathMapper,
  viewportWidth: number,
  viewportHeight: number,
  rangeStartBp: number,
  rangeEndBp: number,
  requestedWidthPx: number,
  offsetPx: number,
  genomeLength: number,
  preferredStartBp: number = rangeStartBp,
  edgePaddingPx = 0
): { startBp: number; widthPx: number } {
  if (requestedWidthPx <= 0) return { startBp: rangeStartBp, widthPx: 0 };
  const samples = buildLaneSamples(path, rangeStartBp, rangeEndBp, offsetPx, genomeLength);
  if (samples.length < 2) return { startBp: rangeStartBp, widthPx: 0 };

  const spans: Array<{ startBp: number; endBp: number; startDist: number; endDist: number }> = [];

  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const curr = samples[i];
    const clip = clipSegmentToViewport(
      prev.x,
      prev.y,
      curr.x,
      curr.y,
      viewportWidth,
      viewportHeight,
      edgePaddingPx
    );
    if (!clip) continue;

    const [t0, t1] = clip;
    const startDist = prev.dist + (curr.dist - prev.dist) * t0;
    const endDist = prev.dist + (curr.dist - prev.dist) * t1;
    if (endDist <= startDist) continue;

    const startBp = prev.bp + (curr.bp - prev.bp) * t0;
    const endBp = prev.bp + (curr.bp - prev.bp) * t1;
    const last = spans[spans.length - 1];
    if (last && Math.abs(last.endDist - startDist) < 0.5) {
      last.endBp = endBp;
      last.endDist = endDist;
    } else {
      spans.push({ startBp, endBp, startDist, endDist });
    }
  }

  if (spans.length === 0) return { startBp: rangeStartBp, widthPx: 0 };

  const preferredDist = distAtBp(
    samples,
    unwrapBpFromStart(rangeStartBp, preferredStartBp, genomeLength)
  );
  const span = spans.reduce((best, candidate) => {
    const bestDist = Math.max(best.startDist, Math.min(preferredDist, best.endDist));
    const candidateDist = Math.max(candidate.startDist, Math.min(preferredDist, candidate.endDist));
    const bestDistanceFromPreferred = Math.abs(bestDist - preferredDist);
    const candidateDistanceFromPreferred = Math.abs(candidateDist - preferredDist);
    if (candidateDistanceFromPreferred < bestDistanceFromPreferred - 1e-6) return candidate;
    if (bestDistanceFromPreferred < candidateDistanceFromPreferred - 1e-6) return best;
    return candidate.endDist - candidate.startDist > best.endDist - best.startDist
      ? candidate
      : best;
  });
  const visibleWidth = span.endDist - span.startDist;
  const widthPx = Math.min(requestedWidthPx, visibleWidth);
  const minStartDist = span.startDist;
  const maxStartDist = Math.max(span.startDist, span.endDist - widthPx);
  const startDist = Math.min(Math.max(preferredDist, minStartDist), maxStartDist);
  return { startBp: bpAtDist(samples, startDist), widthPx };
}

export function isLaneRangeVisibleInViewport(
  path: PathMapper,
  viewportWidth: number,
  viewportHeight: number,
  rangeStartBp: number,
  rangeEndBp: number,
  offsetPx: number,
  genomeLength: number
): boolean {
  const samples = buildLaneSamples(path, rangeStartBp, rangeEndBp, offsetPx, genomeLength);
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const curr = samples[i];
    if (
      clipSegmentToViewport(prev.x, prev.y, curr.x, curr.y, viewportWidth, viewportHeight) !== null
    ) {
      return true;
    }
  }
  return false;
}

export function drawLaneBand(
  g: Graphics,
  path: PathMapper,
  startBp: number,
  endBp: number,
  offsetPx: number,
  halfHeight: number,
  color: number,
  alpha: number,
  genomeLength: number
): void {
  const ranges = path.isArcMode
    ? ([[startBp, endBp]] as Array<[number, number]>)
    : splitWrappedRange(startBp, endBp, genomeLength);

  for (const [rangeStart, rangeEnd] of ranges) {
    if (rangeLength(rangeStart, rangeEnd, genomeLength) <= 0) continue;
    const pts = path.featurePolygonAt(rangeStart, rangeEnd, offsetPx, halfHeight);
    g.poly(pts);
    g.fill({ color, alpha });
  }
}

function laneLocalPoint(
  path: PathMapper,
  startBp: number,
  offsetPx: number,
  distancePx: number,
  normalOffsetPx: number,
  samples?: LaneSample[]
): { x: number; y: number } {
  const bp =
    samples && samples.length >= 2
      ? bpAtDist(samples, Math.max(0, Math.min(distancePx, samples[samples.length - 1].dist)))
      : advanceBpByScreenWidth(path, startBp, distancePx, offsetPx);
  const anchor = laneAnchorAt(path, bp, offsetPx);
  const nx = -Math.sin(anchor.angle);
  const ny = Math.cos(anchor.angle);
  const scaledNormalOffsetPx = path.scaleNormalOffset?.(normalOffsetPx) ?? normalOffsetPx;
  return {
    x: anchor.x + nx * scaledNormalOffsetPx,
    y: anchor.y + ny * scaledNormalOffsetPx,
  };
}

function addRoundedCorner(
  points: Array<[number, number]>,
  cx: number,
  cy: number,
  radius: number,
  from: number,
  to: number,
  steps = 4
): void {
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const a = from + (to - from) * t;
    points.push([cx + Math.cos(a) * radius, cy + Math.sin(a) * radius]);
  }
}

function laneLocalPolygon(
  path: PathMapper,
  startBp: number,
  offsetPx: number,
  localPoints: Array<[number, number]>,
  samples?: LaneSample[]
): number[] {
  if (localPoints.length === 0) return [];
  const pts: number[] = [];
  const emit = (x: number, y: number) => {
    const p = laneLocalPoint(path, startBp, offsetPx, x, y, samples);
    pts.push(p.x, p.y);
  };

  const emitSegment = (prev: [number, number], next: [number, number]) => {
    const [prevX, prevY] = prev;
    const [nextX, nextY] = next;
    const laneDistance = Math.abs(nextX - prevX);
    const steps = path.isArcMode
      ? Math.max(
          1,
          Math.min(MAX_LOCAL_SEGMENT_STEPS, Math.ceil(laneDistance / LANE_LOCAL_SEGMENT_PX))
        )
      : 1;

    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      emit(prevX + (nextX - prevX) * t, prevY + (nextY - prevY) * t);
    }
  };

  emit(localPoints[0][0], localPoints[0][1]);
  for (let i = 1; i < localPoints.length; i++) {
    emitSegment(localPoints[i - 1], localPoints[i]);
  }

  const first = localPoints[0];
  const last = localPoints[localPoints.length - 1];
  if (Math.abs(first[0] - last[0]) > 1e-6 || Math.abs(first[1] - last[1]) > 1e-6) {
    emitSegment(last, first);
  }
  return pts;
}

function roundedPillLocalPoints(widthPx: number, halfHeight: number): Array<[number, number]> {
  const radius = Math.min(3, halfHeight, widthPx / 2);
  const localPoints: Array<[number, number]> = [];
  const add = (x: number, y: number) => localPoints.push([x, y]);

  add(radius, -halfHeight);
  add(widthPx - radius, -halfHeight);
  addRoundedCorner(localPoints, widthPx - radius, -halfHeight + radius, radius, -Math.PI / 2, 0);
  add(widthPx, halfHeight - radius);
  addRoundedCorner(localPoints, widthPx - radius, halfHeight - radius, radius, 0, Math.PI / 2);
  add(radius, halfHeight);
  addRoundedCorner(localPoints, radius, halfHeight - radius, radius, Math.PI / 2, Math.PI);
  add(0, -halfHeight + radius);
  addRoundedCorner(localPoints, radius, -halfHeight + radius, radius, Math.PI, (3 * Math.PI) / 2);

  return localPoints;
}

function clipLocalPolygonByY(
  points: Array<[number, number]>,
  boundaryY: number,
  keep: 'above' | 'below'
): Array<[number, number]> {
  if (points.length < 3) return [];
  const inside = (p: [number, number]) =>
    keep === 'above' ? p[1] <= boundaryY + 1e-6 : p[1] >= boundaryY - 1e-6;
  const intersection = (a: [number, number], b: [number, number]): [number, number] => {
    const t = (boundaryY - a[1]) / (b[1] - a[1] || 1);
    return [a[0] + (b[0] - a[0]) * t, boundaryY];
  };

  const output: Array<[number, number]> = [];
  let prev = points[points.length - 1];
  let prevInside = inside(prev);

  for (const curr of points) {
    const currInside = inside(curr);
    if (currInside) {
      if (!prevInside) output.push(intersection(prev, curr));
      output.push(curr);
    } else if (prevInside) {
      output.push(intersection(prev, curr));
    }
    prev = curr;
    prevInside = currInside;
  }

  return output;
}

export function laneRoundedPillPolygon(
  path: PathMapper,
  startBp: number,
  widthPx: number,
  offsetPx: number,
  halfHeight: number
): number[] {
  if (widthPx <= 0) return [];

  return laneLocalPolygon(path, startBp, offsetPx, roundedPillLocalPoints(widthPx, halfHeight));
}

export function laneRoundedPillShellPolygons(
  path: PathMapper,
  startBp: number,
  widthPx: number,
  offsetPx: number,
  halfHeight: number,
  centerCutoutHalfHeight: number
): number[][] {
  if (widthPx <= 0) return [];
  const cutoutHalf = Math.max(0, Math.min(halfHeight, centerCutoutHalfHeight));
  if (cutoutHalf <= 0) {
    const full = laneRoundedPillPolygon(path, startBp, widthPx, offsetPx, halfHeight);
    return full.length >= 6 ? [full] : [];
  }
  if (cutoutHalf >= halfHeight - 1e-6) return [];

  const localPill = roundedPillLocalPoints(widthPx, halfHeight);
  const top = clipLocalPolygonByY(localPill, -cutoutHalf, 'above');
  const bottom = clipLocalPolygonByY(localPill, cutoutHalf, 'below');

  return [top, bottom]
    .filter((local) => local.length >= 3)
    .map((local) => laneLocalPolygon(path, startBp, offsetPx, local))
    .filter((pts) => pts.length >= 6);
}

export function laneCdsLabelStripOutlinePolygon(
  path: PathMapper,
  startBp: number,
  pillWidthPx: number,
  connectorWidthPx: number,
  offsetPx: number,
  pillHalfHeight: number,
  connectorHalfHeight: number,
  connectorOffsetPx = 0
): number[] {
  if (pillWidthPx <= 0) return [];
  if (connectorWidthPx <= 0) {
    return laneRoundedPillPolygon(path, startBp, pillWidthPx, offsetPx, pillHalfHeight);
  }

  const radius = Math.min(3, pillHalfHeight, pillWidthPx / 2);
  const connectorHalf = Math.min(connectorHalfHeight, pillHalfHeight);
  const connectorEndX = pillWidthPx + connectorWidthPx;
  const rightArcTopY = -pillHalfHeight + radius;
  const rightArcBottomY = pillHalfHeight - radius;
  const connectorTopY = connectorOffsetPx - connectorHalf;
  const connectorBottomY = connectorOffsetPx + connectorHalf;
  const localPoints: Array<[number, number]> = [];
  const add = (x: number, y: number) => localPoints.push([x, y]);

  add(radius, -pillHalfHeight);
  add(pillWidthPx - radius, -pillHalfHeight);
  addRoundedCorner(
    localPoints,
    pillWidthPx - radius,
    -pillHalfHeight + radius,
    radius,
    -Math.PI / 2,
    0
  );
  if (connectorTopY > rightArcTopY) add(pillWidthPx, connectorTopY);
  add(connectorEndX, connectorTopY);
  add(connectorEndX, connectorBottomY);
  if (connectorBottomY >= pillHalfHeight) {
    add(pillWidthPx - radius, pillHalfHeight);
  } else {
    add(pillWidthPx, connectorBottomY);
    if (connectorBottomY < rightArcBottomY) add(pillWidthPx, rightArcBottomY);
    addRoundedCorner(
      localPoints,
      pillWidthPx - radius,
      pillHalfHeight - radius,
      radius,
      0,
      Math.PI / 2
    );
  }
  add(radius, pillHalfHeight);
  addRoundedCorner(localPoints, radius, pillHalfHeight - radius, radius, Math.PI / 2, Math.PI);
  add(0, -pillHalfHeight + radius);
  addRoundedCorner(
    localPoints,
    radius,
    -pillHalfHeight + radius,
    radius,
    Math.PI,
    (3 * Math.PI) / 2
  );

  return laneLocalPolygon(path, startBp, offsetPx, localPoints);
}

export function laneCdsTransitionOutlinePolygon(
  path: PathMapper,
  featureStartBp: number,
  featureEndBp: number,
  pillStartBp: number,
  pillWidthPx: number,
  offsetPx: number,
  pillHalfHeight: number,
  connectorHalfHeight: number,
  genomeLength: number,
  direction: 'forward' | 'reverse' | 'none' = 'none',
  arrowWidthPx = 0
): number[] {
  const laneSamples = path.isArcMode
    ? buildLaneSamples(path, featureStartBp, featureEndBp, offsetPx, genomeLength, 4)
    : [];
  const totalWidthPx =
    laneSamples.length >= 2
      ? laneSamples[laneSamples.length - 1].dist
      : rangeLength(featureStartBp, featureEndBp, genomeLength) * Math.max(path.pixelsPerBp, 1e-4);
  if (totalWidthPx <= 0 || pillWidthPx <= 0) return [];

  const distanceAtBp = (bp: number) =>
    laneSamples.length >= 2
      ? distAtBp(laneSamples, unwrapBpFromStart(featureStartBp, bp, genomeLength))
      : rangeLength(featureStartBp, bp, genomeLength) * Math.max(path.pixelsPerBp, 1e-4);
  const arrowWidth =
    direction === 'none' ? 0 : Math.max(0, Math.min(arrowWidthPx, totalWidthPx / 2));
  const connectorStartX = direction === 'reverse' ? arrowWidth : 0;
  const connectorEndX = direction === 'forward' ? totalWidthPx - arrowWidth : totalWidthPx;
  const pillStartX = Math.max(connectorStartX, Math.min(connectorEndX, distanceAtBp(pillStartBp)));
  const pillEndX = Math.max(pillStartX, Math.min(connectorEndX, pillStartX + pillWidthPx));
  const radius = Math.min(3, pillHalfHeight, (pillEndX - pillStartX) / 2);
  const connectorHalf = Math.min(connectorHalfHeight, pillHalfHeight);
  const connectorTopY = -connectorHalf;
  const connectorBottomY = connectorHalf;
  const localPoints: Array<[number, number]> = [];
  const add = (x: number, y: number) => localPoints.push([x, y]);

  if (direction === 'reverse' && arrowWidth > 0) {
    add(0, 0);
    add(connectorStartX, connectorTopY);
  } else {
    add(connectorStartX, connectorTopY);
  }
  if (pillStartX > connectorStartX) add(pillStartX, connectorTopY);
  add(pillStartX, -pillHalfHeight + radius);
  addRoundedCorner(
    localPoints,
    pillStartX + radius,
    -pillHalfHeight + radius,
    radius,
    Math.PI,
    (3 * Math.PI) / 2
  );
  add(pillEndX - radius, -pillHalfHeight);
  addRoundedCorner(
    localPoints,
    pillEndX - radius,
    -pillHalfHeight + radius,
    radius,
    -Math.PI / 2,
    0
  );
  add(pillEndX, connectorTopY);
  if (direction === 'forward' && arrowWidth > 0) {
    if (pillEndX < connectorEndX) add(connectorEndX, connectorTopY);
    add(totalWidthPx, 0);
    add(connectorEndX, connectorBottomY);
  } else {
    if (pillEndX < connectorEndX) add(connectorEndX, connectorTopY);
    add(connectorEndX, connectorBottomY);
  }
  if (pillEndX < connectorEndX) add(pillEndX, connectorBottomY);
  add(pillEndX, pillHalfHeight - radius);
  addRoundedCorner(localPoints, pillEndX - radius, pillHalfHeight - radius, radius, 0, Math.PI / 2);
  add(pillStartX + radius, pillHalfHeight);
  addRoundedCorner(
    localPoints,
    pillStartX + radius,
    pillHalfHeight - radius,
    radius,
    Math.PI / 2,
    Math.PI
  );
  add(pillStartX, connectorBottomY);
  if (direction === 'reverse' && arrowWidth > 0) {
    if (pillStartX > connectorStartX) add(connectorStartX, connectorBottomY);
  } else if (pillStartX > connectorStartX) {
    add(connectorStartX, connectorBottomY);
  }

  return laneLocalPolygon(path, featureStartBp, offsetPx, localPoints, laneSamples);
}

export function drawLanePill(
  g: Graphics,
  path: PathMapper,
  startBp: number,
  widthPx: number,
  offsetPx: number,
  halfHeight: number,
  color: number,
  alpha: number,
  genomeLength: number
): number {
  if (widthPx <= 0) return startBp;
  const endBp = advanceBpByScreenWidth(path, startBp, widthPx, offsetPx);

  if (!path.isArcMode && endBp <= genomeLength) {
    const y = path.featureLabelPosAt(startBp, offsetPx).y - halfHeight;
    g.roundRect(
      path.bpLeftX(startBp),
      y,
      widthPx,
      halfHeight * 2,
      Math.min(3, halfHeight, widthPx / 2)
    );
    g.fill({ color, alpha });
    return endBp;
  }

  const pts = laneRoundedPillPolygon(path, startBp, widthPx, offsetPx, halfHeight);
  if (pts.length > 0) {
    g.poly(pts);
    g.fill({ color, alpha });
  }
  return endBp;
}
