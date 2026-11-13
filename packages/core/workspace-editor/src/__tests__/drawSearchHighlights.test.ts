import { describe, test, expect, vi } from 'vitest';
import { drawSearchHighlights, type LinePositions } from '../canvas-drawing';
import { DEFAULT_EDITOR_CONFIG } from '../types';
import type { SearchMatch } from '@waypoint/sequence-utils';

vi.mock('../canvas-theme', () => ({
  getCanvasTheme: () => ({ isDark: false }),
}));

function createMockContext() {
  return {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'left' as CanvasTextAlign,
    textBaseline: 'top' as CanvasTextBaseline,
    globalAlpha: 1,
    save: vi.fn(),
    restore: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    arc: vi.fn(),
    measureText: vi.fn(() => ({ width: 0 })),
    fillText: vi.fn(),
    strokeText: vi.fn(),
    setTransform: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    rotate: vi.fn(),
    clip: vi.fn(),
    rect: vi.fn(),
    createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
  } as unknown as CanvasRenderingContext2D;
}

function createLinePosition(
  startPos: number,
  endPos: number,
  annotationY: number,
  lineEndY: number,
  opts?: { preOriginLength?: number }
): LinePositions {
  return {
    line: { startPos, endPos, preOriginLength: opts?.preOriginLength } as any,
    annotationY,
    translationY: annotationY + 40,
    translationLaneCount: 0,
    sequenceY: annotationY + 60,
    complementY: annotationY + 80,
    mutationTrackY: 0,
    hasMutationTrack: false,
    lineEndY,
  } as LinePositions;
}

function createMatch(
  start: number,
  end: number,
  overrides: Partial<SearchMatch> = {}
): SearchMatch {
  return {
    start,
    end,
    strand: 'forward',
    type: 'nucleotide',
    ...overrides,
  };
}

const config = { ...DEFAULT_EDITOR_CONFIG };
const x = 0;
const sequenceLength = 100;

