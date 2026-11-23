import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IndexedPixiLinearRenderer, type Genome } from '@waypoint/genome-renderer';
import {
  useIndexedPixiMap,
  type PixiMapHandle,
} from '../../../../../../packages/core/genome-renderer/src/react/use-pixi-map';
import { disposeRetainedPixiApplications } from '../../../../../../packages/core/genome-renderer/src/react/pixi-application-retention';
import { TabPortalTarget } from '../../canvas/components/TabPortalTarget';
import type { Tab } from '../../canvas/types';
import type { GutterRow } from './track-gutter-rows';
import type { IndexedGenomeTileNativeMapHandle } from './IndexedGenomeTileNativeMap';
import { TrackGutter } from './TrackGutter';
import { useLaneScreenBands } from './useLaneScreenBands';

const fixture = vi.hoisted(() => ({
  renderNow: null as (() => void) | null,
  handle: null as PixiMapHandle | null,
  portalHost: null as HTMLDivElement | null,
  nextHeight: 80,
  presentedHeight: 80,
  renderCount: 0,
  destroyedRenderCount: 0,
  committedWidth: 0,
  committedPortalEpoch: 0,
  measuredWidth: 800,
  measuredHeight: 500,
  nextFrameId: 0,
  frames: new Map<number, FrameRequestCallback>(),
  resizeCallbacks: [] as Array<() => void>,
  log: vi.fn(),
  forensicSnapshot: vi.fn(() => {
    throw new Error('the DOM gutter must not materialize the forensic renderer snapshot');
  }),
}));

vi.mock('pixi.js', () => ({
  CanvasTextMetrics: { clearMeasurementCache: vi.fn() },
  GlobalResourceRegistry: { release: vi.fn() },
  Application: class {
    canvas = document.createElement('canvas');
    stage: { children: object[]; destroyed: boolean } | null = null;
    ticker = { stop: vi.fn() };
    renderer: { events: { setTargetElement: ReturnType<typeof vi.fn> } } | null = {
      events: { setTargetElement: vi.fn() },
    };
    async init() {
      this.stage = { children: [], destroyed: false };
    }
    render() {}
    destroy() {
      this.stage = null;
      this.renderer = null;
    }
  },
}));

vi.mock('@waypoint/genome-renderer', () => {
  class LinearRenderer {
    destroyed = false;
    async init() {}
    setSequenceWindow() {}
    setAnnotationsVisible() {}
    getViewCenterBp(state: { viewOffset: number }) {
      return state.viewOffset * 1_000_000;
    }
    setViewCenterBp(center: number, state: { viewOffset: number }) {
      state.viewOffset = center / 1_000_000;
    }
    render() {
      if (this.destroyed) fixture.destroyedRenderCount += 1;
      fixture.renderCount += 1;
      fixture.presentedHeight = fixture.nextHeight;
      return false;
    }
    hasDrawnOrfs() {
      return false;
    }
    getLaneScreenSnapshot() {
      const heightPx = fixture.presentedHeight;
      return {
        overlayLayout: {
          totalHeight: 0,
          offset: 0,
          annotationHeight: 0,
          strandEnvelopeTop: 0,
          strandEnvelopeBottom: 0,
          fwdStrandTop: 0,
          revStrandBottom: 0,
          trackScrollTop: 40,
        },
        trackScreenBounds: {
          p1: { topPx: 74, heightPx, bottomPx: 74 + heightPx, scrollsVertically: true },
          p2: {
            topPx: 74 + heightPx,
            heightPx: 80,
            bottomPx: 154 + heightPx,
            scrollsVertically: true,
          },
        },
      };
    }
    getRendererDebugSnapshot = fixture.forensicSnapshot;
    destroy() {
      this.destroyed = true;
    }
  }
  class IndexedRenderer extends LinearRenderer {}
  return {
    PixiLinearRenderer: LinearRenderer,
    IndexedPixiLinearRenderer: IndexedRenderer,
    PixiStadiumRenderer: LinearRenderer,
    perfLog: fixture.log,
    perfMark: vi.fn(),
    perfTime: (_label: string, work: () => unknown) => work(),
    perfTimeAsync: async (_label: string, work: () => unknown) => await work(),
    genomeFeatures: (genome: Genome) => genome.features ?? [],
    recordWebGLTrace: vi.fn(),
    registerWebGLInstance: vi.fn(),
    unregisterWebGLInstance: vi.fn(),
    webglThemeForMode: () => ({ background: 0xffffff }),
    applySelectionAction: vi.fn(),
    isWebGLTraceActive: () => false,
  };
});

