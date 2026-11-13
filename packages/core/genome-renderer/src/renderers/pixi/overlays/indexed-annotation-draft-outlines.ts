import type { Graphics } from 'pixi.js';
import type { Feature } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import { drawDashedPolyline, type Point2 } from '../shared/dashed-line';
import { advanceBpByScreenWidth } from '../shared/lane-path';
import type { InteractionOutlineStyle } from '../shared/interaction-outline';
import { flatPolygonToPolyline, type OutlineCommand } from './annotation-feature-geometry';

export const DRAFT_OUTLINE_DASH_PX = 2;
export const DRAFT_OUTLINE_GAP_PX = 2;

export function strokeLanePill(
  g: Graphics,
  path: PathMapper,
  startBp: number,
  widthPx: number,
  offset: number,
  halfHeight: number,
  color: number,
  alpha: number,
  genomeLength: number,
  laneRoundedPillPolygon: (
    path: PathMapper,
    startBp: number,
    widthPx: number,
    offset: number,
    halfHeight: number
  ) => number[]
): void {
  if (widthPx <= 0) return;
  const endBp = advanceBpByScreenWidth(path, startBp, widthPx, offset);
  g.setStrokeStyle({ width: path.scaleStroke(1.5), color, alpha });
  if (!path.isArcMode && endBp <= genomeLength) {
    const y = path.featureLabelPosAt(startBp, offset).y - halfHeight;
    g.roundRect(
      path.bpLeftX(startBp),
      y,
      widthPx,
      halfHeight * 2,
      Math.min(3, halfHeight, widthPx / 2)
    );
  } else {
    const pts = laneRoundedPillPolygon(path, startBp, widthPx, offset, halfHeight);
    if (pts.length < 6) return;
    g.poly(pts);
  }
  g.stroke();
}

export function setFeatureOutline(
  outlineCache: Map<number, OutlineCommand[]>,
  featureId: number,
  commands: OutlineCommand[]
): void {
  outlineCache.set(
    featureId,
    commands.filter((command) => {
      if (command.kind === 'poly') return command.pts.length >= 6;
      if (command.kind === 'polyline') return command.pts.length >= 4;
      return true;
    })
  );
}

export function addFeatureOutline(
  outlineCache: Map<number, OutlineCommand[]>,
  featureId: number,
  command: OutlineCommand
): void {
  const existing = outlineCache.get(featureId);
  if (existing) {
    existing.push(command);
  } else {
    outlineCache.set(featureId, [command]);
  }
}

export function strokeCurrentPath(
  g: Graphics,
  path: PathMapper,
  color: number,
  alpha: number,
  width = 1.5
): void {
  g.setStrokeStyle({ width: path.scaleStroke(width), color, alpha });
  g.stroke();
}

export function strokeOutlineCommands(
  g: Graphics,
  path: PathMapper,
  commands: OutlineCommand[],
  color: number,
  alpha: number
): void {
  if (commands.length === 0) return;
  g.setStrokeStyle({ width: path.scaleStroke(1.5), color, alpha });
  for (const command of commands) {
    strokeOutlineCommand(g, command);
  }
}

export function invalidateCameraDependentInteractionOutline(
  host: {
    retainedOverviewMode: string;
    retainedLinearTranscriptFeatureSet: ReadonlySet<Feature> | null;
    featureById: Map<number, Feature>;
    outlineCache: Map<number, OutlineCommand[]>;
  },
  featureId: number,
  isTranscript: (feature: Feature) => boolean
): void {
  if (host.retainedOverviewMode !== 'retained') return;
  const retainedSet = host.retainedLinearTranscriptFeatureSet;
  if (!retainedSet || retainedSet.size === 0) return;
  const feature = host.featureById.get(featureId);
  if (!feature || !retainedSet.has(feature) || !isTranscript(feature)) return;
  host.outlineCache.delete(featureId);
}

export function strokeOutlineCommand(g: Graphics, command: OutlineCommand): void {
  if (command.kind === 'poly') {
    g.poly(command.pts);
  } else if (command.kind === 'polyline') {
    if (command.pts.length < 4) return;
    g.moveTo(command.pts[0], command.pts[1]);
    for (let i = 2; i < command.pts.length; i += 2) {
      g.lineTo(command.pts[i], command.pts[i + 1]);
    }
  } else {
    g.roundRect(command.x, command.y, command.width, command.height, command.radius);
  }
  g.stroke();
}

export function interactionOutlineStrokeStyle(
  command: OutlineCommand,
  style: InteractionOutlineStyle
): InteractionOutlineStyle & { alignment: number } {
  let bodyWidth = Infinity;
  if (command.kind === 'roundRect') {
    bodyWidth = Math.min(Math.abs(command.width), Math.abs(command.height));
  } else if (command.kind === 'poly' && command.pts.length >= 6) {
    const points = command.pts;
    let twiceArea = 0;
    let perimeter = 0;
    for (let i = 0; i < points.length; i += 2) {
      const next = (i + 2) % points.length;
      const x = points[i] - points[0];
      const y = points[i + 1] - points[1];
      const nextX = points[next] - points[0];
      const nextY = points[next + 1] - points[1];
      twiceArea += x * nextY - nextX * y;
      perimeter += Math.hypot(nextX - x, nextY - y);
    }
    if (perimeter > 0) bodyWidth = Math.abs(twiceArea) / perimeter;
  }
  const narrow = bodyWidth <= Math.max(2, style.width);
  return { ...style, width: narrow ? style.width / 2 : style.width, alignment: narrow ? 0 : 0.5 };
}

export function strokeDraftOutlineCommands(
  g: Graphics,
  path: PathMapper,
  commands: OutlineCommand[],
  color: number,
  alpha: number
): void {
  if (commands.length === 0) return;
  g.setStrokeStyle({ width: path.scaleStroke(1.5), color, alpha });
  for (const command of commands) {
    if (command.kind === 'poly') {
      drawDashedPolyline(
        g,
        flatPolygonToPolyline(command.pts),
        DRAFT_OUTLINE_DASH_PX,
        DRAFT_OUTLINE_GAP_PX
      );
    } else if (command.kind === 'polyline') {
      const points: Point2[] = [];
      for (let i = 0; i + 1 < command.pts.length; i += 2) {
        points.push({ x: command.pts[i], y: command.pts[i + 1] });
      }
      drawDashedPolyline(g, points, DRAFT_OUTLINE_DASH_PX, DRAFT_OUTLINE_GAP_PX);
    } else {
      drawDashedPolyline(
        g,
        [
          { x: command.x, y: command.y },
          { x: command.x + command.width, y: command.y },
          { x: command.x + command.width, y: command.y + command.height },
          { x: command.x, y: command.y + command.height },
          { x: command.x, y: command.y },
        ],
        DRAFT_OUTLINE_DASH_PX,
        DRAFT_OUTLINE_GAP_PX
      );
    }
  }
}
