/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { installNativeWheelSource } from '../../../platform/src/wheel-input.test-helper';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SequenceViewer } from '../SequenceViewer';
import { bpAtCursorForZoom } from '../use-zoom-gesture';
import { computeLineTrackPositions } from '../line-track-layout';
import type { useCanvasWorkerDraw } from '../hooks/useCanvasWorkerDraw';
import {
  installRecordingCanvas,
  uninstallRecordingCanvas,
} from '../testing/recording-canvas-context';

const draws = vi.hoisted(() => ({
  latest: null as Parameters<typeof useCanvasWorkerDraw>[0] | null,
}));
vi.mock('../rendering/webgl-drawing-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../rendering/webgl-drawing-context')>()),
  getSequenceWebGLContext: (canvas: HTMLCanvasElement) =>
    Object.assign(canvas.getContext('2d')!, {
      beginFrame: () => true,
      endFrame: () => undefined,
    }),
}));
vi.mock('../hooks/useCanvasWorkerDraw', () => ({
  useCanvasWorkerDraw: (params: Parameters<typeof useCanvasWorkerDraw>[0]) => {
    draws.latest = params;
  },
}));

let disposeWheel: () => void;
let callbacks: Map<number, FrameRequestCallback>;
let frameId: number;
beforeEach(() => {
  callbacks = new Map();
  frameId = 0;
  draws.latest = null;
  installRecordingCanvas();
  vi.useFakeTimers();
  disposeWheel = installNativeWheelSource(document);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        this.callback(
          [{ target, contentRect: { width: 800, height: 600 } } as ResizeObserverEntry],
          this as unknown as ResizeObserver
        );
      }
      unobserve() {}
      disconnect() {}
    }
  );
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callbacks.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => callbacks.delete(id));
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(20000);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(0, 0, 800, 600)
  );
});
afterEach(() => {
  cleanup();
  uninstallRecordingCanvas();
  disposeWheel();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function renderLinearViewer() {
  const sequence = {
    id: 'linear-mouse-anchor',
    name: 'linear-mouse-anchor',
    sequence: 'ACGTTGCAAC'.repeat(400),
    length: 4000,
    circular: false,
    annotations: [],
  };
  function Viewer() {
    const [zoom, setZoom] = useState(100);
    return (
      <SequenceViewer
        sequence={sequence}
        zoomLevel={zoom}
        config={{ charWidth: (8 * zoom) / 100, rowHeight: (20 * zoom) / 100 }}
        onZoomLevelChange={setZoom}
      />
    );
  }
  render(<Viewer />);
  return screen.getByTestId('sequence-scroll-container');
}

function advanceFrames(count: number, check: () => void) {
  for (let frame = 0; frame < count; frame++) {
    act(() => {
      vi.advanceTimersByTime(16);
      const pending = [...callbacks];
      callbacks.clear();
      for (const [, callback] of pending) callback(performance.now());
    });
    check();
  }
}

function pinnedOrigin() {
  const { layout } = draws.latest!;
  const first = layout.lines.find((row) => row.lineIndex === 0);
  return {
    firstStart: first ? first.startPos : 0,
    firstX: first?.xOffset ?? 0,
    topSpace: layout.viewportOriginOffset ?? 0,
  };
}

it.each([
  ['in', -6],
  ['out', 6],
])('keeps the base under an off-center pointer while zooming %s a linear wrap', (_, deltaY) => {
  const container = renderLinearViewer();
  container.scrollTop = 1200;
  fireEvent.scroll(container);
  advanceFrames(4, () => undefined);
  const { layout, config } = draws.latest!;
  const row = layout.lines.find((line) => line.startPos <= 1550 && line.endPos > 1550)!;
  const tracks = computeLineTrackPositions(row, config);
  const point = {
    clientX:
      config.marginLeft + (row.xOffset ?? 0) + (1550 - row.startPos + 0.2) * config.charWidth,
    clientY: tracks.sequenceY + config.rowHeight / 2 - container.scrollTop,
  };
  const baseAt = () =>
    bpAtCursorForZoom(
      draws.latest!.layout,
      draws.latest!.config,
      container,
      point.clientX,
      point.clientY
    );
  const anchored = baseAt();
  expect(anchored).toBe(1550);
  const startWidth = draws.latest!.config.charWidth;
  const pinned = () => expect(pinnedOrigin()).toEqual({ firstStart: 0, firstX: 0, topSpace: 0 });
  for (let step = 0; step < 6; step++) {
    fireEvent.wheel(container, { deltaY, ctrlKey: true, ...point });
    advanceFrames(12, pinned);
    expect(baseAt()).toBe(anchored);
  }
  advanceFrames(30, pinned);
  expect(baseAt()).toBe(anchored);
  expect(draws.latest!.config.charWidth).not.toBeCloseTo(startWidth, 3);
});
