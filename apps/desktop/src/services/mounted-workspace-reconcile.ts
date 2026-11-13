import { reconcileWorkspaceEntities } from '../db/entity-substrate/reconcile-entities';
import { reconcileAcceptedScientificProjections } from './reconcile-scientific-projections';
import { isDeveloperImportSourcePath } from '../shared/developer-import-sources';
import { isWorkspaceSyncDatabaseBusyError } from '../shared/workspace-sync-errors';
import { gitCommitPaths, gitStatus } from '../features/workspace/public/git';
import { isWorkspaceMutationBusyError } from './workspace-mutation-transaction';
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
      return await withManagedWorkspaceReconcileMutation(
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
    } catch (error) {
      if (!isWorkspaceSyncDatabaseBusyError(error) && !isWorkspaceMutationBusyError(error)) {
        throw error;
      }
      await waitForRetryableAvailability(retryDelayMs, options.signal);
      retryDelayMs = Math.min(retryDelayMs * 2, MAX_DATABASE_BUSY_RETRY_MS);
    }
  }
}
