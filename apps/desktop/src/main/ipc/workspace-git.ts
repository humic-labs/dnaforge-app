import { listWorkspaceRootStatus, relinkWorkspaceRoot } from '../workspace-root-recovery';
import { acquireWorkspaceSyncMutationLease } from '../workspace-sync-mutation-lease';
import { assertWorkspaceMigrationActionsSettled } from '../workspace-migration-admission';
import { recoverLegacyPrimerLibraryInMain } from '../legacy-primer-library-recovery';
import { nativeDocuments } from '../features/native-documents';
import { originalProjectContract } from '../../shared/ipc/original-project.contract';

import { handleGroup, mainIpc, sendRendererIpc } from '../../shared/ipc-contract';
import { looseSequenceFilesContract } from '../../shared/ipc/loose-sequence-files.contract';
import { app } from 'electron';
import { resolveAppCreatedSampleWorkspaceSource } from '../sample-workspaces/factory';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  MANAGED_WORKSPACE_MARKER,
  BENCHLING_MIGRATION_WORKSPACE_MARKER,
} from '../../shared/workspace-git-types';
import { basename, dirname, join } from 'node:path';
import { assertSafePath, withSafeWritablePath, withSafeWritablePaths } from './path-allowlist';
import { resolveSelectedLocalFilePath } from '../local-indexed-track-authority';
import { getDb } from './database';
import {
  identifyOriginalDefaultProject,
  resolveOriginalDefaultProject,
} from '../original-default-project';
import type {
  IdentifyOriginalDefaultProjectRequest,
  OriginalDefaultProjectResolution,
} from '../../shared/first-project';
import { catalogSequenceIdForPath } from '../catalog-package-identity';
import { materializeLimsGlobalRegistryExportInDb } from '../lims-git-export';
import {
  createEmptyManagedWorkspace,
  importFileAsNewManagedWorkspace,
  importContentIntoWorkspaceRoot,
  importFileIntoWorkspaceRoot,
  importFolderIntoWorkspaceRoot,
  importIntoManagedWorkspaceRepo,
  importSequenceContentIntoWorkspaceRoot,
  type ImportProgressUpdate,
} from '../workspace-git/import';
import {
  collectManagedCatalogHeadIndex,
  collectManagedHeadIndex,
  collectWorkspaceEntityMigrations,
} from '../workspace-git/head-index';
import {
  convertLooseSequenceFile,
  inspectLooseSequenceFile,
} from '../workspace-git/convert-tree-to-packages';
import {
  withManagedWorkspaceMutationLock,
  resolveHeadCommit,
  commitOwnedPathsIfDirty,
  hasActiveQuickLookPromotion,
} from '../workspace-git';
import { previewImportDedup } from '../workspace-git/import-dedup-preview';
import { previewImportedSequencePackages } from '../workspace-git/sequence-package-import';
import {
  registerImportedSequenceFile,
  registerImportedSequenceFromContent,
  type RegisterImportedSequenceFromContentRequest,
  type RegisterImportedSequenceRequest,
} from '../lims-register-import';
import { purgeTrashedWorkspaceByUuid } from '../workspace-git/trash';
import {
  renameManagedWorkspace,
  transitionManagedWorkspaceLifecycle,
} from '../workspace-git/lifecycle';
import { discoverWorkspaceArtifacts } from '../workspace-artifact-discovery';
import type {
  CreateEmptyWorkspaceRequest,
  CreateEmptyWorkspaceResult,
  ImportContentRequest,
  ImportFileRequest,
  ImportManagedWorkspaceRequest,
  ImportSequenceContentRequest,
  ManagedWorkspaceLargeFile,
  ManagedWorkspaceLargeFilePolicy,
  SequenceImportPreviewRequest,
  ManagedCatalogHeadIndexRequest,
  WorkspaceArtifactDiscoveryRequest,
  ManagedWorkspaceLifecycleRequest,
  ManagedWorkspaceRenameRequest,
} from '../../shared/workspace-git-types';
import {
  withDeclaredWorkspaceMutation,
  workspaceMutationRootIdentity,
} from '../workspace-sync-mutation-lease';
import {
  captureSequenceMigrationAdmission,
  canAutomaticallyMigrateWorkspace,
} from '../workspace-git/sequence-migration-admission';
import { withDeclaredRendererWorkspaceMutation } from './workspace-mutation-authority';
import { validateManagedCatalogHeadIndexRequest } from '../../shared/managed-catalog-head-request';
import {
  largeFileImportDialogResponseChannel,
  type LargeFileImportDialogResponse,
} from '../../shared/large-file-import-dialog';
import { workspaceContract } from '../../shared/ipc/workspace.contract';
import { admitProjectRootInMain, resolveProjectRootInMain } from '../project-filesystem-authority';
import { isPathInsideBoundary } from '../../shared/path-boundary';
import { withRendererDatabaseStatementWhenReady } from '../workspace-sync-database-fence';

