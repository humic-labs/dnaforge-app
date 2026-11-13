import { describe, it, expect } from 'vitest';
import {
  paintBpHighlights,
  type BpHighlight,
  type BpHighlightLine,
  type BpHighlightDrawConfig,
  type BpHighlightDrawViewport,
} from './useSelectionDraw';
import { getHoverCursorChrome } from '../selection-primitives';

interface RecordingOp {
  op: string;
  args: unknown;
}

function makeRecordingCtx(): { ctx: CanvasRenderingContext2D; ops: RecordingOp[] } {
  const ops: RecordingOp[] = [];
  const ctx = {
    save: () => ops.push({ op: 'save', args: null }),
    restore: () => ops.push({ op: 'restore', args: null }),
    fillRect: (x: number, y: number, w: number, h: number) =>
      ops.push({ op: 'fillRect', args: { x, y, w, h } }),
    set fillStyle(v: string) {
      ops.push({ op: 'set:fillStyle', args: v });
    },
    set globalAlpha(v: number) {
      ops.push({ op: 'set:globalAlpha', args: v });
    },
  } as unknown as CanvasRenderingContext2D;
  return { ctx, ops };
}

const BASE_CONFIG: BpHighlightDrawConfig = {
  marginLeft: 50,
  charWidth: 10,
  rowHeight: 20,
  showAnnotations: false,
  showTranslation: false,
  showReverseComplement: false,
};

const NO_VIEWPORT_CULLING: BpHighlightDrawViewport = { scrollTop: 0, height: 0 };

function lineAt(startPos: number, endPos: number, y: number): BpHighlightLine {
  return { startPos, endPos, y, annotationLaneCount: 0, translationLaneCount: 0 };
}

function fillRectsOf(ops: RecordingOp[]): Array<{ x: number; y: number; w: number; h: number }> {
  return ops
    .filter((o) => o.op === 'fillRect')
    .map((o) => o.args as { x: number; y: number; w: number; h: number });
}

describe('getHoverCursorChrome', () => {
  it('uses neutral gray chrome for canvas hover cursors, not blue', () => {
    expect(getHoverCursorChrome(false)).toEqual({
      glow: 'rgba(107, 114, 128, 0.25)',
      line: '#6b7280',
    });
    expect(getHoverCursorChrome(true)).toEqual({
      glow: 'rgba(156, 163, 175, 0.25)',
      line: '#9ca3af',
    });
    expect(Object.values(getHoverCursorChrome(false))).not.toContain('#93C5FD');
    expect(Object.values(getHoverCursorChrome(true))).not.toContain('#93C5FD');
  });
});

