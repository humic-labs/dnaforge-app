/** @vitest-environment jsdom */

import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseGenBankFull } from '@waypoint/sequence-utils';
import { SequenceViewer1D } from '../SequenceViewer1D';
import {
  installRecordingCanvas,
  uninstallRecordingCanvas,
} from '../testing/recording-canvas-context';

const FIXTURES_DIR = join(__dirname, '../../../../../test-fixtures');
const LINEAR_FIXTURE = join(FIXTURES_DIR, 'sequences/linear/ecoli-mg1655-region.gb');

function loadFixture(path: string) {
  return parseGenBankFull(readFileSync(path, 'utf8'));
}

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

interface ViewerState {
  scrollLeft: number;
  pxPerBase: number;
}

function track(): {
  state: ViewerState;
  onViewportChange: (range: { start: number; end: number; wraps?: boolean }) => void;
  onZoomChange: (zoomPercent: number) => void;
} {
  const state: ViewerState = { scrollLeft: 0, pxPerBase: 9 };

  return {
    state,
    onViewportChange: (range) => {
      const cols = Math.max(1, range.end - range.start);
      const px = (VIEWPORT_WIDTH - HORIZONTAL_PADDING_1D) / cols;
      state.pxPerBase = px;
      state.scrollLeft = range.start * px;
    },
    onZoomChange: (zoomPercent) => {
      state.pxPerBase = (8 * zoomPercent) / 100;
    },
  };
}

function bioColAtScreenX(state: ViewerState, screenX: number): number {
  return (state.scrollLeft + screenX - HORIZONTAL_PADDING_1D) / state.pxPerBase;
}

