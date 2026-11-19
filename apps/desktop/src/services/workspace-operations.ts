import {
  captureProjectLifecycle,
  observeProjectLifecyclePhase,
} from '../features/workspace-loader/workspace-telemetry';

import { waitForNativeFileDocumentReadiness } from '../features/workspace/public/file-document-client';
import { migrateDatabaseOnlyNotebooksForWorkspace } from '../db/workspace-artifacts';
import { findWorkspaceRootForPath } from '../db/workspace-catalog';
import { recordWorkspaceIndex } from '../features/workspace-loader/workspace-telemetry';
import { notifyGitStatusChanged } from '../hooks/useGitStatus';
import { stripTrailingSep } from '../shared/path-boundary';
import { isDeveloperImportSourcePath } from '../shared/developer-import-sources';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { isBrowserOnly } from '../utils/environment';
import {
  reconcileMountedWorkspaceRoot,
  type MountedWorkspaceReconcileResult,
} from './mounted-workspace-reconcile';
import {
  deliverWorkspaceDisplayOutcome,
  type WorkspaceDisplayOutcome,
} from './workspace-display-participants';
import { throwInjectedWorkspaceOperationFailure } from './workspace-operation-test-injection';
import { runTrackedWorkspaceReconcile } from './workspace-reconcile-lifecycle';
import {
  reportEntityReconcileConflicts,
  reportPrimerReconcileFailures,
} from './workspace-reconcile-report';
import { notifyWorkspaceReconciled } from './workspace-reconciled-event';
import type { ManagedSequenceDocumentRef } from '../shared/managed-sequence-document';

export type WorkspaceDisplayDelivery = 'required' | 'optional';

interface WorkspaceReconcileOperationContext {
  workspaceRoot: string;

  operationId?: string;

  mutationToken?: string;
  signal?: AbortSignal;

  assertCurrent?(): void;

  strict: boolean;
  healManagedHead: boolean;

  pendingSequenceDocument?: ManagedSequenceDocumentRef;

  displayDelivery: WorkspaceDisplayDelivery;

  filesChanged?: { revealPath?: string | null; notifyGitStatus?: boolean };
}

export type WorkspaceReconcileOperationInput = WorkspaceReconcileOperationContext &
  (
    | { catalogSource: 'head'; healManagedHead: boolean }
    | { catalogSource: 'working-tree'; healManagedHead: false }
  );

export type { WorkspaceDisplayOutcome } from './workspace-display-participants';

export interface WorkspaceReconcileOperationResult {
  operationId: string;
  workspaceRoot: string;
  durable: MountedWorkspaceReconcileResult;
  display: WorkspaceDisplayOutcome;
}

