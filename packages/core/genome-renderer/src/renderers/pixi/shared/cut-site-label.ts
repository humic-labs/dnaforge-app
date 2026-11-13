import type { PathMapper } from './path-mapper';
import type { Text } from 'pixi.js';
import { CurvedLabelRenderer, getMeasureCtx } from './curved-label';

export interface CutSiteLabelAnchor {
  labelBp: number;
  labelW: number;
  labelH: number;
  labelTopX: number;
  labelTopY: number;
  labelCenterX: number;
  labelCenterY: number;
  angle: number;
}

type ResolvedCutSiteLabel<T> = T & {
  finalBp: number;
  finalTopX: number;
  finalTopY: number;
  finalCenterX: number;
  finalCenterY: number;
  finalAngle: number;
  displaced: boolean;
};
const LABEL_MIN_GAP = 4;
function resolveLinearLabels<T extends CutSiteLabelAnchor>(
  labels: T[],
  path: PathMapper
): ResolvedCutSiteLabel<T>[] {
  const candidates = [...labels]
    .sort((a, b) => a.labelTopX - b.labelTopX)
    .map((label) => ({
      ...label,
      finalBp: label.labelBp,
      finalTopX: label.labelTopX,
      finalTopY: label.labelTopY,
      finalCenterX: label.labelCenterX,
      finalCenterY: label.labelCenterY,
      finalAngle: label.angle,
      displaced: false,
    }));

  const resolved: ResolvedCutSiteLabel<T>[] = [];
  for (const curr of candidates) {
    const prev = resolved[resolved.length - 1];
    if (!prev) {
      resolved.push(curr);
      continue;
    }

    const prevRight = prev.finalCenterX + prev.labelW / 2 + LABEL_MIN_GAP;
    const currLeft = curr.labelCenterX - curr.labelW / 2;
    if (currLeft < prevRight) {
      curr.finalCenterX = prevRight + curr.labelW / 2;
      curr.finalTopX = curr.finalCenterX;
      curr.displaced = true;
    }

    curr.finalBp = curr.labelBp + (curr.finalCenterX - curr.labelCenterX) / path.pixelsPerBp;
    resolved.push(curr);
  }

  return resolved;
}

function labelDistAtBp(samples: LabelArcSample[], targetBp: number): number {
  if (samples.length === 0) return 0;
  if (targetBp <= samples[0].bp) return samples[0].dist;
  const last = samples[samples.length - 1];
  if (targetBp >= last.bp) return last.dist;

  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const curr = samples[i];
    if (targetBp > curr.bp) continue;
    const t = (targetBp - prev.bp) / (curr.bp - prev.bp || 1);
    return prev.dist + (curr.dist - prev.dist) * t;
  }

  return last.dist;
}

function buildLabelCollisionSamples<T extends CutSiteLabelAnchor>(
  path: PathMapper,
  labels: T[]
): LabelArcSample[] {
  if (labels.length === 0) return [];

  const minBp = Math.min(...labels.map((label) => label.labelBp));
  const maxBp = Math.max(...labels.map((label) => label.labelBp));
  const totalPackedWidth = labels.reduce(
    (sum, label) => sum + label.labelW + LABEL_MIN_GAP,
    LABEL_MIN_GAP
  );
  const minPixelsPerBp = Math.max(
    0.001,
    Math.min(...labels.map((label) => labelPixelsPerBp(path, label.labelBp, label.labelH)))
  );
  const padBp = Math.max(4, totalPackedWidth / minPixelsPerBp);
  const startBp = minBp - padBp;
  const endBp = maxBp + padBp;
  const approxPx = Math.max(1, (endBp - startBp) * minPixelsPerBp);
  const sampleCount = Math.max(16, Math.min(2048, Math.ceil(approxPx / LABEL_CURVE_SEGMENT_PX)));

  const samples: LabelArcSample[] = [];
  let dist = 0;
  for (let i = 0; i <= sampleCount; i++) {
    const bp = startBp + (endBp - startBp) * (i / sampleCount);
    const placement = labelPlacementAt(path, bp, labels[0].labelH);
    if (samples.length > 0) {
      const prev = samples[samples.length - 1];
      dist += Math.hypot(placement.centerX - prev.centerX, placement.centerY - prev.centerY);
    }
    samples.push({ ...placement, bp, dist });
  }

  return samples;
}

