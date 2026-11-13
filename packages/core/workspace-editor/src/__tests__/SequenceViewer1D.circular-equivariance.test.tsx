// @vitest-environment jsdom

import { act, cleanup, render } from '@testing-library/react';
import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { parseGenBankFull, findORFs, type ORF } from '@waypoint/sequence-utils';
import { SequenceViewer1D } from '../SequenceViewer1D';
import {
  compute1DLayout,
  HORIZONTAL_PADDING_1D,
  RULER_HEIGHT_1D,
  SEQUENCE_ROW_HEIGHT_1D,
} from '../layout-1d';
import {
  type CanvasOp,
  getRecordingLog,
  installRecordingCanvas,
  uninstallRecordingCanvas,
} from '../testing/recording-canvas-context';

const FIXTURES_DIR = join(__dirname, '../../../../../test-fixtures');
const FIXTURES = {
  pUC19: join(FIXTURES_DIR, 'sequences/circular/pUC19.gb'),
  originSpanning: join(FIXTURES_DIR, 'sequences/circular/origin-spanning-synthetic.gb'),
} as const;

const VIEWPORT_WIDTH = 800;
const VIEWPORT_HEIGHT = 600;
const DEFAULT_PX_PER_BASE = 8;

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

interface TransformState {
  tx: number;
  ty: number;
}

function normalizeToScreenOps(log: CanvasOp[]): CanvasOp[] {
  let tx = 0;
  let ty = 0;
  const stack: TransformState[] = [];
  const out: CanvasOp[] = [];

  for (const op of log) {
    switch (op.op) {
      case 'save':
        stack.push({ tx, ty });
        out.push(op);
        break;
      case 'restore': {
        const prev = stack.pop();
        if (prev) {
          tx = prev.tx;
          ty = prev.ty;
        }
        out.push(op);
        break;
      }
      case 'translate':
        tx += op.x;
        ty += op.y;
        out.push(op);
        break;
      case 'setTransform':
        tx = op.e;
        ty = op.f;
        out.push(op);
        break;
      case 'resetTransform':
        tx = 0;
        ty = 0;
        out.push(op);
        break;
      case 'fillRect':
      case 'strokeRect':
      case 'clearRect':
      case 'rect':
        out.push({ ...op, x: op.x + tx, y: op.y + ty });
        break;
      case 'fillText':
      case 'strokeText':
        out.push({ ...op, x: op.x + tx, y: op.y + ty });
        break;
      case 'moveTo':
      case 'lineTo':
        out.push({ ...op, x: op.x + tx, y: op.y + ty });
        break;
      case 'arc':
        out.push({ ...op, x: op.x + tx, y: op.y + ty });
        break;
      default:
        out.push(op);
    }
  }
  return out;
}

function lastFrameOps(log: CanvasOp[]): CanvasOp[] {
  let lastClear = -1;
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i].op === 'clearRect') {
      lastClear = i;
      break;
    }
  }
  return lastClear >= 0 ? log.slice(lastClear) : log;
}

function opScreenX(op: CanvasOp): number | null {
  switch (op.op) {
    case 'fillRect':
    case 'strokeRect':
    case 'rect':
      return op.x + op.w / 2;
    case 'fillText':
    case 'strokeText':
      return op.x;
    case 'moveTo':
    case 'lineTo':
    case 'arc':
      return op.x;
    default:
      return null;
  }
}

function opBandBox(op: CanvasOp): { yMin: number; yMax: number } | null {
  switch (op.op) {
    case 'fillRect':
    case 'strokeRect':
    case 'rect':
      return { yMin: op.y, yMax: op.y + op.h };
    case 'fillText':
    case 'strokeText':
    case 'moveTo':
    case 'lineTo':
    case 'arc':
      return { yMin: op.y, yMax: op.y };
    default:
      return null;
  }
}

const CONTENT_OPS = new Set<CanvasOp['op']>([
  'fillRect',
  'strokeRect',
  'fillText',
  'strokeText',
  'moveTo',
  'lineTo',
]);

function isContentOp(op: CanvasOp): boolean {
  return CONTENT_OPS.has(op.op);
}

function splitByHalf(
  screenOps: CanvasOp[],
  yMin: number,
  yMax: number,
  centerX: number
): { left: CanvasOp[]; right: CanvasOp[] } {
  const left: CanvasOp[] = [];
  const right: CanvasOp[] = [];
  for (const op of screenOps) {
    if (!isContentOp(op)) continue;
    const box = opBandBox(op);
    if (!box) continue;
    if (box.yMin < yMin || box.yMax > yMax) continue;
    const x = opScreenX(op);
    if (x === null) continue;
    if (x < -50 || x > VIEWPORT_WIDTH + 50) continue;
    if (x < centerX) left.push(op);
    else right.push(op);
  }
  return { left, right };
}

function loadFixture(path: string) {
  const gb = readFileSync(path, 'utf8');
  return parseGenBankFull(gb);
}

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

