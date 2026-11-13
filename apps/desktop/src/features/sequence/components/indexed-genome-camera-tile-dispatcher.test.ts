import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IndexedGenomeManifest } from '@waypoint/genome-data';
import type { GenomeTrackTile } from '../../../shared/indexed-genome';
import {
  markRendererInteractionActivity,
  rendererInteractionQuietDelayMs,
} from '../../../lib/renderer-interaction-activity';
import {
  IndexedGenomeCameraTileDispatcher,
  type IndexedGenomeCameraTileHost,
} from './indexed-genome-camera-tile-dispatcher';

vi.mock('../../../lib/renderer-interaction-activity', () => ({
  markRendererInteractionActivity: vi.fn(),
  rendererInteractionQuietDelayMs: vi.fn(() => 0),
}));

const manifest: IndexedGenomeManifest = {
  chrom: 'chr1',
  fastaPath: '/ref.fa',
  faiPath: '/ref.fa.fai',
  gffPath: '/ref.gff3.gz',
  tbiPath: '/ref.gff3.gz.tbi',
  length: 1_000_000,
};

function tile(overrides: Partial<GenomeTrackTile> = {}): GenomeTrackTile {
  return {
    sessionId: 's',
    requestId: 'annotation-viewport-1',
    trackId: 'chr1:annotations',
    chrom: 'chr1',
    start: 0,
    end: 16_384,
    generation: 1,
    state: 'ready',
    fidelity: 'exact',
    validationState: 'ok',
    byteCount: 0,
    recordCount: 0,
    features: [],
    ...overrides,
  };
}

type AnnotationPending = {
  startBp: number;
  endBp: number;
  token: number;
  requestId?: string;
} | null;

type TileHostHarness = IndexedGenomeCameraTileHost & {
  events: Array<{ event: string; detail?: Record<string, unknown> }>;
  pending: AnnotationPending;
  committed: Array<{ reason: string; startBp: number }>;
  cancelled: string[];
  fetches: number;
};

function host(overrides: Partial<IndexedGenomeCameraTileHost> = {}): TileHostHarness {
  const events: Array<{ event: string; detail?: Record<string, unknown> }> = [];
  const cancelled: string[] = [];
  const committed: Array<{ reason: string; startBp: number }> = [];
  let pending: AnnotationPending = null;
  let fetches = 0;
  return {
    events,
    cancelled,
    committed,
    get pending() {
      return pending;
    },
    get fetches() {
      return fetches;
    },
    isAssembly: false,
    length: 1_000_000,
    containerWidth: 800,
    sessionId: 'session-1',
    manifest,
    visibleTypes: new Set(['mRNA']),
    laneLimit: 12,
    debugInstanceId: 'test',
    recordEvent: (event, detail) => {
      events.push({ event, detail });
    },
    setPending: (next) => {
      pending = next;
    },
    commitTile: (next, reason) => {
      committed.push({ reason, startBp: next.startBp });
    },
    flushResidentPage: () => {},
    onTrackError: () => {},
    cancelRequest: (requestId) => {
      if (requestId) cancelled.push(requestId);
    },
    fetchTile: async (request, requestId) => {
      fetches += 1;
      return tile({
        requestId,
        generation: request.generation,
        start: request.start,
        end: request.end,
      });
    },
    ...overrides,
  };
}

