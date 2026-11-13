import {
  toUserMessage,
  userMessageWithValues,
  userMessageValue,
  type UserMessage,
} from '@waypoint/user-messages';
export type JobsSidebarExecutionState =
  | 'queued'
  | 'running'
  | 'stopping'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type JobsSidebarObservationFreshness = 'current' | 'stale';
export type JobsSidebarResultAvailability =
  | 'none'
  | 'available'
  | 'released'
  | 'expired'
  | 'unavailable';
export type JobsSidebarReviewState =
  | 'not-required'
  | 'not-checked'
  | 'awaiting-review'
  | 'in-review'
  | 'applied'
  | 'dismissed'
  | 'blocked';
export type JobsSidebarExecutionMode = 'managed' | 'connected' | 'recorded';
export type JobsSidebarOwnerKind = 'managed-operation' | 'hosted-compute' | 'agent-action';

export interface JobsSidebarOwnerRef {
  readonly kind: JobsSidebarOwnerKind;
  readonly nativeId: string;
}

export interface JobsSidebarObservation {
  readonly freshness: JobsSidebarObservationFreshness;
  readonly observedAtMs?: number;
  readonly reason?: string;
}

export interface JobsSidebarResult {
  readonly availability: JobsSidebarResultAvailability;
  readonly reason?: string;
}

export interface JobsSidebarReview {
  readonly state: JobsSidebarReviewState;
  readonly reason?: string;
}

export interface JobsSidebarExecutionContext {
  readonly mode: JobsSidebarExecutionMode;
  readonly ownerLabel?: string;
  readonly ownerInstanceId?: string;
  readonly locationLabel?: string;
  readonly lifetimeLabel?: string;
}

export interface JobsSidebarProgress {
  readonly completed: number;
  readonly total: number;
  readonly label?: string;
}

export interface JobsSidebarAction {
  readonly id: string;
  readonly label: string;
  readonly outcomeLabel?: string;
  readonly actorLabel?: string;
  readonly actorKindLabel?: string;
  readonly channelLabel?: string;
  readonly atMs?: number;
}

export interface JobsSidebarActionHistory {
  readonly actions: readonly JobsSidebarAction[];
  readonly total: number;
  readonly truncated: boolean;
  readonly omittedCount?: number;
  readonly historyComplete?: boolean;
  readonly toolVersion?: string;
}

export interface JobsSidebarRecordedProvenance {
  readonly sourceLabel: string;
  readonly runId: string;
  readonly tool: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly input: string;
  readonly inputPath?: string;
  readonly output?: string;
  readonly referenceVersions?: string;
  readonly runtime?: string;
}

export interface JobsSidebarJob {
  readonly id: string;
  readonly owner: JobsSidebarOwnerRef;
  readonly title: string;
  readonly target?: string;
  readonly targetIdentity?: string;
  readonly scopeId?: string;
  readonly state: JobsSidebarExecutionState;
  readonly observation: JobsSidebarObservation;
  readonly result: JobsSidebarResult;
  readonly review: JobsSidebarReview;
  readonly executionContext: JobsSidebarExecutionContext;
  readonly actorLabel: string;
  readonly actorActionLabel?: string;
  readonly actorChannelLabel?: string;
  readonly createdAtMs: number;
  readonly startedAtMs?: number;
  readonly finishedAtMs?: number;
  readonly durationLabel?: string;
  readonly progress?: JobsSidebarProgress;
  readonly canStop: boolean;
  readonly canImportResult?: boolean;
  readonly canOpenResult?: boolean;
  readonly canReleaseResult?: boolean;
  readonly canLoadActions: boolean;
  readonly stopUnavailableReason?: string;
  readonly inputRevision?: string;
  readonly inputSummary?: string;
  readonly toolVersion?: string;
  readonly dataVersion?: string;
  readonly error?: string;
  readonly resultSummary?: string;
  readonly recordedProvenance?: JobsSidebarRecordedProvenance;
  readonly actions?: readonly JobsSidebarAction[];
  readonly children?: readonly JobsSidebarJob[];
}

export interface JobsSidebarScope {
  readonly id: string;
  readonly label: string;
}

export interface JobsSidebarCollectionObservation {
  readonly state: 'connecting' | 'current' | 'unavailable';
  readonly observedAtMs?: number;
  readonly reason?: string;
  readonly canReconnect?: boolean;
}

export interface JobsSidebarHistorySummary {
  readonly operationCount: number;
  readonly activeCount: number;
  readonly terminalCount: number;
  readonly historyComplete: boolean;
}

export interface JobsSidebarSnapshot {
  readonly jobs: readonly JobsSidebarJob[];
  readonly nowMs: number;
  readonly collectionObservation: JobsSidebarCollectionObservation;
  readonly historySummary?: JobsSidebarHistorySummary;
  readonly scopes?: readonly JobsSidebarScope[];
  readonly selectedScopeId?: string | null;
}

