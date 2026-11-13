// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { parseGenBankFull, type SearchMatch } from '@waypoint/sequence-utils';
import { SequenceViewer1D } from '../SequenceViewer1D';
import {
  type CanvasOp,
  getRecordingLog,
  installRecordingCanvas,
  uninstallRecordingCanvas,
} from '../testing/recording-canvas-context';

const FIXTURES_DIR = join(__dirname, '../../../../../test-fixtures');
const LINEAR_FIXTURE = join(FIXTURES_DIR, 'sequences/linear/ecoli-mg1655-region.gb');
const CIRCULAR_FIXTURE = join(FIXTURES_DIR, 'sequences/circular/pUC19.gb');

function loadFixture(path: string) {
  const gb = readFileSync(path, 'utf8');
  return parseGenBankFull(gb);
}

const INACTIVE_LIGHT = 'hsla(35, 85%, 52%, 0.12)';
const INACTIVE_DARK = 'hsla(35, 85%, 52%, 0.10)';

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

function countInactiveSearchFills(log: CanvasOp[]): number {
  let count = 0;
  for (let i = 0; i < log.length; i++) {
    const e = log[i];
    if (e.op !== 'fillRect') continue;
    const fs = fillStyleAt(log, i);
    if (fs === INACTIVE_LIGHT || fs === INACTIVE_DARK) count++;
  }
  return count;
}

describe('SequenceViewer1D — search match highlights', () => {
  it('draws one faint-amber fillRect per inactive match', async () => {
    const sequence = loadFixture(LINEAR_FIXTURE);
    const matches: SearchMatch[] = [
      { start: 100, end: 109, type: 'sequence', strand: 1 },
      { start: 500, end: 509, type: 'sequence', strand: 1 },
      { start: 1000, end: 1009, type: 'sequence', strand: 1 },
    ];
    const { container } = render(
      <SequenceViewer1D
        sequence={sequence}
        searchMatches={matches}
        activeSearchIndex={1}
        initialPxPerBase={4}
      />
    );

    await act(async () => {
      await flushFrames();
    });

    const canvas = getViewerCanvas(container);
    const log = getRecordingLog(canvas);

    expect(countInactiveSearchFills(log)).toBe(2);
  });

  it('draws zero amber rects when searchMatches is undefined', async () => {
    const sequence = loadFixture(LINEAR_FIXTURE);
    const { container } = render(<SequenceViewer1D sequence={sequence} />);

    await act(async () => {
      await flushFrames();
    });

    const canvas = getViewerCanvas(container);
    const log = getRecordingLog(canvas);
    expect(countInactiveSearchFills(log)).toBe(0);
  });

  it('draws zero amber rects when searchMatches is empty', async () => {
    const sequence = loadFixture(LINEAR_FIXTURE);
    const { container } = render(
      <SequenceViewer1D sequence={sequence} searchMatches={[]} activeSearchIndex={undefined} />
    );

    await act(async () => {
      await flushFrames();
    });

    const canvas = getViewerCanvas(container);
    const log = getRecordingLog(canvas);
    expect(countInactiveSearchFills(log)).toBe(0);
  });

  it('renders both cycle copies for a wrapping match on a circular sequence', async () => {
    const sequence = loadFixture(CIRCULAR_FIXTURE);
    const seqLen = sequence.sequence.length;
    const matches: SearchMatch[] = [
      { start: seqLen - 50, end: 49, type: 'sequence', strand: 1, wraps: true },
    ];
    const { container } = render(
      <SequenceViewer1D
        sequence={sequence}
        searchMatches={matches}
        activeSearchIndex={undefined}
        initialPxPerBase={0.5}
      />
    );

    await act(async () => {
      await flushFrames();
    });

    const canvas = getViewerCanvas(container);
    const log = getRecordingLog(canvas);

    expect(countInactiveSearchFills(log)).toBeGreaterThanOrEqual(2);
  });
});
