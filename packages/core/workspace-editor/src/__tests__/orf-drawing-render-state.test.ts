// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { drawORFTracks, makeOrfRenderStateFn, type OrfRenderState } from '../orf-drawing';
import { DEFAULT_EDITOR_CONFIG } from '../types';
import {
  installRecordingCanvas,
  uninstallRecordingCanvas,
  getRecordingLog,
  opsOf,
  type CanvasOp,
} from '../testing/recording-canvas-context';
import type { ORFWithLane } from '../types';

const orf = (overrides: Partial<ORFWithLane> = {}): ORFWithLane => ({
  start: 0,
  end: 26,
  frame: 1,
  strand: '+',
  length: 27,
  lane: 0,
  ...overrides,
});

const drawAt = (
  ctx: CanvasRenderingContext2D,
  state: OrfRenderState,
  orfs: ORFWithLane[] = [orf()]
) => {
  const sequence = 'A'.repeat(60);
  drawORFTracks(
    ctx,
    orfs,
    0,
    60,
    0,
    100,
    DEFAULT_EDITOR_CONFIG,
    sequence,
    sequence.length,
    { type: 'normal' },
    () => state
  );
};

const lastSetValue = (log: CanvasOp[], prop: string): unknown => {
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (e.op === 'set' && e.prop === prop) return e.value;
  }
  return undefined;
};

const allSetValues = (log: CanvasOp[], prop: string): unknown[] => {
  return log
    .filter((e): e is Extract<CanvasOp, { op: 'set' }> => e.op === 'set' && e.prop === prop)
    .map((e) => e.value);
};

let canvas: HTMLCanvasElement;
let ctx: CanvasRenderingContext2D;

beforeEach(() => {
  installRecordingCanvas();
  canvas = document.createElement('canvas');
  ctx = canvas.getContext('2d')!;
});

afterEach(() => {
  uninstallRecordingCanvas();
});

describe('makeOrfRenderStateFn priority', () => {
  const ident = { start: 100, end: 200, strand: '+' as const };
  const orfMatch: ORFWithLane = {
    start: 100,
    end: 200,
    frame: 1,
    strand: '+',
    length: 101,
    lane: 0,
  };
  const orfMiss: ORFWithLane = {
    start: 500,
    end: 600,
    frame: 1,
    strand: '+',
    length: 101,
    lane: 0,
  };

  it('candidate beats selected beats hovered beats default', () => {
    const fn = makeOrfRenderStateFn({ hovered: ident, selected: ident, candidate: ident });
    expect(fn(orfMatch)).toBe('candidate');
  });

  it('selected beats hovered when no candidate', () => {
    const fn = makeOrfRenderStateFn({ hovered: ident, selected: ident });
    expect(fn(orfMatch)).toBe('selected');
  });

  it('hovered when only hovered set', () => {
    const fn = makeOrfRenderStateFn({ hovered: ident });
    expect(fn(orfMatch)).toBe('hovered');
  });

  it('default when no identity matches', () => {
    const fn = makeOrfRenderStateFn({ hovered: ident, selected: ident, candidate: ident });
    expect(fn(orfMiss)).toBe('default');
  });

  it('strand mismatch does not count as match', () => {
    const fn = makeOrfRenderStateFn({
      selected: { start: 100, end: 200, strand: '-' },
    });
    expect(fn(orfMatch)).toBe('default');
  });
});

