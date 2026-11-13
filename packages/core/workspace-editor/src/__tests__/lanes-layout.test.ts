import { describe, expect, it } from 'vitest';
import {
  computeMultiLaneLayout,
  createFixedHeightLane,
  getLaneLodTier,
  LANE_LOD_CLOSE_MIN_PX_PER_COLUMN,
  LANE_LOD_WIDE_MAX_PX_PER_COLUMN,
  type LanePlugin,
} from '../lanes';

describe('1D multi-lane LOD', () => {
  it('uses absolute px-per-column thresholds', () => {
    expect(getLaneLodTier(LANE_LOD_WIDE_MAX_PX_PER_COLUMN - 0.01)).toBe('wide');
    expect(getLaneLodTier(LANE_LOD_WIDE_MAX_PX_PER_COLUMN)).toBe('medium');
    expect(getLaneLodTier(LANE_LOD_CLOSE_MIN_PX_PER_COLUMN - 0.01)).toBe('medium');
    expect(getLaneLodTier(LANE_LOD_CLOSE_MIN_PX_PER_COLUMN)).toBe('close');
  });
});

describe('computeMultiLaneLayout', () => {
  it('stacks lanes vertically and shares one visible column range', () => {
    const layout = computeMultiLaneLayout({
      columnCount: 1_000,
      pxPerColumn: 4,
      viewportWidth: 500,
      viewportHeight: 300,
      scrollLeft: 108,
      lanes: [
        createFixedHeightLane('reference', 30, 'reference'),
        createFixedHeightLane('read-a', 50, 'read'),
        createFixedHeightLane('consensus', 40, 'consensus'),
      ],
    });

    expect(layout.totalHeight).toBe(120);
    expect(layout.lanes.map((lane) => [lane.id, lane.y, lane.height])).toEqual([
      ['reference', 0, 30],
      ['read-a', 30, 50],
      ['consensus', 80, 40],
    ]);
    expect(layout.visibleColumnRange).toEqual({ start: 25, end: 150 });
    expect(layout.visibleLanes.map((lane) => lane.id)).toEqual([
      'reference',
      'read-a',
      'consensus',
    ]);
  });

  it('subtracts the fixed left gutter from the visible content width', () => {
    const layout = computeMultiLaneLayout({
      columnCount: 100,
      pxPerColumn: 10,
      viewportWidth: 220,
      viewportHeight: 100,
      leftGutterWidth: 80,
      lanes: [createFixedHeightLane('reference', 30, 'reference')],
    });

    expect(layout.leftGutterWidth).toBe(80);
    expect(layout.columnGridLeft).toBe(88);
    expect(layout.visibleColumnRange).toEqual({ start: 0, end: 17 });
  });

  it('uses the widest lane header as the fixed gutter width', () => {
    const laneWithHeader: LanePlugin = {
      ...createFixedHeightLane('read-a', 30, 'read'),
      header: {
        width: 160,
        draw: () => {},
      },
    };

    const layout = computeMultiLaneLayout({
      columnCount: 100,
      pxPerColumn: 10,
      viewportWidth: 300,
      viewportHeight: 100,
      leftGutterWidth: 80,
      lanes: [createFixedHeightLane('reference', 30, 'reference'), laneWithHeader],
    });

    expect(layout.leftGutterWidth).toBe(160);
    expect(layout.lanes.map((lane) => lane.headerWidth)).toEqual([0, 160]);
  });

  it('culls visible lanes by vertical scroll position', () => {
    const layout = computeMultiLaneLayout({
      columnCount: 100,
      pxPerColumn: 4,
      viewportWidth: 300,
      viewportHeight: 75,
      scrollTop: 45,
      lanes: [
        createFixedHeightLane('reference', 30, 'reference'),
        createFixedHeightLane('read-a', 40, 'read'),
        createFixedHeightLane('read-b', 40, 'read'),
        createFixedHeightLane('consensus', 30, 'consensus'),
      ],
    });

    expect(layout.totalHeight).toBe(140);
    expect(layout.requiresVerticalScroll).toBe(true);
    expect(layout.visibleLanes.map((lane) => lane.id)).toEqual(['read-a', 'read-b', 'consensus']);
  });

  it('clamps invalid lane heights to zero', () => {
    const badLane: LanePlugin = {
      id: 'bad',
      type: 'read',
      height: () => Number.NaN,
      draw: () => {},
    };

    const layout = computeMultiLaneLayout({
      columnCount: 10,
      pxPerColumn: 4,
      viewportWidth: 100,
      viewportHeight: 100,
      lanes: [badLane],
    });

    expect(layout.totalHeight).toBe(0);
    expect(layout.lanes[0].height).toBe(0);
  });
});
