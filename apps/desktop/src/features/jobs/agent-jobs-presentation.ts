import type {
  JobsSidebarExecutionState,
  JobsSidebarJob,
  JobsSidebarObservation,
  JobsSidebarSnapshot,
} from './presentation';

export type AgentJobState =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'interrupted';

export interface AgentJobRecord {
  readonly id: string;
  readonly tool_name: string;
  readonly duration: 'long-running' | 'streaming';
  readonly pool: string;
  readonly state: AgentJobState;
  readonly cancelable: boolean;
  readonly can_cancel: boolean;
  readonly requested_at: string;
  readonly completed_at: string | null;
  readonly error_code: string | null;
  readonly agent_identity: {
    readonly id: string;
    readonly label: string | null;
    readonly kind: string | null;
  };
}

export interface AgentJobsPresentationSource {
  readonly jobs: readonly AgentJobRecord[];
  readonly jobCount: number;
  readonly activeCount: number;
  readonly terminalCount: number;
  readonly historyComplete: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly observedAtMs: number | null;
  readonly collectionStale?: boolean;
}

export interface AgentJobsPresentationOptions {
  readonly nowMs: number;
}

function executionState(state: AgentJobState): JobsSidebarExecutionState {
  return state === 'canceled' ? 'cancelled' : state;
}

function timestamp(value: string | null, fallback: number): number | undefined {
  if (value === null) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function observationFor(
  source: AgentJobsPresentationSource,
  options: AgentJobsPresentationOptions
): JobsSidebarObservation {
  const observedAtMs = source.observedAtMs ?? options.nowMs;
  return source.error || source.collectionStale
    ? {
        freshness: 'stale',
        observedAtMs,
        reason: source.error ?? 'The agent job collection needs a fresh native read.',
      }
    : { freshness: 'current', observedAtMs };
}

function jobFor(
  source: AgentJobsPresentationSource,
  job: AgentJobRecord,
  options: AgentJobsPresentationOptions
): JobsSidebarJob {
  const active = job.state === 'queued' || job.state === 'running';
  const canStop = active && job.can_cancel && source.error === null;
  const completedAtMs = timestamp(job.completed_at, options.nowMs);
  return {
    id: `agent-action:${job.id}`,
    owner: { kind: 'agent-action', nativeId: job.id },
    title: job.tool_name,
    target: job.pool,
    targetIdentity: job.id,
    state: executionState(job.state),
    observation: observationFor(source, options),
    result: { availability: 'none' },
    review: { state: 'not-required' },
    executionContext: {
      mode: 'managed',
      ownerLabel: 'Agent job',
      ownerInstanceId: job.agent_identity.id,
      locationLabel: 'Local sidecar',
      lifetimeLabel: 'Durable admission; owner loss is reported as interrupted',
    },
    actorLabel: job.agent_identity.label?.trim() || job.agent_identity.id,
    actorActionLabel: 'Started by',
    actorChannelLabel: job.agent_identity.kind?.trim() || 'Agent',
    createdAtMs: timestamp(job.requested_at, options.nowMs) ?? options.nowMs,
    ...(job.state !== 'queued'
      ? { startedAtMs: timestamp(job.requested_at, options.nowMs) ?? options.nowMs }
      : {}),
    ...(completedAtMs !== undefined ? { finishedAtMs: completedAtMs } : {}),
    canStop,
    canOpenResult: false,
    canReleaseResult: false,
    canLoadActions: false,
    ...(active && !canStop
      ? {
          stopUnavailableReason: source.error
            ? 'The agent job owner is not currently observable.'
            : job.cancelable
              ? 'The agent job no longer has a live cancellation owner.'
              : 'This agent job does not support cancellation.',
        }
      : {}),
    toolVersion: job.duration,
    inputSummary: `Agent action ${job.id}`,
    ...(job.error_code ? { error: job.error_code } : {}),
  };
}

function collectionObservation(
  source: AgentJobsPresentationSource
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
      ...(source.loading ? {} : { reason: 'Agent job history has not been loaded yet.' }),
    };
  }
  if (source.collectionStale) {
    return {
      state: 'unavailable',
      observedAtMs: source.observedAtMs,
      reason: 'The agent job collection needs a fresh native read.',
      canReconnect: true,
    };
  }
  return { state: 'current', observedAtMs: source.observedAtMs };
}

export function projectAgentJobsSnapshot(
  source: AgentJobsPresentationSource,
  options: AgentJobsPresentationOptions
): JobsSidebarSnapshot {
  return {
    nowMs: options.nowMs,
    collectionObservation: collectionObservation(source),
    jobs: source.jobs.map((job) => jobFor(source, job, options)),
    historySummary: {
      operationCount: source.jobCount,
      activeCount: source.activeCount,
      terminalCount: source.terminalCount,
      historyComplete: source.historyComplete,
    },
  };
}
