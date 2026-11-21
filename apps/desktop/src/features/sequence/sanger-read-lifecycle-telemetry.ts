import type { IndexedPixiLinearRenderer } from '@waypoint/genome-renderer';
import type { AnnotatedSequence, SequenceFormat } from '@waypoint/sequence-utils';
import {
  getAnalyticsCaptureGeneration,
  isAnalyticsCaptureReady,
  trackRendererEvent,
} from '../../lib/analytics';
import type {
  SangerReadReason,
  SangerReadStage,
  SangerReadViewportKind,
} from '../../shared/sanger-read-telemetry-vocab';

type FileReadOrigin = 'initial_read' | 'local_reload' | 'native_reload';
export type SangerReadPaintReceipt = NonNullable<
  ReturnType<IndexedPixiLinearRenderer['getSequenceReadPaintReceipt']>
>;

interface ViewProperties {
  sanger_view_id: string;
  sanger_view_started_at_ms: number;
  sanger_trace_available: boolean;
  sanger_quality_available: boolean;
  sanger_trace_visible?: boolean;
  sanger_quality_visible?: boolean;
  sanger_bases_visible?: boolean;
  viewport_operation_id?: string;
  viewport_started_at_ms?: number;
  sanger_viewport_kind?: SangerReadViewportKind;
}

interface AcceptedRead {
  current(): boolean;
  emit(stage: SangerReadStage, reason?: SangerReadReason, view?: ViewProperties): void;
}

const acceptedReads = new WeakMap<AnnotatedSequence, AcceptedRead>();
const bindingListeners = new WeakMap<AnnotatedSequence, Set<() => void>>();

function publishSangerReadBinding(sequence: AnnotatedSequence, read: AcceptedRead) {
  acceptedReads.set(sequence, read);
  for (const listener of bindingListeners.get(sequence) ?? []) listener();
}

export function getSangerReadBinding(sequence: AnnotatedSequence) {
  const read = acceptedReads.get(sequence);
  return read?.current() ? read : undefined;
}

export function subscribeToSangerReadBinding(sequence: AnnotatedSequence, listener: () => void) {
  let listeners = bindingListeners.get(sequence);
  if (!listeners) {
    listeners = new Set();
    bindingListeners.set(sequence, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) bindingListeners.delete(sequence);
  };
}

export function bindSangerReadProjection(
  source: AnnotatedSequence,
  published: AnnotatedSequence,
  current: () => boolean
) {
  const read = acceptedReads.get(source);
  if (read && current()) publishSangerReadBinding(published, { ...read, current });
}

export function beginSangerRead(origin: FileReadOrigin) {
  try {
    const operationId = crypto.randomUUID();
    const readRevisionId = crypto.randomUUID();
    const startedAt = Date.now();
    const captureGeneration = getAnalyticsCaptureGeneration();
    const eligible = isAnalyticsCaptureReady();
    let phase: 'requested' | 'parsing' | 'ready' | 'ended' = 'requested';
    let parseStartedAt: number | undefined;

    const emit = (stage: SangerReadStage, reason?: SangerReadReason, view?: ViewProperties) => {
      try {
        if (
          !eligible ||
          !isAnalyticsCaptureReady() ||
          captureGeneration !== getAnalyticsCaptureGeneration()
        )
          return;
        trackRendererEvent('sanger_read_stage', {
          feature_area: 'file',
          operation_id: operationId,
          sanger_stage: stage,
          sanger_origin: origin,
          sanger_classification: phase === 'ready' ? 'decoded_ab1' : 'requested_ab1',
          sanger_started_at_ms: startedAt,
          sanger_parse_started_at_ms: parseStartedAt,
          sanger_read_revision_id: phase === 'ready' ? readRevisionId : undefined,
          sanger_reason: reason,
          ...view,
          occurred_at_ms: Date.now(),
        });
      } catch {}
    };

    emit('read_requested');
    return {
      parseStarted() {
        if (phase !== 'requested') return;
        phase = 'parsing';
        parseStartedAt = Date.now();
        emit('parse_started');
      },
      parsed(format: SequenceFormat, sequence: AnnotatedSequence, current: () => boolean) {
        if (phase !== 'parsing') return;
        if (format !== 'ab1') {
          phase = 'ended';
          emit('read_refused', 'decode');
          return;
        }
        phase = 'ready';
        emit('parsed');
        publishSangerReadBinding(sequence, { current, emit });
      },
      revisionReady(
        format: SequenceFormat | undefined,
        sequence: AnnotatedSequence,
        current: () => boolean
      ) {
        if (phase !== 'requested') return;
        if (format !== 'ab1') {
          phase = 'ended';
          emit('read_refused', 'decode');
          return;
        }
        phase = 'ready';
        emit('revision_ready');
        publishSangerReadBinding(sequence, { current, emit });
      },
      end(stage: 'read_failed' | 'read_cancelled' | 'read_superseded', reason: SangerReadReason) {
        if (phase === 'ended' || phase === 'ready') return;
        phase = 'ended';
        emit(stage, reason);
      },
    };
  } catch {
    return undefined;
  }
}

