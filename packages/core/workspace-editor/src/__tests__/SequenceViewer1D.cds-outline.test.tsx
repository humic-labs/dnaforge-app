/** @vitest-environment jsdom */
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AnnotatedSequence } from '@waypoint/sequence-utils';
import { SequenceViewer1D } from '../SequenceViewer1D';
import {
  getRecordingLog,
  installRecordingCanvas,
  uninstallRecordingCanvas,
  type CanvasOp,
} from '../testing/recording-canvas-context';

const VIEWPORT_WIDTH = 800;
const VIEWPORT_HEIGHT = 600;

class ImmediateResizeObserver {
  constructor(private cb: ResizeObserverCallback) {}
  observe(target: Element) {
    this.cb(
      [
        {
          target,
          contentRect: {
            x: 0,
            y: 0,
            width: VIEWPORT_WIDTH,
            height: VIEWPORT_HEIGHT,
            top: 0,
            left: 0,
            bottom: VIEWPORT_HEIGHT,
            right: VIEWPORT_WIDTH,
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
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
    ImmediateResizeObserver as unknown as typeof ResizeObserver;
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => VIEWPORT_WIDTH,
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => VIEWPORT_HEIGHT,
  });
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 });
});

beforeEach(() => {
  installRecordingCanvas();
  (window as unknown as { __test?: Record<string, unknown> }).__test = {};
});

afterEach(() => {
  cleanup();
  uninstallRecordingCanvas();
  delete (window as unknown as { __test?: Record<string, unknown> }).__test;
});

function interactionStrokes(log: CanvasOp[]) {
  const strokes: { style: string; width: number }[] = [];
  let style = '';
  let width = 1;
  const stack: { style: string; width: number }[] = [];
  for (const op of log) {
    if (op.op === 'save') stack.push({ style, width });
    if (op.op === 'restore') ({ style, width } = stack.pop() ?? { style, width });
    if (op.op === 'set' && op.prop === 'strokeStyle') style = String(op.value);
    if (op.op === 'set' && op.prop === 'lineWidth') width = Number(op.value);
    if (op.op === 'stroke' && width >= 1.5) strokes.push({ style, width });
  }
  return strokes;
}

describe('SequenceViewer1D CDS interaction outline', () => {
  it('strokes the selected CDS name, line and chevrons as one outline', async () => {
    const sequenceText = 'ATG' + 'GCT'.repeat(160) + 'TAA';
    const cds = {
      name: 'cdsA',
      type: 'CDS',
      start: 1,
      end: sequenceText.length,
      direction: 1 as const,
      color: '#4F7FE8',
    };
    const sequence: AnnotatedSequence = {
      id: 'one-cds',
      name: 'one-cds',
      sequence: sequenceText,
      length: sequenceText.length,
      circular: false,
      annotations: [cds],
    };
    const { container } = render(<SequenceViewer1D sequence={sequence} selectedAnnotation={cds} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 20));
      await new Promise((r) => setTimeout(r, 20));
    });
    const canvas = container.querySelector<HTMLCanvasElement>(
      '[data-testid="sequence-viewer-1d"] canvas'
    )!;
    const strokes = interactionStrokes(getRecordingLog(canvas));
    expect(strokes).toHaveLength(1);
  });
});