function resolveArcLabels<T extends CutSiteLabelAnchor>(
  labels: T[],
  path: PathMapper,
  genomeLength: number
): ResolvedCutSiteLabel<T>[] {
  let sorted = [...labels].sort((a, b) => a.labelBp - b.labelBp);
  if (genomeLength > 0 && sorted.length > 1) {
    let first = 0;
    let largestGap = -1;
    for (let i = 0; i < sorted.length; i++) {
      const next = (i + 1) % sorted.length;
      const gap = sorted[next].labelBp + (next === 0 ? genomeLength : 0) - sorted[i].labelBp;
      if (gap > largestGap) {
        largestGap = gap;
        first = next;
      }
    }
    sorted = [
      ...sorted.slice(first),
      ...sorted.slice(0, first).map((label) => ({
        ...label,
        labelBp: label.labelBp + genomeLength,
      })),
    ];
  }
  const samples = buildLabelCollisionSamples(path, sorted);
  const resolved: ResolvedCutSiteLabel<T>[] = [];
  let previousEndDist = Number.NEGATIVE_INFINITY;

  for (const label of sorted) {
    const originalCenterDist = labelDistAtBp(samples, label.labelBp);
    const minCenterDist = previousEndDist + LABEL_MIN_GAP + label.labelW / 2;
    const finalCenterDist = Math.max(originalCenterDist, minCenterDist);

    const finalBp = bpAtLabelDist(samples, finalCenterDist);
    const placement = labelPlacementAt(path, finalBp, label.labelH);

    previousEndDist = finalCenterDist + label.labelW / 2;
    resolved.push({
      ...label,
      finalBp,
      finalTopX: placement.topX,
      finalTopY: placement.topY,
      finalCenterX: placement.centerX,
      finalCenterY: placement.centerY,
      finalAngle: placement.angle,
      displaced: Math.abs(finalCenterDist - originalCenterDist) > 0.5,
    });
  }

  return resolved;
}

export function resolveCutSiteLabels<T extends CutSiteLabelAnchor>(
  labels: T[],
  path: PathMapper,
  genomeLength = 0
): ResolvedCutSiteLabel<T>[] {
  return path.isArcMode
    ? resolveArcLabels(labels, path, genomeLength)
    : resolveLinearLabels(labels, path);
}

const LABEL_CURVE_SEGMENT_PX = 4;
const MAX_LABEL_CURVE_SEGMENTS = 64;
const CONNECTOR_CURVE_SEGMENT_PX = 6;
export type LabelArcSample = ReturnType<typeof labelPlacementAt> & { bp: number; dist: number };

function labelCenterFromTop(
  x: number,
  y: number,
  angle: number,
  labelHeight: number
): { x: number; y: number } {
  const nx = -Math.sin(angle);
  const ny = Math.cos(angle);
  return {
    x: x + nx * (labelHeight / 2),
    y: y + ny * (labelHeight / 2),
  };
}

export function labelPlacementAt(path: PathMapper, bp: number, labelHeight: number) {
  const top = path.cutLabelAt(bp);
  const angle = path.backboneAt(bp).angle;
  const center = labelCenterFromTop(top.x, top.y, angle, labelHeight);
  return { topX: top.x, topY: top.y, centerX: center.x, centerY: center.y, angle };
}

