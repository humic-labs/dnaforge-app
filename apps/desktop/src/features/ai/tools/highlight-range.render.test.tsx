
// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { parseGenBankFull } from '@waypoint/sequence-utils';
import { SequenceViewer1D } from '@waypoint/workspace-editor';
import {
  type CanvasOp,
  getRecordingLog,
  installRecordingCanvas,
  uninstallRecordingCanvas,
} from '../../../../../../packages/core/workspace-editor/src/testing/recording-canvas-context';
import { SELECTION_FILL_LIGHT } from '../../../../../../packages/core/workspace-editor/src/selection-primitives';

import { primerBindingToViewState } from '../../sequence/primer-binding-viewstate';


function fillStyleAt(log: CanvasOp[], i: number): string | undefined {
  for (let j = i - 1; j >= 0; j--) {
    const e = log[j];
    if (e.op === 'set' && e.prop === 'fillStyle') return String(e.value);
  }
  return undefined;
}

function selectionFills(log: CanvasOp[]): Array<Extract<CanvasOp, { op: 'fillRect' }>> {
  return log
    .map((e, i) => ({ e, i }))
    .filter((p) => p.e.op === 'fillRect' && fillStyleAt(log, p.i) === SELECTION_FILL_LIGHT)
    .map((p) => p.e as Extract<CanvasOp, { op: 'fillRect' }>);
}


const FIXTURES_DIR = join(__dirname, '../../../../../../test-fixtures');
const LINEAR_FIXTURE = join(FIXTURES_DIR, 'sequences/linear/ecoli-mg1655-region.gb');

function loadFixture(path: string) {
  return parseGenBankFull(readFileSync(path, 'utf8'));
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
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 });
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

async function renderHighlightBand(input: { start: number; end: number }) {
  const sequence = loadFixture(LINEAR_FIXTURE);
  const viewState = primerBindingToViewState(input.start, input.end);
  const { container } = render(
    <SequenceViewer1D sequence={sequence} selection={viewState.highlightRange} />
  );
  await act(async () => {
    await flushFrames();
  });
  const log = getRecordingLog(getViewerCanvas(container));
  return { fills: selectionFills(log), viewState };
}


describe('highlight_range → sequence viewer paint (L1)', () => {
  it('paints a selection band from a 1-indexed highlight_range via the shared converter', async () => {
    const { fills, viewState } = await renderHighlightBand({ start: 11, end: 31 });

    expect(viewState.highlightRange).toMatchObject({ start: 10, end: 30 });
    expect(viewState.scrollPosition).toBe(11);

    expect(fills.length, 'expected at least one selection-fill rect').toBeGreaterThan(0);
    const band = fills[0];
    expect(band.w, 'selection band width > 0').toBeGreaterThan(0);
    expect(band.h, 'selection band spans the full lane stack').toBeGreaterThan(40);
  });

  it('band position tracks the coordinate through the converter (off-by-one honest)', async () => {
    const near = await renderHighlightBand({ start: 6, end: 16 });
    const far = await renderHighlightBand({ start: 46, end: 56 });

    expect(near.fills.length, 'near band painted').toBeGreaterThan(0);
    expect(far.fills.length, 'far band painted').toBeGreaterThan(0);

    const nearX = Math.min(...near.fills.map((f) => f.x));
    const farX = Math.min(...far.fills.map((f) => f.x));
    expect(farX, 'a higher 1-indexed start paints further right').toBeGreaterThan(nearX);
  });
});
