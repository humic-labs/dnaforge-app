import {
  getAnalyticsCaptureGeneration,
  isAnalyticsCaptureReady,
  trackRendererEvent,
} from '../../lib/analytics';
import type {
  IndexedGenomeOrigin,
  IndexedGenomeReason,
  IndexedGenomeStage,
} from '../../shared/indexed-genome-telemetry-vocab';

interface TelemetryAuthority {
  now(): number;
  newId(): string;
  captureGeneration(): number;
  captureReady(): boolean;
  track(event: string, properties: Record<string, unknown>): boolean;
}

const desktopAuthority: TelemetryAuthority = {
  now: Date.now,
  newId: () => crypto.randomUUID(),
  captureGeneration: () => getAnalyticsCaptureGeneration(),
  captureReady: () => isAnalyticsCaptureReady(),
  track: (event, properties) => trackRendererEvent(event, properties),
};

type OpenProgress = 'accepted' | 'coordinate_ready' | 'presented' | 'ended';
type Termination =
  | { outcome: 'refused'; reason: 'source_unavailable' }
  | { outcome: 'failed'; reason: 'index' | 'session' | 'renderer' }
  | { outcome: 'cancelled'; reason: 'closed' }
  | { outcome: 'superseded'; reason: 'superseded' };

interface ViewportOperation {
  commandId: number;
  operationId: string;
  startedAt: number;
}

export function beginIndexedGenomeOpen(
  origin: IndexedGenomeOrigin,
  authority: TelemetryAuthority = desktopAuthority
) {
  const operationId = authority.newId();
  const generationId = authority.newId();
  const startedAt = authority.now();
  const captureGeneration = authority.captureGeneration();
  const captureEligible = authority.captureReady();
  let progress: OpenProgress = 'accepted';
  let viewport: ViewportOperation | undefined;
  let lastViewportCommandId = 0;

  function emit(
    stage: IndexedGenomeStage,
    reason?: IndexedGenomeReason,
    jump?: Omit<ViewportOperation, 'commandId'>
  ) {
    if (
      !captureEligible ||
      !authority.captureReady() ||
      captureGeneration !== authority.captureGeneration()
    )
      return;
    try {
      authority.track('indexed_genome_stage', {
        feature_area: 'scientific_workflow',
        operation_id: operationId,
        genome_generation_id: generationId,
        genome_stage: stage,
        genome_origin: origin,
        genome_reason: reason,
        genome_started_at_ms: startedAt,
        viewport_operation_id: jump?.operationId,
        viewport_started_at_ms: jump?.startedAt,
        occurred_at_ms: authority.now(),
      });
    } catch {}
  }

  emit('open_accepted');
  return {
    coordinateReady() {
      if (progress !== 'accepted') return;
      progress = 'coordinate_ready';
      emit('coordinate_ready');
    },
    firstViewportPresented() {
      if (progress !== 'coordinate_ready') return;
      progress = 'presented';
      emit('first_viewport_presented');
    },
    acceptViewport(commandId: number) {
      if (progress !== 'coordinate_ready' && progress !== 'presented') return;
      if (commandId <= lastViewportCommandId) return;
      lastViewportCommandId = commandId;
      if (viewport) emit('viewport_superseded', 'superseded', viewport);
      viewport = { commandId, operationId: authority.newId(), startedAt: authority.now() };
      emit('viewport_accepted', undefined, viewport);
    },
    refuseViewport() {
      if (progress !== 'coordinate_ready' && progress !== 'presented') return;
      emit('viewport_refused', 'invalid_coordinate', {
        operationId: authority.newId(),
        startedAt: authority.now(),
      });
    },
    viewportPresented(commandId: number) {
      if (viewport?.commandId !== commandId) return;
      const presented = viewport;
      viewport = undefined;
      emit('viewport_presented', undefined, presented);
    },
    end({ outcome, reason }: Termination) {
      if (progress === 'ended') return;
      if (progress !== 'presented') emit(`open_${outcome}`, reason);
      progress = 'ended';
      if (!viewport) return;
      const abandoned = viewport;
      viewport = undefined;
      emit(`viewport_${outcome}`, reason, abandoned);
    },
  };
}

export type IndexedGenomeOpenTelemetry = ReturnType<typeof beginIndexedGenomeOpen>;

const pendingOpens = new Map<string, IndexedGenomeOpenTelemetry>();
const recentDocuments = new Set<string>();
const MAX_RECENT_DOCUMENTS = 128;

export function registerIndexedGenomeOpen(tabId: string, documentId: string): void {
  pendingOpens.get(tabId)?.end({ outcome: 'superseded', reason: 'superseded' });
  const reopening = recentDocuments.delete(documentId);
  recentDocuments.add(documentId);
  if (recentDocuments.size > MAX_RECENT_DOCUMENTS) {
    const oldest = recentDocuments.values().next();
    if (!oldest.done) recentDocuments.delete(oldest.value);
  }
  pendingOpens.set(tabId, beginIndexedGenomeOpen(reopening ? 'reopen' : 'open'));
}

export function claimIndexedGenomeOpen(tabId: string): IndexedGenomeOpenTelemetry | undefined {
  const operation = pendingOpens.get(tabId);
  pendingOpens.delete(tabId);
  return operation;
}

export function cancelUnclaimedIndexedGenomeOpens(tabExists: (tabId: string) => boolean): void {
  for (const [tabId, operation] of pendingOpens) {
    if (tabExists(tabId)) continue;
    pendingOpens.delete(tabId);
    operation.end({ outcome: 'cancelled', reason: 'closed' });
  }
}
