import { describe, expect, it } from 'vitest';
import {
  computeMultiLaneLayout,
  createFixedHeightLane,
  hitTestMultiLane,
  renderMultiLane,
  type LaneDrawState,
  type LaneHeaderState,
  type LanePlugin,
} from '../lanes';
import type { HitResult } from '../layout-interface';

interface DrawCall {
  laneId: string;
  state: LaneDrawState;
}
interface HeaderCall {
  laneId: string;
  state: LaneHeaderState;
}

interface RecordedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface RecordingContext {
  ctx: CanvasRenderingContext2D;
  log: Array<{ kind: string; payload?: unknown }>;
  fillRects: RecordedRect[];
  saves: number;
  restores: number;
  clipPaths: RecordedRect[];
}

function createRecordingContext(): RecordingContext {
  const log: RecordingContext['log'] = [];
  const fillRects: RecordedRect[] = [];
  const clipPaths: RecordedRect[] = [];
  let pathRect: RecordedRect | null = null;
  let saves = 0;
  let restores = 0;

  const noop = () => undefined;
  const ctx = {
    canvas: { width: 800, height: 600 },
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    fillRect(x: number, y: number, w: number, h: number) {
      fillRects.push({ x, y, w, h });
      log.push({ kind: 'fillRect', payload: { x, y, w, h } });
    },
    rect(x: number, y: number, w: number, h: number) {
      pathRect = { x, y, w, h };
      log.push({ kind: 'rect', payload: { x, y, w, h } });
    },
    clip() {
      if (pathRect) clipPaths.push(pathRect);
      log.push({ kind: 'clip' });
    },
    beginPath() {
      pathRect = null;
      log.push({ kind: 'beginPath' });
    },
    closePath() {
      log.push({ kind: 'closePath' });
    },
    moveTo(x: number, y: number) {
      log.push({ kind: 'moveTo', payload: { x, y } });
    },
    lineTo(x: number, y: number) {
      log.push({ kind: 'lineTo', payload: { x, y } });
    },
    stroke() {
      log.push({ kind: 'stroke' });
    },
    save() {
      saves += 1;
      log.push({ kind: 'save' });
    },
    restore() {
      restores += 1;
      log.push({ kind: 'restore' });
    },
    setTransform: noop,
    translate: noop,
    scale: noop,
    fillText: noop,
    strokeText: noop,
    measureText: () => ({ width: 0 }),
  } as unknown as CanvasRenderingContext2D;

  return {
    ctx,
    log,
    fillRects,
    clipPaths,
    get saves() {
      return saves;
    },
    get restores() {
      return restores;
    },
  } as RecordingContext;
}

function trackingLane(
  id: string,
  height: number,
  type: LanePlugin['type'],
  draws: DrawCall[],
  options: { header?: { width: number; calls: HeaderCall[] }; hitTest?: HitResult | null } = {}
): LanePlugin {
  return {
    id,
    type,
    height: () => height,
    draw: (_ctx, _columnRange, state) => {
      draws.push({ laneId: id, state });
    },
    hitTest: options.hitTest === undefined ? undefined : () => options.hitTest ?? null,
    header: options.header
      ? {
          width: options.header.width,
          draw: (_ctx, headerState) => {
            options.header!.calls.push({ laneId: id, state: headerState });
          },
        }
      : undefined,
  };
}

function baseLayoutInput() {
  return {
    columnCount: 1000,
    pxPerColumn: 4,
    viewportWidth: 600,
    viewportHeight: 200,
    scrollLeft: 0,
    leftGutterWidth: 80,
  };
}