export function readableTextRotation(angle: number): number {
  let normalized = ((angle + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (normalized > Math.PI / 2) normalized -= Math.PI;
  if (normalized < -Math.PI / 2) normalized += Math.PI;
  return normalized;
}

function flatLabelBoxPolygon(
  cx: number,
  cy: number,
  angle: number,
  width: number,
  height: number
): number[] {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const lhw = width / 2;
  const lhh = height / 2;
  return [
    cx + lhw * cos - lhh * -sin,
    cy + lhw * sin - lhh * cos,
    cx - lhw * cos - lhh * -sin,
    cy - lhw * sin - lhh * cos,
    cx - lhw * cos + lhh * -sin,
    cy - lhw * sin + lhh * cos,
    cx + lhw * cos + lhh * -sin,
    cy + lhw * sin + lhh * cos,
  ];
}

export function labelPixelsPerBp(path: PathMapper, bp: number, labelHeight: number): number {
  const prev = labelPlacementAt(path, bp - 1, labelHeight);
  const next = labelPlacementAt(path, bp + 1, labelHeight);
  const sampled = Math.hypot(next.centerX - prev.centerX, next.centerY - prev.centerY) / 2;
  return sampled > 1e-4 ? sampled : Math.max(path.pixelsPerBp, 1e-4);
}

function buildLabelArcSamples(
  path: PathMapper,
  centerBp: number,
  widthPx: number,
  labelHeight: number
): { samples: LabelArcSample[]; centerDist: number } {
  const pxPerBp = labelPixelsPerBp(path, centerBp, labelHeight);
  const spanBp = Math.max(2, (widthPx / pxPerBp) * 2);
  const startBp = centerBp - spanBp / 2;
  const endBp = centerBp + spanBp / 2;
  const sampleCount = Math.max(16, Math.min(96, Math.ceil(widthPx / 2)));
  const bps = [centerBp];
  for (let i = 0; i <= sampleCount; i++) {
    bps.push(startBp + (endBp - startBp) * (i / sampleCount));
  }
  bps.sort((a, b) => a - b);

  const samples: LabelArcSample[] = [];
  let dist = 0;
  for (const bp of bps) {
    if (samples.length > 0 && Math.abs(bp - samples[samples.length - 1].bp) < 1e-6) continue;
    const placement = labelPlacementAt(path, bp, labelHeight);
    if (samples.length > 0) {
      const prev = samples[samples.length - 1];
      dist += Math.hypot(placement.centerX - prev.centerX, placement.centerY - prev.centerY);
    }
    samples.push({ ...placement, bp, dist });
  }

  const centerSample = samples.find((sample) => Math.abs(sample.bp - centerBp) < 1e-6);
  return { samples, centerDist: centerSample?.dist ?? dist / 2 };
}

export function bpAtLabelDist(samples: LabelArcSample[], targetDist: number): number {
  if (samples.length === 0) return 0;
  if (targetDist <= samples[0].dist) return samples[0].bp;
  const last = samples[samples.length - 1];
  if (targetDist >= last.dist) return last.bp;

  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const curr = samples[i];
    if (targetDist > curr.dist) continue;
    const t = (targetDist - prev.dist) / (curr.dist - prev.dist || 1);
    return prev.bp + (curr.bp - prev.bp) * t;
  }

  return last.bp;
}

function pushUniquePoint(points: Array<{ x: number; y: number }>, point: { x: number; y: number }) {
  const prev = points[points.length - 1];
  if (prev && Math.hypot(point.x - prev.x, point.y - prev.y) < 0.5) return;
  points.push(point);
}

export function buildCutSiteLabelConnectorPolyline(
  path: PathMapper,
  labelHeight: number,
  anchor: { x: number; y: number },
  labelBp: number,
  finalBp: number
): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  pushUniquePoint(points, anchor);

  const original = labelPlacementAt(path, labelBp, labelHeight);
  pushUniquePoint(points, { x: original.topX, y: original.topY });

  const deltaBp = finalBp - labelBp;
  if (Math.abs(deltaBp) < 1e-6) return points;

  const midBp = labelBp + deltaBp / 2;
  const approxPx = Math.abs(deltaBp) * labelPixelsPerBp(path, midBp, labelHeight);
  const segmentCount = path.isArcMode
    ? Math.max(
        1,
        Math.min(MAX_LABEL_CURVE_SEGMENTS, Math.ceil(approxPx / CONNECTOR_CURVE_SEGMENT_PX))
      )
    : 1;

  for (let i = 1; i <= segmentCount; i++) {
    const bp = labelBp + deltaBp * (i / segmentCount);
    const p = labelPlacementAt(path, bp, labelHeight);
    pushUniquePoint(points, { x: p.topX, y: p.topY });
  }

  return points;
}