describe('SequenceViewer1D — zoom anchor', () => {
  it('acknowledges a controlled scroll only after the viewer applies it', async () => {
    const sequence = loadFixture(LINEAR_FIXTURE);
    const onScrollToPositionComplete = vi.fn();

    render(
      <SequenceViewer1D
        sequence={sequence}
        scrollToPosition={2_000}
        scrollAnimate={false}
        onScrollToPositionComplete={onScrollToPositionComplete}
      />
    );

    await act(async () => {
      await flushFrames();
    });

    expect(onScrollToPositionComplete).toHaveBeenCalledTimes(1);
  });

  it('consumes a new command ID at the same target without treating callback identity as a request', async () => {
    const sequence = loadFixture(LINEAR_FIXTURE);
    const firstComplete = vi.fn();
    const secondComplete = vi.fn();
    const unrelatedCallback = vi.fn();
    const view = render(
      <SequenceViewer1D
        sequence={sequence}
        scrollToPosition={2_000}
        scrollCommandId={1}
        scrollAnimate={false}
        onScrollToPositionComplete={firstComplete}
      />
    );
    await act(async () => {
      await flushFrames();
    });
    expect(firstComplete).toHaveBeenCalledTimes(1);

    view.rerender(
      <SequenceViewer1D
        sequence={sequence}
        scrollToPosition={2_000}
        scrollCommandId={2}
        scrollAnimate={false}
        onScrollToPositionComplete={secondComplete}
      />
    );
    await act(async () => {
      await flushFrames();
    });
    expect(secondComplete).toHaveBeenCalledTimes(1);

    view.rerender(
      <SequenceViewer1D
        sequence={sequence}
        scrollToPosition={2_000}
        scrollCommandId={2}
        scrollAnimate={false}
        onScrollToPositionComplete={unrelatedCallback}
      />
    );
    await act(async () => {
      await flushFrames();
    });
    expect(unrelatedCallback).not.toHaveBeenCalled();
    expect(secondComplete).toHaveBeenCalledTimes(1);
  });

  it('Cmd+wheel zoom anchors on the cursor (column under cursor stays put)', async () => {
    const sequence = loadFixture(LINEAR_FIXTURE);
    const tracker = track();
    const { container } = render(
      <SequenceViewer1D
        sequence={sequence}
        initialPxPerBase={4}
        scrollToPosition={3000}
        onViewportChange={tracker.onViewportChange}
      />
    );
    await act(async () => {
      await flushFrames();
    });

    const cursorScreenX = VIEWPORT_WIDTH * 0.75;
    const bioColBeforeZoom = bioColAtScreenX(tracker.state, cursorScreenX);

    const viewer = container.querySelector('[data-testid="sequence-viewer-1d"]');
    if (!viewer) throw new Error('viewer not mounted');

    await act(async () => {
      fireEvent.wheel(viewer, {
        deltaY: -100,
        clientX: cursorScreenX,
        clientY: 100,
        metaKey: true,
      });
      await flushFrames();
    });

    const bioColAfterZoom = bioColAtScreenX(tracker.state, cursorScreenX);

    expect(bioColAfterZoom).toBeCloseTo(bioColBeforeZoom, 0);
  });

  it('Cmd+wheel zoom-out also anchors on the cursor', async () => {
    const sequence = loadFixture(LINEAR_FIXTURE);
    const tracker = track();
    const { container } = render(
      <SequenceViewer1D
        sequence={sequence}
        initialPxPerBase={8}
        scrollToPosition={2000}
        onViewportChange={tracker.onViewportChange}
      />
    );
    await act(async () => {
      await flushFrames();
    });

    const cursorScreenX = VIEWPORT_WIDTH * 0.25;
    const bioColBeforeZoom = bioColAtScreenX(tracker.state, cursorScreenX);

    const viewer = container.querySelector('[data-testid="sequence-viewer-1d"]');
    if (!viewer) throw new Error('viewer not mounted');

    await act(async () => {
      fireEvent.wheel(viewer, {
        deltaY: 100,
        clientX: cursorScreenX,
        clientY: 100,
        ctrlKey: true,
      });
      await flushFrames();
    });

    const bioColAfterZoom = bioColAtScreenX(tracker.state, cursorScreenX);
    expect(bioColAfterZoom).toBeCloseTo(bioColBeforeZoom, 0);
  });

  it('regression: with cursor far from center, zoom does NOT pin the center column', async () => {
    const sequence = loadFixture(LINEAR_FIXTURE);
    const tracker = track();
    const { container } = render(
      <SequenceViewer1D
        sequence={sequence}
        initialPxPerBase={4}
        scrollToPosition={3000}
        onViewportChange={tracker.onViewportChange}
      />
    );
    await act(async () => {
      await flushFrames();
    });

    const cursorScreenX = VIEWPORT_WIDTH * 0.75;
    const centerScreenX = VIEWPORT_WIDTH / 2;

    const cursorColBefore = bioColAtScreenX(tracker.state, cursorScreenX);
    const centerColBefore = bioColAtScreenX(tracker.state, centerScreenX);

    const viewer = container.querySelector('[data-testid="sequence-viewer-1d"]');
    if (!viewer) throw new Error('viewer not mounted');
    await act(async () => {
      fireEvent.wheel(viewer, {
        deltaY: -100,
        clientX: cursorScreenX,
        clientY: 100,
        metaKey: true,
      });
      await flushFrames();
    });

    const cursorColAfter = bioColAtScreenX(tracker.state, cursorScreenX);
    const centerColAfter = bioColAtScreenX(tracker.state, centerScreenX);

    const cursorDrift = Math.abs(cursorColAfter - cursorColBefore);
    const centerDrift = Math.abs(centerColAfter - centerColBefore);
    expect(
      cursorDrift,
      `cursor-column should be more stable than center-column under cursor-anchored zoom — cursor drift ${cursorDrift.toFixed(2)}, center drift ${centerDrift.toFixed(2)}`
    ).toBeLessThan(centerDrift);
  });

  it('toolbar zoom (no cursor) keeps the center column pinned', async () => {
    const sequence = loadFixture(LINEAR_FIXTURE);
    const tracker = track();
    const { rerender } = render(
      <SequenceViewer1D
        sequence={sequence}
        zoomPercent={50}
        scrollToPosition={2000}
        onViewportChange={tracker.onViewportChange}
        onZoomChange={tracker.onZoomChange}
      />
    );
    await act(async () => {
      await flushFrames();
    });

    const centerScreenX = VIEWPORT_WIDTH / 2;
    const centerColBefore = bioColAtScreenX(tracker.state, centerScreenX);

    rerender(
      <SequenceViewer1D
        sequence={sequence}
        zoomPercent={75}
        scrollToPosition={2000}
        onViewportChange={tracker.onViewportChange}
        onZoomChange={tracker.onZoomChange}
      />
    );
    await act(async () => {
      await flushFrames();
    });

    const centerColAfter = bioColAtScreenX(tracker.state, centerScreenX);
    expect(centerColAfter).toBeCloseTo(centerColBefore, 0);
  });
});