describe('paintBpHighlights', () => {
  it('emits no ops for an empty highlights array', () => {
    const { ctx, ops } = makeRecordingCtx();
    paintBpHighlights(ctx, [], [lineAt(0, 100, 0)], BASE_CONFIG, NO_VIEWPORT_CULLING);
    expect(ops).toHaveLength(0);
  });

  it('emits no fillRect when no line overlaps the highlight bp range', () => {
    const { ctx, ops } = makeRecordingCtx();
    const h: BpHighlight = { start: 500, end: 502, color: '#fbbf24' };
    paintBpHighlights(
      ctx,
      [h],
      [lineAt(0, 100, 0), lineAt(100, 200, 30)],
      BASE_CONFIG,
      NO_VIEWPORT_CULLING
    );
    expect(fillRectsOf(ops)).toHaveLength(0);
  });

  it('emits one fillRect for a 3-bp codon contained in one line', () => {
    const { ctx, ops } = makeRecordingCtx();
    const h: BpHighlight = { start: 10, end: 12, color: '#fbbf24', alpha: 0.5 };
    paintBpHighlights(ctx, [h], [lineAt(0, 100, 0)], BASE_CONFIG, NO_VIEWPORT_CULLING);

    const rects = fillRectsOf(ops);
    expect(rects).toHaveLength(1);
    expect(rects[0]).toEqual({ x: 150, y: 0, w: 30, h: 20 });
  });

  it('paints across both rows when a range spans a wrap boundary', () => {
    const { ctx, ops } = makeRecordingCtx();
    const h: BpHighlight = { start: 99, end: 101, color: '#fbbf24' };
    paintBpHighlights(
      ctx,
      [h],
      [lineAt(0, 99, 0), lineAt(100, 199, 50)],
      BASE_CONFIG,
      NO_VIEWPORT_CULLING
    );

    const rects = fillRectsOf(ops);
    expect(rects).toHaveLength(2);
    expect(rects[0]).toMatchObject({ x: 1040, w: 10 });
    expect(rects[1]).toMatchObject({ x: 50, w: 20 });
  });

  it('skips lines outside the viewport (top + bottom margins of 50px)', () => {
    const { ctx, ops } = makeRecordingCtx();
    const h: BpHighlight = { start: 0, end: 100, color: '#fbbf24' };
    const viewport: BpHighlightDrawViewport = { scrollTop: 100, height: 100 };
    paintBpHighlights(
      ctx,
      [h],
      [lineAt(0, 100, 0), lineAt(0, 100, 100), lineAt(0, 100, 250), lineAt(0, 100, 1000)],
      BASE_CONFIG,
      viewport
    );

    const rects = fillRectsOf(ops);
    expect(rects).toHaveLength(2);
  });

  it('disables viewport culling when height is 0', () => {
    const { ctx, ops } = makeRecordingCtx();
    const h: BpHighlight = { start: 0, end: 100, color: '#fbbf24' };
    paintBpHighlights(
      ctx,
      [h],
      [lineAt(0, 100, 0), lineAt(0, 100, 50_000), lineAt(0, 100, 1_000_000)],
      BASE_CONFIG,
      { scrollTop: 0, height: 0 }
    );
    expect(fillRectsOf(ops)).toHaveLength(3);
  });

  it('applies highlight alpha (default 0.4 when undefined)', () => {
    const { ctx, ops } = makeRecordingCtx();
    const h: BpHighlight = { start: 0, end: 2, color: '#fbbf24' };
    paintBpHighlights(ctx, [h], [lineAt(0, 100, 0)], BASE_CONFIG, NO_VIEWPORT_CULLING);
    const alphaSets = ops.filter((o) => o.op === 'set:globalAlpha');
    expect(alphaSets).toHaveLength(1);
    expect(alphaSets[0].args).toBe(0.4);
  });

  it('applies the highlight-provided alpha when set', () => {
    const { ctx, ops } = makeRecordingCtx();
    const h: BpHighlight = { start: 0, end: 2, color: '#fbbf24', alpha: 0.55 };
    paintBpHighlights(ctx, [h], [lineAt(0, 100, 0)], BASE_CONFIG, NO_VIEWPORT_CULLING);
    const alphaSets = ops.filter((o) => o.op === 'set:globalAlpha');
    expect(alphaSets[0].args).toBe(0.55);
  });

  it('doubles the fill height when reverse complement is shown', () => {
    const { ctx, ops } = makeRecordingCtx();
    const config: BpHighlightDrawConfig = { ...BASE_CONFIG, showReverseComplement: true };
    const h: BpHighlight = { start: 5, end: 7, color: '#fbbf24' };
    paintBpHighlights(ctx, [h], [lineAt(0, 100, 0)], config, NO_VIEWPORT_CULLING);
    const rects = fillRectsOf(ops);
    expect(rects[0].h).toBe(40);
  });

  it('wraps draws in save / restore', () => {
    const { ctx, ops } = makeRecordingCtx();
    const h: BpHighlight = { start: 0, end: 2, color: '#fbbf24' };
    paintBpHighlights(ctx, [h], [lineAt(0, 100, 0)], BASE_CONFIG, NO_VIEWPORT_CULLING);
    expect(ops[0]).toEqual({ op: 'save', args: null });
    expect(ops[ops.length - 1]).toEqual({ op: 'restore', args: null });
  });

  it('handles multiple highlights with independent styling', () => {
    const { ctx, ops } = makeRecordingCtx();
    const highlights: BpHighlight[] = [
      { start: 5, end: 7, color: '#fbbf24', alpha: 0.5 },
      { start: 50, end: 52, color: '#dc2626', alpha: 0.7 },
    ];
    paintBpHighlights(ctx, highlights, [lineAt(0, 100, 0)], BASE_CONFIG, NO_VIEWPORT_CULLING);
    const fillStyles = ops.filter((o) => o.op === 'set:fillStyle').map((o) => o.args);
    const alphas = ops.filter((o) => o.op === 'set:globalAlpha').map((o) => o.args);
    expect(fillStyles).toEqual(['#fbbf24', '#dc2626']);
    expect(alphas).toEqual([0.5, 0.7]);
    expect(fillRectsOf(ops)).toHaveLength(2);
  });
});