function curvedLabelBoxPolygon(
  path: PathMapper,
  centerBp: number,
  widthPx: number,
  labelHeight: number
): number[] {
  const { samples, centerDist } = buildLabelArcSamples(path, centerBp, widthPx, labelHeight);
  if (samples.length < 2) return [];
  const startBp = bpAtLabelDist(samples, centerDist - widthPx / 2);
  const endBp = bpAtLabelDist(samples, centerDist + widthPx / 2);
  const spanBp = endBp - startBp;
  if (spanBp <= 0) return [];

  const segmentCount = Math.max(
    2,
    Math.min(MAX_LABEL_CURVE_SEGMENTS, Math.ceil(widthPx / LABEL_CURVE_SEGMENT_PX))
  );
  const top: number[] = [];
  const bottom: number[] = [];

  for (let i = 0; i <= segmentCount; i++) {
    const bp = startBp + spanBp * (i / segmentCount);
    const p = labelPlacementAt(path, bp, labelHeight);
    const nx = -Math.sin(p.angle);
    const ny = Math.cos(p.angle);
    top.push(p.topX, p.topY);
    bottom.push(p.topX + nx * labelHeight, p.topY + ny * labelHeight);
  }

  const pts = [...top];
  for (let i = bottom.length - 2; i >= 0; i -= 2) {
    pts.push(bottom[i], bottom[i + 1]);
  }
  pts.push(top[0], top[1]);
  return pts;
}

export function labelBoxPolygonAtPath(
  path: PathMapper,
  centerBp: number,
  width: number,
  height: number
): number[] {
  if (path.isArcMode) {
    const curved = curvedLabelBoxPolygon(path, centerBp, width, height);
    if (curved.length > 0) return curved;
  }

  const placement = labelPlacementAt(path, centerBp, height);
  return flatLabelBoxPolygon(placement.centerX, placement.centerY, placement.angle, width, height);
}

export function renderCutSiteLabelText(
  text: Text,
  curved: CurvedLabelRenderer,
  path: PathMapper,
  centerBp: number,
  height: number,
  color: number,
  alpha = 1
): void {
  text.renderable = !path.isArcMode;
  if (!path.isArcMode) return;
  const ctx = getMeasureCtx();
  const style = text.style;
  ctx.font = `${style.fontWeight} ${style.fontSize}px ${style.fontFamily}`;
  const width = ctx.measureText(text.text).width;
  const { samples, centerDist } = buildLabelArcSamples(path, centerBp, width, height);
  const mid = labelPlacementAt(path, centerBp, height);
  const flip = Math.cos(mid.angle) < 0;
  const prev = labelPlacementAt(path, centerBp - 1, height);
  const next = labelPlacementAt(path, centerBp + 1, height);
  const tangentDirection =
    (next.centerX - prev.centerX) * Math.cos(mid.angle) +
      (next.centerY - prev.centerY) * Math.sin(mid.angle) >=
    0
      ? 1
      : -1;
  const direction = tangentDirection * (flip ? -1 : 1);
  curved.renderLabel(
    text.text,
    (t) => {
      const bp = bpAtLabelDist(samples, centerDist + (t - 0.5) * width * direction);
      const p = labelPlacementAt(path, bp, height);
      return { x: p.centerX, y: p.centerY, angle: p.angle };
    },
    Number(style.fontSize),
    color,
    1,
    flip,
    alpha,
    style
  );
}