export function emptyWorkspaceRootDir(): string {
  return join(app.getPath('userData'), 'empty-workspaces');
}

export function sanitizeEmptyWorkspaceName(name: string | undefined): string {
  const cleaned = (name ?? '').replace(/[\\/\s]+/g, ' ').trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : 'Untitled workspace';
}

const IMPORT_PROGRESS_THROTTLE_MS = 100;

export function managedRootDir(): string {
  return join(app.getPath('userData'), 'managed-workspaces');
}

function materializeGlobalLimsRegistryAfterSequenceImport(registered: boolean): void {
  if (!registered) return;
  try {
    materializeLimsGlobalRegistryExportInDb(
      getDb(),
      join(app.getPath('userData'), 'lims-registry')
    );
  } catch (err) {
    console.warn(`[LIMS] global registry export after sequence import failed: ${String(err)}`);
  }
}

async function resolveSequenceImportSource(sourcePath: string): Promise<string> {
  try {
    return await assertSafePath(sourcePath);
  } catch (error) {
    try {
      return resolveSelectedLocalFilePath(sourcePath);
    } catch {
      throw error;
    }
  }
}

function createCleanMigrationPaths() {
  let flushed: Promise<void> | undefined;
  return async <T>(paths: readonly string[], operation: () => Promise<T>): Promise<T> => {
    flushed ??= nativeDocuments.flushDirtyDocumentClients();
    await flushed;
    return nativeDocuments.fileDocuments.withCleanPaths(paths, operation);
  };
}

