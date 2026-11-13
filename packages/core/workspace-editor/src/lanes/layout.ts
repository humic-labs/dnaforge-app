import { HORIZONTAL_PADDING_1D, MIN_PX_PER_BASE_1D, MAX_PX_PER_BASE_1D } from '../layout-1d';
import { getLaneLodTier } from './lod';
import type { ColumnRange, LaneHeightState, LanePlugin, MeasuredLane } from './types';

export interface MultiLaneLayoutInput {
  columnCount: number;
  pxPerColumn: number;
  viewportWidth: number;
  viewportHeight: number;
  scrollLeft?: number;
  scrollTop?: number;
  leftGutterWidth?: number;
  lanes: readonly LanePlugin[];
}

export interface MultiLaneLayout {
  columnCount: number;
  pxPerColumn: number;
  lodTier: LaneHeightState['lodTier'];
  totalWidth: number;
  totalHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  scrollLeft: number;
  scrollTop: number;
  leftGutterWidth: number;
  columnGridLeft: number;
  visibleColumnRange: ColumnRange;
  lanes: MeasuredLane[];
  visibleLanes: MeasuredLane[];
  requiresVerticalScroll: boolean;
}

function clampFinite(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function measureLaneHeight(plugin: LanePlugin, state: LaneHeightState): number {
  return clampFinite(plugin.height(state), 0, Number.MAX_SAFE_INTEGER);
}

function computeVisibleColumnRange(input: {
  columnCount: number;
  pxPerColumn: number;
  scrollLeft: number;
  visibleContentWidth: number;
}): ColumnRange {
  const { columnCount, pxPerColumn, scrollLeft, visibleContentWidth } = input;
  if (columnCount <= 0 || visibleContentWidth <= 0) return { start: 0, end: 0 };

  const visibleLeft = Math.max(0, scrollLeft - HORIZONTAL_PADDING_1D);
  const visibleRight = Math.max(
    visibleLeft,
    scrollLeft + visibleContentWidth - HORIZONTAL_PADDING_1D
  );
  const start = clampFinite(Math.floor(visibleLeft / pxPerColumn), 0, columnCount);
  const end = clampFinite(Math.ceil(visibleRight / pxPerColumn), start, columnCount);
  return { start, end };
}

export function computeMultiLaneLayout(input: MultiLaneLayoutInput): MultiLaneLayout {
  const columnCount = Math.max(0, Math.floor(input.columnCount));
  const pxPerColumn = clampFinite(input.pxPerColumn, MIN_PX_PER_BASE_1D, MAX_PX_PER_BASE_1D);
  const viewportWidth = Math.max(0, input.viewportWidth);
  const viewportHeight = Math.max(0, input.viewportHeight);
  const scrollLeft = Math.max(0, input.scrollLeft ?? 0);
  const scrollTop = Math.max(0, input.scrollTop ?? 0);
  const lodTier = getLaneLodTier(pxPerColumn);

  const state: LaneHeightState = { pxPerColumn, lodTier };
  let leftGutterWidth = Math.max(0, input.leftGutterWidth ?? 0);
  for (const lane of input.lanes) {
    leftGutterWidth = Math.max(leftGutterWidth, Math.max(0, lane.header?.width ?? 0));
  }

  let y = 0;
  const laneViewportBottom = scrollTop + viewportHeight;
  const lanes: MeasuredLane[] = input.lanes.map((plugin) => {
    const height = measureLaneHeight(plugin, state);
    const laneTop = y;
    const laneBottom = laneTop + height;
    y = laneBottom;
    return {
      id: plugin.id,
      type: plugin.type,
      plugin,
      y: laneTop,
      height,
      visible: laneBottom > scrollTop && laneTop < laneViewportBottom,
      headerWidth: Math.max(0, plugin.header?.width ?? 0),
    };
  });

  const totalHeight = y;
  const visibleContentWidth = Math.max(0, viewportWidth - leftGutterWidth);
  const visibleColumnRange = computeVisibleColumnRange({
    columnCount,
    pxPerColumn,
    scrollLeft,
    visibleContentWidth,
  });

  return {
    columnCount,
    pxPerColumn,
    lodTier,
    totalWidth: leftGutterWidth + HORIZONTAL_PADDING_1D * 2 + columnCount * pxPerColumn,
    totalHeight,
    viewportWidth,
    viewportHeight,
    scrollLeft,
    scrollTop,
    leftGutterWidth,
    columnGridLeft: leftGutterWidth + HORIZONTAL_PADDING_1D,
    visibleColumnRange,
    lanes,
    visibleLanes: lanes.filter((lane) => lane.visible),
    requiresVerticalScroll: totalHeight > viewportHeight,
  };
}

export function createFixedHeightLane(
  id: string,
  height: number,
  type: LanePlugin['type'] = 'feature'
): LanePlugin {
  return {
    id,
    type,
    height: () => height,
    draw: () => {},
  };
}