async function flushMicrotasks(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

describe('IndexedGenomeCameraTileDispatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(rendererInteractionQuietDelayMs).mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('owns tile and camera timer fields on the dispatcher itself', () => {
    const dispatcher = new IndexedGenomeCameraTileDispatcher();
    expect(Object.hasOwn(dispatcher, 'annotationTileDispatchTimerRef')).toBe(true);
    expect(Object.hasOwn(dispatcher, 'annotationTileSemaphoreRef')).toBe(true);
    expect(Object.hasOwn(dispatcher, 'cameraChangeDispatchTimerRef')).toBe(true);
    expect(dispatcher.annotationTileDispatchTimerRef.current).toBeNull();
    expect(dispatcher.annotationTileSemaphoreRef.current.active).toBeNull();
  });

  it('clears owned timers without throwing when they are already idle', () => {
    const clearTimeout = vi.spyOn(window, 'clearTimeout');
    const dispatcher = new IndexedGenomeCameraTileDispatcher();
    dispatcher.clearAnnotationTileDispatchTimer();
    dispatcher.clearAnnotationTileCommitIdleTimer();
    dispatcher.clearCameraChangeDispatchTimer();
    expect(clearTimeout).not.toHaveBeenCalled();
    expect(dispatcher.annotationTileDispatchTimerRef.current).toBeNull();
  });

  it('clears a parked dispatch timer and drops the handle', () => {
    const clearTimeout = vi.spyOn(window, 'clearTimeout');
    const dispatcher = new IndexedGenomeCameraTileDispatcher();
    dispatcher.annotationTileDispatchTimerRef.current = 17;
    dispatcher.clearAnnotationTileDispatchTimer();
    expect(clearTimeout).toHaveBeenCalledWith(17);
    expect(dispatcher.annotationTileDispatchTimerRef.current).toBeNull();
  });

  it('does not request a chromosome viewport tile on an assembly camera', () => {
    const dispatcher = new IndexedGenomeCameraTileDispatcher();
    const tileHost = host({ isAssembly: true });
    dispatcher.requestAnnotationViewportTile(
      { reportedCenterBp: 1000, reason: 'scroll', viewportRange: { start: 0, end: 1000 } },
      tileHost
    );
    expect(tileHost.fetches).toBe(0);
    expect(tileHost.events).toEqual([]);
  });

  it('does not request a viewport annotation tile for a sequence-only genome', () => {
    const dispatcher = new IndexedGenomeCameraTileDispatcher();
    const tileHost = host({ manifest: { ...manifest, gffPath: undefined, tbiPath: undefined } });
    dispatcher.requestAnnotationViewportTile(
      { reportedCenterBp: 1000, reason: 'scroll', viewportRange: { start: 0, end: 1000 } },
      tileHost
    );
    expect(tileHost.fetches).toBe(0);
    expect(tileHost.events).toEqual([]);
  });

  it('skips a wide viewport instead of fetching', () => {
    const dispatcher = new IndexedGenomeCameraTileDispatcher();
    const tileHost = host();
    dispatcher.requestAnnotationViewportTile(
      {
        reportedCenterBp: 5_000_000,
        reason: 'zoom',
        viewportRange: { start: 0, end: 2_000_000 },
      },
      tileHost
    );
    expect(tileHost.fetches).toBe(0);
    expect(tileHost.events.map((entry) => entry.event)).toEqual([
      'annotation-viewport-tile-skip-wide',
    ]);
  });

  it('skips dispatch while zoom velocity is above the hysteresis budget', () => {
    const dispatcher = new IndexedGenomeCameraTileDispatcher();
    const tileHost = host();
    dispatcher.annotationTileHysteresisRef.current = {
      visibleBp: 1_000,
      timestampMs: 1,
    };
    vi.spyOn(performance, 'now').mockReturnValue(2);
    dispatcher.requestAnnotationViewportTile(
      {
        reportedCenterBp: 50_000,
        reason: 'zoom',
        viewportRange: { start: 0, end: 200_000 },
      },
      tileHost
    );
    expect(tileHost.fetches).toBe(0);
    expect(tileHost.events.map((entry) => entry.event)).toEqual([
      'annotation-viewport-tile-skipped-hysteresis',
    ]);
  });

  it('parks a second tile request until the active request drains', async () => {
    const dispatcher = new IndexedGenomeCameraTileDispatcher();
    let resolveFirst: ((tile: GenomeTrackTile) => void) | undefined;
    const tileHost = host({
      fetchTile: () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    });
    dispatcher.requestAnnotationViewportTile(
      { reportedCenterBp: 8_000, reason: 'scroll', viewportRange: { start: 0, end: 16_000 } },
      tileHost
    );
    dispatcher.requestAnnotationViewportTile(
      {
        reportedCenterBp: 400_000,
        reason: 'scroll',
        viewportRange: { start: 392_000, end: 408_000 },
      },
      tileHost
    );
    expect(tileHost.events.map((entry) => entry.event)).toContain(
      'annotation-viewport-tile-queued'
    );
    expect(dispatcher.annotationTilePendingDispatchRef.current).toBeTypeOf('function');
    expect(dispatcher.annotationTileSemaphoreRef.current.queued).not.toBeNull();
    await flushMicrotasks();
    expect(resolveFirst).toBeTypeOf('function');
    resolveFirst?.(
      tile({
        requestId: 'annotation-viewport-1',
        generation: 1,
        start: 0,
        end: 16_384,
      })
    );
    await flushMicrotasks();
    expect(dispatcher.annotationTilePendingDispatchRef.current).toBeNull();
  });

  it('coalesces camera changes onto one delayed process call', () => {
    const dispatcher = new IndexedGenomeCameraTileDispatcher();
    const process = vi.fn();
    dispatcher.scheduleCoalescedCameraChange(
      { reportedCenterBp: 10, reason: 'scroll', viewportRange: { start: 0, end: 100 } },
      process,
      48
    );
    dispatcher.scheduleCoalescedCameraChange(
      { reportedCenterBp: 20, reason: 'zoom', viewportRange: { start: 0, end: 200 } },
      process,
      48
    );
    expect(process).not.toHaveBeenCalled();
    vi.advanceTimersByTime(48);
    expect(process).toHaveBeenCalledTimes(1);
    expect(process).toHaveBeenCalledWith(20, 'zoom', { start: 0, end: 200 });
  });

  it('fetches and commits a chromosome viewport tile immediately when idle', async () => {
    const dispatcher = new IndexedGenomeCameraTileDispatcher();
    const tileHost = host();
    dispatcher.requestAnnotationViewportTile(
      { reportedCenterBp: 8_000, reason: 'scroll', viewportRange: { start: 0, end: 16_000 } },
      tileHost
    );
    expect(tileHost.events.map((entry) => entry.event)).toContain(
      'annotation-viewport-tile-request'
    );
    expect(tileHost.pending).not.toBeNull();
    await flushMicrotasks();
    expect(tileHost.fetches).toBe(1);
    expect(tileHost.committed).toEqual([{ reason: 'immediate', startBp: expect.any(Number) }]);
    expect(tileHost.pending).toBeNull();
  });

  it('records no-session instead of fetching when the host has no session', () => {
    const dispatcher = new IndexedGenomeCameraTileDispatcher();
    const tileHost = host({ sessionId: undefined });
    dispatcher.requestAnnotationViewportTile(
      { reportedCenterBp: 8_000, reason: 'scroll', viewportRange: { start: 0, end: 16_000 } },
      tileHost
    );
    expect(tileHost.fetches).toBe(0);
    expect(tileHost.events.map((entry) => entry.event)).toEqual([
      'annotation-viewport-tile-no-session',
    ]);
  });

  it('parks a ready tile until the renderer is quiet, then commits camera-idle', async () => {
    vi.mocked(rendererInteractionQuietDelayMs).mockReturnValue(16);
    const dispatcher = new IndexedGenomeCameraTileDispatcher();
    const tileHost = host();
    dispatcher.noteCameraInteraction(tileHost);
    expect(markRendererInteractionActivity).toHaveBeenCalledTimes(1);
    expect(dispatcher.cameraInteractionActiveRef.current).toBe(true);
    dispatcher.requestAnnotationViewportTile(
      { reportedCenterBp: 8_000, reason: 'scroll', viewportRange: { start: 0, end: 16_000 } },
      tileHost
    );
    await flushMicrotasks();
    expect(tileHost.committed).toEqual([]);
    expect(dispatcher.pendingAnnotationViewportTileCommitRef.current).not.toBeNull();
    expect(tileHost.events.map((entry) => entry.event)).toContain(
      'annotation-viewport-tile-commit-deferred'
    );
    vi.mocked(rendererInteractionQuietDelayMs).mockReturnValue(0);
    vi.advanceTimersByTime(16);
    expect(tileHost.committed).toEqual([{ reason: 'camera-idle', startBp: expect.any(Number) }]);
    expect(dispatcher.cameraInteractionActiveRef.current).toBe(false);
  });

  it('drops a coalesced camera change on reset without calling process', () => {
    const dispatcher = new IndexedGenomeCameraTileDispatcher();
    const process = vi.fn();
    dispatcher.scheduleCoalescedCameraChange(
      { reportedCenterBp: 10, reason: 'scroll', viewportRange: { start: 0, end: 100 } },
      process,
      48
    );
    dispatcher.reset();
    vi.advanceTimersByTime(48);
    expect(process).not.toHaveBeenCalled();
    expect(dispatcher.pendingCameraChangeRef.current).toBeNull();
    expect(dispatcher.cameraChangeDispatchTimerRef.current).toBeNull();
  });
});
