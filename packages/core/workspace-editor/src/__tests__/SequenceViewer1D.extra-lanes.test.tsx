// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { parseGenBankFull } from '@waypoint/sequence-utils';
import {
  SequenceViewer1D,
  type SequenceExtraLane,
  type SequenceExtraLanePaintInfo,
} from '../SequenceViewer1D';
import {
  type CanvasOp,
  getRecordingLog,
  installRecordingCanvas,
  uninstallRecordingCanvas,
} from '../testing/recording-canvas-context';

const FIXTURES_DIR = join(__dirname, '../../../../../test-fixtures');
const LINEAR_FIXTURE = join(FIXTURES_DIR, 'sequences/linear/ecoli-mg1655-region.gb');

function loadFixture(path: string) {
  const gb = readFileSync(path, 'utf8');
  return parseGenBankFull(gb);
}

const VIEWPORT_WIDTH = 800;
const VIEWPORT_HEIGHT = 600;

class ImmediateResizeObserver {
  private cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
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
            toJSON() {
              return {};
            },
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
    get() {
      return VIEWPORT_WIDTH;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return VIEWPORT_HEIGHT;
    },
  });
  Object.defineProperty(window, 'devicePixelRatio', {
    configurable: true,
    value: 1,
  });
});

beforeEach(() => {
  installRecordingCanvas();
});

afterEach(() => {
  cleanup();
  uninstallRecordingCanvas();
});

function getViewerCanvas(container: HTMLElement): HTMLCanvasElement {
  const viewer = container.querySelector('[data-testid="sequence-viewer-1d"]');
  if (!viewer) throw new Error('SequenceViewer1D not found');
  const canvas = viewer.querySelector('canvas');
  if (!canvas) throw new Error('canvas not found');
  return canvas as HTMLCanvasElement;
}

async function flushFrames() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 20));
}

function transformAtOp(
  log: CanvasOp[],
  opIndex: number
): [number, number, number, number, number, number] {
  const stack: Array<[number, number, number, number, number, number]> = [[1, 0, 0, 1, 0, 0]];
  let current = stack[0];
  for (let i = 0; i <= opIndex && i < log.length; i++) {
    const op = log[i];
    if (op.op === 'save') {
      stack.push([...current] as [number, number, number, number, number, number]);
    } else if (op.op === 'restore') {
      if (stack.length > 1) stack.pop();
      current = stack[stack.length - 1];
    } else if (op.op === 'translate') {
      current = [
        current[0],
        current[1],
        current[2],
        current[3],
        current[4] + current[0] * op.x + current[2] * op.y,
        current[5] + current[1] * op.x + current[3] * op.y,
      ];
      stack[stack.length - 1] = current;
    } else if (op.op === 'setTransform') {
      current = [op.a, op.b, op.c, op.d, op.e, op.f];
      stack[stack.length - 1] = current;
    }
  }
  return current;
}

