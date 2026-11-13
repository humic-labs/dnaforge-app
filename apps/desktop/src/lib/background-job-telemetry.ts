import type { OperationSnapshot } from '@waypoint/api-client';
import { managedOperations } from '../services/managed-operations';
import { trackRendererEvent } from './analytics';

type BackgroundJobPhase = 'submitted' | 'completed' | 'failed' | 'canceled' | 'interrupted';
type JobStore = Pick<Storage, 'getItem' | 'setItem'>;
type JobOperation = Pick<
  OperationSnapshot,
  'id' | 'kind' | 'state' | 'created_at' | 'updated_at' | 'settled_at' | 'error'
>;

export interface BackgroundJobTelemetryDeps {
  operations: () => readonly JobOperation[];
  subscribe: (listener: () => void) => () => void;
  track: (event: string, properties: Record<string, unknown>) => void;
  store: JobStore | undefined;
}

export const BACKGROUND_JOB_KINDS = new Set([
  'alignment_coverage_preparation',
  'alignment_index_preparation',
  'annotation',
  'annotation_provisioning',
  'genome_indexing',
  'multiple_sequence_alignment',
  'ngs_read_analysis',
  'pairwise_session_alignment',
  'primer_library_search',
  'track_registration',
  'variant_source_preparation',
]);

const ACTIVE_STATES = new Set(['queued', 'running', 'stopping']);
const TERMINAL_PHASES: Readonly<Record<string, BackgroundJobPhase>> = {
  succeeded: 'completed',
  failed: 'failed',
  canceled: 'canceled',
  interrupted: 'interrupted',
};
const ACTIVE_KEY = 'dnaforge.telemetry.background-jobs.active';
const ACTIVE_LIMIT = 500;

function safeCode(value: string | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^[^a-z]+|_+$/g, '')
    .slice(0, 64);
}

export function backgroundJobKind(kind: string): string {
  const normalized = safeCode(kind);
  return BACKGROUND_JOB_KINDS.has(normalized) ? normalized : 'other';
}

function durationMs(operation: JobOperation): number | undefined {
  const end = operation.settled_at ?? operation.updated_at;
  if (typeof end !== 'number' || typeof operation.created_at !== 'number') return undefined;
  return Math.max(0, Math.round((end - operation.created_at) * 1000));
}

function readActive(store: JobStore | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(store?.getItem(ACTIVE_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function writeActive(store: JobStore | undefined, ids: Iterable<string>): void {
  try {
    store?.setItem(ACTIVE_KEY, JSON.stringify([...ids].slice(-ACTIVE_LIMIT)));
  } catch {}
}

function defaultStore(): JobStore | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function defaultDeps(): BackgroundJobTelemetryDeps {
  return {
    operations: () => managedOperations.getSnapshot().records.map((record) => record.snapshot),
    subscribe: (listener) => managedOperations.subscribe(listener),
    track: (event, properties) => {
      trackRendererEvent(event, properties);
    },
    store: defaultStore(),
  };
}

export function installBackgroundJobTelemetry(
  deps: BackgroundJobTelemetryDeps = defaultDeps()
): () => void {
  const active = new Set(readActive(deps.store));
  const seenThisSession = new Set<string>();
  const report = (operation: JobOperation, phase: BackgroundJobPhase, recovered?: boolean) => {
    try {
      deps.track('background_job_observed', {
        feature_area: 'reliability',
        job_kind: backgroundJobKind(operation.kind),
        job_phase: phase,
        ...(phase === 'submitted' ? {} : { job_duration_ms: durationMs(operation) }),
        ...(phase === 'failed' || phase === 'interrupted'
          ? { error_class: safeCode(operation.error?.code) || operation.state }
          : {}),
        ...(recovered === undefined ? {} : { recovered_at_launch: recovered }),
      });
    } catch {}
  };
  const observe = () => {
    let changed = false;
    for (const operation of deps.operations()) {
      if (ACTIVE_STATES.has(operation.state)) {
        seenThisSession.add(operation.id);
        if (active.has(operation.id)) continue;
        active.add(operation.id);
        changed = true;
        report(operation, 'submitted');
        continue;
      }
      const phase = TERMINAL_PHASES[operation.state];
      if (!phase || !active.has(operation.id)) continue;
      active.delete(operation.id);
      changed = true;
      report(operation, phase, !seenThisSession.has(operation.id));
    }
    if (changed) writeActive(deps.store, active);
  };
  observe();
  return deps.subscribe(observe);
}