export type JobsSidebarSectionId = 'active' | 'attention' | 'recent';

export interface JobsSidebarBatchSummary {
  readonly total: number;
  readonly finished: number;
  readonly failed: number;
  readonly interrupted: number;
}

export type ProjectedJobsSidebarJob = Omit<JobsSidebarJob, 'progress' | 'children'> & {
  readonly progress: JobsSidebarProgress | null;
  readonly elapsedLabel: string;
  readonly stateLabel: string;
  readonly attentionReasons: readonly UserMessage[];
  readonly batchSummary: JobsSidebarBatchSummary | null;
  readonly children: readonly ProjectedJobsSidebarJob[];
  readonly hasDetails: boolean;
};

export interface JobsSidebarSection {
  readonly id: JobsSidebarSectionId;
  readonly label: string;
  readonly jobs: readonly ProjectedJobsSidebarJob[];
}

export interface JobsSidebarProjection {
  readonly sections: readonly JobsSidebarSection[];
  readonly activeCount: number;
  readonly uncertainCount: number;
  readonly attentionCount: number;
  readonly historyCoverage?: JobsSidebarHistorySummary & { readonly visibleTerminalCount: number };
}

const ACTIVE_STATES = new Set<JobsSidebarExecutionState>(['queued', 'running', 'stopping']);
const TERMINAL_STATES = new Set<JobsSidebarExecutionState>([
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
]);

const EXECUTION_STATE_LABEL: Record<JobsSidebarExecutionState, string> = {
  queued: 'Waiting',
  running: 'Running',
  stopping: 'Stopping',
  succeeded: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
};

export function formatJobElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (seconds < 1) return '<1s';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function validProgress(progress: JobsSidebarProgress | undefined): JobsSidebarProgress | null {
  if (!progress) return null;
  const { completed, total } = progress;
  if (
    !Number.isInteger(completed) ||
    !Number.isInteger(total) ||
    total <= 0 ||
    completed < 0 ||
    completed > total
  ) {
    return null;
  }
  return progress;
}

function batchSummary(
  children: readonly JobsSidebarJob[] | undefined
): JobsSidebarBatchSummary | null {
  if (!children || children.length === 0) return null;
  let finished = 0;
  let failed = 0;
  let interrupted = 0;
  for (const child of children) {
    if (TERMINAL_STATES.has(child.state)) finished += 1;
    if (child.state === 'failed') failed += 1;
    if (child.state === 'interrupted') interrupted += 1;
  }
  return { total: children.length, finished, failed, interrupted };
}

function elapsedFor(job: JobsSidebarJob, nowMs: number): string {
  if (job.durationLabel) return job.durationLabel;
  const start = job.startedAtMs ?? job.createdAtMs;
  const end = TERMINAL_STATES.has(job.state)
    ? job.finishedAtMs
    : job.observation.freshness === 'stale'
      ? job.observation.observedAtMs
      : nowMs;
  if (!Number.isFinite(start) || end === undefined || !Number.isFinite(end) || end < start) {
    return 'Duration unknown';
  }
  return formatJobElapsed(end - start);
}

function attentionReasonsFor(
  job: JobsSidebarJob,
  children: readonly ProjectedJobsSidebarJob[],
  summary: JobsSidebarBatchSummary | null
): readonly UserMessage[] {
  const reasons: UserMessage[] = [];
  const add = (message: UserMessage) => {
    if (!reasons.includes(message)) reasons.push(message);
  };
  if (job.state === 'failed') add(toUserMessage(job.error, 'jobs.failed'));
  if (job.state === 'interrupted') add(toUserMessage(job.error, 'jobs.interrupted'));
  if (ACTIVE_STATES.has(job.state) && job.observation.freshness === 'stale')
    add(toUserMessage(job.observation.reason, 'jobs.statusStale'));
  if (job.review.state === 'awaiting-review')
    add(
      toUserMessage(
        job.review.reason ??
          (job.result.availability === 'expired' || job.result.availability === 'unavailable'
            ? job.result.reason
            : undefined),
        'jobs.reviewPending'
      )
    );
  if (job.review.state === 'in-review')
    add(toUserMessage(job.review.reason, 'jobs.reviewInProgress'));
  if (job.review.state === 'blocked') add(toUserMessage(job.review.reason, 'jobs.reviewBlocked'));
  if (summary?.failed)
    add(
      userMessageWithValues(summary.failed === 1 ? 'jobs.batchFailedOne' : 'jobs.batchFailedMany', {
        count: userMessageValue(summary.failed),
      })
    );
  if (summary?.interrupted)
    add(
      userMessageWithValues(
        summary.interrupted === 1 ? 'jobs.batchInterruptedOne' : 'jobs.batchInterruptedMany',
        { count: userMessageValue(summary.interrupted) }
      )
    );
  const uncertainChildren = children.filter(
    (child) => ACTIVE_STATES.has(child.state) && child.observation.freshness === 'stale'
  ).length;
  if (uncertainChildren > 0)
    add(
      userMessageWithValues(
        uncertainChildren === 1 ? 'jobs.batchUncertainOne' : 'jobs.batchUncertainMany',
        { count: userMessageValue(uncertainChildren) }
      )
    );
  const reviewChildren = children.filter((child) =>
    ['awaiting-review', 'in-review', 'blocked'].includes(child.review.state)
  ).length;
  if (reviewChildren > 0)
    add(
      userMessageWithValues(reviewChildren === 1 ? 'jobs.batchReviewOne' : 'jobs.batchReviewMany', {
        count: userMessageValue(reviewChildren),
      })
    );
  return reasons;
}

