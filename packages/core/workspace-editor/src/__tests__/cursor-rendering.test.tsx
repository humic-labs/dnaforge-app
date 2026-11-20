// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { getCanvasTheme, setCanvasTheme } from '../canvas-theme';
import { drawSelectionHandleBar, drawViewCursorLine } from '../selection-primitives';
import { useSelectionDraw } from '../hooks/useSelectionDraw';
import { calculateLinePositions } from '../line-positions';
import { DEFAULT_EDITOR_CONFIG, type LayoutSnapshot2D } from '../types';
import {
  getRecordingLog,
  installRecordingCanvas,
  uninstallRecordingCanvas,
} from '../testing/recording-canvas-context';

vi.mock('../rendering/webgl-drawing-context', () => ({
  getSequenceWebGLContext: (canvas: HTMLCanvasElement) =>
    Object.assign(canvas.getContext('2d')!, {
      beginFrame: () => true,
      endFrame: () => undefined,
    }),
}));

const initialTheme = getCanvasTheme();
const layout: LayoutSnapshot2D = {
  lines: [
    {
      lineIndex: 0,
      startPos: 0,
      endPos: 10,
      sequence: 'N'.repeat(10),
      complementSequence: 'N'.repeat(10),
      y: 32,
      annotations: [],
      annotationLaneCount: 0,
      translationLaneCount: 0,
    },
  ],
  totalWidth: 200,
  totalHeight: 160,
};

beforeEach(() => installRecordingCanvas());
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  uninstallRecordingCanvas();
  setCanvasTheme(initialTheme);
});

function renderCursorPainter(charWidth = DEFAULT_EDITOR_CONFIG.charWidth) {
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  const config = {
    ...DEFAULT_EDITOR_CONFIG,
    charWidth,
    showAnnotations: false,
    showTranslation: false,
  };
  const { result } = renderHook(() =>
    useSelectionDraw({
      selectionCanvasRef: { current: canvas },
      viewportRef: { current: { scrollTop: 0, height: 160 } },
      hoverCursorRef: { current: null },
      shiftPreviewRef: { current: null },
      layout,
      config,
      precomputedLinePositions: layout.lines.map((line) =>
        calculateLinePositions(line, config, [], 10)
      ),
      editable: false,
      sequenceLength: 10,
      primers: [],
      cursor: undefined,
      cursorVisible: false,
      insertedRanges: [],
      deletedRanges: [],
      hoveredEnzymeNameRef: { current: null },
      renderedCutSitesRef: { current: [] },
      bpHighlightsRef: { current: [] },
    })
  );
  return {
    canvas,
    config,
    clear: () => result.current.drawSelectionAndCursorRef.current(null, undefined, false),
    paint: (column: number) =>
      result.current.drawSelectionAndCursorRef.current(null, undefined, false, [], [], {
        x: config.marginLeft + column * config.charWidth,
        lineIdx: 0,
      }),
  };
}

it('leaves an empty overlay idle and clears a removed hover guide once', () => {
  const { canvas, clear, paint } = renderCursorPainter();
  const context = vi.spyOn(canvas, 'getContext');

  clear();
  clear();
  expect(context).not.toHaveBeenCalled();

  paint(5);
  expect(context).toHaveBeenCalledTimes(1);
  clear();
  expect(context).toHaveBeenCalledTimes(2);
  clear();
  expect(context).toHaveBeenCalledTimes(2);
});

describe.each([false, true])('Canvas cursor styling (dark=%s)', (isDark) => {
  beforeEach(() => setCanvasTheme({ ...initialTheme, isDark }));

  it('draws the placed cursor and selection ends at the nonwrapped WebGL width', () => {
    const cursorCanvas = document.createElement('canvas');
    const handleCanvas = document.createElement('canvas');
    const cursorContext = cursorCanvas.getContext('2d');
    const handleContext = handleCanvas.getContext('2d');
    if (!cursorContext || !handleContext)
      throw new Error('Recording canvas context is unavailable');
    drawViewCursorLine(cursorContext, 44, 0, 120);
    drawSelectionHandleBar(handleContext, 44, 0, 120);

    expect(getRecordingLog(cursorCanvas)).toEqual(getRecordingLog(handleCanvas));
    expect(getRecordingLog(cursorCanvas)).toContainEqual({
      op: 'set',
      prop: 'lineWidth',
      value: 2,
    });
  });

  it('paints one hover guide with WebGL width, color, opacity, and dash spacing', () => {
    const { canvas, paint } = renderCursorPainter();
    paint(5);

    const ops = getRecordingLog(canvas);
    expect(ops.filter((op) => op.op === 'stroke')).toHaveLength(1);
    expect(ops).toContainEqual({ op: 'set', prop: 'lineWidth', value: 1.5 });
    expect(ops).toContainEqual({ op: 'set', prop: 'globalAlpha', value: 0.55 });
    expect(ops).toContainEqual({
      op: 'set',
      prop: 'strokeStyle',
      value: isDark ? '#f5e58a' : '#000000',
    });
    expect(ops).toContainEqual({ op: 'setLineDash', segments: [5, 4] });
    expect(ops).toContainEqual({ op: 'moveTo', x: 44, y: 0 });
    expect(ops.filter((op) => op.op === 'moveTo')).toHaveLength(1);
    expect(ops.at(-1)).toEqual({ op: 'restore' });
  });
});

describe.each([4, 8, 12])('Canvas hover positioning (charWidth=%s)', (charWidth) => {
  it.each([
    [5.25, 5],
    [5.49, 5],
    [5.5, 6],
    [5.75, 6],
    [9.75, 10],
    [20, 10],
    [-0.2, 0],
  ])('snaps column %s to boundary %s', (column, boundary) => {
    const { canvas, config, paint } = renderCursorPainter(charWidth);
    paint(column);

    expect(getRecordingLog(canvas).filter((op) => op.op === 'moveTo')).toEqual([
      { op: 'moveTo', x: config.marginLeft + boundary * charWidth, y: 0 },
    ]);
  });
});
