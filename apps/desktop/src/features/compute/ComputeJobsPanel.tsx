import { Button } from '../../components/ui';
import { reconcileWorkspaceAfterFilesChanged } from '../../services/workspace-operations';
import { platform } from '../../platform';
import { toUserMessage, userEntityLabel, userToolLabel } from '@waypoint/user-messages';
import { useEffect, useState } from 'react';
import {
  SETTINGS_SECONDARY_BUTTON_CLASS,
  SETTINGS_SURFACE_CLASS,
  SettingsSubsectionHeader,
} from '../../components/SettingsSubsection';
import { useWorkspaceStore } from '../../stores/workspaceStore';

import type { ComputeJobRecord, ComputeJobState } from '../../shared/compute-jobs-ipc';
import { useComputeJobsStore } from './jobs-store';

const REFRESH_MS = 5_000;

export const COMPUTE_JOB_STATE_LABEL: Record<ComputeJobState, string> = {
  intent: 'Preparing',
  'submission-unknown': 'Submission unconfirmed',
  submitted: 'Submitted',
  queued: 'Queued',
  running: 'Running',
  completed: 'Completed · not yet imported',
  failed: 'Failed',
  canceled: 'Canceled',
  imported: 'Imported',
};

const STATE_TONE: Record<ComputeJobState, string> = {
  intent: 'text-fg-subtle',
  'submission-unknown': 'text-warning',
  submitted: 'text-fg-muted',
  queued: 'text-fg-muted',
  running: 'text-accent',
  completed: 'text-warning',
  failed: 'text-danger',
  canceled: 'text-fg-subtle',
  imported: 'text-fg',
};

