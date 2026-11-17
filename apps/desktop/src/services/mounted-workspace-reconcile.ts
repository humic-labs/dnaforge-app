import { reconcileWorkspaceEntities } from '../db/entity-substrate/reconcile-entities';
import { reconcileAcceptedScientificProjections } from './reconcile-scientific-projections';
import { isDeveloperImportSourcePath } from '../shared/developer-import-sources';
import { isWorkspaceSyncDatabaseBusyError } from '../shared/workspace-sync-errors';
import { gitCommitPaths, gitStatus } from '../features/workspace/public/git';
import { isWorkspaceMutationBusyError } from './workspace-mutation-transaction';
import { platform } from '../platform';
import { reportEntityMigrationIssues } from './workspace-reconcile-report';
import type { ManagedSequenceDocumentRef } from '../shared/managed-sequence-document';
import {
  reconcileWorkspaceRoot,
  withManagedWorkspaceReconcileMutation,
  type WorkspaceReconcileResult,
  type WorkspaceCatalogSource,
} from './workspace-reconcile';

interface MountedWorkspaceReconcileOptions {
  catalogSource?: WorkspaceCatalogSource;
  signal?: AbortSignal;
  waitForMutationAvailability?: boolean;
  mutationToken?: string;
  healManagedHead?: boolean;
  strict?: boolean;
  pendingSequenceDocument?: ManagedSequenceDocumentRef;
}

export interface MountedWorkspaceReconcileResult {
  result: WorkspaceReconcileResult;
  entityResult: Awaited<ReturnType<typeof reconcileWorkspaceEntities>>;
}

const INITIAL_DATABASE_BUSY_RETRY_MS = 25;
const MAX_DATABASE_BUSY_RETRY_MS = 500;

type ReconcileFailure = Readonly<{ message: string }>;

function findRetryableFailure(
  ...failureGroups: ReadonlyArray<readonly ReconcileFailure[]>
): Error | undefined {
  for (const failures of failureGroups) {
    const failure = failures.find(
      ({ message }) =>
        isWorkspaceSyncDatabaseBusyError(message) ||
        isWorkspaceMutationBusyError(new Error(message))
    );
    if (failure) return new Error(failure.message);
  }
  return undefined;
}

