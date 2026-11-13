/**
 * @vitest-environment jsdom
 */

import { createRef, StrictMode } from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Annotation } from '@waypoint/sequence-utils';
import { SequenceScrollbar, type SequenceScrollbarHandle } from '../SequenceScrollbar';
import { SequenceViewer } from '../SequenceViewer';
import type { LayoutSnapshot2D } from '../types';
import {
  countOp,
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
  releaseSequenceWebGLContext: () => undefined,
}));

const MINIMAP_HEIGHT = 400;

class ImmediateResizeObserver {
  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }

  observe(target: Element): void {
    this.callback(
      [
        {
          target,
          contentRect: {
            x: 0,
            y: 0,
            width: 24,
            height: MINIMAP_HEIGHT,
            top: 0,
            left: 0,
            right: 24,
            bottom: MINIMAP_HEIGHT,
            toJSON: () => ({}),
          },
          borderBoxSize: [],
          contentBoxSize: [],
          devicePixelContentBoxSize: [],
        } as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver
    );
  }

  unobserve(): void {}
  disconnect(): void {}
}

beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
    ImmediateResizeObserver as unknown as typeof ResizeObserver;
  Object.defineProperty(window, 'devicePixelRatio', {
    configurable: true,
    value: 2,
  });
});

beforeEach(() => {
  installRecordingCanvas();
});

afterEach(() => {
  cleanup();
  uninstallRecordingCanvas();
});

function makeAnnotations(count: number): Annotation[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `feature-${index}`,
    type: index % 2 === 0 ? 'gene' : 'misc_feature',
    start: index * 2 + 1,
    end: index * 2 + 2,
    direction: 1,
    color: index % 2 === 0 ? '#16a34a' : '#2563eb',
  }));
}

describe('SequenceScrollbar annotation minimap', () => {
  it('navigates by Canvas base positions, including circular buffers and unequal row heights', () => {
    const layout: LayoutSnapshot2D = {
      lines: [0, 1000, 1100, 1400].map((y, i) => ({
        lineIndex: i,
        startPos: i === 2 ? 50 : 0,
        endPos: i === 2 ? 100 : 50,
        sequence: 'A'.repeat(50),
        complementSequence: 'T'.repeat(50),
        y,
        annotations: [],
        annotationLaneCount: 0,
        translationLaneCount: 0,
      })),
      totalHeight: 2500,
      totalWidth: 800,
      sequenceLength: 100,
      isCircular: true,
      firstRealRowIndex: 1,
      firstBottomBufferIndex: 3,
    };
    const ref = createRef<SequenceScrollbarHandle>();
    const onNavigate = vi.fn();
    const { container } = render(
      <SequenceScrollbar
        ref={ref}
        layout={layout}
        sequenceLength={100}
        annotations={[]}
        viewportScrollTop={1000}
        viewportHeight={600}
        totalHeight={400}
        onNavigate={onNavigate}
      />
    );
    const svg = container.querySelector('svg[style*="z-index: 2"]')!;
    const thumb = svg.querySelector('g rect')!;
    act(() => ref.current!.setViewportPositions({ start: 0, end: 80 }));
    fireEvent.mouseDown(thumb, { clientY: 100 });
    fireEvent.mouseMove(window, { clientY: 200 });
    fireEvent.mouseUp(window);
    expect(onNavigate).toHaveBeenLastCalledWith(1050);
    fireEvent.click(svg, { clientY: 300 });
    fireEvent.click(svg, { clientY: 300 });
    expect(onNavigate).toHaveBeenLastCalledWith(950);
  });

  it.each([false, true])(
    'keeps the Canvas scrollbar when short content fits (circular=%s)',
    (circular) => {
      const { container } = render(
        <SequenceViewer
          sequence={{
            id: 'short',
            name: 'short',
            sequence: 'ACGT',
            length: 4,
            circular,
            annotations: [],
          }}
          showMinimap
        />
      );
      expect(container.querySelector('[data-testid="sequence-scroll-container"]')).not.toBeNull();
      expect(
        container.querySelector('[data-testid="sequence-scrollbar-annotation-canvas"]')
      ).not.toBeNull();
    }
  );

  it('paints every annotation through one bounded canvas surface', () => {
    const annotations = makeAnnotations(2_000);
    const layout: LayoutSnapshot2D = {
      lines: [],
      totalHeight: 4_000,
      totalWidth: 800,
      sequenceLength: 4_000,
      isCircular: false,
    };

    const { container } = render(
      <StrictMode>
        <SequenceScrollbar
          layout={layout}
          sequenceLength={4_000}
          annotations={annotations}
          viewportHeight={600}
          totalHeight={4_000}
        />
      </StrictMode>
    );

    const canvas = container.querySelector<HTMLCanvasElement>(
      '[data-testid="sequence-scrollbar-annotation-canvas"]'
    );
    expect(canvas).not.toBeNull();
    if (!canvas) throw new Error('annotation minimap canvas missing');

    expect(canvas.dataset.paintedAnnotationCount).toBe('2000');
    expect(countOp(getRecordingLog(canvas), 'fillRect')).toBe(2_000);
    expect(container.querySelectorAll('svg rect').length).toBeLessThan(10);
    expect(container.querySelectorAll('svg title')).toHaveLength(0);
  });

  it('keeps genome markers painted while wrapped row heights change', () => {
    const annotations = makeAnnotations(2_000);
    const layout: LayoutSnapshot2D = {
      lines: [],
      totalHeight: 4_000,
      totalWidth: 800,
      sequenceLength: 4_000,
      isCircular: false,
    };
    const props = {
      sequenceLength: 4_000,
      annotations,
      viewportHeight: 600,
      totalHeight: 4_000,
    };
    const { container, rerender } = render(<SequenceScrollbar {...props} layout={layout} />);
    const canvas = container.querySelector<HTMLCanvasElement>(
      '[data-testid="sequence-scrollbar-annotation-canvas"]'
    )!;
    const paints = countOp(getRecordingLog(canvas), 'fillRect');
    expect(paints).toBeGreaterThanOrEqual(annotations.length);

    rerender(
      <SequenceScrollbar
        {...props}
        layout={{ ...layout, totalHeight: 9_000 }}
        totalHeight={9_000}
      />
    );
    expect(countOp(getRecordingLog(canvas), 'fillRect')).toBe(paints);
    expect(canvas.dataset.paintedAnnotationCount).toBe('2000');
  });
});