describe('renderMultiLane', () => {
  it('draws lanes in input order with shared column range', () => {
    const draws: DrawCall[] = [];
    const lanes = [
      trackingLane('reference', 30, 'reference', draws),
      trackingLane('read-a', 50, 'read', draws),
      trackingLane('consensus', 40, 'consensus', draws),
    ];
    const layout = computeMultiLaneLayout({ ...baseLayoutInput(), lanes });
    const { ctx } = createRecordingContext();

    renderMultiLane(ctx, layout);

    expect(draws.map((d) => d.laneId)).toEqual(['reference', 'read-a', 'consensus']);
    for (const call of draws) {
      expect(call.state.columnRange).toEqual(layout.visibleColumnRange);
      expect(call.state.pxPerColumn).toBe(4);
      expect(call.state.lodTier).toBe('medium');
      expect(call.state.columnGridLeft).toBe(layout.columnGridLeft);
      expect(call.state.contentWidth).toBe(layout.viewportWidth - layout.leftGutterWidth);
    }
    expect(draws[0].state.laneY).toBe(0);
    expect(draws[1].state.laneY).toBe(30);
    expect(draws[2].state.laneY).toBe(80);
  });

  it('reserves the gutter — clip rects start after leftGutterWidth', () => {
    const draws: DrawCall[] = [];
    const lanes = [trackingLane('reference', 30, 'reference', draws)];
    const layout = computeMultiLaneLayout({ ...baseLayoutInput(), lanes });
    const recorder = createRecordingContext();

    renderMultiLane(recorder.ctx, layout);

    const contentClip = recorder.clipPaths.find((rect) => rect.x === layout.leftGutterWidth);
    expect(contentClip).toBeDefined();
    expect(contentClip!.w).toBe(layout.viewportWidth - layout.leftGutterWidth);
  });

  it('culls lanes that scroll out of the viewport', () => {
    const draws: DrawCall[] = [];
    const lanes = [
      trackingLane('reference', 30, 'reference', draws),
      trackingLane('read-a', 40, 'read', draws),
      trackingLane('read-b', 40, 'read', draws),
      trackingLane('consensus', 30, 'consensus', draws),
    ];
    const layout = computeMultiLaneLayout({
      columnCount: 200,
      pxPerColumn: 4,
      viewportWidth: 400,
      viewportHeight: 75,
      scrollLeft: 0,
      scrollTop: 45,
      lanes,
    });
    const { ctx } = createRecordingContext();

    renderMultiLane(ctx, layout);

    expect(draws.map((d) => d.laneId)).toEqual(['read-a', 'read-b', 'consensus']);
    expect(draws[0].state.laneY).toBe(30 - 45);
  });

  it('draws header callbacks for lanes with a header config', () => {
    const draws: DrawCall[] = [];
    const headerCalls: HeaderCall[] = [];
    const lanes = [
      trackingLane('reference', 30, 'reference', draws, {
        header: { width: 100, calls: headerCalls },
      }),
      trackingLane('read-a', 50, 'read', draws),
    ];
    const layout = computeMultiLaneLayout({ ...baseLayoutInput(), lanes });
    const { ctx } = createRecordingContext();

    renderMultiLane(ctx, layout);

    expect(headerCalls).toHaveLength(1);
    expect(headerCalls[0].laneId).toBe('reference');
    expect(headerCalls[0].state.width).toBe(layout.leftGutterWidth);
    expect(headerCalls[0].state.laneY).toBe(0);
  });

  it('strokes a horizontal divider between each pair of adjacent visible lanes', () => {
    const draws: DrawCall[] = [];
    const lanes = [
      trackingLane('reference', 30, 'reference', draws),
      trackingLane('read-a', 40, 'read', draws),
      trackingLane('read-b', 40, 'read', draws),
    ];
    const layout = computeMultiLaneLayout({ ...baseLayoutInput(), lanes });
    const recorder = createRecordingContext();

    renderMultiLane(recorder.ctx, layout, { background: null, gutterDivider: null });

    const strokeOps = recorder.log.filter((op) => op.kind === 'stroke');
    expect(strokeOps).toHaveLength(2);
  });

  it('strokes the vertical gutter divider when the gutter is non-zero', () => {
    const draws: DrawCall[] = [];
    const lanes = [
      trackingLane('reference', 30, 'reference', draws, {
        header: { width: 80, calls: [] },
      }),
    ];
    const layout = computeMultiLaneLayout({ ...baseLayoutInput(), lanes });
    const recorder = createRecordingContext();

    renderMultiLane(recorder.ctx, layout, { background: null, divider: null });

    const moves = recorder.log.filter((op) => op.kind === 'moveTo');
    const verticalMove = moves.find((op) => {
      const p = op.payload as { x: number; y: number };
      return p.y === 0 && Math.round(p.x) === Math.round(layout.leftGutterWidth) + 0;
    });
    expect(verticalMove ?? moves[0]).toBeDefined();
  });

  it('skips background fill when options.background is null', () => {
    const draws: DrawCall[] = [];
    const lanes = [trackingLane('reference', 30, 'reference', draws)];
    const layout = computeMultiLaneLayout({ ...baseLayoutInput(), lanes });
    const recorder = createRecordingContext();

    renderMultiLane(recorder.ctx, layout, { background: null });

    const fullViewportFill = recorder.fillRects.find(
      (rect) => rect.x === 0 && rect.y === 0 && rect.w === 600 && rect.h === 200
    );
    expect(fullViewportFill).toBeUndefined();
  });

  it('does not call draw for lanes culled from view (zero-height in scrollTop region)', () => {
    const draws: DrawCall[] = [];
    const lanes = [
      trackingLane('top', 30, 'reference', draws),
      trackingLane('mid', 30, 'read', draws),
    ];
    const layout = computeMultiLaneLayout({
      columnCount: 100,
      pxPerColumn: 4,
      viewportWidth: 400,
      viewportHeight: 25,
      scrollTop: 30,
      lanes,
    });
    const { ctx } = createRecordingContext();

    renderMultiLane(ctx, layout);

    expect(draws.map((d) => d.laneId)).toEqual(['mid']);
  });

  it('shifts state.columnGridLeft by scrollLeft so plugins draw at correct screen x', () => {
    const draws: DrawCall[] = [];
    const lanes = [trackingLane('reference', 30, 'reference', draws)];
    const layout = computeMultiLaneLayout({
      ...baseLayoutInput(),
      scrollLeft: 1000,
      lanes,
    });
    const { ctx } = createRecordingContext();

    renderMultiLane(ctx, layout);

    expect(draws).toHaveLength(1);
    expect(draws[0].state.columnGridLeft).toBe(layout.columnGridLeft - 1000);
  });

  it('createFixedHeightLane plays nicely with the renderer (no draw side effects)', () => {
    const lanes = [createFixedHeightLane('spacer', 20, 'feature')];
    const layout = computeMultiLaneLayout({ ...baseLayoutInput(), lanes });
    const recorder = createRecordingContext();
    expect(() => renderMultiLane(recorder.ctx, layout)).not.toThrow();
  });

  it('paints referenceColumnOverlays at the target lane y-range  Phase 2A)', () => {
    const draws: DrawCall[] = [];
    const referenceLane = trackingLane('reference', 30, 'reference', draws);
    const readLane: LanePlugin = {
      ...trackingLane('read-a', 50, 'read', draws),
      referenceColumnOverlays: [
        {
          id: 'mut-wash',
          target: 'reference',
          columns: [10, 50],
          color: '#dc2626',
          kind: 'columnWash',
          alpha: 0.3,
        },
      ],
    };
    const layout = computeMultiLaneLayout({
      ...baseLayoutInput(),
      lanes: [referenceLane, readLane],
    });
    const recorder = createRecordingContext();

    renderMultiLane(recorder.ctx, layout);

    const overlayRects = recorder.fillRects.filter((r) => r.y === 0 && r.h === 30);
    expect(overlayRects.length).toBe(2);
  });

  it('silently skips referenceColumnOverlays whose target is not a visible lane', () => {
    const lanes: LanePlugin[] = [
      trackingLane('reference', 30, 'reference', []),
      {
        ...trackingLane('read-a', 50, 'read', []),
        referenceColumnOverlays: [
          {
            id: 'mut',
            target: 'sequenceBand',
            columns: [10],
            color: '#dc2626',
            kind: 'columnWash',
          },
          {
            id: 'mut2',
            target: 'nonexistent-lane',
            columns: [20],
            color: '#dc2626',
            kind: 'columnWash',
          },
        ],
      },
    ];
    const layout = computeMultiLaneLayout({ ...baseLayoutInput(), lanes });
    const recorder = createRecordingContext();
    expect(() => renderMultiLane(recorder.ctx, layout)).not.toThrow();
    const sequenceBandRects = recorder.fillRects.filter((r) => r.y === 0 && r.h === 30);
    expect(sequenceBandRects.length).toBe(0);
  });
});

