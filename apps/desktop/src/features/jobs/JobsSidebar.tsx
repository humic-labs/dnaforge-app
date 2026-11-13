import {
  toUserMessage,
  userMessage,
  toOptionalUserEntityLabel,
  userEntityLabel,
} from '@waypoint/user-messages';
import { beginJobManagement, jobManagementContext } from '../../lib/jobs-management-telemetry';
import type { JobManagementObservation } from '../../shared/jobs-management-telemetry';
import { useEffect, useId, useRef, useState } from 'react';
import {
  canRequestJobStop,
  projectJobsSnapshot,
  type JobsSidebarBatchSummary,
  type JobsSidebarActionHistory,
  type JobsSidebarExecutionMode,
  type JobsSidebarExecutionState,
  type JobsSidebarOwnerRef,
  type JobsSidebarResultAvailability,
  type JobsSidebarReviewState,
  type JobsSidebarSnapshot,
  type ProjectedJobsSidebarJob,
} from './presentation';

export interface JobsSidebarProps {
  snapshot: JobsSidebarSnapshot;
  onStop: (owner: JobsSidebarOwnerRef) => void;
  onImportResult: (owner: JobsSidebarOwnerRef) => void;
  onOpenResult: (owner: JobsSidebarOwnerRef) => void;
  onReleaseResult?: (owner: JobsSidebarOwnerRef) => void;
  onLoadActions?: (owner: JobsSidebarOwnerRef) => Promise<JobsSidebarActionHistory>;
  onImportRecordedRun?: () => void;
  importingRecordedRun?: boolean;
  onReconnect?: () => void;
  onScopeChange?: (scopeId: string | null) => void;
}

function hasCurrentActiveJob(jobs: JobsSidebarSnapshot['jobs']): boolean {
  return jobs.some(
    (job) =>
      (job.observation.freshness === 'current' &&
        (job.state === 'queued' || job.state === 'running' || job.state === 'stopping')) ||
      hasCurrentActiveJob(job.children ?? [])
  );
}

function usePresentationNow(snapshot: JobsSidebarSnapshot): number {
  const [clockNowMs, setClockNowMs] = useState(snapshot.nowMs);
  const clockNeeded = hasCurrentActiveJob(snapshot.jobs);

  useEffect(() => {
    if (!clockNeeded) return;
    const timer = window.setInterval(() => setClockNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [clockNeeded]);

  return Math.max(snapshot.nowMs, clockNowMs);
}

const STATE_CLASS: Record<JobsSidebarExecutionState, string> = {
  queued: 'bg-warning',
  running: 'bg-accent',
  stopping: 'bg-warning',
  succeeded: 'bg-success',
  failed: 'bg-error',
  cancelled: 'bg-fg-subtle',
  interrupted: 'bg-error',
};

const MODE_LABEL: Record<JobsSidebarExecutionMode, string> = {
  managed: 'Managed execution',
  connected: 'Connected execution',
  recorded: 'Recorded history',
};

const MODE_EXPLANATION: Record<JobsSidebarExecutionMode, string> = {
  managed: 'DNAForge owns lifecycle reporting and exposes only supported controls',
  connected: 'Status and supported controls come from the connected execution owner',
  recorded: 'Recorded history · no live control',
};

const RESULT_LABEL: Record<JobsSidebarResultAvailability, string> = {
  none: 'None reported',
  available: 'Available',
  released: 'Released',
  expired: 'Expired',
  unavailable: 'Unavailable',
};

const REVIEW_LABEL: Record<JobsSidebarReviewState, string> = {
  'not-required': 'Not required',
  'not-checked': 'Not checked',
  'awaiting-review': 'Awaiting review',
  'in-review': 'In review',
  applied: 'Applied',
  dismissed: 'Dismissed',
  blocked: 'Blocked',
};

function BatchSummary({ summary }: { summary: JobsSidebarBatchSummary }) {
  const failures = [
    summary.failed > 0 ? `${summary.failed} failed` : null,
    summary.interrupted > 0 ? `${summary.interrupted} interrupted` : null,
  ].filter(Boolean);
  return (
    <span className="block truncate text-[10px] text-fg-muted">
      {summary.finished}/{summary.total} finished
      {failures.length > 0 ? ` · ${failures.join(' · ')}` : ''}
    </span>
  );
}

function DetailRow({ label, value }: { label: string; value: string | undefined }) {
  if (!value) return null;
  return (
    <div className="min-w-0">
      <dt className="text-[9px] uppercase tracking-wide text-fg-subtle">{label}</dt>
      <dd className="break-words text-[10px] leading-4 text-fg">{value}</dd>
    </div>
  );
}

function formatObservation(job: ProjectedJobsSidebarJob): string {
  const observedAt = job.observation.observedAtMs;
  const timeLabel =
    observedAt === undefined
      ? undefined
      : new Date(observedAt).toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        });
  if (job.observation.freshness === 'stale') {
    return timeLabel ? `Stale · last observed ${timeLabel}` : 'Stale';
  }
  return timeLabel ? `Current · observed ${timeLabel}` : 'Current';
}

