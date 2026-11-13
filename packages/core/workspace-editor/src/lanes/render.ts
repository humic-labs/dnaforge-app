import { drawLaneDivider, drawLaneGutterDivider } from '../rendering/canvas-primitives';
import type {
  ColumnRange,
  LaneDrawState,
  LaneHeaderState,
  LaneHitState,
  MeasuredLane,
} from './types';
import type { MultiLaneLayout } from './layout';
import type { HitResult } from '../layout-interface';

export interface RenderMultiLaneOptions {
  background?: string | null;
  divider?: string | null;
  gutterDivider?: string | null;
  canvasWidth?: number;
  canvasHeight?: number;
}

const DEFAULT_BACKGROUND = '#ffffff';
const DEFAULT_DIVIDER = 'rgba(148, 163, 184, 0.35)';
const DEFAULT_GUTTER_DIVIDER = 'rgba(100, 116, 139, 0.55)';

function laneContentRect(
  lane: MeasuredLane,
  layout: MultiLaneLayout,
  width: number
): { x: number; y: number; w: number; h: number } {
  const x = layout.leftGutterWidth;
  const y = lane.y - layout.scrollTop;
  const w = Math.max(0, width - layout.leftGutterWidth);
  const h = lane.height;
  return { x, y, w, h };
}

function laneGutterRect(
  lane: MeasuredLane,
  layout: MultiLaneLayout
): { x: number; y: number; w: number; h: number } {
  return {
    x: 0,
    y: lane.y - layout.scrollTop,
    w: layout.leftGutterWidth,
    h: lane.height,
  };
}

function buildDrawState(
  lane: MeasuredLane,
  layout: MultiLaneLayout,
  contentWidth: number
): LaneDrawState {
  return {
    pxPerColumn: layout.pxPerColumn,
    lodTier: layout.lodTier,
    columnRange: layout.visibleColumnRange,
    laneY: lane.y - layout.scrollTop,
    laneHeight: lane.height,
    columnGridLeft: layout.columnGridLeft - layout.scrollLeft,
    contentWidth: Math.max(0, contentWidth),
  };
}

function buildHeaderState(lane: MeasuredLane, layout: MultiLaneLayout): LaneHeaderState {
  return {
    pxPerColumn: layout.pxPerColumn,
    lodTier: layout.lodTier,
    laneY: lane.y - layout.scrollTop,
    laneHeight: lane.height,
    width: layout.leftGutterWidth,
  };
}

export function renderMultiLane(
  ctx: CanvasRenderingContext2D,
  layout: MultiLaneLayout,
  options: RenderMultiLaneOptions = {}
): void {
  const width = options.canvasWidth ?? layout.viewportWidth;
  const height = options.canvasHeight ?? layout.viewportHeight;
  const background = options.background === undefined ? DEFAULT_BACKGROUND : options.background;
  const divider = options.divider === undefined ? DEFAULT_DIVIDER : options.divider;
  const gutterDivider =
    options.gutterDivider === undefined ? DEFAULT_GUTTER_DIVIDER : options.gutterDivider;

  if (background !== null) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);
  }

  const laneRectsById = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const lane of layout.visibleLanes) {
    laneRectsById.set(lane.id, laneContentRect(lane, layout, width));
  }

  for (const lane of layout.visibleLanes) {
    const content = laneContentRect(lane, layout, width);
    if (content.w > 0 && content.h > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(content.x, content.y, content.w, content.h);
      ctx.clip();
      lane.plugin.draw(ctx, layout.visibleColumnRange, buildDrawState(lane, layout, content.w));
      ctx.restore();
    }

    if (lane.plugin.header && layout.leftGutterWidth > 0) {
      const gutter = laneGutterRect(lane, layout);
      ctx.save();
      ctx.beginPath();
      ctx.rect(gutter.x, gutter.y, gutter.w, gutter.h);
      ctx.clip();
      lane.plugin.header.draw(ctx, buildHeaderState(lane, layout));
      ctx.restore();
    }
  }

  paintReferenceColumnOverlays(ctx, layout, laneRectsById);

  if (divider !== null && layout.visibleLanes.length > 1) {
    for (let i = 1; i < layout.visibleLanes.length; i++) {
      const lane = layout.visibleLanes[i];
      drawLaneDivider(ctx, 0, lane.y - layout.scrollTop, width, divider);
    }
  }

  if (gutterDivider !== null && layout.leftGutterWidth > 0) {
    drawLaneGutterDivider(ctx, layout.leftGutterWidth, 0, height, gutterDivider);
  }
}

export interface MultiLaneHitResult {
  laneId: string;
  lane: MeasuredLane;
  inGutter: boolean;
  hit: HitResult | null;
}

export function hitTestMultiLane(
  layout: MultiLaneLayout,
  x: number,
  y: number
): MultiLaneHitResult | null {
  if (x < 0 || y < 0) return null;

  const yWorld = y + layout.scrollTop;
  for (const lane of layout.lanes) {
    if (yWorld < lane.y || yWorld >= lane.y + lane.height) continue;
    const inGutter = x < layout.leftGutterWidth;
    const contentWidth = Math.max(0, layout.viewportWidth - layout.leftGutterWidth);
    const hit =
      !inGutter && lane.plugin.hitTest
        ? lane.plugin.hitTest(x, y, buildHitState(lane, layout, contentWidth))
        : null;
    return { laneId: lane.id, lane, inGutter, hit };
  }
  return null;
}

function buildHitState(
  lane: MeasuredLane,
  layout: MultiLaneLayout,
  contentWidth: number
): LaneHitState {
  return {
    pxPerColumn: layout.pxPerColumn,
    lodTier: layout.lodTier,
    columnRange: layout.visibleColumnRange,
    laneY: lane.y - layout.scrollTop,
    laneHeight: lane.height,
    columnGridLeft: layout.columnGridLeft - layout.scrollLeft,
    contentWidth: Math.max(0, contentWidth),
  };
}

function paintReferenceColumnOverlays(
  ctx: CanvasRenderingContext2D,
  layout: MultiLaneLayout,
  laneRects: ReadonlyMap<string, { x: number; y: number; w: number; h: number }>
): void {
  const { pxPerColumn, columnGridLeft, scrollLeft, visibleColumnRange } = layout;
  const seen = new Set<string>();
  ctx.save();
  for (const lane of layout.visibleLanes) {
    const overlays = lane.plugin.referenceColumnOverlays;
    if (!overlays || overlays.length === 0) continue;
    for (const overlay of overlays) {
      const dedupKey = `${lane.id}/${overlay.id}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      const rect = laneRects.get(overlay.target);
      if (!rect) continue;
      const isWash = overlay.kind === 'columnWash';
      const isTopMarker = overlay.kind === 'topMarker';
      const thickness = overlay.thickness ?? 2;
      const alpha = overlay.alpha ?? 0.28;
      ctx.fillStyle = overlay.color;
      ctx.globalAlpha = isWash ? alpha : 1;
      for (const col of overlay.columns) {
        if (col < visibleColumnRange.start || col >= visibleColumnRange.end) continue;
        const x = columnGridLeft - scrollLeft + col * pxPerColumn;
        if (isWash) {
          ctx.fillRect(x, rect.y, pxPerColumn, rect.h);
        } else if (isTopMarker) {
          ctx.fillRect(x, rect.y, pxPerColumn, thickness);
        } else {
          ctx.fillRect(x, rect.y + rect.h - thickness, pxPerColumn, thickness);
        }
      }
    }
  }
  ctx.restore();
}

export type { ColumnRange };