export function registerWorkspaceGitHandlers(): void {
  handleGroup(looseSequenceFilesContract, {
    inspect: async (_event, request) => {
      const workspaceRoot = await assertSafePath(request.workspaceRoot, { requireAbsolute: true });
      const sourceDir = await assertSafePath(dirname(request.sourcePath), {
        requireAbsolute: true,
      });
      return inspectLooseSequenceFile(workspaceRoot, join(sourceDir, basename(request.sourcePath)));
    },
    convert: async (_event, request) =>
      withSafeWritablePaths(
        [
          { path: request.workspaceRoot, options: { requireAbsolute: true } },
          { path: dirname(request.sourcePath), options: { requireAbsolute: true } },
        ],
        ([workspaceRoot, sourceDir]) => {
          const sourcePath = join(sourceDir, basename(request.sourcePath));
          return withDeclaredWorkspaceMutation(
            getDb(),
            workspaceRoot,
            [workspaceRoot, sourcePath],
            () =>
              withManagedWorkspaceMutationLock(workspaceRoot, async () => {
                const db = getDb();
                const admission = captureSequenceMigrationAdmission(db, workspaceRoot, {
                  requireWritable: true,
                });
                if (request.automatic && admission.workspaceId === null)
                  throw new Error('Automatic conversion requires an active owning project.');
                const managed = [
                  MANAGED_WORKSPACE_MARKER,
                  BENCHLING_MIGRATION_WORKSPACE_MARKER,
                ].some((marker) => existsSync(join(workspaceRoot, marker)));
                const expectedHead =
                  request.automatic && managed ? await resolveHeadCommit(workspaceRoot) : null;
                if (request.automatic && hasActiveQuickLookPromotion(workspaceRoot))
                  return {
                    converted: false,
                    packageRoots: [],
                    reason: 'This project is not ready to convert the file. It was left unchanged.',
                    disposition: 'blocked' as const,
                  };
                const result = await convertLooseSequenceFile(workspaceRoot, sourcePath, {
                  ...(request.automatic ? admission : {}),
                  automatic: request.automatic,
                  confirmedDnaSourceSha256: request.confirmedDnaSourceSha256,
                  confirmedNucleicAcid: request.confirmedNucleicAcid,
                  confirmedRecoverySourceSha256: request.confirmedRecoverySourceSha256,
                  packageIdForPath: (path) => catalogSequenceIdForPath(db, path),
                  withCleanPaths: createCleanMigrationPaths(),
                });
                if (request.automatic && result.converted && expectedHead) {
                  admission.assertCurrent();
                  const paths = result.mutatedGitFiles ?? [];
                  await commitOwnedPathsIfDirty(
                    workspaceRoot,
                    'reconcile: migrate opened sequence',
                    {
                      expectedHead,
                      paths,
                      forceInclude: paths,
                      expectedContentSha256: result.expectedContentSha256,
                    }
                  );
                }
                return {
                  converted: result.converted,
                  packageRoots: result.packageRoots,
                  reason: result.reason,
                  disposition: result.disposition,
                };
              })
          );
        }
      ),
  });
  handleGroup(workspaceContract, {
    migrateLegacyProjectFiles: async (event, request) =>
      withSafeWritablePath(
        request.repoPath,
        (repoPath) =>
          withDeclaredRendererWorkspaceMutation({
            db: getDb(),
            ownerId: event.sender.id,
            workspaceRoot: repoPath,
            mutationPaths: [repoPath],
            mutationToken: request.mutationToken,
            operation: () =>
              withManagedWorkspaceMutationLock(repoPath, async () => {
                const db = getDb();
                const admission = captureSequenceMigrationAdmission(db, repoPath, {
                  requireWritable: true,
                });
                if (admission.workspaceId === null)
                  throw new Error('Automatic migration requires an active owning project.');
                const migrated = await collectWorkspaceEntityMigrations(repoPath, {
                  ...admission,
                  packageIdForPath: (path) => catalogSequenceIdForPath(db, path),
                  withCleanPaths: createCleanMigrationPaths(),
                });
                return {
                  healedFileCount: migrated.healedFileCount,
                  migrationIssues: migrated.migrationIssues,
                };
              }),
          }),
        { requireAbsolute: true }
      ),
    rootStatus: async () => listWorkspaceRootStatus(getDb()),
    relinkRoot: async (_event, request) => {
      await assertSafePath(request.selectedPath);
      const release = await acquireWorkspaceSyncMutationLease(request.repoPath);
      try {
        await assertWorkspaceMigrationActionsSettled(request.repoPath);
        await assertWorkspaceMigrationActionsSettled(request.selectedPath);
        const blocker = await nativeDocuments.fileDocuments.rootRelinkBlocker(request.repoPath);
        if (blocker) return { status: 'rejected' as const, reason: blocker };
        return await nativeDocuments.fileDocuments.withCleanPaths(
          [request.repoPath, request.selectedPath],
          async () => relinkWorkspaceRoot(getDb(), request)
        );
      } catch (error) {
        if (error instanceof Error && /^DIRTY_(FILE_DRAFT|NOTEBOOK|SEQUENCE)/.test(error.message))
          return { status: 'rejected' as const, reason: 'unsaved-document' as const };
        throw error;
      } finally {
        release();
      }
    },
    recoverLegacyPrimerLibrary: async () => {
      const db = getDb();
      return recoverLegacyPrimerLibraryInMain({
        db,
        profileDirectory: app.getPath('userData'),
        managedRootDir: managedRootDir(),
        assertCurrent: () => {
          if (getDb() !== db)
            throw new Error('The application profile changed during primer recovery.');
        },
      });
    },
    resolveProjectRoot: async (event, request) => {
      const db = getDb();
      return resolveProjectRootInMain(request, {
        db,
        managedRootDir: managedRootDir(),
        protectedAppDataRoot: app.getPath('userData'),
        runDatabase: (operation) =>
          withRendererDatabaseStatementWhenReady(db, event.sender, () => {
            if (getDb() !== db)
              throw new Error('The application profile changed while opening the project.');
            return operation();
          }),
      });
    },
    importManaged: async (event, request: ImportManagedWorkspaceRequest) => {
      const sourcePath = await assertSafePath(request.sourcePath, { requireAbsolute: true });
      const sampleSource = await resolveAppCreatedSampleWorkspaceSource(sourcePath);
      if (
        isPathInsideBoundary(sourcePath, workspaceMutationRootIdentity(app.getPath('userData'))) &&
        !sampleSource
      )
        await admitProjectRootInMain(sourcePath, {
          db: getDb(),
          managedRootDir: managedRootDir(),
          protectedAppDataRoot: app.getPath('userData'),
        });
      return importIntoManagedWorkspaceRepo(sourcePath, {
        db: getDb(),
        managedRootDir: managedRootDir(),
        displayName: request.displayName?.trim() || sampleSource?.displayName,
        largeFilePolicy: request.largeFilePolicy,
        resolveLargeFilePolicy: (files, thresholdBytes) =>
          promptForLargeFilePolicy(files, thresholdBytes, event.sender),
        onProgress: makeImportProgressSink(event.sender, request.importId),
      });
    },
    createEmptyWorkspace: async (
      _event,
      request: CreateEmptyWorkspaceRequest
    ): Promise<CreateEmptyWorkspaceResult> => {
      const displayName = sanitizeEmptyWorkspaceName(request?.name);
      const managed = await createEmptyManagedWorkspace(
        displayName,
        {
          db: getDb(),
          managedRootDir: managedRootDir(),
        },
        { originalDefaultProject: request?.originalDefaultProject === true ? true : undefined }
      );
      return {
        rootPath: managed.repoPath,
        displayName: managed.displayName,
        createdAt: managed.createdAt,
      };
    },
    importFile: async (_event, request: ImportFileRequest) => {
      await assertSafePath(request.sourcePath);
      return withSafeWritablePath(request.targetRoot, (targetRoot) =>
        withDeclaredWorkspaceMutation(getDb(), targetRoot, [targetRoot], () =>
          importFileIntoWorkspaceRoot(
            { ...request, targetRoot },
            {
              db: getDb(),
              managedRootDir: managedRootDir(),
            }
          )
        )
      );
    },
    importFileFromContent: async (_event, request: ImportContentRequest) => {
      return withSafeWritablePath(request.targetRoot, (targetRoot) =>
        withDeclaredWorkspaceMutation(getDb(), targetRoot, [targetRoot], () =>
          importContentIntoWorkspaceRoot(
            { ...request, targetRoot },
            {
              db: getDb(),
              managedRootDir: managedRootDir(),
            }
          )
        )
      );
    },
    importSequenceFromContent: async (_event, request: ImportSequenceContentRequest) =>
      withSafeWritablePath(request.targetRoot, (targetRoot) =>
        withDeclaredWorkspaceMutation(getDb(), targetRoot, [targetRoot], () =>
          importSequenceContentIntoWorkspaceRoot(
            { ...request, targetRoot },
            {
              db: getDb(),
              managedRootDir: managedRootDir(),
            }
          )
        )
      ),
    importFolder: async (_event, request: { targetRoot: string; sourcePath: string }) => {
      await assertSafePath(request.sourcePath);
      return withSafeWritablePath(request.targetRoot, (targetRoot) =>
        withDeclaredWorkspaceMutation(getDb(), targetRoot, [targetRoot], () =>
          importFolderIntoWorkspaceRoot(
            { ...request, targetRoot },
            {
              db: getDb(),
              managedRootDir: managedRootDir(),
            }
          )
        )
      );
    },
    importFileAsNewWorkspace: async (_event, request: { sourcePath: string }) => {
      await assertSafePath(request.sourcePath);
      return importFileAsNewManagedWorkspace(request.sourcePath, {
        db: getDb(),
        managedRootDir: managedRootDir(),
      });
    },
    previewImportDedup: async (_event, request: { sourcePaths: string[]; targetRoot: string }) => {
      for (const p of request.sourcePaths) await assertSafePath(p);
      await assertSafePath(request.targetRoot);
      return previewImportDedup(request.sourcePaths, request.targetRoot);
    },
    previewSequenceImport: async (_event, request: SequenceImportPreviewRequest) => {
      const sourcePath = await resolveSequenceImportSource(request.sourcePath);
      return previewImportedSequencePackages(sourcePath, {
        confirmedDnaSourceSha256: request.confirmedDnaSourceSha256,
        confirmedNucleicAcid: request.confirmedNucleicAcid,
      });
    },
    registerImportedSequence: async (_event, request: RegisterImportedSequenceRequest) => {
      const sourcePath = await resolveSequenceImportSource(request.sourcePath);
      return withSafeWritablePath(request.targetRoot, async (targetRoot) => {
        const result = await withDeclaredWorkspaceMutation(getDb(), targetRoot, [targetRoot], () =>
          registerImportedSequenceFile(
            { ...request, sourcePath, targetRoot },
            {
              db: getDb(),
              managedRootDir: managedRootDir(),
            }
          )
        );
        materializeGlobalLimsRegistryAfterSequenceImport(result.registered);
        return result;
      });
    },
    registerImportedSequenceFromContent: async (
      _event,
      request: RegisterImportedSequenceFromContentRequest
    ) => {
      return withSafeWritablePath(request.targetRoot, async (targetRoot) => {
        const result = await withDeclaredWorkspaceMutation(getDb(), targetRoot, [targetRoot], () =>
          registerImportedSequenceFromContent(
            { ...request, targetRoot },
            {
              db: getDb(),
              managedRootDir: managedRootDir(),
            }
          )
        );
        materializeGlobalLimsRegistryAfterSequenceImport(result.registered);
        return result;
      });
    },
    indexManagedHead: async (_event, request: { repoPath: string }) =>
      withSafeWritablePath(
        request.repoPath,
        (repoPath) =>
          withDeclaredWorkspaceMutation(getDb(), repoPath, [repoPath], () => {
            const db = getDb();
            const healWorkingTree = canAutomaticallyMigrateWorkspace(db, repoPath);
            const admission = captureSequenceMigrationAdmission(db, repoPath, {
              requireWritable: healWorkingTree,
            });
            return collectManagedHeadIndex(repoPath, {
              ...admission,
              healWorkingTree,
              ownedMigrationCommit: admission.enrolled,
              packageIdForPath: (path) => catalogSequenceIdForPath(db, path),
              withCleanPaths: createCleanMigrationPaths(),
            });
          }),
        { requireAbsolute: true }
      ),
    indexManagedCatalogHead: async (event, request: ManagedCatalogHeadIndexRequest) => {
      return withSafeWritablePath(
        request.repoPath,
        (repoPath) => {
          validateManagedCatalogHeadIndexRequest(request);
          return withDeclaredRendererWorkspaceMutation({
            db: getDb(),
            ownerId: event.sender.id,
            workspaceRoot: repoPath,
            mutationPaths: [repoPath],
            mutationToken: request.mutationToken,
            operation: () => {
              const db = getDb();
              const healWorkingTree =
                request.healWorkingTree !== false && canAutomaticallyMigrateWorkspace(db, repoPath);
              const admission = captureSequenceMigrationAdmission(db, repoPath, {
                requireWritable: healWorkingTree,
              });

              return collectManagedCatalogHeadIndex(repoPath, request.preserveRelPaths, {
                ...admission,
                healWorkingTree,
                ownedMigrationCommit: admission.enrolled,
                packageIdForPath: (path) => catalogSequenceIdForPath(db, path),
                withCleanPaths: createCleanMigrationPaths(),
              });
            },
          });
        },
        { requireAbsolute: true }
      );
    },
    discoverArtifacts: async (_event, request: WorkspaceArtifactDiscoveryRequest) => {
      await assertSafePath(request.rootPath);
      const admission = captureSequenceMigrationAdmission(getDb(), request.rootPath);
      const result = await discoverWorkspaceArtifacts(request, {
        activeAcceptedPaths: admission.activeAcceptedPaths,
      });
      admission.assertCurrent();
      return result;
    },
    purgeTrashed: async (_event, request: { repoUuid: string }) => {
      const db = getDb();
      const row = db
        .prepare('SELECT path FROM workspaces WHERE repo_uuid = ? AND trashed_at IS NOT NULL')
        .get(request.repoUuid) as { path: string } | undefined;
      if (!row) return { purged: false };
      return nativeDocuments.fileDocuments.withCleanPaths([row.path], () =>
        withSafeWritablePath(dirname(row.path), async () => ({
          purged: await purgeTrashedWorkspaceByUuid(db, managedRootDir(), request.repoUuid),
        }))
      );
    },
    transitionLifecycle: async (_event, request: ManagedWorkspaceLifecycleRequest) => {
      const db = getDb();
      if (request.action.startsWith('archive-') || request.action.startsWith('trash-')) {
        const row = (
          'repoPath' in request
            ? db.prepare('SELECT path FROM workspaces WHERE path=?').get(request.repoPath)
            : db.prepare('SELECT path FROM workspaces WHERE repo_uuid=?').get(request.repoUuid)
        ) as { path: string } | undefined;
        if (row)
          return nativeDocuments.fileDocuments.withCleanPaths([row.path], () =>
            transitionManagedWorkspaceLifecycle(db, request)
          );
      }
      return transitionManagedWorkspaceLifecycle(db, request);
    },
    rename: async (_event, request: ManagedWorkspaceRenameRequest) =>
      renameManagedWorkspace(getDb(), request),
  });

  handleGroup(originalProjectContract, {
    getOriginalDefaultProject: (): OriginalDefaultProjectResolution =>
      resolveOriginalDefaultProject(getDb()),
    identifyOriginalDefaultProject: (
      _event,
      request: IdentifyOriginalDefaultProjectRequest
    ): OriginalDefaultProjectResolution => identifyOriginalDefaultProject(getDb(), request),
  });
}