vi.mock('../../../../../../packages/core/genome-renderer/src/react/pixi-canvas', () => ({
  clearPixiCanvas: vi.fn(),
  resizePixiCanvas: (app: { canvas: HTMLCanvasElement }, width: number, height: number) => {
    const backingChanged = app.canvas.width !== width || app.canvas.height !== height;
    app.canvas.width = width;
    app.canvas.height = height;
    return { width, height, backingChanged };
  },
}));

vi.mock('../../../../../../packages/core/genome-renderer/src/react/pixi-theme', () => ({
  applyPixiTheme: vi.fn(),
  currentWebGLThemeMode: () => 'light',
  installWebGLThemeObserver: () => () => undefined,
}));

vi.mock('../../../../../../packages/core/genome-renderer/src/react/webgl-test-hooks', () => ({
  clearWebGLTestHooks: vi.fn(),
  exposeWebGLTestHooks: (input: { renderNow: () => void }) => {
    fixture.renderNow = input.renderNow;
  },
  updateWebGLTestHookGenome: vi.fn(),
}));

vi.mock('../../../../../../packages/core/genome-renderer/src/react/interaction-adapter', () => ({
  attachPixiInteractionAdapter: () => ({
    flushInteraction: vi.fn(),
    cancelMotion: vi.fn(),
    cleanup: vi.fn(),
    invalidateHoverHitTest: vi.fn(),
  }),
}));

vi.mock('../../canvas/components/TabContentPortalManager', () => ({
  useTabPortalHost: () => fixture.portalHost,
}));

function dataRow(over: Partial<GutterRow> = {}): GutterRow {
  return {
    id: '__legacy__:p1',
    kind: 'data',
    label: 'HG002 pileup',
    visible: true,
    removable: true,
    togglable: true,
    trackId: 'p1',
    bucket: '__legacy__',
    band: { topPx: 440, heightPx: 60 },
    ...over,
  };
}

const noop = () => {};
const source: Genome = {
  name: 'completed-frame-producer',
  sourceIdentity: 'completed-frame-producer',
  length: 1_000_000,
  circular: false,
};
const tab: Tab = {
  id: 'completed-frame-tab',
  type: 'sequence',
  entityId: 'completed-frame-producer',
  label: 'Completed frame',
};
const webglRef: { current: IndexedGenomeTileNativeMapHandle | null } = { current: null };

function PresentedRows({ width = 800 }: { width?: number }) {
  const { containerRef, handle } = useIndexedPixiMap({
    genome: source,
    width,
    height: 500,
  });
  fixture.handle = handle;
  webglRef.current = {
    getComparisonCamera: handle.getComparisonCamera,
    setComparisonCamera: handle.setComparisonCamera,
    getComparisonSelection: () => null,
    getContactCamera: handle.getContactCamera,
    setContactCamera: handle.setContactCamera,
    getContactSelection: () => null,
    getLinearRenderer: () => {
      const renderer = handle.getLinearRenderer();
      return renderer instanceof IndexedPixiLinearRenderer ? renderer : null;
    },
    requestRender: handle.requestRender,
    subscribeToPresentedFrames: handle.subscribeToPresentedFrames,
    subscribeToCurrentGenomeFrames: handle.subscribeToPresentedFrames,
    setViewport: (range) => range,
    schedulePostPresentWork: handle.schedulePostPresentWork,
    getViewCenter: handle.getCameraCenter,
    getViewportRange: handle.getViewportRange,
    setViewCenter: handle.setViewCenter,
    setSelection: handle.setSelection,
    getSelection: () => null,
    setProteinSearchHighlightRanges: noop,
    setDisplaySize: handle.setDisplaySize,
    setTrackStackEndReserve: () => false,
    scrollTracksBy: () => false,
    setTrackPresentationOrder: () => false,
    setTrackPresentationDrag: () => false,
  };
  const bands = useLaneScreenBands(webglRef);
  useLayoutEffect(() => {
    fixture.committedWidth = width;
  }, [width]);
  return (
    <>
      <div ref={containerRef} />
      <TrackGutter
        rows={[
          dataRow({ band: bands.dataBounds.p1, requestedHeightPx: 112 }),
          dataRow({
            id: '__legacy__:p2',
            trackId: 'p2',
            label: 'Following row',
            band: bands.dataBounds.p2,
          }),
        ]}
        onToggleVisible={noop}
        onRemove={noop}
        onPreviewDataRowHeight={noop}
        onCommitDataRowHeight={noop}
      />
    </>
  );
}