function stateLabelFor(job: JobsSidebarJob): string {
  const label = EXECUTION_STATE_LABEL[job.state];
  if (ACTIVE_STATES.has(job.state) && job.observation.freshness === 'stale') {
    return `Last known: ${label}`;
  }
  return label;
}

function projectJob(job: JobsSidebarJob, nowMs: number): ProjectedJobsSidebarJob {
  const children = (job.children ?? []).map((child) => projectJob(child, nowMs));
  const summary = batchSummary(job.children);
  return {
    ...job,
    progress: validProgress(job.progress),
    elapsedLabel: elapsedFor(job, nowMs),
    stateLabel: stateLabelFor(job),
    attentionReasons: attentionReasonsFor(job, children, summary),
    batchSummary: summary,
    children,
    hasDetails: true,
  };
}

function isCurrentActive(job: Readonly<Pick<JobsSidebarJob, 'state' | 'observation'>>): boolean {
  return ACTIVE_STATES.has(job.state) && job.observation.freshness === 'current';
}

function isUncertainActive(job: Readonly<Pick<JobsSidebarJob, 'state' | 'observation'>>): boolean {
  return ACTIVE_STATES.has(job.state) && job.observation.freshness === 'stale';
}

function sectionFor(job: ProjectedJobsSidebarJob): JobsSidebarSectionId {
  if (job.attentionReasons.length > 0) return 'attention';
  if (isCurrentActive(job)) return 'active';
  return 'recent';
}

const SECTIONS: readonly Readonly<{ id: JobsSidebarSectionId; label: string }>[] = [
  { id: 'active', label: 'Active' },
  { id: 'attention', label: 'Needs attention' },
  { id: 'recent', label: 'Recent' },
];

export function projectJobsSnapshot(snapshot: JobsSidebarSnapshot): JobsSidebarProjection {
  const selectedScopeExists =
    !!snapshot.selectedScopeId &&
    !!snapshot.scopes?.some((scope) => scope.id === snapshot.selectedScopeId);
  const visibleJobs = selectedScopeExists
    ? snapshot.jobs.filter((job) => job.scopeId === snapshot.selectedScopeId)
    : snapshot.jobs;
  const projectedJobs = visibleJobs.map((job) => projectJob(job, snapshot.nowMs));
  const rowActiveCount = visibleJobs.filter(isCurrentActive).length;
  const historySummary = selectedScopeExists ? undefined : snapshot.historySummary;
  const grouped = new Map<JobsSidebarSectionId, ProjectedJobsSidebarJob[]>();

  for (const job of projectedJobs) {
    const section = sectionFor(job);
    const jobs = grouped.get(section) ?? [];
    jobs.push(job);
    grouped.set(section, jobs);
  }

  return {
    sections: SECTIONS.flatMap(({ id, label }) => {
      const jobs = grouped.get(id);
      return jobs?.length ? [{ id, label, jobs }] : [];
    }),
    activeCount:
      snapshot.collectionObservation.state === 'current' && historySummary
        ? Math.max(rowActiveCount, historySummary.activeCount)
        : rowActiveCount,
    uncertainCount: visibleJobs.filter(isUncertainActive).length,
    attentionCount: projectedJobs.filter((job) => job.attentionReasons.length > 0).length,
    ...(historySummary
      ? {
          historyCoverage: {
            ...historySummary,
            visibleTerminalCount: visibleJobs.filter((job) => TERMINAL_STATES.has(job.state))
              .length,
          },
        }
      : {}),
  };
}

export function canRequestJobStop(
  job: Readonly<Pick<JobsSidebarJob, 'canStop' | 'state' | 'observation' | 'executionContext'>>
): boolean {
  return (
    job.canStop &&
    job.observation.freshness === 'current' &&
    job.executionContext.mode !== 'recorded' &&
    (job.state === 'queued' || job.state === 'running')
  );
}
