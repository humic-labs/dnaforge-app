import type {
  GenomeSequenceWindow,
  GenomeSequenceWindowRequest,
} from '../../../shared/indexed-genome';
import {
  decideSequenceWindowPolicy,
  type SequenceViewportRange,
  type SequenceWindowPending,
  type SequenceWindowPolicyDecision,
} from './indexed-sequence-window-policy';

export type IndexedGenomeCameraReason = 'scroll' | 'zoom';

export type IndexedGenomeSequenceWindowState = {
  startBp: number;
  endBp: number;
  generation: number;
  byteCount: number;
  bases: string;
};

type RefBox<T> = { current: T };

export type IndexedGenomeSequenceWindowCameraHost = {
  length: number;
  containerWidth: number;
  sessionId: string | undefined;
  chrom: string;
  lastViewportCenter: RefBox<number | null>;
  sequenceWindowCoverage: RefBox<{ startBp: number; endBp: number } | null>;
  sequenceWindowPending: RefBox<SequenceWindowPending | null>;
  fetchToken: RefBox<number>;
  recordEvent: (event: string, detail?: Record<string, unknown>) => void;
  commitSceneViewportRange: (range: SequenceViewportRange | null | undefined) => void;
  setPendingSequenceWindow: (pending: SequenceWindowPending | null) => void;
  setSequenceWindow: (window: IndexedGenomeSequenceWindowState) => void;
  cancelRequest: (requestId: string | null | undefined) => void;
  fetchSequenceWindow: (
    request: GenomeSequenceWindowRequest,
    requestId: string
  ) => Promise<GenomeSequenceWindow>;
  onSequenceTrackError: (message: string) => void;
};

export type IndexedGenomeSequenceWindowCameraChangeInput = {
  reportedCenterBp: number;
  reason: IndexedGenomeCameraReason;
  handleCenter: number | null | undefined;
  viewportRange: SequenceViewportRange | null | undefined;
  host: IndexedGenomeSequenceWindowCameraHost;
};

export type IndexedGenomeAssemblyCameraChangeInput = {
  reportedCenterBp: number;
  reason: IndexedGenomeCameraReason;
  handleCenter: number | null | undefined;
  viewportRange: SequenceViewportRange | null | undefined;
  assemblyLengthBp: number;
  assemblyRoutingEnabled: boolean;
  lastViewportCenter: RefBox<number | null>;
  recordEvent: (event: string, detail?: Record<string, unknown>) => void;
  commitSceneViewportRange: (
    range: SequenceViewportRange | null | undefined,
    maxLength: number
  ) => void;
  onAssemblyCamera: (
    viewportRange: SequenceViewportRange | null,
    options: { immediate: boolean }
  ) => void;
  streamPileupViaTileEngine: (viewportRange: SequenceViewportRange | null | undefined) => void;
};

