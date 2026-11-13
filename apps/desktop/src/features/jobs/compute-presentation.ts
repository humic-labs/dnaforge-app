import type {
  ComputeJobRecord,
  ComputeJobState,
  ComputeJobsSnapshot,
} from '../../shared/compute-jobs-ipc';
import { isPathInsideBoundary } from '../../shared/path-boundary';
import type {
  JobsSidebarExecutionState,
  JobsSidebarJob,
  JobsSidebarObservation,
  JobsSidebarResult,
  JobsSidebarSnapshot,
} from './presentation';

export interface ComputeJobsPresentationSource {
  readonly jobs: readonly ComputeJobRecord[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly observedAtMs: number | null;
  readonly collectionStale?: boolean;
  readonly coverage?: Omit<ComputeJobsSnapshot, 'jobs'> | null;
}

export interface ComputeJobsPresentationOptions {
  readonly nowMs: number;
  readonly historyLimit: number;
  readonly cancellationByProvider?: Readonly<
    Record<string, { readonly mode: 'provider' | 'unavailable'; readonly note: string }>
  >;
}

const ACTIVE_STATES = new Set<ComputeJobState>(['intent', 'submitted', 'queued', 'running']);
const TERMINAL_STATES = new Set<ComputeJobState>(['completed', 'failed', 'canceled', 'imported']);

function executionState(state: ComputeJobState): JobsSidebarExecutionState {
  switch (state) {
    case 'intent':
    case 'submitted':
    case 'queued':
      return 'queued';
    case 'running':
      return 'running';
    case 'submission-unknown':
      return 'interrupted';
    case 'completed':
    case 'imported':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'canceled':
      return 'cancelled';
  }
}

function timestamp(value: string, fallback: number): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function observationFor(
  source: ComputeJobsPresentationSource,
  options: ComputeJobsPresentationOptions
): JobsSidebarObservation {
  const observedAtMs = source.observedAtMs ?? options.nowMs;
  return source.error || source.collectionStale || !source.coverage?.activeComplete
    ? {
        freshness: 'stale',
        observedAtMs,
        reason: source.error ?? 'The job collection needs a fresh native read.',
      }
    : { freshness: 'current', observedAtMs };
}

function resultFor(job: ComputeJobRecord): JobsSidebarResult {
  if (job.state === 'completed') {
    if (!job.workspaceRoot) {
      return {
        availability: 'available',
        reason:
          'The provider result is ready, but this job has no recorded workspace. Import it in Settings → Integrations.',
      };
    }
    return {
      availability: 'available',
      reason: 'The provider result is ready to import from Jobs.',
    };
  }
  if (job.state === 'imported') {
    return {
      availability: 'available',
      reason: 'The provider result was imported into the workspace.',
    };
  }
  return { availability: 'none' };
}

function costSummary(job: ComputeJobRecord): string | undefined {
  const amount = job.costActual ?? job.costEstimate;
  const unit = job.costActualUnit ?? job.costEstimateUnit;
  if (amount === null) return undefined;
  const unitLabel = unit === 'weighted_hours' ? 'weighted hours' : unit;
  return [String(amount), unitLabel].filter(Boolean).join(' ');
}

function resultSummary(job: ComputeJobRecord): string | undefined {
  if (job.importedPaths.length > 0) {
    return `${job.importedPaths.length} ${job.importedPaths.length === 1 ? 'file' : 'files'} imported into the workspace`;
  }
  const cost = costSummary(job);
  return cost ? `Provider cost: ${cost}` : undefined;
}

function jobFor(
  source: ComputeJobsPresentationSource,
  job: ComputeJobRecord,
  options: ComputeJobsPresentationOptions
): JobsSidebarJob {
  const state = executionState(job.state);
  const active = ACTIVE_STATES.has(job.state);
  const remoteIdentity = job.remoteId ?? 'Provider acknowledgement pending';
  const cancellation = options.cancellationByProvider?.[job.provider];
  const workspaceRoot = job.workspaceRoot;
  const canStop =
    active && source.error === null && job.remoteId !== null && cancellation?.mode === 'provider';
  const canImportResult =
    job.state === 'completed' && job.remoteId !== null && job.workspaceRoot !== null;
  const canOpenResult =
    job.state === 'imported' &&
    workspaceRoot !== null &&
    job.importedPaths.some(
      (path) =>
        !/(?:^|[\\/])compute-job\.json$/i.test(path) && isPathInsideBoundary(path, workspaceRoot)
    );
  return {
    id: `compute:${job.id}`,
    owner: { kind: 'hosted-compute', nativeId: job.id },
    title: job.label?.trim() || job.toolId,
    target: job.provider,
    targetIdentity: job.workspaceRoot ?? undefined,
    state,
    observation: observationFor(source, options),
    result: resultFor(job),
    review: { state: 'not-required' },
    executionContext: {
      mode: 'connected',
      ownerLabel: job.provider,
      ownerInstanceId: job.remoteId ?? job.id,
      locationLabel: job.provider,
      lifetimeLabel: 'Tracked across DNAForge restarts',
    },
    actorLabel: 'DNAForge',
    actorActionLabel: 'Tracked by',
    actorChannelLabel: 'Hosted provider',
    createdAtMs: timestamp(job.createdAt, options.nowMs),
    ...(job.state !== 'intent' ? { startedAtMs: timestamp(job.createdAt, options.nowMs) } : {}),
    ...(TERMINAL_STATES.has(job.state)
      ? { finishedAtMs: timestamp(job.updatedAt, options.nowMs) }
      : {}),
    canStop,
    canImportResult,
    canOpenResult,
    canReleaseResult: false,
    canLoadActions: false,
    ...(active && !canStop
      ? {
          stopUnavailableReason:
            job.remoteId === null
              ? 'DNAForge is waiting for the provider to acknowledge this job.'
              : (cancellation?.note ??
                'This hosted-compute owner does not advertise cancellation through DNAForge.'),
        }
      : {}),
    inputRevision: job.requestHash ?? job.settingsHash,
    inputSummary:
      job.state === 'submission-unknown'
        ? 'Submission unconfirmed. The provider may have accepted this job; check its account before sending another request.'
        : `Provider job: ${remoteIdentity}`,
    toolVersion: job.toolId,
    dataVersion: job.providerState || undefined,
    error: job.lastError ?? undefined,
    resultSummary: resultSummary(job),
  };
}

function collectionObservation(
  source: ComputeJobsPresentationSource
): JobsSidebarSnapshot['collectionObservation'] {
  if (source.error) {
    return {
      state: 'unavailable',
      ...(source.observedAtMs !== null ? { observedAtMs: source.observedAtMs } : {}),
      reason: source.error,
      canReconnect: true,
    };
  }
  if (source.observedAtMs === null) {
    return {
      state: 'connecting',
      ...(source.loading ? {} : { reason: 'Hosted compute history has not been loaded yet.' }),
    };
  }
  if (source.collectionStale || !source.coverage?.activeComplete) {
    return {
      state: 'unavailable',
      observedAtMs: source.observedAtMs,
      reason: 'The job collection needs a fresh native read.',
      canReconnect: true,
    };
  }
  return { state: 'current', observedAtMs: source.observedAtMs };
}

export function projectComputeJobsSnapshot(
  source: ComputeJobsPresentationSource,
  options: ComputeJobsPresentationOptions
): JobsSidebarSnapshot {
  return {
    nowMs: options.nowMs,
    collectionObservation: collectionObservation(source),
    jobs: source.jobs.map((job) => jobFor(source, job, options)),

    ...(source.coverage
      ? {
          historySummary: {
            operationCount: source.coverage.jobCount,
            activeCount: source.coverage.activeCount,
            terminalCount: source.coverage.terminalCount,
            historyComplete: source.coverage.historyComplete,
          },
        }
      : {}),
  };
}