describe('drawSearchHighlights', () => {
  test('no-op when matches array is empty', () => {
    const ctx = createMockContext();
    const linePositions = [createLinePosition(0, 50, 32, 120)];

    drawSearchHighlights(ctx, linePositions, [], 0, x, config, sequenceLength);

    expect(ctx.save).not.toHaveBeenCalled();
    expect(ctx.restore).not.toHaveBeenCalled();
    expect(ctx.fillRect).not.toHaveBeenCalled();
  });

  test('calls save and restore', () => {
    const ctx = createMockContext();
    const linePositions = [createLinePosition(0, 50, 32, 120)];
    const matches = [createMatch(5, 10)];

    drawSearchHighlights(ctx, linePositions, matches, 0, x, config, sequenceLength);

    expect(ctx.save).toHaveBeenCalledTimes(1);
    expect(ctx.restore).toHaveBeenCalledTimes(1);
  });

  test('single match that is active does NOT draw fillRect (skipped — handled by highlightedRange)', () => {
    const ctx = createMockContext();
    const linePositions = [createLinePosition(0, 50, 32, 120)];
    const matches = [createMatch(5, 10)];

    drawSearchHighlights(ctx, linePositions, matches, 0, x, config, sequenceLength);

    expect(ctx.fillRect).not.toHaveBeenCalled();
  });

  test('active match is skipped, only inactive matches draw fillRect', () => {
    const ctx = createMockContext();
    const linePositions = [createLinePosition(0, 50, 32, 120)];
    const matches = [createMatch(5, 10), createMatch(15, 20)];

    drawSearchHighlights(ctx, linePositions, matches, 0, x, config, sequenceLength);

    expect(ctx.fillRect).toHaveBeenCalledTimes(1);
    expect(ctx.strokeRect).not.toHaveBeenCalled();
  });

  test('match spanning two lines draws fillRect on both', () => {
    const ctx = createMockContext();
    const linePositions = [
      createLinePosition(0, 30, 32, 120),
      createLinePosition(30, 60, 152, 240),
    ];
    const matches = [createMatch(25, 35)];

    drawSearchHighlights(ctx, linePositions, matches, -1, x, config, sequenceLength);

    expect(ctx.fillRect).toHaveBeenCalledTimes(2);
  });

  test('match outside all lines draws no fillRect', () => {
    const ctx = createMockContext();
    const linePositions = [createLinePosition(0, 30, 32, 120)];
    const matches = [createMatch(40, 45)];

    drawSearchHighlights(ctx, linePositions, matches, -1, x, config, sequenceLength);

    expect(ctx.save).toHaveBeenCalled();
    expect(ctx.fillRect).not.toHaveBeenCalled();
  });

  test('origin-wrapping match draws two segments', () => {
    const ctx = createMockContext();
    const linePositions = [
      createLinePosition(0, 50, 32, 120),
      createLinePosition(50, 100, 152, 240),
    ];
    const matches = [createMatch(90, 5, { wraps: true })];

    drawSearchHighlights(ctx, linePositions, matches, -1, x, config, sequenceLength);

    expect(ctx.fillRect).toHaveBeenCalled();
    const fillCalls = (ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(fillCalls).toBeGreaterThanOrEqual(2);
  });

  test('fillRect position uses charWidth for column calculations', () => {
    const ctx = createMockContext();
    const linePositions = [createLinePosition(0, 50, 32, 120)];
    const matches = [createMatch(5, 10)];
    const testConfig = { ...config, charWidth: 10 };

    drawSearchHighlights(ctx, linePositions, matches, -1, 0, testConfig, sequenceLength);

    const fillCall = (ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fillCall[0]).toBe(50);
    expect(fillCall[2]).toBe(60);
  });

  test('multiple matches: active is skipped, others get fillRect', () => {
    const ctx = createMockContext();
    const linePositions = [createLinePosition(0, 50, 32, 120)];
    const matches = [createMatch(2, 4), createMatch(10, 14), createMatch(20, 24)];

    drawSearchHighlights(ctx, linePositions, matches, 1, x, config, sequenceLength);

    expect(ctx.fillRect).toHaveBeenCalledTimes(2);
    expect(ctx.strokeRect).not.toHaveBeenCalled();
  });

  test('match in pre-origin portion of origin-spanning line draws correctly', () => {
    const ctx = createMockContext();
    const linePositions = [createLinePosition(80, 20, 32, 120, { preOriginLength: 20 })];
    const matches = [createMatch(85, 90)];

    drawSearchHighlights(
      ctx,
      linePositions,
      matches,
      -1,
      0,
      { ...config, charWidth: 10 },
      sequenceLength
    );

    expect(ctx.fillRect).toHaveBeenCalledTimes(1);
    const call = (ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe(50);
    expect(call[2]).toBe(60);
  });

  test('match in post-origin portion of origin-spanning line draws correctly', () => {
    const ctx = createMockContext();
    const linePositions = [createLinePosition(80, 20, 32, 120, { preOriginLength: 20 })];
    const matches = [createMatch(5, 10)];

    drawSearchHighlights(
      ctx,
      linePositions,
      matches,
      -1,
      0,
      { ...config, charWidth: 10 },
      sequenceLength
    );

    expect(ctx.fillRect).toHaveBeenCalledTimes(1);
    const call = (ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe(250);
    expect(call[2]).toBe(60);
  });

  test('matches in both portions of origin-spanning line both draw', () => {
    const ctx = createMockContext();
    const linePositions = [createLinePosition(80, 20, 32, 120, { preOriginLength: 20 })];
    const matches = [createMatch(85, 90), createMatch(5, 10)];

    drawSearchHighlights(ctx, linePositions, matches, -1, 0, config, sequenceLength);

    expect(ctx.fillRect).toHaveBeenCalledTimes(2);
  });

  test('all matches drawn when activeIndex is -1 (no active match)', () => {
    const ctx = createMockContext();
    const linePositions = [createLinePosition(0, 50, 32, 120)];
    const matches = [createMatch(2, 4), createMatch(10, 14)];

    drawSearchHighlights(ctx, linePositions, matches, -1, x, config, sequenceLength);

    expect(ctx.fillRect).toHaveBeenCalledTimes(2);
  });
});