export function beginSangerReadView(sequence: AnnotatedSequence) {
  try {
    const read = acceptedReads.get(sequence);
    if (!read?.current()) return undefined;
    const viewId = crypto.randomUUID();
    const startedAt = Date.now();
    let phase: 'pending' | 'admitted' | 'presented' | 'closed' = 'pending';
    let traceAvailable = false;
    let qualityAvailable = false;
    let minimumPaintCount = 0;
    let viewport:
      | {
          operationId: string;
          startedAt: number;
          kind: SangerReadViewportKind;
          minimumPaintCount: number;
        }
      | undefined;

    const fields = (): ViewProperties => ({
      sanger_view_id: viewId,
      sanger_view_started_at_ms: startedAt,
      sanger_trace_available: traceAvailable,
      sanger_quality_available: qualityAvailable,
    });
    const viewportFields = (operation: NonNullable<typeof viewport>): ViewProperties => ({
      ...fields(),
      viewport_operation_id: operation.operationId,
      viewport_started_at_ms: operation.startedAt,
      sanger_viewport_kind: operation.kind,
    });

    return {
      admit(trace: boolean, quality: boolean, paintCount: number) {
        if (phase === 'closed' || !read.current()) return;
        traceAvailable = trace;
        qualityAvailable = quality;
        minimumPaintCount = paintCount;
        if (viewport) viewport.minimumPaintCount = paintCount;
        if (phase !== 'pending') return;
        phase = 'admitted';
        read.emit('scene_admitted', undefined, fields());
      },
      acceptViewport(kind: SangerReadViewportKind, paintCount: number) {
        if (phase === 'pending' || phase === 'closed' || !read.current()) return;
        if (viewport) read.emit('viewport_superseded', 'superseded', viewportFields(viewport));
        viewport = {
          operationId: crypto.randomUUID(),
          startedAt: Date.now(),
          kind,
          minimumPaintCount: paintCount,
        };
        read.emit('viewport_accepted', undefined, viewportFields(viewport));
      },
      presented(receipt: SangerReadPaintReceipt | null) {
        if (!receipt || phase === 'pending' || phase === 'closed' || !read.current()) return;
        const visible = {
          sanger_trace_visible: receipt.traceVisible,
          sanger_quality_visible: receipt.qualityVisible,
          sanger_bases_visible: receipt.basesVisible,
        };
        if (phase === 'admitted' && receipt.paintCount > minimumPaintCount) {
          phase = 'presented';
          read.emit('first_viewport_presented', undefined, { ...fields(), ...visible });
        }
        if (viewport && receipt.paintCount > viewport.minimumPaintCount) {
          const presented = viewport;
          viewport = undefined;
          read.emit('viewport_presented', undefined, {
            ...viewportFields(presented),
            ...visible,
          });
        }
      },
      fail() {
        if (phase === 'closed' || !read.current()) return;
        phase = 'closed';
        read.emit('read_failed', 'scene', fields());
      },
      close() {
        if (phase === 'closed') return;
        if (read.current()) {
          if (phase !== 'presented') read.emit('read_cancelled', 'closed', fields());
          if (viewport) read.emit('viewport_cancelled', 'closed', viewportFields(viewport));
        }
        viewport = undefined;
        phase = 'closed';
      },
    };
  } catch {
    return undefined;
  }
}