describe.each([
  { name: 'pUC19 (origin-spanning rep_origin)', path: FIXTURES.pUC19 },
  {
    name: 'origin-spanning-synthetic (CDS at complement(3299..678))',
    path: FIXTURES.originSpanning,
  },
])('SequenceViewer1D — translation-equivariance — $name', ({ path }) => {
  it('every render band paints in BOTH halves of a straddle viewport', async () => {
    const sequence = loadFixture(path);
    const columnCount = sequence.sequence.length;

    const orfs: ORF[] = findORFs(sequence.sequence);

    const layout = compute1DLayout({
      columnCount,
      annotations: sequence.annotations ?? [],
      pxPerBase: DEFAULT_PX_PER_BASE,
      fullSequence: sequence.sequence,
      orfs,
      isCircular: true,
      showReverseComplement: true,
    });

    const { container } = render(
      <SequenceViewer1D
        sequence={sequence}
        orfs={orfs}
        scrollToPosition={0}
        showReverseComplement={true}
      />
    );

    await act(async () => {
      await flushFrames();
    });

    const canvas = getViewerCanvas(container);
    const finalFrame = lastFrameOps(getRecordingLog(canvas));
    const screenOps = normalizeToScreenOps(finalFrame);

    const fillTextOps = screenOps.filter(
      (o): o is Extract<CanvasOp, { op: 'fillText' }> => o.op === 'fillText'
    );
    const numericRulerLabels = fillTextOps
      .filter((o) => o.y >= layout.rulerY && o.y <= layout.rulerY + RULER_HEIGHT_1D)
      .map((o) => Number(o.text))
      .filter((n) => Number.isFinite(n));
    expect(
      numericRulerLabels.some((n) => n > columnCount * 0.75),
      'straddle viewport must include high-col ruler labels on left half'
    ).toBe(true);
    expect(
      numericRulerLabels.includes(1),
      'straddle viewport must include the "1" ruler label (new cycle starts)'
    ).toBe(true);

    const SPLIT_X = VIEWPORT_WIDTH / 2;

    const scrollLeft =
      columnCount * DEFAULT_PX_PER_BASE -
      (VIEWPORT_WIDTH / 2 - HORIZONTAL_PADDING_1D - 0.5 * DEFAULT_PX_PER_BASE);
    const visibleStartCol = Math.max(
      0,
      Math.floor((scrollLeft - HORIZONTAL_PADDING_1D) / DEFAULT_PX_PER_BASE)
    );
    const visibleEndCol = Math.ceil(
      (scrollLeft + VIEWPORT_WIDTH - HORIZONTAL_PADDING_1D) / DEFAULT_PX_PER_BASE
    );
    const leftHalfEndCol = Math.min(columnCount, visibleEndCol);
    const rightHalfStartVirtual = Math.max(visibleStartCol, columnCount);
    const rightBioStart = rightHalfStartVirtual - columnCount;
    const rightBioEnd = visibleEndCol - columnCount;

    const leftBioRange: [number, number] = [visibleStartCol, leftHalfEndCol - 1];
    const rightBioRange: [number, number] = [
      rightBioStart,
      Math.max(rightBioStart, rightBioEnd - 1),
    ];

    function annOverlapsRange(
      ann: { start: number; end: number },
      lo: number,
      hi: number
    ): boolean {
      const annStart0 = ann.start - 1;
      const annEnd0 = ann.end - 1;
      if (annStart0 <= annEnd0) {
        return !(annEnd0 < lo || annStart0 > hi);
      }
      return !(columnCount - 1 < lo || annStart0 > hi) || !(annEnd0 < lo || 0 > hi);
    }

    const annotations = sequence.annotations ?? [];
    const nonCdsAnns = annotations.filter((a) => a.type !== 'CDS');
    const cdsAnns = annotations.filter((a) => a.type === 'CDS');

    const expectAnnLeft = nonCdsAnns.some((a) =>
      annOverlapsRange(a, leftBioRange[0], leftBioRange[1])
    );
    const expectAnnRight = nonCdsAnns.some((a) =>
      annOverlapsRange(a, rightBioRange[0], rightBioRange[1])
    );
    const expectCdsLeft = cdsAnns.some((a) =>
      annOverlapsRange(a, leftBioRange[0], leftBioRange[1])
    );
    const expectCdsRight = cdsAnns.some((a) =>
      annOverlapsRange(a, rightBioRange[0], rightBioRange[1])
    );

    function orfOverlapsRange(o: ORF, lo: number, hi: number): boolean {
      return !(o.end < lo || o.start > hi);
    }
    const expectOrfLeft = orfs.some((o) => orfOverlapsRange(o, leftBioRange[0], leftBioRange[1]));
    const expectOrfRight = orfs.some((o) =>
      orfOverlapsRange(o, rightBioRange[0], rightBioRange[1])
    );

    interface Band {
      name: string;
      yMin: number;
      yMax: number;
      expectLeft: boolean;
      expectRight: boolean;
    }

    const bands: Band[] = [
      {
        name: 'annotation lanes',
        yMin: layout.laneBandTop,
        yMax: layout.laneBandTop + layout.laneBandHeight,
        expectLeft: expectAnnLeft,
        expectRight: expectAnnRight,
      },
      {
        name: 'CDS translation band',
        yMin: layout.translationBandTop,
        yMax: layout.translationBandTop + layout.translationBandHeight,
        expectLeft: expectCdsLeft,
        expectRight: expectCdsRight,
      },
      {
        name: 'ORF band',
        yMin: layout.orfBandTop,
        yMax: layout.orfBandTop + layout.orfBandHeight,
        expectLeft: expectOrfLeft,
        expectRight: expectOrfRight,
      },
      {
        name: 'forward strand text',
        yMin: layout.sequenceRowY,
        yMax: layout.sequenceRowY + SEQUENCE_ROW_HEIGHT_1D,
        expectLeft: true,
        expectRight: true,
      },
      {
        name: 'reverse complement strand',
        yMin: layout.complementRowY,
        yMax: layout.complementRowY + SEQUENCE_ROW_HEIGHT_1D,
        expectLeft: true,
        expectRight: true,
      },
      {
        name: 'ruler',
        yMin: layout.rulerY,
        yMax: layout.rulerY + RULER_HEIGHT_1D,
        expectLeft: true,
        expectRight: true,
      },
    ];

    const failures: string[] = [];
    for (const band of bands) {
      const { left, right } = splitByHalf(screenOps, band.yMin, band.yMax, SPLIT_X);
      if (band.expectLeft && left.length === 0) {
        failures.push(
          `${band.name}: expected content on LEFT half (pre-origin biological cols ${leftBioRange[0]}..${leftBioRange[1]}) but got 0 ops. ` +
            `This is the "origin-straddle render disappearance" bug — a render path is clamping to columnCount instead of iterating offsets.`
        );
      }
      if (band.expectRight && right.length === 0) {
        failures.push(
          `${band.name}: expected content on RIGHT half (post-origin biological cols ${rightBioRange[0]}..${rightBioRange[1]} via wrap) but got 0 ops. ` +
            `This is the "origin-straddle render disappearance" bug — a render path is clamping to columnCount instead of iterating offsets.`
        );
      }
    }

    expect(failures, 'straddle-origin render must paint both halves for every band').toEqual([]);
  });
});