function PortalCommitMarker({ epoch }: { epoch: number }) {
  useLayoutEffect(() => {
    fixture.committedPortalEpoch = epoch;
  }, [epoch]);
  return null;
}

function PortalRows({ epoch }: { epoch: number }) {
  if (!fixture.portalHost) throw new Error('portal fixture host is unavailable');
  return (
    <>
      {createPortal(<PresentedRows />, fixture.portalHost)}
      <TabPortalTarget key={epoch} tab={tab} />
      <PortalCommitMarker epoch={epoch} />
    </>
  );
}

async function initialFront() {
  await waitFor(() => expect(fixture.renderNow).toBeTypeOf('function'));
  act(() => fixture.renderNow?.());
  expect(screen.getByTestId('track-gutter-row-__legacy__:p1').style.height).toBe('80px');
  expect(screen.getByTestId('track-gutter-row-__legacy__:p2').style.top).toBe('194px');
}

function observeCompletedFrame(checkCommit: () => void = noop) {
  const resized = screen.getByTestId('track-gutter-row-__legacy__:p1');
  const following = screen.getByTestId('track-gutter-row-__legacy__:p2');
  const failures: unknown[] = [];
  let completions = 0;
  const unsubscribe = fixture.handle?.subscribeToPresentedFrames(() => {
    completions += 1;
    try {
      checkCommit();
      expect(resized.style.height).toBe('112px');
      expect(following.style.top).toBe('226px');
    } catch (error) {
      failures.push(error);
    }
  });
  if (!unsubscribe) throw new Error('presented-frame subscription is unavailable');
  return {
    unsubscribe,
    verify: () => {
      expect(completions).toBe(1);
      expect(failures).toEqual([]);
      expect(resized.querySelector('[role="separator"]')).not.toBeNull();
      expect(resized.querySelector<HTMLElement>('[role="separator"]')?.className).toContain(
        'bottom-0'
      );
      expect(following.className).not.toMatch(/transition-\[[^\]]*\btop\b/);
    },
  };
}

