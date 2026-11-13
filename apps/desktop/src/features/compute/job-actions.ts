import type { ComputeJobRecord } from '../../shared/compute-jobs-ipc';
import { isPathInsideBoundary } from '../../shared/path-boundary';
import { getStructureFileFormat } from '../../shared/scientific-file-types';
import { MOLECULAR_DOCUMENT_SUFFIX } from '../../shared/molecular-document';
import type { WorkspaceFolder } from '../../stores/workspaceStore';
import { cancelComputeJob, type ComputeToolContext } from '../ai/public/tools/compute';
import { openDocument } from '../document-opening/public/open-document';
import { importCompletedJob } from './predict-structure';
import { useComputeJobsStore } from './jobs-store';
import { reopenInspectionPrediction } from '../structure-drawer/public/inspection-prediction';
import { platform } from '../../platform';
import { openCatalogStructure } from './molecular-catalog';

type CancelArgs = { provider: string; remote_id: string; tool_id: string };
type OpenDocument = typeof openDocument;

export interface HostedComputeJobActionDeps {
  readonly newActionId: () => string;
  readonly cancel: (args: CancelArgs, context: ComputeToolContext) => Promise<unknown>;
  readonly markCanceled: (id: string, providerState: string) => Promise<ComputeJobRecord | null>;
  readonly importCompleted: (job: ComputeJobRecord, folders: WorkspaceFolder[]) => Promise<boolean>;
  readonly openDocument: OpenDocument;
  readonly reopenInspection?: typeof reopenInspectionPrediction;
  readonly openCatalogResult?: (
    job: ComputeJobRecord
  ) => Promise<Awaited<ReturnType<OpenDocument>> | null>;
}

const defaultDeps: HostedComputeJobActionDeps = {
  newActionId: () => crypto.randomUUID(),
  cancel: cancelComputeJob,
  markCanceled: (id, providerState) =>
    useComputeJobsStore.getState().markCanceled(id, providerState),
  importCompleted: importCompletedJob,
  openDocument,
  reopenInspection: reopenInspectionPrediction,
  openCatalogResult: async (job) => {
    const matches = await platform().molecularCatalog.list({ jobRecordId: job.id, limit: 200 });
    const match = job.importedPaths.flatMap((path) =>
      matches.filter((item) => item.observation.origin.filePath === path)
    )[0];
    return match ? openCatalogStructure(match.observation.id) : null;
  },
};

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function recordedWorkspaceRoot(job: ComputeJobRecord, folders: readonly WorkspaceFolder[]): string {
  if (!job.workspaceRoot) {
    throw new Error(
      'This job has no recorded workspace, so DNAForge cannot choose an import target.'
    );
  }
  const mounted = folders
    .filter((folder) => !folder.pinned)
    .find((folder) => isPathInsideBoundary(job.workspaceRoot as string, folder.path));
  if (!mounted) {
    throw new Error('The recorded workspace for this job is not open. Open it before continuing.');
  }
  return job.workspaceRoot;
}

export async function cancelHostedComputeJob(
  job: ComputeJobRecord,
  deps: HostedComputeJobActionDeps = defaultDeps
): Promise<ComputeJobRecord> {
  if (!['submitted', 'queued', 'running'].includes(job.state)) {
    throw new Error('Only a queued or running hosted job can be stopped.');
  }
  if (!job.remoteId) {
    throw new Error('The provider has not acknowledged this job yet.');
  }
  const response = object(
    await deps.cancel(
      { provider: job.provider, remote_id: job.remoteId, tool_id: job.toolId },
      {
        grantedCapabilities: ['external-compute:manage'],
        initiator: 'user',
        toolCallId: `ui-compute-cancel-${deps.newActionId()}`,
      }
    )
  );
  if (response.ok !== true) {
    throw new Error(
      typeof response.message === 'string' && response.message
        ? response.message
        : 'The provider did not cancel this job.'
    );
  }
  if (response.state !== 'canceled') {
    throw new Error(
      `The provider reported ${String(response.state || 'an unknown state')}, not canceled.`
    );
  }
  const providerState =
    typeof response.provider_state === 'string' && response.provider_state
      ? response.provider_state
      : 'canceled';
  const updated = await deps.markCanceled(job.id, providerState);
  if (!updated || updated.state !== 'canceled') {
    throw new Error(
      'The provider canceled this job, but DNAForge could not update its job record.'
    );
  }
  return updated;
}

export async function importHostedComputeJob(
  job: ComputeJobRecord,
  folders: WorkspaceFolder[],
  deps: HostedComputeJobActionDeps = defaultDeps
): Promise<boolean> {
  if (job.state !== 'completed') {
    throw new Error('Only a completed hosted job can be imported.');
  }
  if (!job.remoteId) throw new Error('The completed job has no provider identity.');
  recordedWorkspaceRoot(job, folders);
  return deps.importCompleted(job, folders);
}

function isMolecularView(path: string): boolean {
  return path.toLowerCase().endsWith(MOLECULAR_DOCUMENT_SUFFIX);
}

function isReceiptPath(path: string): boolean {
  return /(?:^|[\\/])compute-job\.json$/i.test(path);
}

export async function openHostedComputeResult(
  job: ComputeJobRecord,
  folders: WorkspaceFolder[],
  deps: HostedComputeJobActionDeps = defaultDeps
): ReturnType<OpenDocument> {
  if (job.state !== 'imported') {
    throw new Error('Import this hosted result before opening it.');
  }
  if (job.resultTarget) {
    recordedWorkspaceRoot(job, folders);
    return (deps.reopenInspection ?? reopenInspectionPrediction)(job);
  }
  if (!job.importedPaths.some(isMolecularView)) {
    const catalogResult = await deps.openCatalogResult?.(job);
    if (catalogResult) return catalogResult;
  }
  const workspaceRoot = recordedWorkspaceRoot(job, folders);
  const candidates = job.importedPaths.filter(
    (path) => !isReceiptPath(path) && isPathInsideBoundary(path, workspaceRoot)
  );
  const rank = (path: string) => (isMolecularView(path) ? 0 : getStructureFileFormat(path) ? 1 : 2);
  candidates.sort((left, right) => rank(left) - rank(right));
  let lastReason = 'No imported file has a supported application view.';
  for (const path of candidates) {
    const opened = await deps.openDocument({
      target: { kind: 'file', path },
      label: job.label?.trim() || job.toolId,
      placement: { kind: 'smart' },
    });
    if (opened.status === 'presented') return opened;
    if ('message' in opened && opened.message) lastReason = opened.message;
  }
  throw new Error(lastReason);
}
