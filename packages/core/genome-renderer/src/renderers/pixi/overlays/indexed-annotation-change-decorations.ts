import type { Graphics } from 'pixi.js';
import type { Feature, RenderState } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import { drawDashedPolyline, type Point2 } from '../shared/dashed-line';
import type { OutlineCommand } from './annotation-feature-geometry';

export interface AnnotationChangeDecorationHost {
  readonly featureById: ReadonlyMap<number, Feature>;
  readonly outlineCache: ReadonlyMap<number, OutlineCommand[]>;
  invalidateCameraDependentInteractionOutline(id: number): void;
  ensureInteractionOutline(path: PathMapper, id: number): void;
}

function metadataOutlineColor(color: number): number {
  return (
    (Math.max(0, ((color >>> 16) & 255) - 60) << 16) |
    (Math.max(0, ((color >>> 8) & 255) - 60) << 8) |
    Math.max(0, (color & 255) - 60)
  );
}

function commandPoints(command: OutlineCommand): Point2[] {
  if (command.kind !== 'roundRect') {
    const points: Point2[] = [];
    for (let index = 0; index + 1 < command.pts.length; index += 2)
      points.push({ x: command.pts[index]!, y: command.pts[index + 1]! });
    return points;
  }
  const { x, y, width, height } = command;
  const radius = Math.max(0, Math.min(command.radius, width / 2, height / 2));
  if (!radius)
    return [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height },
    ];
  const points: Point2[] = [];
  for (const [cx, cy, start] of [
    [x + width - radius, y + radius, -Math.PI / 2],
    [x + width - radius, y + height - radius, 0],
    [x + radius, y + height - radius, Math.PI / 2],
    [x + radius, y + radius, Math.PI],
  ] as const)
    for (let step = 0; step <= 4; step += 1) {
      const angle = start + (step * Math.PI) / 8;
      points.push({ x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius });
    }
  return points;
}

function clipPolygon(points: Point2[], left: number, right: number): Point2[] {
  let clipped = points;
  for (const [boundary, sign] of [
    [left, 1],
    [right, -1],
  ] as const) {
    const next: Point2[] = [];
    for (let index = 0; index < clipped.length; index += 1) {
      const a = clipped[index]!;
      const b = clipped[(index + 1) % clipped.length]!;
      const insideA = (a.x - boundary) * sign >= 0;
      const insideB = (b.x - boundary) * sign >= 0;
      if (insideA) next.push(a);
      if (insideA !== insideB) {
        const t = (boundary - a.x) / (b.x - a.x);
        next.push({ x: boundary, y: a.y + t * (b.y - a.y) });
      }
    }
    clipped = next;
  }
  return clipped;
}

function clipLine(points: Point2[], left: number, right: number): Point2[][] {
  const segments: Point2[][] = [];
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]!;
    const b = points[index]!;
    const dx = b.x - a.x;
    if (dx === 0) {
      if (a.x >= left && a.x <= right) segments.push([a, b]);
      continue;
    }
    const first = Math.max(0, Math.min((left - a.x) / dx, (right - a.x) / dx));
    const last = Math.min(1, Math.max((left - a.x) / dx, (right - a.x) / dx));
    if (last <= first) continue;
    segments.push([
      { x: a.x + dx * first, y: a.y + (b.y - a.y) * first },
      { x: a.x + dx * last, y: a.y + (b.y - a.y) * last },
    ]);
  }
  return segments;
}

export function renderAnnotationChangeDecorations(
  host: AnnotationChangeDecorationHost,
  graphics: Graphics,
  path: PathMapper,
  state: RenderState
): { commandCount: number; featureIds: number[] } {
  const decorations = state.annotationChangeDecorations;
  if (!decorations?.size) return { commandCount: 0, featureIds: [] };
  let commandCount = 0;
  const featureIds: number[] = [];
  for (const [featureId, decoration] of decorations) {
    const feature = host.featureById.get(featureId);
    if (!feature) continue;

    host.invalidateCameraDependentInteractionOutline(featureId);
    host.ensureInteractionOutline(path, featureId);
    const commands = host.outlineCache.get(featureId);
    if (!commands?.length) continue;
    const color =
      decoration.color ??
      (decoration.kind === 'removed' ? 0xdf3a3a : metadataOutlineColor(feature.color));
    const rangeClips = decoration.ranges?.map((range) => ({
      left: path.bpLeftX(range.start),
      right: path.bpLeftX(range.end),
    }));

    if (path.isArcMode && rangeClips) continue;
    const viewport = path.isArcMode
      ? { left: Number.NEGATIVE_INFINITY, right: Number.POSITIVE_INFINITY }
      : { left: path.bpLeftX(path.viewStartBp), right: path.bpLeftX(path.viewEndBp) };
    const clips = rangeClips ?? [viewport];
    let featureCommandCount = 0;
    graphics.setStrokeStyle({ width: path.scaleStroke(1.75), color, alpha: 1 });
    for (const command of commands) {
      const source = commandPoints(command);
      if (source.length < 2) continue;
      for (const clip of clips) {
        const left = Math.max(viewport.left, clip.left),
          right = Math.min(viewport.right, clip.right);
        if (!(right > left)) continue;
        if (command.kind === 'polyline') {
          const segments = clipLine(source, left, right);
          for (const segment of segments) drawDashedPolyline(graphics, segment, 3, 2.5);
          if (segments.length) featureCommandCount += 1;
          continue;
        }
        const points = clipPolygon(source, left, right);
        if (points.length < 3) continue;
        if (decoration.kind === 'removed' || rangeClips) {
          graphics.poly(points.flatMap((point) => [point.x, point.y]));
          graphics.fill({ color, alpha: decoration.kind === 'removed' ? 0.16 : 0.18 });
        }
        drawDashedPolyline(graphics, [...points, points[0]!], 3, 2.5);
        if (decoration.kind === 'removed') {
          const low = Math.min(...points.map((point) => point.x)),
            high = Math.max(...points.map((point) => point.x));
          const y =
            (Math.min(...points.map((point) => point.y)) +
              Math.max(...points.map((point) => point.y))) /
            2;
          graphics.moveTo(low, y);
          graphics.lineTo(high, y);
          graphics.stroke();
        }
        featureCommandCount += 1;
      }
    }
    if (featureCommandCount) {
      featureIds.push(featureId);
      commandCount += featureCommandCount;
    }
  }
  return { commandCount, featureIds };
}