function formatCost(amount: number | null, unit: string | null): string | null {
  if (amount === null) return null;
  const label = unit === 'weighted_hours' ? 'weighted hours' : (unit ?? '');
  return `${amount} ${label}`.trim();
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function JobRow({
  job,
  onImport,
  onRecover,
  recovering = false,
  importing = false,
}: {
  job: ComputeJobRecord;
  onImport?: () => void;
  onRecover?: () => void;
  recovering?: boolean;
  importing?: boolean;
}) {
  const estimate = formatCost(job.costEstimate, job.costEstimateUnit);
  const actual = formatCost(job.costActual, job.costActualUnit);
  return (
    <li
      className={`rounded-md p-3 ${SETTINGS_SURFACE_CLASS}`}
      data-testid={`compute-job-${job.id}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-fg">{userEntityLabel(job.label)}</span>
            <span className="text-[11px] text-fg-subtle">
              {userToolLabel(job.toolId)} · {job.provider}
            </span>
          </div>
          <p className="mt-1 text-[11px] text-fg-subtle">
            {job.remoteId ? `Provider job ${job.remoteId}` : 'Not yet acknowledged by the provider'}{' '}
            · started {formatWhen(job.createdAt)}
            {job.providerState ? ` · provider says “${job.providerState}”` : ''}
          </p>
          {job.lastError && (
            <p className="mt-1 text-[11px] text-danger" data-testid="compute-job-error">
              {job.lastError}
            </p>
          )}
          {job.state === 'submission-unknown' && (
            <p className="mt-1 text-[11px] text-warning">
              The provider may have accepted this job. Check its account before sending another
              request. DNAForge has retained the inputs and will not automatically resubmit it.
            </p>
          )}
          {job.importedPaths.length > 0 && (
            <p
              className="mt-1 truncate text-[11px] text-fg-muted"
              title={job.importedPaths.join('\n')}
            >
              {job.importedPaths.length} file{job.importedPaths.length === 1 ? '' : 's'} in
              workspace
            </p>
          )}
        </div>
        <div className="shrink-0 text-right">
          <div
            className={`text-[11px] font-medium ${STATE_TONE[job.state]}`}
            data-testid="compute-job-state"
          >
            {COMPUTE_JOB_STATE_LABEL[job.state]}
          </div>
          <div className="mt-1 text-[11px] text-fg-subtle">
            {actual ? `Cost ${actual}` : estimate ? `Est. ${estimate}` : 'Cost unknown'}
          </div>
          {onRecover && (
            <div className="mt-2">
              <Button
                type="button"
                data-testid="compute-job-recover"
                onClick={onRecover}
                disabled={recovering}
              >
                {recovering ? 'Recovering…' : 'Recover legacy results'}
              </Button>
            </div>
          )}
          {onImport && (
            <button
              type="button"
              data-testid="compute-job-import"
              onClick={onImport}
              disabled={importing}
              className={`${SETTINGS_SECONDARY_BUTTON_CLASS} mt-2 px-2 py-1 text-[11px]`}
            >
              {importing ? 'Importing…' : 'Import into workspace'}
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

export function ComputeJobsPanel({ limit = 50 }: { limit?: number }) {
  const jobs = useComputeJobsStore((s) => s.jobs);
  const error = useComputeJobsStore((s) => s.error);
  const refresh = useComputeJobsStore((s) => s.refresh);
  const visibleJobs = jobs.slice(0, Math.min(Math.max(limit, 1), 1000));
  const folders = useWorkspaceStore((s) => s.folders);
  const [importingId, setImportingId] = useState<string | null>(null);

  const [recoveringId, setRecoveringId] = useState<string | null>(null);
  const [recoveryMessage, setRecoveryMessage] = useState<string | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const recoverJob = async (job: ComputeJobRecord) => {
    setRecoveringId(job.id);
    setRecoveryMessage(null);
    setRecoveryError(null);
    try {
      const result = await platform().compute.recoverLegacyResult(job.id);
      await reconcileWorkspaceAfterFilesChanged({
        workspaceRoot: job.workspaceRoot!,
        revealPath: `${job.workspaceRoot}/${result.targetRelativePath}`,
        strict: true,
      });
      useWorkspaceStore.getState().bumpFileTreeRefresh();
      await refresh({ limit });
      setRecoveryMessage(
        'Recovered results are available in Files. The original files have been retained.'
      );
    } catch (error) {
      setRecoveryError(toUserMessage(error, 'operation.failed'));
    } finally {
      setRecoveringId(null);
    }
  };

  const importJob = async (job: ComputeJobRecord) => {
    setImportingId(job.id);
    try {
      const { importCompletedJob } = await import('./predict-structure');
      await importCompletedJob(job, folders);
      await refresh({ limit });
    } finally {
      setImportingId(null);
    }
  };

  useEffect(() => {
    void refresh({ limit });
    const handle = setInterval(() => void refresh({ limit }), REFRESH_MS);
    return () => clearInterval(handle);
  }, [refresh, limit]);

  return (
    <div className="space-y-2" data-testid="compute-jobs-panel">
      <SettingsSubsectionHeader title="Compute jobs" />
      {recoveryMessage && (
        <p role="status" className="text-xs text-fg-muted">
          {recoveryMessage}
        </p>
      )}
      {recoveryError && (
        <p role="alert" className="text-xs text-danger">
          {toUserMessage(recoveryError, 'operation.failed')}
        </p>
      )}
      {error && (
        <p className="text-xs text-danger" role="alert">
          {toUserMessage(error, 'operation.failed')}
        </p>
      )}
      {jobs.length === 0 && !error && <p className="text-xs text-fg-subtle">No jobs yet.</p>}
      <ul className="space-y-2">
        {visibleJobs.map((job) => (
          <JobRow
            key={job.id}
            job={job}
            onImport={
              job.state === 'completed' && job.remoteId ? () => void importJob(job) : undefined
            }
            onRecover={
              job.state === 'imported' &&
              job.workspaceRoot &&
              job.remoteId &&
              job.importedPaths.some((path) =>
                path.startsWith(`${job.workspaceRoot}/compute/${job.provider}/${job.remoteId}/`)
              )
                ? () => void recoverJob(job)
                : undefined
            }
            recovering={recoveringId === job.id}
            importing={importingId === job.id}
          />
        ))}
      </ul>
      {visibleJobs.some((j) => j.state === 'completed') && (
        <p className="text-[11px] text-fg-muted">
          Completed jobs are not yet in your workspace. Import them here; providers may delete
          results after a few days.
        </p>
      )}
    </div>
  );
}