export class WorkspaceDisplayDeliveryError extends Error {
  override readonly name = 'WorkspaceDisplayDeliveryError';
  constructor(
    readonly operationId: string,
    readonly workspaceRoot: string,
    readonly durable: MountedWorkspaceReconcileResult,
    readonly errors: readonly unknown[]
  ) {
    super(`Required display delivery failed for ${workspaceRoot}: ${describeError(errors[0])}`);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function newOperationId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

export function resolveReconcileWorkspaceRoot(
  explicitRoot: string | null | undefined,
  path: string | null | undefined
): string | null {
  const store = useWorkspaceStore.getState();
  const workspaceRoot = explicitRoot ?? findWorkspaceRootForPath(store.folders, path ?? null);
  if (!workspaceRoot) {
    store.bumpFileTreeRefresh();
    return null;
  }
  return isBrowserOnly() ? null : workspaceRoot;
}

export async function runWorkspaceReconcileOperation(
  rawInput: WorkspaceReconcileOperationInput
): Promise<WorkspaceReconcileOperationResult> {
  const input = { ...rawInput, workspaceRoot: stripTrailingSep(rawInput.workspaceRoot) };
  const operationId = input.operationId ?? newOperationId('workspace-reconcile');
  const durable = await runTrackedWorkspaceReconcile(
    input.workspaceRoot,
    () => reconstructDurably(input),
    { ordered: !input.mutationToken }
  );
  return completeOperation(operationId, input, durable);
}

export async function reconcileWorkspaceOnMount(
  rawWorkspaceRoot: string,
  options: { signal?: AbortSignal } = {}
): Promise<WorkspaceReconcileOperationResult> {
  const workspaceRoot = stripTrailingSep(rawWorkspaceRoot);
  const folder = useWorkspaceStore
    .getState()
    .folders.find((entry) => stripTrailingSep(entry.path) === workspaceRoot);
  const input: WorkspaceReconcileOperationInput = {
    workspaceRoot,
    signal: options.signal,
    strict: false,
    catalogSource: 'head',
    healManagedHead: !folder?.pinned,
    displayDelivery: 'optional',
  };
  const durable = await runTrackedWorkspaceReconcile(workspaceRoot, async () => {
    if (!input.healManagedHead || isDeveloperImportSourcePath(workspaceRoot))
      return reconstructDurably(input);
    await waitForNativeFileDocumentReadiness();
    options.signal?.throwIfAborted();
    const notebookMigration = await migrateDatabaseOnlyNotebooksForWorkspace(workspaceRoot);
    if (notebookMigration.failed.length > 0) {
      console.warn(
        `[WorkspaceOperations] Automatic notebook materialization deferred for ${notebookMigration.failed.length} record(s); source rows remain intact and a later mount will retry:`,
        notebookMigration.failed
      );
    }
    return reconstructDurably(input);
  });
  const healed = (durable.result.healedFileCount ?? 0) > 0;
  return completeOperation(
    newOperationId('workspace-mount'),
    healed ? { ...input, filesChanged: {} } : input,
    durable
  );
}

export function reconcileWorkspaceAfterFilesChanged(
  input: Pick<
    WorkspaceReconcileOperationInput,
    'workspaceRoot' | 'mutationToken' | 'assertCurrent'
  > & {
    revealPath?: string | null;

    strict?: boolean;

    healManagedHead?: boolean;

    notifyGitStatus?: boolean;
  }
): Promise<WorkspaceReconcileOperationResult> {
  return runWorkspaceReconcileOperation({
    workspaceRoot: input.workspaceRoot,
    mutationToken: input.mutationToken,
    assertCurrent: input.assertCurrent,
    strict: input.strict ?? false,
    catalogSource: 'head',
    healManagedHead: input.healManagedHead ?? true,
    displayDelivery: 'optional',
    filesChanged: {
      revealPath: input.revealPath ?? null,
      notifyGitStatus: input.notifyGitStatus ?? false,
    },
  });
}

async function reconstructDurably(
  input: WorkspaceReconcileOperationInput
): Promise<MountedWorkspaceReconcileResult> {
  const { workspaceRoot } = input;
  const projectLifecycle = captureProjectLifecycle(workspaceRoot);
  assertStillCurrent(input);
  if (input.filesChanged?.notifyGitStatus) notifyGitStatusChanged(workspaceRoot);
  throwInjectedWorkspaceOperationFailure('reconstruction', workspaceRoot);
  const durable = await reconcileMountedWorkspaceRoot(workspaceRoot, {
    signal: input.signal,
    mutationToken: input.mutationToken,
    healManagedHead: input.healManagedHead,
    ...(input.catalogSource === 'working-tree' ? { catalogSource: input.catalogSource } : {}),
    strict: input.strict,
    waitForMutationAvailability: true,
    ...(input.pendingSequenceDocument
      ? { pendingSequenceDocument: input.pendingSequenceDocument }
      : {}),
  }).catch((error) => {
    observeProjectLifecyclePhase(workspaceRoot, projectLifecycle, 'index_failed');
    throw error;
  });
  assertStillCurrent(input);
  recordWorkspaceIndex(workspaceRoot, durable.result.visibleFileCount ?? durable.result.scanned);
  observeProjectLifecyclePhase(workspaceRoot, projectLifecycle, 'indexed');
  reportPrimerReconcileFailures(workspaceRoot, durable.result);
  reportEntityReconcileConflicts(workspaceRoot, durable.entityResult);
  if (durable.entityResult.reconciled > 0 || durable.entityResult.conflicts > 0) {
    console.log(
      `[WorkspaceOperations] entity reconcile ${workspaceRoot}: ${durable.entityResult.reconciled} rebuilt, ${durable.entityResult.conflicts} conflict(s)`
    );
  }
  return durable;
}

async function completeOperation(
  operationId: string,
  input: WorkspaceReconcileOperationInput,
  durable: MountedWorkspaceReconcileResult
): Promise<WorkspaceReconcileOperationResult> {
  const { workspaceRoot } = input;
  if (input.filesChanged) useWorkspaceStore.getState().bumpFileTreeRefresh();
  notifyWorkspaceReconciled(workspaceRoot);

  const display = await deliverWorkspaceDisplayOutcome({
    workspaceRoot,
    operationId,
    assertCurrent: () => assertStillCurrent(input),
  });
  assertStillCurrent(input);
  if (input.filesChanged?.revealPath) {
    useWorkspaceStore.getState().revealPath(input.filesChanged.revealPath);
  }
  if (display.state === 'failed') {
    if (input.displayDelivery === 'required') {
      throw new WorkspaceDisplayDeliveryError(operationId, workspaceRoot, durable, display.errors);
    }
    console.warn(
      `[WorkspaceOperations] ${display.errors.length} display participant(s) could not refresh after ${operationId}; durable records are complete:`,
      display.errors
    );
  }
  return { operationId, workspaceRoot, durable, display };
}

function assertStillCurrent(input: WorkspaceReconcileOperationInput): void {
  input.signal?.throwIfAborted();
  input.assertCurrent?.();
}