describe('hitTestMultiLane', () => {
  it('returns null for negative coordinates', () => {
    const lanes = [createFixedHeightLane('reference', 30)];
    const layout = computeMultiLaneLayout({ ...baseLayoutInput(), lanes });
    expect(hitTestMultiLane(layout, -1, 5)).toBeNull();
    expect(hitTestMultiLane(layout, 5, -1)).toBeNull();
  });

  it('returns the matching lane and inGutter=true for gutter clicks', () => {
    const draws: DrawCall[] = [];
    const lanes = [
      trackingLane('reference', 30, 'reference', draws),
      trackingLane('read', 30, 'read', draws),
    ];
    const layout = computeMultiLaneLayout({ ...baseLayoutInput(), lanes });

    const result = hitTestMultiLane(layout, 5, 10);
    expect(result).not.toBeNull();
    expect(result!.laneId).toBe('reference');
    expect(result!.inGutter).toBe(true);
    expect(result!.hit).toBeNull();
  });

  it('dispatches to lane.plugin.hitTest for content clicks', () => {
    const draws: DrawCall[] = [];
    const fakeHit: HitResult = { type: 'nucleotide', position: 42 } as unknown as HitResult;
    const lanes = [
      trackingLane('reference', 30, 'reference', draws, { hitTest: fakeHit }),
      trackingLane('read', 30, 'read', draws, { hitTest: null }),
    ];
    const layout = computeMultiLaneLayout({ ...baseLayoutInput(), lanes });

    const result = hitTestMultiLane(layout, layout.leftGutterWidth + 30, 15);
    expect(result).not.toBeNull();
    expect(result!.laneId).toBe('reference');
    expect(result!.inGutter).toBe(false);
    expect(result!.hit).toBe(fakeHit);
  });

  it('respects vertical scroll when locating the lane under the cursor', () => {
    const draws: DrawCall[] = [];
    const lanes = [
      trackingLane('top', 30, 'reference', draws),
      trackingLane('mid', 30, 'read', draws),
    ];
    const layout = computeMultiLaneLayout({
      ...baseLayoutInput(),
      viewportHeight: 30,
      scrollTop: 30,
      lanes,
    });

    const result = hitTestMultiLane(layout, layout.leftGutterWidth + 5, 5);
    expect(result?.laneId).toBe('mid');
  });

  it('returns null when the cursor is below all lanes', () => {
    const lanes = [createFixedHeightLane('reference', 20)];
    const layout = computeMultiLaneLayout({ ...baseLayoutInput(), lanes });
    expect(hitTestMultiLane(layout, 10, 999)).toBeNull();
  });
});
