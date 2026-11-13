// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { parseGenBankFull } from '@waypoint/sequence-utils';
import { SequenceViewer1D } from '../SequenceViewer1D';
import {
  installRecordingCanvas,
  uninstallRecordingCanvas,
} from '../testing/recording-canvas-context';

const FIXTURES_DIR = join(__dirname, '../../../../../test-fixtures');
const LINEAR_FIXTURE = join(FIXTURES_DIR, 'sequences/linear/ecoli-mg1655-region.gb');

const VIEWPORT_WIDTH = 800;
const VIEWPORT_HEIGHT = 600;
const HORIZONTAL_PADDING_1D = 8;

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
  HTMLDivElement.prototype.getBoundingClientRect = function () {
    return {
      x: 0,
      y: 0,
      width: VIEWPORT_WIDTH,
      height: VIEWPORT_HEIGHT,
      top: 0,
      left: 0,
      bottom: VIEWPORT_HEIGHT,
      right: VIEWPORT_WIDTH,
      toJSON: () => ({}),
    } as DOMRect;
  };
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

async function flushFrames() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 20));
}

interface ViewerSnapshot {
  scrollLeft: number;
  pxPerBase: number;
}

function track(): {
  state: ViewerSnapshot;
  onViewportChange: (range: { start: number; end: number; wraps?: boolean }) => void;
} {
  const state: ViewerSnapshot = { scrollLeft: 0, pxPerBase: 9 };
  return {
    state,
    onViewportChange: (range) => {
      const cols = Math.max(1, range.end - range.start);
      state.pxPerBase = (VIEWPORT_WIDTH - HORIZONTAL_PADDING_1D) / cols;
      state.scrollLeft = range.start * state.pxPerBase;
    },
  };
}

function bioColAt(state: ViewerSnapshot, screenX: number): number {
  return (state.scrollLeft + screenX - HORIZONTAL_PADDING_1D) / state.pxPerBase;
}

const SEQUENCE = parseGenBankFull(readFileSync(LINEAR_FIXTURE, 'utf8'));

interface Tuple {
  initialPxPerBase: number;
  scrollToColumn: number;
  cursorFrac: number;
  zoomDir: 'in' | 'out';
}

const TUPLES: Tuple[] = [];
for (const initialPxPerBase of [2, 4, 8, 12]) {
  for (const cursorFrac of [0.05, 0.25, 0.5, 0.75, 0.95]) {
    for (const scrollToColumn of [500, 2_000, 10_000]) {
      for (const zoomDir of ['in', 'out'] as const) {
        TUPLES.push({ initialPxPerBase, scrollToColumn, cursorFrac, zoomDir });
      }
    }
  }
}

describe('SequenceViewer1D — zoom anchor property tests', () => {
  it.each(TUPLES)(
    'cursor column preserved across $zoomDir zoom (px=$initialPxPerBase, scrollTo=$scrollToColumn, cursorFrac=$cursorFrac)',
    async ({ initialPxPerBase, scrollToColumn, cursorFrac, zoomDir }) => {
      const tracker = track();
      const { container } = render(
        <SequenceViewer1D
          sequence={SEQUENCE}
          initialPxPerBase={initialPxPerBase}
          scrollToPosition={scrollToColumn}
          onViewportChange={tracker.onViewportChange}
        />
      );
      await act(async () => {
        await flushFrames();
      });

      const cursorScreenX = VIEWPORT_WIDTH * cursorFrac;
      const bioColBefore = bioColAt(tracker.state, cursorScreenX);

      const viewer = container.querySelector('[data-testid="sequence-viewer-1d"]');
      if (!viewer) throw new Error('viewer not mounted');

      await act(async () => {
        fireEvent.wheel(viewer, {
          deltaY: zoomDir === 'in' ? -100 : 100,
          clientX: cursorScreenX,
          clientY: 100,
          metaKey: true,
        });
        await flushFrames();
      });

      const bioColAfter = bioColAt(tracker.state, cursorScreenX);

      const drift = Math.abs(bioColAfter - bioColBefore);
      expect(
        drift,
        `cursor-col drift ${drift.toFixed(2)} cols exceeds 1.5 (before=${bioColBefore.toFixed(2)}, after=${bioColAfter.toFixed(2)}, scrollLeft=${tracker.state.scrollLeft.toFixed(1)}, pxPerBase=${tracker.state.pxPerBase.toFixed(2)})`
      ).toBeLessThanOrEqual(1.5);
    }
  );
});