describe('completed-frame producer and lane gutter lifecycle', () => {
  beforeEach(() => {
    fixture.renderNow = null;
    fixture.handle = null;
    fixture.portalHost = document.createElement('div');
    fixture.nextHeight = 80;
    fixture.presentedHeight = 80;
    fixture.renderCount = 0;
    fixture.destroyedRenderCount = 0;
    fixture.committedWidth = 0;
    fixture.committedPortalEpoch = 0;
    fixture.measuredWidth = 800;
    fixture.measuredHeight = 500;
    fixture.nextFrameId = 0;
    fixture.frames.clear();
    fixture.resizeCallbacks.length = 0;
    fixture.log.mockClear();
    fixture.forensicSnapshot.mockClear();
    webglRef.current = null;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
      x: 0,
      y: 0,
      width: fixture.measuredWidth,
      height: fixture.measuredHeight,
      top: 0,
      right: fixture.measuredWidth,
      bottom: fixture.measuredHeight,
      left: 0,
      toJSON: () => ({}),
    }));
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(private callback: (entries: Array<{ isIntersecting: boolean }>) => void) {}
        observe() {
          queueMicrotask(() => this.callback([{ isIntersecting: true }]));
        }
        disconnect() {}
      }
    );
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          fixture.resizeCallbacks.push(callback);
        }
        observe() {}
        disconnect() {}
      }
    );
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = ++fixture.nextFrameId;
      fixture.frames.set(id, callback);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => fixture.frames.delete(id));
  });

  afterEach(() => {
    try {
      cleanup();
      disposeRetainedPixiApplications();
      expect(fixture.destroyedRenderCount).toBe(0);
      expect(fixture.forensicSnapshot).not.toHaveBeenCalled();
      expect(
        fixture.log.mock.calls.filter(([event]) =>
          ['frame-error', 'presented-frame-listener-error'].includes(event)
        )
      ).toEqual([]);
      expect(
        vi
          .mocked(console.error)
          .mock.calls.filter((args) =>
            args.some((arg) =>
              String(arg).includes('flushSync was called from inside a lifecycle method')
            )
          )
      ).toEqual([]);
      expect(fixture.frames.size).toBe(0);
    } finally {
      fixture.portalHost?.remove();
      webglRef.current = null;
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  it('presents display-prop backing changes after commit with current geometry inside the completed frame', async () => {
    const view = render(<PresentedRows />);
    await initialFront();
    const observation = observeCompletedFrame(() => expect(fixture.committedWidth).toBe(1_200));
    try {
      fixture.nextHeight = 112;
      const before = fixture.renderCount;
      view.rerender(<PresentedRows width={1_200} />);
      expect(fixture.renderCount).toBe(before);
      await act(async () => {
        await Promise.resolve();
      });
      observation.verify();
    } finally {
      observation.unsubscribe();
    }
  });

  it('presents the actual portal layout-origin attachment after commit with current geometry', async () => {
    const view = render(<PortalRows epoch={0} />);
    await initialFront();
    const observation = observeCompletedFrame(() => expect(fixture.committedPortalEpoch).toBe(1));
    try {
      fixture.nextHeight = 112;
      const before = fixture.renderCount;
      view.rerender(<PortalRows epoch={1} />);
      expect(fixture.renderCount).toBe(before);
      await act(async () => {
        await Promise.resolve();
      });
      observation.verify();
    } finally {
      observation.unsubscribe();
    }
  });

  it('keeps ordinary imperative display-size delivery synchronous', async () => {
    render(<PresentedRows />);
    await initialFront();
    const observation = observeCompletedFrame();
    try {
      fixture.nextHeight = 112;
      const before = fixture.renderCount;
      act(() => {
        fixture.handle?.setDisplaySize({ width: 1_200, height: 600 });
        expect(fixture.renderCount).toBe(before + 1);
        observation.verify();
      });
    } finally {
      observation.unsubscribe();
    }
  });

  it('keeps ordinary ResizeObserver delivery synchronous', async () => {
    render(<PresentedRows />);
    await initialFront();
    const observation = observeCompletedFrame();
    try {
      fixture.nextHeight = 112;
      fixture.measuredWidth = 1_200;
      fixture.measuredHeight = 600;
      const before = fixture.renderCount;
      act(() => {
        expect(fixture.resizeCallbacks).toHaveLength(1);
        fixture.resizeCallbacks[0]?.();
        expect(fixture.renderCount).toBe(before + 1);
        observation.verify();
      });
    } finally {
      observation.unsubscribe();
    }
  });

  it('keeps the real rAF completed-frame listener geometry synchronous', async () => {
    render(<PresentedRows />);
    await initialFront();
    const observation = observeCompletedFrame();
    try {
      fixture.nextHeight = 112;
      fixture.handle?.requestRender();
      const frame = fixture.frames.entries().next().value;
      if (!frame) throw new Error('real render-loop rAF ticket is unavailable');
      act(() => {
        fixture.frames.delete(frame[0]);
        frame[1](performance.now());
        observation.verify();
      });
    } finally {
      observation.unsubscribe();
    }
  });

  it('does not present a queued layout-origin frame after its owner unmounts', async () => {
    const view = render(<PresentedRows />);
    await initialFront();
    const listener = vi.fn();
    const unsubscribe = fixture.handle?.subscribeToPresentedFrames(listener);
    try {
      fixture.nextHeight = 112;
      const before = fixture.renderCount;
      view.rerender(<PresentedRows width={1_200} />);
      view.unmount();
      await act(async () => {
        await Promise.resolve();
      });
      expect(fixture.renderCount).toBe(before);
      expect(listener).not.toHaveBeenCalled();
      expect(fixture.destroyedRenderCount).toBe(0);
    } finally {
      unsubscribe?.();
    }
  });
});