describe('drawORFTracks — render-state visual treatments', () => {
  it('default state: no outer outline (no setLineDash op)', () => {
    drawAt(ctx, 'default');
    const log = getRecordingLog(canvas);
    expect(opsOf(log, 'setLineDash')).toHaveLength(0);
  });

  it('hovered state: brighter cell colors, still no outer outline', () => {
    drawAt(ctx, 'hovered');
    const hoveredLog = getRecordingLog(canvas);
    expect(opsOf(hoveredLog, 'setLineDash')).toHaveLength(0);

    const hoveredFills = allSetValues(hoveredLog, 'fillStyle');

    canvas = document.createElement('canvas');
    ctx = canvas.getContext('2d')!;
    drawAt(ctx, 'default');
    const defaultFills = allSetValues(getRecordingLog(canvas), 'fillStyle');

    expect(hoveredFills).not.toEqual(defaultFills);
  });

  it('selected state: solid outer outline with lineWidth=2', () => {
    drawAt(ctx, 'selected');
    const log = getRecordingLog(canvas);
    const dashOps = opsOf(log, 'setLineDash');
    expect(dashOps).toHaveLength(1);
    expect(dashOps[0].segments).toEqual([]);

    const dashIdx = log.findIndex((e) => e === dashOps[0]);
    let foundLineWidth: unknown;
    for (let i = dashIdx - 1; i >= 0; i--) {
      const e = log[i];
      if (e.op === 'set' && e.prop === 'lineWidth') {
        foundLineWidth = e.value;
        break;
      }
    }
    expect(foundLineWidth).toBe(2);
  });

  it('candidate state: dashed outer outline with non-empty dash pattern', () => {
    drawAt(ctx, 'candidate');
    const log = getRecordingLog(canvas);
    const dashOps = opsOf(log, 'setLineDash');
    expect(dashOps).toHaveLength(1);
    expect(dashOps[0].segments.length).toBeGreaterThan(0);
  });

  it('selected vs candidate: same color family (ORF gray, not accent blue)', () => {
    for (const state of ['selected', 'candidate'] as const) {
      canvas = document.createElement('canvas');
      ctx = canvas.getContext('2d')!;
      drawAt(ctx, state);
      const log = getRecordingLog(canvas);
      const dashIdx = log.findIndex((e) => e.op === 'setLineDash');
      let foundStroke: unknown;
      for (let i = dashIdx - 1; i >= 0; i--) {
        const e = log[i];
        if (e.op === 'set' && e.prop === 'strokeStyle') {
          foundStroke = e.value;
          break;
        }
      }
      expect(String(foundStroke)).not.toMatch(/(37, 99, 235|96, 165, 250)/);
    }
  });

  it('reverse-strand outline: extends across the full ORF span (no missing end codons)', () => {
    const reverseOrf: ORFWithLane = {
      start: 0,
      end: 26,
      frame: -1,
      strand: '-',
      length: 27,
      lane: 0,
    };
    drawAt(ctx, 'selected', [reverseOrf]);
    const log = getRecordingLog(canvas);
    const dashOps = opsOf(log, 'setLineDash');
    expect(dashOps).toHaveLength(1);

    const dashIdx = log.findIndex((e) => e === dashOps[0]);
    let strokeIdx = log.length;
    for (let i = dashIdx + 1; i < log.length; i++) {
      if (log[i].op === 'stroke') {
        strokeIdx = i;
        break;
      }
    }
    const pathOps = log
      .slice(dashIdx + 1, strokeIdx)
      .filter(
        (e): e is Extract<CanvasOp, { op: 'moveTo' | 'lineTo' }> =>
          e.op === 'moveTo' || e.op === 'lineTo'
      );
    expect(pathOps.length).toBeGreaterThan(0);

    const xs = pathOps.map((p) => p.x);
    const minPathX = Math.min(...xs);
    const maxPathX = Math.max(...xs);
    expect(maxPathX - minPathX).toBeGreaterThan(20);
  });

  it('per-ORF state: getRenderState lambda applied per-ORF (mixed states)', () => {
    const a = orf({ start: 0, end: 26, lane: 0 });
    const b = orf({ start: 30, end: 56, lane: 1 });
    drawORFTracks(
      ctx,
      [a, b],
      0,
      60,
      0,
      100,
      DEFAULT_EDITOR_CONFIG,
      'A'.repeat(60),
      60,
      { type: 'normal' },
      (o) => (o === a ? 'selected' : 'candidate')
    );
    const log = getRecordingLog(canvas);
    expect(opsOf(log, 'setLineDash')).toHaveLength(2);
  });

  it('no lambda: default treatment, identical to explicit default', () => {
    drawORFTracks(ctx, [orf()], 0, 60, 0, 100, DEFAULT_EDITOR_CONFIG, 'A'.repeat(60), 60, {
      type: 'normal',
    });
    const noLambda = allSetValues(getRecordingLog(canvas), 'fillStyle');

    canvas = document.createElement('canvas');
    ctx = canvas.getContext('2d')!;
    drawAt(ctx, 'default');
    const explicitDefault = allSetValues(getRecordingLog(canvas), 'fillStyle');

    expect(noLambda).toEqual(explicitDefault);
  });

  void lastSetValue;
});