describe('SequenceViewer1D — wrap-aware overlays', () => {
  it('renders a wrap selection in both halves of any viewport it crosses', async () => {
    const sequence = loadFixture(FIXTURES.pUC19);
    const columnCount = sequence.sequence.length;
    const selection = {
      start: columnCount - 50,
      end: 50,
      wraps: true,
    };
    const { container } = render(
      <SequenceViewer1D
        sequence={sequence}
        selection={selection}
        scrollToPosition={0}
        showReverseComplement={true}
      />
    );
    await act(async () => {
      await flushFrames();
    });
    const canvas = getViewerCanvas(container);
    const screenOps = normalizeToScreenOps(lastFrameOps(getRecordingLog(canvas)));

    const SEL_FILL = 'rgb(255, 255, 200)';
    let currentFillStyle = '';
    const selFills: Array<{ x: number; w: number }> = [];
    for (const op of screenOps) {
      if (op.op === 'set' && op.prop === 'fillStyle') {
        currentFillStyle = String(op.value);
      }
      if (op.op === 'fillRect' && currentFillStyle === SEL_FILL) {
        selFills.push({ x: op.x, w: op.w });
      }
    }

    const SPLIT_X = VIEWPORT_WIDTH / 2;
    const leftFills = selFills.filter((f) => f.x + f.w / 2 < SPLIT_X);
    const rightFills = selFills.filter((f) => f.x + f.w / 2 >= SPLIT_X);
    expect(leftFills.length, 'wrap selection must render a fill in the LEFT half').toBeGreaterThan(
      0
    );
    expect(
      rightFills.length,
      'wrap selection must render a fill in the RIGHT half'
    ).toBeGreaterThan(0);
  });

  it('renders the view cursor at a wrap-buffer col in a straddle viewport', async () => {
    const sequence = loadFixture(FIXTURES.pUC19);
    const { container } = render(
      <SequenceViewer1D
        sequence={sequence}
        viewCursor={10}
        scrollToPosition={0}
        showReverseComplement={true}
      />
    );
    await act(async () => {
      await flushFrames();
    });
    const canvas = getViewerCanvas(container);
    const screenOps = normalizeToScreenOps(lastFrameOps(getRecordingLog(canvas)));

    const SPLIT_X = VIEWPORT_WIDTH / 2;
    const rightStrokes = screenOps.filter(
      (o) => o.op === 'moveTo' && o.x >= SPLIT_X && o.x <= VIEWPORT_WIDTH
    );
    expect(
      rightStrokes.length,
      'view cursor at wrap-buffer bio col must stroke in the RIGHT half'
    ).toBeGreaterThan(0);
  });
});