function formatCollectionObservation(
  observation: JobsSidebarSnapshot['collectionObservation']
): string | undefined {
  if (observation.observedAtMs === undefined) return undefined;
  return `Last known ${new Date(observation.observedAtMs).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })}`;
}

function JobDetails({
  job,
  nowMs,
  actionHistory,
  actionHistoryStatus,
  actionHistoryError,
  onRefreshActions,
  onStop,
  onImportResult,
  onOpenResult,
  onReleaseResult,
  onLoadActions,
}: {
  job: ProjectedJobsSidebarJob;
  nowMs: number;
  actionHistory?: JobsSidebarActionHistory;
  actionHistoryStatus: 'idle' | 'loading' | 'loaded' | 'error';
  actionHistoryError?: string;
  onRefreshActions?: () => void;
  onStop: (owner: JobsSidebarOwnerRef) => void;
  onImportResult: (owner: JobsSidebarOwnerRef) => void;
  onOpenResult: (owner: JobsSidebarOwnerRef) => void;
  onReleaseResult?: (owner: JobsSidebarOwnerRef) => void;
  onLoadActions?: (owner: JobsSidebarOwnerRef) => Promise<JobsSidebarActionHistory>;
}) {
  const actions = actionHistory?.actions ?? job.actions;
  return (
    <div className="mt-2 border-t border-border/70 pt-2">
      <dl className="space-y-1.5">
        <DetailRow
          label="Attention"
          value={job.attentionReasons.length ? userMessage('jobs.attention') : undefined}
        />
        <DetailRow
          label="Error"
          value={job.error ? toUserMessage(job.error, 'jobs.failed') : undefined}
        />
        <DetailRow
          label="Observation detail"
          value={
            job.observation.reason
              ? toUserMessage(job.observation.reason, 'jobs.refreshFailed')
              : undefined
          }
        />
        <div className="grid grid-cols-2 gap-2">
          <DetailRow label="Result" value={RESULT_LABEL[job.result.availability]} />
          <DetailRow label="Review" value={REVIEW_LABEL[job.review.state]} />
        </div>
        <DetailRow
          label="Result detail"
          value={
            job.result.reason
              ? toUserMessage(
                  job.result.reason,
                  job.result.availability === 'expired'
                    ? 'jobs.retentionEnded'
                    : job.result.availability === 'released'
                      ? 'jobs.resultReleased'
                      : 'jobs.resultUnavailable'
                )
              : undefined
          }
        />
        <DetailRow label="Result summary" value={job.resultSummary} />
        <DetailRow
          label="Review detail"
          value={job.review.reason ? toUserMessage(job.review.reason, 'jobs.attention') : undefined}
        />
        <DetailRow label="Stop" value={job.stopUnavailableReason} />
        <DetailRow label="Location" value={job.executionContext.locationLabel} />
        <DetailRow label="Lifetime" value={job.executionContext.lifetimeLabel} />
        <DetailRow
          label="Control"
          value={job.executionContext.mode === 'recorded' ? MODE_EXPLANATION.recorded : undefined}
        />
        <DetailRow label="Recorded source" value={job.recordedProvenance?.sourceLabel} />
      </dl>
      {onRefreshActions ? (
        <button
          type="button"
          className="mt-2 rounded border border-border px-1.5 py-0.5 text-[10px] text-fg-muted hover:bg-bg-muted disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-accent/40"
          disabled={actionHistoryStatus === 'loading'}
          onClick={onRefreshActions}
        >
          {actionHistoryStatus === 'loading' ? 'Refreshing history…' : 'Refresh history'}
        </button>
      ) : null}
      {onLoadActions && actionHistoryStatus === 'loading' ? (
        <p className="mt-2 text-[10px] leading-4 text-fg-muted">Loading history…</p>
      ) : null}
      {onLoadActions && actionHistoryStatus === 'error' ? (
        <p role="alert" className="mt-2 break-words text-[10px] leading-4 text-error">
          History unavailable. {toUserMessage(actionHistoryError, 'operation.failed')}
        </p>
      ) : null}
      {actionHistoryStatus === 'loaded' && actions?.length === 0 ? (
        <p className="mt-2 text-[10px] leading-4 text-fg-muted">No retained actions.</p>
      ) : null}
      {actions && actions.length > 0 ? (
        <div className="mt-2">
          <div className="text-[9px] uppercase tracking-wide text-fg-subtle">History</div>
          <ol className="mt-1 space-y-1 text-[10px] leading-4 text-fg-muted">
            {actions.map((action) => (
              <li key={action.id}>
                {[action.label, action.outcomeLabel].filter(Boolean).join(' · ')}
                {action.actorLabel
                  ? ` · ${[action.actorKindLabel, userEntityLabel(action.actorLabel, 'identity.user')].filter(Boolean).join(' ')}`
                  : ''}
                {action.channelLabel ? ` · ${action.channelLabel}` : ''}
                {action.atMs !== undefined
                  ? ` · ${new Date(action.atMs).toLocaleString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}`
                  : ''}
              </li>
            ))}
          </ol>
          {actionHistory?.truncated ? (
            <p className="mt-1 text-[10px] leading-4 text-fg-muted">
              Showing {actions.length} of {actionHistory.total} retained actions.
            </p>
          ) : null}
          {actionHistory?.historyComplete === false ? (
            <p className="mt-1 text-[10px] leading-4 text-fg-muted">
              {actionHistory.omittedCount
                ? `${actionHistory.omittedCount} earlier ${actionHistory.omittedCount === 1 ? 'action was' : 'actions were'} omitted by the execution owner's history policy.`
                : "Earlier actions were omitted by the execution owner's history policy."}
            </p>
          ) : null}
        </div>
      ) : null}
      <dl className="mt-2 space-y-1.5 border-t border-border/70 pt-2">
        <DetailRow label="Target" value={job.target} />
        <DetailRow
          label={job.actorActionLabel ?? 'Started by'}
          value={toOptionalUserEntityLabel(job.actorLabel, 'identity.user')}
        />
        <DetailRow label="Channel" value={job.actorChannelLabel} />
        <DetailRow label="Mode" value={MODE_LABEL[job.executionContext.mode]} />
        <DetailRow
          label="Owner"
          value={toOptionalUserEntityLabel(job.executionContext.ownerLabel, 'identity.service')}
        />
        <DetailRow label="Observation" value={formatObservation(job)} />
      </dl>
      <details className="mt-2 border-t border-border/70 pt-2">
        <summary className="cursor-pointer rounded text-[10px] text-fg-muted focus:outline-none focus:ring-2 focus:ring-accent/40">
          Technical details
        </summary>
        <dl className="mt-2 space-y-1.5">
          <DetailRow label="Workflow identity" value={job.id} />
          <DetailRow label="Owner-native identity" value={job.owner.nativeId} />
          <DetailRow label="Target identity" value={job.targetIdentity} />
          <DetailRow label="Owner instance" value={job.executionContext.ownerInstanceId} />
          <DetailRow
            label="Control"
            value={
              job.executionContext.mode === 'recorded'
                ? undefined
                : MODE_EXPLANATION[job.executionContext.mode]
            }
          />
          <DetailRow
            label="Execution ownership"
            value={
              job.executionContext.mode === 'recorded' ? 'Not observed by DNAForge' : undefined
            }
          />
          <DetailRow label="Input revision" value={job.inputRevision} />
          <DetailRow label="Input" value={job.inputSummary} />
          <DetailRow label="Tool" value={actionHistory?.toolVersion ?? job.toolVersion} />
          <DetailRow label="Data" value={job.dataVersion} />
          <DetailRow label="Reported run" value={job.recordedProvenance?.runId} />
          <DetailRow label="Reported tool" value={job.recordedProvenance?.tool} />
          <DetailRow label="Reported started" value={job.recordedProvenance?.startedAt} />
          <DetailRow label="Reported finished" value={job.recordedProvenance?.finishedAt} />
          <DetailRow label="Reported input" value={job.recordedProvenance?.input} />
          <DetailRow label="Reported input path" value={job.recordedProvenance?.inputPath} />
          <DetailRow label="Reported output" value={job.recordedProvenance?.output} />
          <DetailRow
            label="Reported reference versions"
            value={job.recordedProvenance?.referenceVersions}
          />
          <DetailRow label="Reported runtime" value={job.recordedProvenance?.runtime} />
        </dl>
      </details>
      {job.children.length > 0 ? (
        <ul
          className="mt-2 space-y-1 border-l border-border pl-2"
          aria-label={`Items in ${job.title}`}
        >
          {job.children.map((child) => (
            <JobRow
              key={child.id}
              job={child}
              nowMs={nowMs}
              onStop={onStop}
              onImportResult={onImportResult}
              onOpenResult={onOpenResult}
              onReleaseResult={onReleaseResult}
              onLoadActions={onLoadActions}
              child
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function JobSummary({ job, expanded }: { job: ProjectedJobsSidebarJob; expanded: boolean }) {
  const actorSummary = [
    `${job.actorActionLabel ?? 'Started by'} ${userEntityLabel(job.actorLabel, 'identity.user')}`,
    job.actorChannelLabel,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <>
      <span
        aria-hidden="true"
        className={`mt-0.5 block h-4 w-4 flex-none text-center text-xs leading-4 text-fg-muted transition-transform ${
          expanded ? 'rotate-90' : ''
        }`}
      >
        ›
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11px] font-medium text-fg" title={job.title}>
          {job.title}
        </span>
        {job.target ? (
          <span className="block truncate text-[10px] text-fg-muted" title={job.target}>
            {job.target}
          </span>
        ) : null}
        <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] text-fg-muted">
          <span className="inline-flex items-center gap-1">
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 rounded-full ${STATE_CLASS[job.state]}`}
            />
            {job.stateLabel}
          </span>
          <span>{job.elapsedLabel}</span>
          {job.progress ? (
            <span className="min-w-0 truncate" title={job.progress.label}>
              <span>
                {job.progress.completed}/{job.progress.total}
              </span>
              {job.progress.label ? ` · ${job.progress.label}` : null}
            </span>
          ) : null}
        </span>
        {job.review.state !== 'not-required' ? (
          <span className="mt-0.5 block text-[10px] text-fg-muted">
            {`Review: ${REVIEW_LABEL[job.review.state]}`}
          </span>
        ) : null}
        {job.actorLabel ? (
          <span className="mt-0.5 block truncate text-[10px] text-fg-subtle" title={actorSummary}>
            {actorSummary}
          </span>
        ) : null}
        {job.attentionReasons.length > 0 ? (
          <span className="mt-1 block break-words text-[10px] leading-4 text-error">
            {job.attentionReasons.join(' · ')}
          </span>
        ) : null}
        {job.batchSummary ? <BatchSummary summary={job.batchSummary} /> : null}
      </span>
    </>
  );
}

function disclosureLabel(job: ProjectedJobsSidebarJob, expanded: boolean): string {
  return [
    `${expanded ? 'Hide' : 'Show'} details for ${job.title}`,
    job.target ? `Target ${job.target}` : undefined,
    job.stateLabel,
    job.review.state !== 'not-required' ? `Review: ${REVIEW_LABEL[job.review.state]}` : undefined,
    job.actorLabel
      ? [
          job.actorActionLabel ?? 'Started by',
          userEntityLabel(job.actorLabel, 'identity.user'),
          job.actorChannelLabel,
        ]
          .filter(Boolean)
          .join(' ')
      : undefined,
    job.attentionReasons.length > 0
      ? `Needs attention: ${job.attentionReasons.join(' · ')}`
      : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join('. ');
}

function JobRow({
  job,
  nowMs,
  onStop,
  onImportResult,
  onOpenResult,
  onReleaseResult,
  onLoadActions,
  child = false,
}: {
  job: ProjectedJobsSidebarJob;
  nowMs: number;
  onStop: (owner: JobsSidebarOwnerRef) => void;
  onImportResult: (owner: JobsSidebarOwnerRef) => void;
  onOpenResult: (owner: JobsSidebarOwnerRef) => void;
  onReleaseResult?: (owner: JobsSidebarOwnerRef) => void;
  onLoadActions?: (owner: JobsSidebarOwnerRef) => Promise<JobsSidebarActionHistory>;
  child?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [actionHistoryStatus, setActionHistoryStatus] = useState<
    'idle' | 'loading' | 'loaded' | 'error'
  >('idle');
  const [actionHistory, setActionHistory] = useState<JobsSidebarActionHistory>();
  const [actionHistoryError, setActionHistoryError] = useState<string>();
  const loadGeneration = useRef(0);
  const detailsId = useId();
  const showStop = canRequestJobStop(job);
  const showImportResult = job.result.availability === 'available' && job.canImportResult === true;
  const showOpenResult = job.result.availability === 'available' && job.canOpenResult !== false;
  const showReleaseResult =
    job.result.availability === 'available' &&
    job.canReleaseResult === true &&
    onReleaseResult !== undefined;

  useEffect(
    () => () => {
      loadGeneration.current += 1;
    },
    []
  );

  const loadActions = () => {
    if (!job.canLoadActions || !onLoadActions || actionHistoryStatus === 'loading') return;
    const generation = ++loadGeneration.current;
    const observed = beginJobManagement('history', jobManagementContext(job));
    setActionHistoryStatus('loading');
    setActionHistoryError(undefined);
    let read: Promise<JobsSidebarActionHistory>;
    try {
      read = onLoadActions(job.owner);
    } catch (error) {
      observed.settle({ phase: 'error', result: 'request_rejected' });
      throw error;
    }
    void read.then(
      (history) => {
        if (loadGeneration.current !== generation) {
          observed.settle({ phase: 'cancelled', result: 'superseded', freshness: 'superseded' });
          return;
        }
        setActionHistory(history);
        setActionHistoryStatus('loaded');
        observed.settle({
          phase: 'result',
          result: 'history_returned',
          authority: 'owner_history_return',
          history:
            history.historyComplete === true
              ? 'complete'
              : history.historyComplete === false || history.truncated
                ? 'limited'
                : 'unknown',
        });
      },
      (error: unknown) => {
        if (loadGeneration.current !== generation) {
          observed.settle({ phase: 'cancelled', result: 'superseded', freshness: 'superseded' });
          return;
        }
        observed.settle({ phase: 'error', result: 'request_rejected' });
        setActionHistoryError(toUserMessage(error, 'operation.failed'));
        setActionHistoryStatus('error');
      }
    );
  };

  const toggleExpanded = () => {
    const nextExpanded = !expanded;
    setExpanded(nextExpanded);
    if (nextExpanded && actionHistoryStatus === 'idle') loadActions();
  };

  return (
    <li
      data-testid={`job-row-${
        job.owner.kind === 'managed-operation' ? job.owner.nativeId : job.id
      }`}
      className={child ? 'min-w-0 py-1' : 'min-w-0 rounded border border-border bg-bg p-2'}
    >
      <button
        type="button"
        aria-label={disclosureLabel(job, expanded)}
        aria-expanded={expanded}
        aria-controls={detailsId}
        className="flex w-full min-w-0 items-start gap-1.5 rounded text-left hover:bg-bg-muted/50 focus:outline-none focus:ring-2 focus:ring-accent/40"
        onClick={toggleExpanded}
      >
        <JobSummary job={job} expanded={expanded} />
      </button>

      {showStop || showImportResult || showOpenResult || showReleaseResult ? (
        <div className="mt-2 flex flex-wrap justify-end gap-1">
          {showStop ? (
            <button
              type="button"
              className="rounded border border-border px-1.5 py-0.5 text-[10px] text-fg hover:bg-bg-muted focus:outline-none focus:ring-2 focus:ring-accent/40"
              onClick={() => onStop(job.owner)}
            >
              Stop
            </button>
          ) : null}
          {showImportResult ? (
            <button
              type="button"
              className="rounded border border-accent/40 px-1.5 py-0.5 text-[10px] text-accent hover:bg-accent/10 focus:outline-none focus:ring-2 focus:ring-accent/40"
              onClick={() => onImportResult(job.owner)}
            >
              Import result
            </button>
          ) : null}
          {showOpenResult ? (
            <button
              type="button"
              className="rounded border border-accent/40 px-1.5 py-0.5 text-[10px] text-accent hover:bg-accent/10 focus:outline-none focus:ring-2 focus:ring-accent/40"
              onClick={() => onOpenResult(job.owner)}
            >
              Open result
            </button>
          ) : null}
          {showReleaseResult ? (
            <button
              type="button"
              className="rounded border border-error/40 px-1.5 py-0.5 text-[10px] text-error hover:bg-error/10 focus:outline-none focus:ring-2 focus:ring-error/40"
              onClick={() => onReleaseResult(job.owner)}
            >
              Release result
            </button>
          ) : null}
        </div>
      ) : null}

      {expanded ? (
        <div id={detailsId} role="region" aria-label={`Details for ${job.title}`}>
          <JobDetails
            job={job}
            nowMs={nowMs}
            actionHistory={actionHistory}
            actionHistoryStatus={actionHistoryStatus}
            actionHistoryError={actionHistoryError}
            onRefreshActions={job.canLoadActions && onLoadActions ? loadActions : undefined}
            onStop={onStop}
            onImportResult={onImportResult}
            onOpenResult={onOpenResult}
            onReleaseResult={onReleaseResult}
            onLoadActions={job.canLoadActions ? onLoadActions : undefined}
          />
        </div>
      ) : null}
    </li>
  );
}

export function JobsSidebar({
  snapshot,
  onStop,
  onImportResult,
  onOpenResult,
  onReleaseResult,
  onLoadActions,
  onImportRecordedRun,
  importingRecordedRun = false,
  onReconnect,
  onScopeChange,
}: JobsSidebarProps) {
  const presentationNowMs = usePresentationNow(snapshot);
  const projection = projectJobsSnapshot({ ...snapshot, nowMs: presentationNowMs });
  const selectedScopeExists = snapshot.scopes?.some(
    (scope) => scope.id === snapshot.selectedScopeId
  );
  const scopes = snapshot.scopes ?? [];
  const pendingScope = useRef<{
    target: string | null;
    previous: string | null;
    observed: JobManagementObservation;
  } | null>(null);
  const actualScope = selectedScopeExists ? (snapshot.selectedScopeId ?? null) : null;
  useEffect(() => {
    const pending = pendingScope.current;
    if (!pending) return;
    if (actualScope === pending.target) {
      pendingScope.current = null;
      pending.observed.record({
        phase: 'observed',
        result: 'scope_applied',
        authority: 'surface',
        scope: actualScope === null ? 'all' : 'scoped',
      });
    } else if (
      pending.target !== null &&
      snapshot.selectedScopeId === pending.target &&
      !selectedScopeExists
    ) {
      pendingScope.current = null;
      pending.observed.record({
        phase: 'refused',
        result: 'scope_unavailable',
        authority: 'surface',
      });
    } else if (actualScope !== pending.previous) {
      pendingScope.current = null;
      pending.observed.record({
        phase: 'cancelled',
        result: 'superseded',
        freshness: 'superseded',
      });
    }
  }, [actualScope, snapshot.selectedScopeId, selectedScopeExists]);
  useEffect(
    () => () => {
      pendingScope.current?.observed.record({ phase: 'cancelled', result: 'surface_closed' });
      pendingScope.current = null;
    },
    []
  );
  const changeScope = (target: string | null) => {
    const observed = beginJobManagement('scope', {
      owner: 'federated',
      freshness: snapshot.collectionObservation.state === 'current' ? 'current' : 'stale',
      observedAtMs: snapshot.collectionObservation.observedAtMs,
      scope: target === null ? 'all' : 'scoped',
    });
    pendingScope.current?.observed.record({
      phase: 'cancelled',
      result: 'superseded',
      freshness: 'superseded',
    });
    pendingScope.current = { target, previous: actualScope, observed };
    try {
      onScopeChange?.(target);
      observed.settle({ phase: 'result', result: 'scope_requested', authority: 'surface' });

      if (actualScope === target) {
        pendingScope.current = null;
        observed.record({ phase: 'observed', result: 'scope_unchanged', authority: 'surface' });
      }
    } catch (error) {
      pendingScope.current = null;
      observed.settle({ phase: 'error', result: 'request_rejected' });
      throw error;
    }
  };
  const showScopeFilter = scopes.length > 1 && onScopeChange !== undefined;
  const activitySummary = [
    projection.activeCount > 0 ? `${projection.activeCount} active` : null,
    projection.uncertainCount > 0
      ? `${projection.uncertainCount} ${projection.uncertainCount === 1 ? 'status' : 'statuses'} unknown`
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const collectionUnavailable = snapshot.collectionObservation.state !== 'current';
  const collectionObservationTime = formatCollectionObservation(snapshot.collectionObservation);
  const limitedHistory =
    projection.historyCoverage && !projection.historyCoverage.historyComplete
      ? projection.historyCoverage
      : undefined;

  return (
    <section
      data-analytics-block
      aria-label="Jobs"
      data-testid="jobs-sidebar"
      className="ph-no-capture flex h-full min-w-0 flex-col overflow-hidden bg-bg"
    >
      <header className="flex-none border-b border-border px-3 py-2.5">
        <div className="flex items-start justify-between gap-2">
          <h2 className="truncate text-xs font-semibold uppercase tracking-wide text-fg">Jobs</h2>
          {activitySummary ? (
            <span className="text-right text-[10px] leading-4 text-fg-muted">
              {activitySummary}
            </span>
          ) : null}
        </div>
        {onImportRecordedRun ? (
          <button
            type="button"
            disabled={importingRecordedRun}
            className="mt-2 w-full rounded border border-border bg-bg px-1.5 py-1 text-[10px] text-fg hover:bg-bg-muted focus:outline-none focus:ring-2 focus:ring-accent/40 disabled:cursor-wait disabled:opacity-60"
            onClick={onImportRecordedRun}
          >
            {importingRecordedRun ? 'Recording completed run…' : 'Record completed run…'}
          </button>
        ) : null}
        {showScopeFilter ? (
          <label className="mt-2 block">
            <span className="sr-only">Job scope</span>
            <select
              aria-label="Job scope"
              value={selectedScopeExists ? (snapshot.selectedScopeId ?? '') : ''}
              onChange={(event) => changeScope(event.currentTarget.value || null)}
              className="h-7 w-full min-w-0 rounded border border-border bg-bg px-1.5 text-[10px] text-fg focus:outline-none focus:ring-2 focus:ring-accent/40"
            >
              <option value="">All workspaces</option>
              {scopes.map((scope) => (
                <option key={scope.id} value={scope.id}>
                  {scope.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {limitedHistory ? (
          <div className="mx-1 mt-3 rounded border border-border bg-bg-muted/40 px-2 py-2 text-[10px] leading-4 text-fg-muted">
            <p className="font-medium text-fg">Recent history is limited.</p>
            <p>
              {limitedHistory.activeCount > 0
                ? snapshot.collectionObservation.state === 'current'
                  ? `All ${limitedHistory.activeCount} active ${limitedHistory.activeCount === 1 ? 'job is' : 'jobs are'} shown. `
                  : `The last refresh included all ${limitedHistory.activeCount} active ${limitedHistory.activeCount === 1 ? 'job' : 'jobs'}. `
                : ''}
              Showing {limitedHistory.visibleTerminalCount} of {limitedHistory.terminalCount}{' '}
              finished jobs.
            </p>
          </div>
        ) : null}
        {collectionUnavailable ? (
          <div
            role="status"
            className="mx-1 mt-3 rounded border border-border bg-bg-muted/40 px-2 py-2 text-[10px] leading-4 text-fg-muted"
          >
            <p className="font-medium text-fg">
              {snapshot.collectionObservation.state === 'connecting'
                ? 'Connecting to job history…'
                : 'Job status is unavailable.'}
            </p>
            {collectionObservationTime ? <p>{collectionObservationTime}</p> : null}
            {snapshot.collectionObservation.reason ? (
              <p className="break-words">{snapshot.collectionObservation.reason}</p>
            ) : null}
            {snapshot.collectionObservation.canReconnect && onReconnect ? (
              <button
                type="button"
                className="mt-1.5 rounded border border-border bg-bg px-1.5 py-0.5 text-[10px] text-fg hover:bg-bg-muted focus:outline-none focus:ring-2 focus:ring-accent/40"
                onClick={onReconnect}
              >
                Reconnect
              </button>
            ) : null}
          </div>
        ) : null}
        {projection.sections.length === 0 ? (
          snapshot.collectionObservation.state === 'current' &&
          (!projection.historyCoverage || projection.historyCoverage.operationCount === 0) ? (
            <p className="px-1 py-5 text-center text-[11px] leading-4 text-fg-muted">
              No tracked jobs yet.
            </p>
          ) : null
        ) : (
          projection.sections.map((section) => (
            <section key={section.id} className="mt-3" aria-labelledby={`jobs-${section.id}`}>
              <h3
                id={`jobs-${section.id}`}
                className={`mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-wide ${
                  section.id === 'attention' ? 'text-error' : 'text-fg-muted'
                }`}
              >
                {section.label}
              </h3>
              <ul className="space-y-1.5">
                {section.jobs.map((job) => (
                  <JobRow
                    key={job.id}
                    job={job}
                    nowMs={presentationNowMs}
                    onStop={onStop}
                    onImportResult={onImportResult}
                    onOpenResult={onOpenResult}
                    onReleaseResult={onReleaseResult}
                    onLoadActions={onLoadActions}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </section>
  );
}