function isGenomeRequestCancelled(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

export function isCancelledSequenceWindow(window: GenomeSequenceWindow): boolean {
  return window.byteCount === 0 && window.bases.length === 0 && window.end === window.start;
}

function sequenceWindowErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function processIndexedGenomeAssemblyCameraChange(
  input: IndexedGenomeAssemblyCameraChangeInput
): void {
  const { reportedCenterBp, reason, handleCenter, viewportRange } = input;
  input.commitSceneViewportRange(viewportRange, input.assemblyLengthBp);
  const assemblyCenterBp =
    viewportRange != null ? (viewportRange.start + viewportRange.end) / 2 : handleCenter;
  input.lastViewportCenter.current = assemblyCenterBp ?? reportedCenterBp;
  input.recordEvent('camera-change', {
    reason,
    reportedCenterBp,
    handleCenterBp: handleCenter ?? null,
    centerBp: input.lastViewportCenter.current,
    viewportRange: viewportRange ? { start: viewportRange.start, end: viewportRange.end } : null,
  });
  input.onAssemblyCamera(viewportRange ?? null, { immediate: false });
  input.streamPileupViaTileEngine(viewportRange);
  if (!input.assemblyRoutingEnabled) {
    input.recordEvent('assembly-camera-fail-closed-no-router', {
      centerBp: input.lastViewportCenter.current,
      viewportRange,
    });
  }
}

export function resolveIndexedGenomeSequenceWindowCameraChange(
  input: IndexedGenomeSequenceWindowCameraChangeInput
): SequenceWindowPolicyDecision {
  const { reportedCenterBp, reason, handleCenter, viewportRange, host } = input;
  const decision = decideSequenceWindowPolicy({
    reportedCenterBp,
    handleCenterBp: handleCenter,
    viewportRange,
    length: host.length,
    containerWidth: host.containerWidth,
    loadedCoverage: host.sequenceWindowCoverage.current,
    pendingCoverage: host.sequenceWindowPending.current,
  });
  host.lastViewportCenter.current = decision.centerBp;
  host.recordEvent('camera-change', {
    reason,
    reportedCenterBp,
    handleCenterBp: handleCenter ?? null,
    centerBp: decision.centerBp,
    viewportRange: decision.viewportRange
      ? { start: decision.viewportRange.start, end: decision.viewportRange.end }
      : null,
  });
  host.commitSceneViewportRange(decision.viewportRange);
  return decision;
}

export function applyIndexedGenomeSequenceWindowCameraDecision(
  decision: SequenceWindowPolicyDecision,
  reason: IndexedGenomeCameraReason,
  host: IndexedGenomeSequenceWindowCameraHost
): void {
  if (decision.kind === 'skip-lod') {
    host.cancelRequest(host.sequenceWindowPending.current?.requestId);
    host.fetchToken.current += 1;
    host.sequenceWindowPending.current = null;
    host.setPendingSequenceWindow(null);
    host.recordEvent('sequence-window-skip-lod', {
      centerBp: decision.centerBp,
      requiredStart: decision.requiredStart,
      requiredEnd: decision.requiredEnd,
      visibleBp: decision.visibleBp,
      pixelsPerBp: decision.pixelsPerBp,
      threshold: decision.threshold,
    });
    return;
  }

  if (decision.kind === 'loaded-coverage') {
    host.recordEvent('sequence-window-covered', {
      centerBp: decision.centerBp,
      requiredStart: decision.requiredStart,
      requiredEnd: decision.requiredEnd,
      coverage: decision.coverage,
    });
    return;
  }

  if (decision.kind === 'pending-coverage') {
    host.recordEvent('sequence-window-pending', {
      centerBp: decision.centerBp,
      requiredStart: decision.requiredStart,
      requiredEnd: decision.requiredEnd,
      pending: decision.pending,
    });
    return;
  }

  const { startBp, endBp } = decision.request;
  if (endBp <= startBp) return;
  if (!host.sessionId) {
    host.recordEvent('sequence-window-no-session', {
      centerBp: decision.centerBp,
      startBp,
      endBp,
    });
    return;
  }

  const token = ++host.fetchToken.current;
  const requestId = `sequence-window-${token}`;
  host.cancelRequest(host.sequenceWindowPending.current?.requestId);
  const pending = { startBp, endBp, token, requestId };
  host.sequenceWindowPending.current = pending;
  host.setPendingSequenceWindow(pending);
  host.recordEvent('sequence-window-request', {
    token,
    requestId,
    reason,
    centerBp: decision.centerBp,
    viewportRange: decision.viewportRange,
    requiredStart: decision.requiredStart,
    requiredEnd: decision.requiredEnd,
    visibleBp: decision.visibleBp,
    pixelsPerBp: decision.pixelsPerBp,
    startBp,
    endBp,
  });
  void Promise.resolve()
    .then(() =>
      host.fetchSequenceWindow(
        { chrom: host.chrom, start: startBp, end: endBp, generation: token },
        requestId
      )
    )
    .then((window) => {
      if (token !== host.fetchToken.current) return;
      host.sequenceWindowPending.current = null;
      host.setPendingSequenceWindow(null);
      if (isCancelledSequenceWindow(window)) {
        host.recordEvent('sequence-window-cancelled', {
          token,
          requestId: window.requestId,
          centerBp: decision.centerBp,
          startBp,
          endBp,
        });
        return;
      }
      const next = {
        startBp: window.start,
        endBp: window.end,
        generation: window.generation,
        byteCount: window.byteCount,
        bases: window.bases,
      };
      host.sequenceWindowCoverage.current = { startBp: window.start, endBp: window.end };
      host.setSequenceWindow(next);
      host.recordEvent('sequence-window-ready', {
        token,
        requestId: window.requestId,
        centerBp: decision.centerBp,
        startBp: window.start,
        endBp: window.end,
        basesLength: window.bases.length,
        byteCount: window.byteCount,
      });
    })
    .catch((err: unknown) => {
      if (token !== host.fetchToken.current) return;
      const message = sequenceWindowErrorMessage(err);
      host.sequenceWindowPending.current = null;
      host.setPendingSequenceWindow(null);
      if (isGenomeRequestCancelled(err)) {
        host.recordEvent('sequence-window-cancelled', {
          token,
          centerBp: decision.centerBp,
          startBp,
          endBp,
        });
        return;
      }
      host.recordEvent('sequence-window-error', {
        token,
        centerBp: decision.centerBp,
        startBp,
        endBp,
        message,
      });
      host.onSequenceTrackError(message);
    });
}