function makeImportProgressSink(
  sender: Electron.WebContents,
  importId: string | undefined
): ((update: ImportProgressUpdate) => void) | undefined {
  if (!importId) return undefined;
  let lastSentAt = 0;
  let lastStatus: ImportProgressUpdate['status'] | null = null;
  return (update) => {
    const now = Date.now();
    const isThrottleable =
      update.status === 'copying' &&
      update.status === lastStatus &&
      update.filesCopied < update.totalFiles &&
      now - lastSentAt < IMPORT_PROGRESS_THROTTLE_MS;
    if (isThrottleable) return;
    lastSentAt = now;
    lastStatus = update.status;
    if (sender.isDestroyed()) return;
    sendRendererIpc(sender, 'workspace:import-progress', { importId, ...update });
  };
}

async function promptForLargeFilePolicy(
  files: ManagedWorkspaceLargeFile[],
  thresholdBytes: number,
  sender: Electron.WebContents
): Promise<ManagedWorkspaceLargeFilePolicy | 'cancel'> {
  if (sender.isDestroyed()) return 'cancel';

  const requestId = randomUUID();
  const responseChannel = largeFileImportDialogResponseChannel(requestId);

  return new Promise((resolve) => {
    let settled = false;

    const cleanup = (): void => {
      mainIpc.removeListener(responseChannel, onResponse);
      sender.removeListener('destroyed', onDestroyed);
    };
    const settle = (
      policy: ManagedWorkspaceLargeFilePolicy | 'cancel',
      dismissRenderer = false
    ): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (dismissRenderer && !sender.isDestroyed()) {
        try {
          sendRendererIpc(sender, 'workspace:large-file-import-cancel', { requestId });
        } catch {}
      }
      resolve(policy);
    };
    const onResponse = (_event: unknown, response: LargeFileImportDialogResponse): void => {
      if (response.requestId !== requestId) {
        settle('cancel');
        return;
      }
      if (response.policy === 'copy' || response.policy === 'symlink') {
        settle(response.policy);
        return;
      }
      settle('cancel');
    };
    const onDestroyed = (): void => settle('cancel');

    mainIpc.once(responseChannel, onResponse);
    sender.once('destroyed', onDestroyed);

    try {
      sendRendererIpc(sender, 'workspace:large-file-import-request', {
        requestId,
        files,
        thresholdBytes,
      });
    } catch {
      settle('cancel', true);
    }
  });
}
