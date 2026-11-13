// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { parseGenBankFull } from '@waypoint/sequence-utils';
import { SequenceViewer1D } from '../SequenceViewer1D';
import { CHANGE_COLORS, type CoordinateSpace, type MutationMarker } from '../types';
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

function fillStyleAt(log: CanvasOp[], i: number): string | undefined {
  for (let j = i - 1; j >= 0; j--) {
    const e = log[j];
    if (e.op === 'set' && e.prop === 'fillStyle') {
      return String(e.value);
    }
  }
  return undefined;
}

function countFillsWithStyle(log: CanvasOp[], targetColor: string): number {
  let n = 0;
  for (let i = 0; i < log.length; i++) {
    const e = log[i];
    if (e.op !== 'fillRect') continue;
    if (fillStyleAt(log, i) === targetColor) n++;
  }
  return n;
}

describe('SequenceViewer1D — mutation track (Phase 4)', () => {
  it('paints colored backgrounds at mutation columns when mutations are provided', async () => {
    const sequence = loadFixture(LINEAR_FIXTURE);
    const coordinateSpace: CoordinateSpace = {
      mode: 'gapped',
      gappedSequence: sequence.sequence,
      alignedQuery: sequence.sequence,
    };
    const mutations: MutationMarker[] = [
      { column: 100, type: 'substitution', refBase: 'A', queryBase: 'G' },
      { column: 200, type: 'insertion', refBase: '-', queryBase: 'T' },
      { column: 300, type: 'deletion', refBase: 'C', queryBase: '-' },
    ];

    const { container } = render(
      <SequenceViewer1D
        sequence={sequence}
        coordinateSpace={coordinateSpace}
        mutations={mutations}
        initialPxPerBase={4}
      />
    );

    await act(async () => {
      await flushFrames();
    });

    const canvas = getViewerCanvas(container);
    const log = getRecordingLog(canvas);

    const subColor = CHANGE_COLORS.substitution.bg;
    expect(countFillsWithStyle(log, subColor)).toBeGreaterThanOrEqual(1);
  });

  it('renders nothing in the mutation-track band when no mutations or alignedQuery are provided', async () => {
    const sequence = loadFixture(LINEAR_FIXTURE);
    const { container } = render(<SequenceViewer1D sequence={sequence} initialPxPerBase={4} />);

    await act(async () => {
      await flushFrames();
    });

    const canvas = getViewerCanvas(container);
    const log = getRecordingLog(canvas);

    expect(countFillsWithStyle(log, CHANGE_COLORS.substitution.bg)).toBe(0);
    expect(countFillsWithStyle(log, CHANGE_COLORS.insertion.bg)).toBe(0);
    expect(countFillsWithStyle(log, CHANGE_COLORS.deletion.bg)).toBe(0);
  });

  it('emits aligned-query glyphs when alignedQuery is provided (zoom above text threshold)', async () => {
    const sequence = loadFixture(LINEAR_FIXTURE);
    const alignedQuery = 'X'.repeat(50) + sequence.sequence.slice(50);
    const coordinateSpace: CoordinateSpace = {
      mode: 'gapped',
      gappedSequence: sequence.sequence,
      alignedQuery,
    };

    const { container } = render(
      <SequenceViewer1D
        sequence={sequence}
        coordinateSpace={coordinateSpace}
        initialPxPerBase={10}
      />
    );

    await act(async () => {
      await flushFrames();
    });

    const canvas = getViewerCanvas(container);
    const log = getRecordingLog(canvas);

    const xTextOps = log.filter((e) => e.op === 'fillText' && e.text === 'X');
    expect(xTextOps.length).toBeGreaterThan(0);
  });
});