describe('SequenceViewer1D — native precision and motion handover', () => {
  type ScrollState = ViewerState & { clientWidth: number; hpad: number };
  const runtime = window as unknown as {
    __test?: { sequenceViewer1D?: { getScrollState: () => ScrollState } };
  };
  let previousTestBridge: typeof runtime.__test;
  let removeNativeSource: (() => void) | undefined;

  beforeEach(() => {
    previousTestBridge = runtime.__test;
    runtime.__test = {};
    vi.useFakeTimers({
      toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'],
    });
  });

  afterEach(() => {
    cleanup();
    removeNativeSource?.();
    removeNativeSource = undefined;
    runtime.__test = previousTestBridge;
    vi.useRealTimers();
  });

  const readScroll = (): ScrollState => {
    const bridge = runtime.__test?.sequenceViewer1D;
    if (!bridge) throw new Error('Missing the mounted SequenceViewer1D scroll-state bridge');
    return bridge.getScrollState();
  };
  const advanceFrames = async (milliseconds: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(milliseconds);
    });
  };
  const enableNativePrecision = async () => {
    const { installNativeWheelSource } =
      await import('../../../platform/src/wheel-input.test-helper');
    removeNativeSource = installNativeWheelSource(document);
  };

  it('accumulates every 0.25px precision packet without an easing tail', async () => {
    await enableNativePrecision();
    const { getByTestId } = render(
      <SequenceViewer1D
        sequence={loadFixture(LINEAR_FIXTURE)}
        initialPxPerBase={4}
        scrollToPosition={2_000}
        scrollAnimate={false}
      />
    );
    await advanceFrames(32);
    const viewer = getByTestId('sequence-viewer-1d');
    const start = readScroll().scrollLeft;

    for (let packet = 1; packet <= 4; packet += 1) {
      fireEvent.wheel(viewer, { deltaY: 0.25, deltaMode: 0 });
      expect(readScroll().scrollLeft - start).toBeCloseTo(packet * 0.25, 10);
    }
    await advanceFrames(240);
    expect(readScroll().scrollLeft - start).toBeCloseTo(1, 10);
  });

  it('imperative scrollToPosition cancels the remaining coarse wheel motion', async () => {
    const viewerRef = { current: null as { scrollToPosition: (position: number) => void } | null };
    const { getByTestId } = render(
      <SequenceViewer1D
        ref={viewerRef}
        sequence={loadFixture(LINEAR_FIXTURE)}
        initialPxPerBase={4}
        scrollToPosition={2_000}
        scrollAnimate={false}
      />
    );
    await advanceFrames(32);
    const start = readScroll().scrollLeft;

    fireEvent.wheel(getByTestId('sequence-viewer-1d'), { deltaY: 2.5, deltaMode: 1 });
    await advanceFrames(16);
    const duringWheel = readScroll().scrollLeft;
    expect(duringWheel).toBeGreaterThan(start);
    expect(duringWheel).toBeLessThan(start + 40);

    act(() => {
      if (!viewerRef.current) throw new Error('Missing the public SequenceViewer1D handle');
      viewerRef.current.scrollToPosition(5_000);
    });
    const destination = readScroll();
    expect(destination.scrollLeft).toBeCloseTo(
      destination.hpad + 5_000.5 * destination.pxPerBase - destination.clientWidth / 2,
      10
    );
    await advanceFrames(240);
    expect(readScroll().scrollLeft).toBeCloseTo(destination.scrollLeft, 10);
  });

  it('precision wheel input cancels an animated navigation tween', async () => {
    await enableNativePrecision();
    const sequence = loadFixture(LINEAR_FIXTURE);
    const { getByTestId, rerender } = render(
      <SequenceViewer1D
        sequence={sequence}
        initialPxPerBase={4}
        scrollToPosition={2_000}
        scrollAnimate={false}
      />
    );
    await advanceFrames(32);
    const start = readScroll();
    rerender(
      <SequenceViewer1D
        sequence={sequence}
        initialPxPerBase={4}
        scrollToPosition={5_000}
        scrollAnimate
      />
    );
    await advanceFrames(64);
    const duringNavigation = readScroll().scrollLeft;
    const navigationTarget = start.hpad + 4_999.5 * start.pxPerBase - start.clientWidth / 2;
    expect(duringNavigation).toBeGreaterThan(start.scrollLeft);
    expect(duringNavigation).toBeLessThan(navigationTarget);

    fireEvent.wheel(getByTestId('sequence-viewer-1d'), { deltaY: 4, deltaMode: 0 });
    expect(readScroll().scrollLeft).toBeCloseTo(duringNavigation + 4, 10);
    await advanceFrames(400);
    expect(readScroll().scrollLeft).toBeCloseTo(duringNavigation + 4, 10);
  });
  it('revokes an in-flight controlled animation without acknowledging it', async () => {
    const sequence = loadFixture(LINEAR_FIXTURE);
    const onComplete = vi.fn();
    const view = render(<SequenceViewer1D sequence={sequence} initialPxPerBase={4} />);
    await advanceFrames(32);
    const start = readScroll().scrollLeft;
    view.rerender(
      <SequenceViewer1D
        sequence={sequence}
        initialPxPerBase={4}
        scrollToPosition={5_000}
        scrollCommandId={1}
        onScrollToPositionComplete={onComplete}
      />
    );
    await advanceFrames(64);
    const moving = readScroll().scrollLeft;
    expect(moving).toBeGreaterThan(start);
    expect(onComplete).not.toHaveBeenCalled();
    view.rerender(
      <SequenceViewer1D sequence={sequence} initialPxPerBase={4} scrollToPosition={null} />
    );
    await advanceFrames(400);
    expect(readScroll().scrollLeft).toBe(moving);
    expect(onComplete).not.toHaveBeenCalled();
  });
});