function waitForRetryableAvailability(delayMs: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function reconcileMountedWorkspaceRoot(
  rootPath: string,
  options: MountedWorkspaceReconcileOptions = {}
): Promise<MountedWorkspaceReconcileResult> {
  if (isDeveloperImportSourcePath(rootPath)) {
    return {
      result: await reconcileWorkspaceRoot(rootPath, options),
      entityResult: await reconcileWorkspaceEntities(rootPath, options),
    };
  }
  let retryDelayMs = INITIAL_DATABASE_BUSY_RETRY_MS;
  for (;;) {
    options.signal?.throwIfAborted();
    try {
      let completed = await withManagedWorkspaceReconcileMutation(
        rootPath,
        async (mutationToken, managedRepo) => {
          const accepted = await reconcileAcceptedScientificProjections(rootPath, mutationToken);
          const result = await reconcileWorkspaceRoot(rootPath, {
            signal: options.signal,
            mutationToken,
            ...(options.catalogSource ? { catalogSource: options.catalogSource } : {}),
            healManagedHead: options.healManagedHead,
            strict: options.strict,
            ...(options.pendingSequenceDocument
              ? { pendingSequenceDocument: options.pendingSequenceDocument }
              : {}),
            acceptedPaths: accepted.paths,
            acceptedResourceIds: accepted.resourceIds,
          });
          const catalogBusyFailure = findRetryableFailure(
            result.errors,
            result.primerArtifactErrors
          );
          if (catalogBusyFailure) throw catalogBusyFailure;
          const entityResult = await reconcileWorkspaceEntities(rootPath, {
            signal: options.signal,
            candidatePaths: result.entityArtifactCandidatePaths,
            mutationToken,
            acceptedPaths: accepted.paths,
          });
          const entityBusyFailure = findRetryableFailure(entityResult.errors);
          if (entityBusyFailure) throw entityBusyFailure;
          if (options.strict && entityResult.errors.length > 0) {
            throw new Error(
              `Workspace entity reconciliation failed for ${entityResult.errors.length} item(s): ${entityResult.errors
                .slice(0, 3)
                .map((error) => `${error.path}: ${error.message}`)
                .join('; ')}`
            );
          }
          if (options.strict && entityResult.conflicts > 0) {
            const details =
              entityResult.conflictDetails
                ?.slice(0, 3)
                .map(({ path }) => `${path}: file and application content conflict`)
                .join('; ') ?? rootPath;
            throw new Error(
              `Workspace reconstruction has ${entityResult.conflicts} unresolved content conflict(s): ${details}. Both versions are retained; compare the saved file with the open document before retrying.`
            );
          }
          if (managedRepo && options.healManagedHead !== false) {
            options.signal?.throwIfAborted();
            const status = await gitStatus(rootPath, mutationToken);
            const registryPaths = [...status.keys()].filter((path) =>
              path.startsWith('.waypoint/lims/')
            );
            if (registryPaths.length > 0) {
              await gitCommitPaths(
                rootPath,
                'reconcile: capture Registry projections',
                registryPaths,
                mutationToken
              );
            }
          }
          return { result, entityResult };
        },
        options
      );
      const migrate = platform().notebook?.migrateLegacyProjectFiles;
      if (migrate && options.healManagedHead !== false && !options.mutationToken) {
        const owners = await platform().db.select<
          Array<{
            access_mode?: string;
            archived_at?: number | null;
            trashed_at?: number | null;
            access_role?: string | null;
          }>
        >(
          'SELECT w.access_mode,w.archived_at,w.trashed_at,b.access_role FROM workspaces w LEFT JOIN workspace_sync_bindings b ON b.workspace_id=w.id WHERE w.path=?',
          [rootPath]
        );
        const owner = owners.length === 1 ? owners[0] : undefined;
        if (
          owner &&
          owner.access_mode !== 'reference' &&
          owner.access_role !== 'viewer' &&
          owner.archived_at == null &&
          owner.trashed_at == null
        ) {
          options.signal?.throwIfAborted();
          const migration = await migrate({ workspaceRoot: rootPath });
          if (migration.migrated > 0 || migration.gitChanged) {
            const refreshed = await reconcileMountedWorkspaceRoot(rootPath, {
              ...options,
              catalogSource: 'working-tree',
              healManagedHead: false,
            });
            refreshed.result.healedFileCount =
              (completed.result.healedFileCount ?? 0) + migration.migrated;
            refreshed.result.migrationIssues = [
              ...(completed.result.migrationIssues ?? []),
              ...(refreshed.result.migrationIssues ?? []),
            ];
            refreshed.result.errors.unshift(...completed.result.errors);
            completed = refreshed;
          }
          if (migration.issues.length > 0) {
            const issues = migration.issues.map(({ path, reason }) => ({
              path,
              reason,
              kind: 'failed' as const,
            }));
            completed.result.migrationIssues = [
              ...(completed.result.migrationIssues ?? []),
              ...issues,
            ];
            completed.result.errors.push(
              ...issues.map(({ path, reason }) => ({ path, message: reason }))
            );
            reportEntityMigrationIssues(rootPath, completed.result);
            if (options.strict)
              throw new Error(
                `Notebook migration remains incomplete: ${issues
                  .slice(0, 3)
                  .map(({ path, reason }) => `${path}: ${reason}`)
                  .join('; ')}`
              );
          }
        }
      }
      return completed;
    } catch (error) {
      if (!isWorkspaceSyncDatabaseBusyError(error) && !isWorkspaceMutationBusyError(error)) {
        throw error;
      }
      await waitForRetryableAvailability(retryDelayMs, options.signal);
      retryDelayMs = Math.min(retryDelayMs * 2, MAX_DATABASE_BUSY_RETRY_MS);
    }
  }
}