describe('SequenceViewer1D — extraLanes paint hook contract', () => {
  it('extraLanes undefined: no extras-attributable draw ops appear in the log', async () => {
    const sequence = loadFixture(LINEAR_FIXTURE);
    const { container } = render(<SequenceViewer1D sequence={sequence} />);
    await act(async () => {
      await flushFrames();
    });
    const canvas = getViewerCanvas(container);
    const log = getRecordingLog(canvas);

    const probeFills = log.filter(
      (op) => op.op === 'fillText' && (op as { text: string }).text === '__probe__'
    );
    expect(probeFills).toHaveLength(0);
  });

  it('canvas is in WORLD coords when lane.draw is called (regression: zoom-in off-screen)', async () => {
    const sequence = loadFixture(LINEAR_FIXTURE);
    const captured: SequenceExtraLanePaintInfo[] = [];
    const probeLane: SequenceExtraLane = {
      id: 'probe',
      height: 32,
      draw: (ctx, info) => {
        captured.push({ ...info });
        ctx.fillRect(info.scrollLeft, info.laneY, 1, 1);
      },
    };
    const { container } = render(
      <SequenceViewer1D
        sequence={sequence}
        extraLanes={[probeLane]}
        initialPxPerBase={16}
        scrollToPosition={5_000}
      />
    );
    await act(async () => {
      await flushFrames();
    });

    expect(captured.length, 'probe lane should be called at least once').toBeGreaterThan(0);
    const info = captured[captured.length - 1];
    expect(info.scrollLeft, 'scrollLeft should be > 0 after scrollToPosition').toBeGreaterThan(0);

    const canvas = getViewerCanvas(container);
    const log = getRecordingLog(canvas);
    const probeOps: Array<{ idx: number; op: Extract<CanvasOp, { op: 'fillRect' }> }> = [];
    log.forEach((op, idx) => {
      if (op.op === 'fillRect' && op.w === 1 && op.h === 1 && op.x === info.scrollLeft) {
        probeOps.push({ idx, op });
      }
    });
    expect(probeOps.length, 'probe fillRect should appear in canvas log').toBeGreaterThan(0);

    for (const { idx, op } of probeOps) {
      const t = transformAtOp(log, idx);
      const screenX = t[0] * op.x + t[4];
      expect(
        screenX,
        `probe at world x=${op.x} should resolve to screen x≈0 — got ${screenX} (transform ${t.join(',')})`
      ).toBeCloseTo(0, 0);
    }
  });

  it('multiple lanes: called in input order with Y stacked starting at layout.totalHeight', async () => {
    const sequence = loadFixture(LINEAR_FIXTURE);
    const captured: Array<{ id: string; laneY: number; laneHeight: number }> = [];
    const lanes: SequenceExtraLane[] = [
      {
        id: 'lane-A',
        height: 30,
        draw: (_ctx, info) => {
          captured.push({ id: 'lane-A', laneY: info.laneY, laneHeight: info.laneHeight });
        },
      },
      {
        id: 'lane-B',
        height: 50,
        draw: (_ctx, info) => {
          captured.push({ id: 'lane-B', laneY: info.laneY, laneHeight: info.laneHeight });
        },
      },
      {
        id: 'lane-C',
        height: 20,
        draw: (_ctx, info) => {
          captured.push({ id: 'lane-C', laneY: info.laneY, laneHeight: info.laneHeight });
        },
      },
    ];
    render(<SequenceViewer1D sequence={sequence} extraLanes={lanes} />);
    await act(async () => {
      await flushFrames();
    });

    expect(captured.length).toBeGreaterThanOrEqual(3);
    const lastPass = captured.slice(-3);
    expect(lastPass.map((c) => c.id)).toEqual(['lane-A', 'lane-B', 'lane-C']);
    expect(lastPass[1].laneY).toBe(lastPass[0].laneY + lastPass[0].laneHeight);
    expect(lastPass[2].laneY).toBe(lastPass[1].laneY + lastPass[1].laneHeight);
  });

  it('paint info: pxPerBase, viewportWidth, visibleStart/End, isCircular match the 1D viewer state', async () => {
    const sequence = loadFixture(LINEAR_FIXTURE);
    const captured: SequenceExtraLanePaintInfo[] = [];
    const probe: SequenceExtraLane = {
      id: 'probe',
      height: 30,
      draw: (_ctx, info) => {
        captured.push({ ...info });
      },
    };
    render(<SequenceViewer1D sequence={sequence} extraLanes={[probe]} initialPxPerBase={4} />);
    await act(async () => {
      await flushFrames();
    });

    expect(captured.length).toBeGreaterThan(0);
    const info = captured[captured.length - 1];
    expect(info.pxPerBase).toBeCloseTo(4, 5);
    expect(info.viewportWidth).toBe(VIEWPORT_WIDTH);
    expect(info.columnCount).toBe(sequence.sequence.length);
    expect(info.isCircular).toBe(false);
    expect(info.visibleStart).toBe(0);
    expect(info.visibleEnd).toBeGreaterThan(0);
    expect(info.visibleEnd).toBeLessThanOrEqual(info.columnCount);
  });

  it('each lane is bracketed by save/restore in the canvas op log', async () => {
    const sequence = loadFixture(LINEAR_FIXTURE);
    const markers: Array<{ laneId: string; opIndexAtEntry: number }> = [];
    const probeLog: CanvasOp[][] = [];
    let captureNextLog: HTMLCanvasElement | null = null;
    const lanes: SequenceExtraLane[] = [
      {
        id: 'A',
        height: 20,
        draw: (ctx) => {
          captureNextLog = (ctx as unknown as { canvas: HTMLCanvasElement }).canvas;
          markers.push({
            laneId: 'A',
            opIndexAtEntry: getRecordingLog(captureNextLog).length,
          });
          ctx.fillRect(0, 0, 1, 1);
        },
      },
      {
        id: 'B',
        height: 20,
        draw: (ctx) => {
          markers.push({
            laneId: 'B',
            opIndexAtEntry: getRecordingLog(captureNextLog!).length,
          });
          ctx.fillRect(0, 0, 1, 1);
        },
      },
    ];
    const { container } = render(<SequenceViewer1D sequence={sequence} extraLanes={lanes} />);
    await act(async () => {
      await flushFrames();
    });
    if (captureNextLog) probeLog.push(getRecordingLog(captureNextLog));

    expect(markers.length).toBeGreaterThanOrEqual(2);
    const canvas = getViewerCanvas(container);
    const log = getRecordingLog(canvas);

    for (const marker of markers.slice(-2)) {
      let i = marker.opIndexAtEntry - 1;
      while (i >= 0 && log[i].op !== 'save') {
        if (log[i].op === 'translate' || log[i].op === 'set') {
          i--;
          continue;
        }
        break;
      }
      expect(
        i >= 0 && log[i]?.op,
        `[${marker.laneId}] expected save before lane.draw at op ${marker.opIndexAtEntry}`
      ).toBe('save');
    }
  });
});
