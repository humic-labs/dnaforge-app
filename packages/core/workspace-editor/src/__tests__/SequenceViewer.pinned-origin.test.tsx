/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { installNativeWheelSource } from '@waypoint/platform/wheel-motion';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SequenceViewer } from '../SequenceViewer';
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

it('keeps the finite wrapped origin at the top-left during off-center zoom and release', () => {
  const sequence = {
    id: 'pinned-origin',
    name: 'pinned-origin',
    sequence: 'ACGT'.repeat(1000),
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
  const origin = () => {
    const { layout } = draws.latest!;
    const first = layout.lines.find((row) => row.startPos === 0)!;
    return {
      topBp: layout.summary!.topBp,
      x: first.xOffset ?? 0,
      topSpace: layout.viewportOriginOffset ?? 0,
    };
  };
  expect(origin()).toEqual({ topBp: 0, x: 0, topSpace: 0 });
  fireEvent.wheel(screen.getByTestId('sequence-scroll-container'), {
    deltaY: 60,
    ctrlKey: true,
    clientX: 431,
    clientY: 48,
  });
  for (let frame = 0; frame < 30; frame++) {
    act(() => {
      vi.advanceTimersByTime(16);
      const pending = [...callbacks];
      callbacks.clear();
      for (const [, callback] of pending) callback(performance.now());
    });
    expect(origin()).toEqual({ topBp: 0, x: 0, topSpace: 0 });
  }
  expect(draws.latest!.config.charWidth).toBeLessThan(8);
});
