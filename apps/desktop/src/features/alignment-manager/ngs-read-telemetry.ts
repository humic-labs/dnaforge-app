import type { NgsReadAnalysisRequest, OperationSnapshot } from '@waypoint/api-client';
import { trackRendererEvent } from '../../lib/analytics';
import { errorClassFor, workflowCountBucket } from '../../lib/workflow-telemetry';
import type { NgsReadEvidence } from './ngs-read-evidence';

type ReadPreset = NgsReadAnalysisRequest['preset'];
type ReportedStore = Pick<Storage, 'getItem' | 'setItem'>;

const REPORTED_KEY = 'dnaforge.telemetry.ngs-read-analysis.reported';
const REPORTED_LIMIT = 200;

export function readCountBucket(total: number): string {
  if (!Number.isFinite(total) || total < 0) return 'unknown';
  if (total < 1_000) return 'lt_1k';
  if (total < 10_000) return '1k_10k';
  if (total < 100_000) return '10k_100k';
  if (total < 1_000_000) return '100k_1m';
  if (total < 10_000_000) return '1m_10m';
  return '10m_plus';
}

export function mappedFractionBucket(mapped: number, total: number): string {
  if (!Number.isFinite(mapped) || !Number.isFinite(total) || total <= 0) return 'unknown';
  const fraction = mapped / total;
  if (fraction < 0.5) return 'lt_50';
  if (fraction < 0.8) return '50_80';
  if (fraction < 0.95) return '80_95';
  if (fraction < 0.99) return '95_99';
  return '99_plus';
}

function send(properties: Record<string, unknown>): void {
  try {
    trackRendererEvent('ngs_read_analysis_observed', {
      feature_area: 'scientific_workflow',
      ...properties,
    });
  } catch {}
}

function reportedStore(): ReportedStore | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function claimReport(reportKey: string, store: ReportedStore | undefined): boolean {
  if (!store) return true;
  try {
    const parsed: unknown = JSON.parse(store.getItem(REPORTED_KEY) ?? '[]');
    const reported = Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
    if (reported.includes(reportKey)) return false;
    store.setItem(REPORTED_KEY, JSON.stringify([...reported, reportKey].slice(-REPORTED_LIMIT)));
    return true;
  } catch {
    return true;
  }
}

function operationErrorClass(code: string | undefined, fallback: string): string {
  const normalized = (code ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^[^a-z]+|_+$/g, '')
    .slice(0, 64);
  return normalized || fallback;
}

function operationDurationMs(operation: OperationSnapshot): number | undefined {
  const end = operation.settled_at ?? operation.updated_at;
  if (typeof end !== 'number' || typeof operation.created_at !== 'number') return undefined;
  return Math.max(0, Math.round((end - operation.created_at) * 1000));
}

export function trackNgsReadAnalysisStarted(preset: ReadPreset): void {
  send({ analysis_phase: 'started', read_preset: preset });
}

export function trackNgsReadAnalysisSubmitFailed(preset: ReadPreset, error: unknown): void {
  send({
    analysis_phase: 'failed',
    failure_stage: 'submit',
    read_preset: preset,
    error_class: errorClassFor(error),
  });
}

export function trackNgsReadAnalysisSettled(
  operation: OperationSnapshot,
  outcome: { evidence?: NgsReadEvidence; candidateCount?: number; error?: unknown },
  store: ReportedStore | undefined = reportedStore()
): void {
  const duration_ms = operationDurationMs(operation);
  const evidence = outcome.evidence;
  if (evidence && outcome.error === undefined) {
    if (!claimReport(`${operation.id}:completed`, store)) return;
    send({
      analysis_phase: 'completed',
      read_preset: evidence.settings.preset,
      read_count_bucket: readCountBucket(evidence.totalReads),
      mapped_fraction_bucket: mappedFractionBucket(evidence.mappedReads, evidence.totalReads),
      candidate_count_bucket: workflowCountBucket(outcome.candidateCount ?? 0),
      duration_ms,
    });
    return;
  }
  if (operation.state === 'canceled') {
    if (!claimReport(`${operation.id}:canceled`, store)) return;
    send({ analysis_phase: 'canceled', duration_ms });
    return;
  }
  const failureStage = operation.state === 'succeeded' ? 'import' : 'job';
  if (!claimReport(`${operation.id}:failed:${failureStage}`, store)) return;
  send({
    analysis_phase: 'failed',
    failure_stage: failureStage,
    error_class:
      failureStage === 'import'
        ? errorClassFor(outcome.error)
        : operationErrorClass(operation.error?.code, operation.state),
    duration_ms,
  });
}
