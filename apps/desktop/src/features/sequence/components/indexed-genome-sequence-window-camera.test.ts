// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

import type { GenomeSequenceWindow } from '../../../shared/indexed-genome';
import {
  SEQUENCE_STREAM_MIN_PIXELS_PER_BP,
  SEQUENCE_WINDOW_PAD_BP,
  SEQUENCE_WINDOW_TARGET_BP,
} from './indexed-sequence-window-policy';
import {
  applyIndexedGenomeSequenceWindowCameraDecision,
  isCancelledSequenceWindow,
  processIndexedGenomeAssemblyCameraChange,
  resolveIndexedGenomeSequenceWindowCameraChange,
  type IndexedGenomeSequenceWindowCameraHost,
} from './indexed-genome-sequence-window-camera';

const CHR11_LENGTH = 135_086_622;
const VIEW_WIDTH = 1_200;

async function flushMicrotasks(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

function sequenceWindow(overrides: Partial<GenomeSequenceWindow> = {}): GenomeSequenceWindow {
  return {
    sessionId: 'session-chr11',
    requestId: 'sequence-window-1',
    chrom: 'chr11',
    start: 500_000,
    end: 500_000 + SEQUENCE_WINDOW_TARGET_BP,
    generation: 1,
    validationState: 'ok',
    byteCount: 128,
    bases: 'ACGT'.repeat(32),
    ...overrides,
  };
}

function host(
  overrides: Partial<IndexedGenomeSequenceWindowCameraHost> = {}
): IndexedGenomeSequenceWindowCameraHost & {
  events: Array<{ event: string; detail?: Record<string, unknown> }>;
  cancelled: Array<string | null | undefined>;
  sequenceWindows: Array<{ startBp: number; endBp: number; bases: string }>;
  pendingWindows: Array<{ startBp: number; endBp: number; token: number } | null>;
  fetches: GenomeSequenceWindow['requestId'][];
  trackErrors: string[];
} {
  const events: Array<{ event: string; detail?: Record<string, unknown> }> = [];
  const cancelled: Array<string | null | undefined> = [];
  const sequenceWindows: Array<{ startBp: number; endBp: number; bases: string }> = [];
  const pendingWindows: Array<{ startBp: number; endBp: number; token: number } | null> = [];
  const fetches: string[] = [];
  const trackErrors: string[] = [];
  const built: IndexedGenomeSequenceWindowCameraHost & {
    events: typeof events;
    cancelled: typeof cancelled;
    sequenceWindows: typeof sequenceWindows;
    pendingWindows: typeof pendingWindows;
    fetches: typeof fetches;
    trackErrors: typeof trackErrors;
  } = {
    events,
    cancelled,
    sequenceWindows,
    pendingWindows,
    fetches,
    trackErrors,
    length: CHR11_LENGTH,
    containerWidth: VIEW_WIDTH,
    sessionId: 'session-chr11',
    chrom: 'chr11',
    lastViewportCenter: { current: null },
    sequenceWindowCoverage: { current: null },
    sequenceWindowPending: { current: null },
    fetchToken: { current: 0 },
    recordEvent: (event, detail) => {
      events.push(detail ? { event, detail } : { event });
    },
    commitSceneViewportRange: vi.fn(),
    setPendingSequenceWindow: (pending) => {
      pendingWindows.push(pending);
    },
    setSequenceWindow: (window) => {
      sequenceWindows.push({
        startBp: window.startBp,
        endBp: window.endBp,
        bases: window.bases,
      });
    },
    cancelRequest: (requestId) => {
      cancelled.push(requestId);
    },
    fetchSequenceWindow: (request, requestId) => {
      fetches.push(requestId);
      return Promise.resolve(
        sequenceWindow({
          requestId,
          start: request.start,
          end: request.end,
          generation: request.generation,
        })
      );
    },
    onSequenceTrackError: (message) => {
      trackErrors.push(message);
    },
    ...overrides,
  };
  return built;
}

describe('processIndexedGenomeAssemblyCameraChange', () => {
  it('commits the assembly viewport and streams pileup without reminting sequence', () => {
    const lastViewportCenter = { current: null as number | null };
    const events: Array<{ event: string; detail?: Record<string, unknown> }> = [];
    const commitSceneViewportRange = vi.fn();
    const onAssemblyCamera = vi.fn();
    const streamPileupViaTileEngine = vi.fn();
    const viewportRange = { start: 1_000, end: 5_000 };

    processIndexedGenomeAssemblyCameraChange({
      reportedCenterBp: 9_999,
      reason: 'scroll',
      handleCenter: 2_500,
      viewportRange,
      assemblyLengthBp: 3_088_269_832,
      assemblyRoutingEnabled: true,
      lastViewportCenter,
      recordEvent: (event, detail) => {
        events.push(detail ? { event, detail } : { event });
      },
      commitSceneViewportRange,
      onAssemblyCamera,
      streamPileupViaTileEngine,
    });

    expect(commitSceneViewportRange).toHaveBeenCalledWith(viewportRange, 3_088_269_832);
    expect(lastViewportCenter.current).toBe(3_000);
    expect(onAssemblyCamera).toHaveBeenCalledWith(viewportRange, { immediate: false });
    expect(streamPileupViaTileEngine).toHaveBeenCalledWith(viewportRange);
    expect(events.map((entry) => entry.event)).toEqual(['camera-change']);
    expect(events[0]?.detail).toMatchObject({
      reason: 'scroll',
      reportedCenterBp: 9_999,
      handleCenterBp: 2_500,
      centerBp: 3_000,
      viewportRange,
    });
  });

  it('records fail-closed when assembly routing is disabled', () => {
    const events: Array<{ event: string }> = [];
    processIndexedGenomeAssemblyCameraChange({
      reportedCenterBp: 100,
      reason: 'zoom',
      handleCenter: null,
      viewportRange: null,
      assemblyLengthBp: 1_000,
      assemblyRoutingEnabled: false,
      lastViewportCenter: { current: null },
      recordEvent: (event) => {
        events.push({ event });
      },
      commitSceneViewportRange: vi.fn(),
      onAssemblyCamera: vi.fn(),
      streamPileupViaTileEngine: vi.fn(),
    });
    expect(events.map((entry) => entry.event)).toEqual([
      'camera-change',
      'assembly-camera-fail-closed-no-router',
    ]);
  });
});

describe('indexed genome sequence-window camera change', () => {
  it('skips LOD for chromosome-scale views and cancels a pending FASTA read', () => {
    const cameraHost = host({
      sequenceWindowPending: {
        current: { startBp: 0, endBp: 1_000, token: 3, requestId: 'sequence-window-3' },
      },
      fetchToken: { current: 3 },
    });

    const decision = resolveIndexedGenomeSequenceWindowCameraChange({
      reportedCenterBp: 70_000_000,
      reason: 'zoom',
      handleCenter: 70_000_000,
      viewportRange: { start: 10_000_000, end: 120_000_000 },
      host: cameraHost,
    });
    expect(decision.kind).toBe('skip-lod');
    expect(decision.pixelsPerBp).toBeLessThan(SEQUENCE_STREAM_MIN_PIXELS_PER_BP);
    expect(cameraHost.commitSceneViewportRange).toHaveBeenCalled();

    applyIndexedGenomeSequenceWindowCameraDecision(decision, 'zoom', cameraHost);

    expect(cameraHost.cancelled).toEqual(['sequence-window-3']);
    expect(cameraHost.fetchToken.current).toBe(4);
    expect(cameraHost.sequenceWindowPending.current).toBeNull();
    expect(cameraHost.fetches).toEqual([]);
    expect(cameraHost.events.map((entry) => entry.event)).toEqual([
      'camera-change',
      'sequence-window-skip-lod',
    ]);
  });

  it('reuses loaded coverage instead of fetching', () => {
    const cameraHost = host({
      sequenceWindowCoverage: { current: { startBp: 528_441, endBp: 725_049 } },
    });
    const decision = resolveIndexedGenomeSequenceWindowCameraChange({
      reportedCenterBp: 626_744,
      reason: 'scroll',
      handleCenter: 626_744,
      viewportRange: { start: 626_578, end: 626_910 },
      host: cameraHost,
    });
    expect(decision.kind).toBe('loaded-coverage');
    applyIndexedGenomeSequenceWindowCameraDecision(decision, 'scroll', cameraHost);
    expect(cameraHost.fetches).toEqual([]);
    expect(cameraHost.events.map((entry) => entry.event)).toEqual([
      'camera-change',
      'sequence-window-covered',
    ]);
  });

  it('reuses a covering pending request instead of fetching again', () => {
    const pending = { startBp: 528_441, endBp: 725_049, token: 7, requestId: 'sequence-window-7' };
    const cameraHost = host({ sequenceWindowPending: { current: pending } });
    const decision = resolveIndexedGenomeSequenceWindowCameraChange({
      reportedCenterBp: 626_744,
      reason: 'scroll',
      handleCenter: 626_744,
      viewportRange: { start: 626_578, end: 626_910 },
      host: cameraHost,
    });
    expect(decision.kind).toBe('pending-coverage');
    applyIndexedGenomeSequenceWindowCameraDecision(decision, 'scroll', cameraHost);
    expect(cameraHost.fetches).toEqual([]);
    expect(cameraHost.events.at(-1)?.event).toBe('sequence-window-pending');
  });

  it('records no-session instead of fetching when the host has no session', () => {
    const cameraHost = host({ sessionId: undefined });
    const decision = resolveIndexedGenomeSequenceWindowCameraChange({
      reportedCenterBp: 47_450_000,
      reason: 'zoom',
      handleCenter: 47_450_000,
      viewportRange: { start: 47_426_000, end: 47_474_000 },
      host: cameraHost,
    });
    expect(decision.kind).toBe('request');
    applyIndexedGenomeSequenceWindowCameraDecision(decision, 'zoom', cameraHost);
    expect(cameraHost.fetches).toEqual([]);
    expect(cameraHost.events.at(-1)?.event).toBe('sequence-window-no-session');
  });

  it('fetches a bounded FASTA window and commits coverage on success', async () => {
    const cameraHost = host();
    const decision = resolveIndexedGenomeSequenceWindowCameraChange({
      reportedCenterBp: 47_450_000,
      reason: 'zoom',
      handleCenter: 47_450_000,
      viewportRange: { start: 47_426_000, end: 47_474_000 },
      host: cameraHost,
    });
    expect(decision.kind).toBe('request');
    applyIndexedGenomeSequenceWindowCameraDecision(decision, 'zoom', cameraHost);
    expect(cameraHost.sequenceWindowPending.current?.requestId).toBe('sequence-window-1');
    await flushMicrotasks();
    expect(cameraHost.fetches).toEqual(['sequence-window-1']);
    expect(cameraHost.sequenceWindows).toHaveLength(1);
    expect(
      cameraHost.sequenceWindows[0]?.endBp - (cameraHost.sequenceWindows[0]?.startBp ?? 0)
    ).toBe(SEQUENCE_WINDOW_TARGET_BP + SEQUENCE_WINDOW_PAD_BP * 2);
    expect(cameraHost.sequenceWindowCoverage.current).toEqual({
      startBp: cameraHost.sequenceWindows[0]?.startBp,
      endBp: cameraHost.sequenceWindows[0]?.endBp,
    });
    expect(cameraHost.events.map((entry) => entry.event)).toEqual([
      'camera-change',
      'sequence-window-request',
      'sequence-window-ready',
    ]);
  });

  it('ignores an empty cancelled window instead of wiping coverage', async () => {
    const cameraHost = host({
      fetchSequenceWindow: (_request, requestId) =>
        Promise.resolve(
          sequenceWindow({
            requestId,
            start: 100,
            end: 100,
            byteCount: 0,
            bases: '',
          })
        ),
    });
    const decision = resolveIndexedGenomeSequenceWindowCameraChange({
      reportedCenterBp: 47_450_000,
      reason: 'scroll',
      handleCenter: 47_450_000,
      viewportRange: { start: 47_426_000, end: 47_474_000 },
      host: cameraHost,
    });
    applyIndexedGenomeSequenceWindowCameraDecision(decision, 'scroll', cameraHost);
    await flushMicrotasks();
    expect(cameraHost.sequenceWindows).toEqual([]);
    expect(cameraHost.sequenceWindowCoverage.current).toBeNull();
    expect(cameraHost.events.at(-1)?.event).toBe('sequence-window-cancelled');
    expect(
      isCancelledSequenceWindow(sequenceWindow({ start: 100, end: 100, byteCount: 0, bases: '' }))
    ).toBe(true);
  });

  it('swallows AbortError without reporting a sequence track error', async () => {
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    const cameraHost = host({
      fetchSequenceWindow: () => Promise.reject(abortError),
    });
    const decision = resolveIndexedGenomeSequenceWindowCameraChange({
      reportedCenterBp: 47_450_000,
      reason: 'scroll',
      handleCenter: 47_450_000,
      viewportRange: { start: 47_426_000, end: 47_474_000 },
      host: cameraHost,
    });
    applyIndexedGenomeSequenceWindowCameraDecision(decision, 'scroll', cameraHost);
    await flushMicrotasks();
    expect(cameraHost.trackErrors).toEqual([]);
    expect(cameraHost.sequenceWindows).toEqual([]);
    expect(cameraHost.events.at(-1)?.event).toBe('sequence-window-cancelled');
  });

  it('reports a sequence track error and keeps the previous window', async () => {
    const cameraHost = host({
      fetchSequenceWindow: () => Promise.reject(new Error('fasta offline')),
    });
    const decision = resolveIndexedGenomeSequenceWindowCameraChange({
      reportedCenterBp: 47_450_000,
      reason: 'scroll',
      handleCenter: 47_450_000,
      viewportRange: { start: 47_426_000, end: 47_474_000 },
      host: cameraHost,
    });
    applyIndexedGenomeSequenceWindowCameraDecision(decision, 'scroll', cameraHost);
    await flushMicrotasks();
    expect(cameraHost.trackErrors).toEqual(['fasta offline']);
    expect(cameraHost.sequenceWindows).toEqual([]);
    expect(cameraHost.events.at(-1)?.event).toBe('sequence-window-error');
  });

  it('drops a superseded response when the fetch token moved on', async () => {
    let resolveWindow: ((window: GenomeSequenceWindow) => void) | undefined;
    const cameraHost = host({
      fetchSequenceWindow: () =>
        new Promise((resolve) => {
          resolveWindow = resolve;
        }),
    });
    const decision = resolveIndexedGenomeSequenceWindowCameraChange({
      reportedCenterBp: 47_450_000,
      reason: 'scroll',
      handleCenter: 47_450_000,
      viewportRange: { start: 47_426_000, end: 47_474_000 },
      host: cameraHost,
    });
    applyIndexedGenomeSequenceWindowCameraDecision(decision, 'scroll', cameraHost);
    cameraHost.fetchToken.current += 1;
    resolveWindow?.(sequenceWindow({ requestId: 'sequence-window-1', generation: 1 }));
    await flushMicrotasks();
    expect(cameraHost.sequenceWindows).toEqual([]);
    expect(cameraHost.events.map((entry) => entry.event)).toEqual([
      'camera-change',
      'sequence-window-request',
    ]);
  });
});
