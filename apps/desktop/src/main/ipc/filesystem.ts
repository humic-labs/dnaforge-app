import { appendProjectMemoryEventInMain } from '../project-memory';
import { sequencePackageFilesystemHandlers } from './sequence-package-filesystem-handlers';
import { resolveRegisteredProjectPath } from '../project-path-identity';
import { assertWorkspaceContentPublicationWritable } from './workspace-content-publication';
import { nativeDocuments } from '../features/native-documents';

import { handleGroup, mainIpc, sendRendererIpc } from '../../shared/ipc-contract';
import { sequenceAlignmentHistoryContract } from '../../shared/ipc/sequence-alignment-history.contract';
import { app, BrowserWindow } from 'electron';

import { assertKnownWorkspaceContentWritable } from '../workspace-content-write-access';
import { createHash } from 'node:crypto';
import { assertWorkspaceMigrationActionsSettled } from '../workspace-migration-admission';
import {
  open,
  readFile,
  writeFile,
  readdir,
  mkdir,
  lstat,
  stat,
  access,
  rename,
  cp,
  rm,
} from 'fs/promises';
import { createReadStream, watch, watchFile, unwatchFile, type FSWatcher } from 'fs';
import { basename, isAbsolute, join } from 'path';
import { HARD_CAP_BYTES, OversizedFileError } from '../../shared/oversized-guard';
import { planMoveIntoDirectory } from '../move-path';
import { assertSafePath, withSafeWritablePath, withSafeWritablePaths } from './path-allowlist';
import { createRegisteredSequencePackagePublicationContext } from '../sequence-package-registry-publication';
import { acquireQuickLookRendererMutationLease } from '../workspace-git';
import {
  validateWorkspacePathInMain,
  writeWorkspaceBinaryFileAtomicInMain,
  writeWorkspaceTextFileAtomicInMain,
} from '../primer-artifact-files';
import type {
  WorkspacePathValidationInput,
  WorkspaceBinaryFileAtomicWriteInput,
  WorkspaceTextFileAtomicWriteInput,
} from '../../shared/workspace-file-atomic';
import { readFileBoundedFromHandle } from './bounded-file-read';
import { readAdmittedTextFile } from './admitted-text-file-read';
import {
  MAX_WORKSPACE_BINARY_WRITE_BYTES,
  serializeWorkspaceTextFileAtomicWriteFailure,
} from '../../shared/workspace-file-atomic';
import { packageScratchCapabilities } from './package-scratch-capability';
import { workspaceMutationCapabilities } from './workspace-mutation-capability';
import { RendererOwnerLifecycle } from '../renderer-owner-lifecycle';
import {
  withDeclaredRendererWorkspaceMutation,
  withDeclaredRendererFilesystemMutation,
  withKnownRendererFilesystemMutation,
  assertUnversionedRendererFilesystemMutationAllowed,
} from './workspace-mutation-authority';
import { assertEnrolledPrimerPathMutationAllowed } from '../primer-artifact-mutation-guard';
import { contentHashInMain } from '../content-hash';
import { writeTextFileAtomicInMain } from '../text-file-atomic';
import { assertWorkspaceWriteAllowed } from '../workspace-write-admission';
import {
  assertTextFileAtomicWriteInput,
  type TextFileAtomicWriteInput,
} from '../../shared/text-file-atomic';
import { recoverNativeCatalogRecordPublications } from '../native-catalog-record-mutations';
import {
  assertCommittedDatabaseReadAllowed,
  withRendererDatabaseStatement,
} from '../workspace-sync-database-fence';
import { FileWatchConsumers } from './file-watch-consumers';
import {
  acquireWorkspaceMutationShared,
  waitForWorkspaceMutationShared,
  findKnownWorkspaceRoot,
  withWorkspaceMutation,
  workspaceMutationRootIdentity,
} from '../workspace-sync-mutation-lease';
import { createPackageScratchRecoveryCallbacks } from '../workspace-sync-package-recovery';
import {
  migrateNotebookPackageAtPathInMain,
  prepareNotebookPackageRenameInMain,
  publishNotebookPackageV2InMain,
  recoverNotebookPackageRenameIfNeededInMain,
} from '../notebook-package-authority';
import type {
  MigrateNotebookPackageAtPathInput,
  PrepareNotebookPackageRenameInput,
  RecoverNotebookPackageRenameInput,
  SerializablePublishNotebookPackageInput,
} from '../../db/notebook-package-migration';

import { packageRootForLockedSequenceMarkerReplace } from '../sequence-package-marker-lock';

import { withRecoveredSequencePackageMutationInMain } from '../sequence-package-revision-publication';

import { publishSequenceAlignmentHistoryInMain } from '../sequence-package-evidence-publication';
import type { PublishSequenceAlignmentHistoryRequest } from '../../shared/sequence-package-evidence';
import { fsContract } from '../../shared/ipc/fs.contract';

export function registerFilesystemHandlers(): void {
  const sequenceDocumentSubscribers = new Map<
    number,
    { sender: Electron.WebContents; ids: Set<string> }
  >();
  nativeDocuments.sequenceDocuments.subscribe((snapshot) => {
    for (const [id, subscription] of sequenceDocumentSubscribers) {
      if (subscription.sender.isDestroyed()) {
        sequenceDocumentSubscribers.delete(id);
        continue;
      }
      if (subscription.ids.has(snapshot.documentId))
        sendRendererIpc(subscription.sender, 'fs:sequenceDocumentChanged', snapshot);
    }
  });
  const fileDocumentSubscribers = new Map<
    number,
    { sender: Electron.WebContents; paths: Set<string>; ids: Map<string, string> }
  >();
  const dirtyDocumentSubscribers = new Map<number, Electron.WebContents>();
  nativeDocuments.fileDocuments.subscribe((snapshot) => {
    for (const [id, sender] of dirtyDocumentSubscribers) {
      if (sender.isDestroyed()) dirtyDocumentSubscribers.delete(id);
      else sendRendererIpc(sender, 'fs:dirtyDocumentsChanged');
    }
    for (const [id, subscription] of fileDocumentSubscribers) {
      if (subscription.sender.isDestroyed()) {
        fileDocumentSubscribers.delete(id);
        continue;
      }
      if (subscription.paths.has(snapshot.path) || subscription.ids.has(snapshot.documentId)) {
        const previousPath = subscription.ids.get(snapshot.documentId);
        if (previousPath && previousPath !== snapshot.path) subscription.paths.delete(previousPath);
        subscription.ids.set(snapshot.documentId, snapshot.path);
        subscription.paths.add(snapshot.path);
        sendRendererIpc(subscription.sender, 'fs:fileDocumentChanged', snapshot);
      }
    }
  });
  const pendingMutationWaits = new WeakMap<Electron.WebContents, Map<string, AbortController>>();
  const maxPendingMutationWaitsPerRenderer = 16;
  const mutationRendererLifecycle = new RendererOwnerLifecycle(
    (sender) => {
      for (const controller of pendingMutationWaits.get(sender)?.values() ?? []) {
        controller.abort();
      }
      pendingMutationWaits.delete(sender);
      workspaceMutationCapabilities.releaseOwner(sender.id);
      void packageScratchCapabilities.releaseOwner(sender.id).catch((error: unknown) => {
        console.error('[filesystem] failed to settle abandoned package scratch:', error);
      });
    },
    () => new Error('WORKSPACE_MUTATION_RENDERER_GONE')
  );

  mainIpc.handle(
    'fs:writeWorkspaceBinaryFileAtomic',
    async (event, input: WorkspaceBinaryFileAtomicWriteInput) => {
      try {
        if (!(input.content instanceof Uint8Array)) {
          throw new Error('Binary workspace content must be a Uint8Array.');
        }
        if (input.content.byteLength > MAX_WORKSPACE_BINARY_WRITE_BYTES) {
          throw new Error(
            `Binary workspace content exceeds ${MAX_WORKSPACE_BINARY_WRITE_BYTES} bytes.`
          );
        }
        const workspaceRoot = await assertSafePath(input.workspaceRoot);
        const { getDb } = await import('./database');
        const db = getDb();
        assertWorkspaceContentPublicationWritable(db, event, workspaceRoot);
        return await withSafeWritablePath(input.path, (path) =>
          withDeclaredRendererFilesystemMutation({
            fileWrite: true,
            db,
            ownerId: event.sender.id,
            workspaceRoot,
            mutationPaths: [path],
            mutationToken: input.mutationToken,
            operation: async () => {
              assertWorkspaceContentPublicationWritable(db, event, workspaceRoot);
              return {
                ok: true as const,
                result: await writeWorkspaceBinaryFileAtomicInMain(
                  { ...input, workspaceRoot, path },
                  {
                    beforePublish: () =>
                      assertWorkspaceContentPublicationWritable(db, event, workspaceRoot),
                  }
                ),
              };
            },
          })
        );
      } catch (error) {
        return serializeWorkspaceTextFileAtomicWriteFailure(error);
      }
    }
  );

  mainIpc.handle(
    'fs:writeWorkspaceTextFileAtomic',
    async (event, input: WorkspaceTextFileAtomicWriteInput) => {
      try {
        const workspaceRoot = await assertSafePath(input.workspaceRoot);
        const { getDb } = await import('./database');
        const db = getDb();
        const assertCurrent = () =>
          assertWorkspaceContentPublicationWritable(db, event, workspaceRoot);
        assertCurrent();
        return await withSafeWritablePath(input.path, (path) =>
          withDeclaredRendererFilesystemMutation({
            fileWrite: true,
            db,
            ownerId: event.sender.id,
            workspaceRoot,
            mutationPaths: [path],
            mutationToken: input.mutationToken,
            operation: async () => {
              assertCurrent();
              const write = () =>
                writeWorkspaceTextFileAtomicInMain(
                  { ...input, workspaceRoot, path },
                  {
                    beforePublish: () => {
                      assertCurrent();
                      withRendererDatabaseStatement(db, event.sender, () =>
                        assertEnrolledPrimerPathMutationAllowed(db, [path])
                      );
                    },
                  }
                );
              const sequencePackageRoot = packageRootForLockedSequenceMarkerReplace(
                workspaceRoot,
                path,
                input.mode
              );
              return {
                ok: true as const,
                result: sequencePackageRoot
                  ? await withRecoveredSequencePackageMutationInMain(
                      workspaceRoot,
                      sequencePackageRoot,
                      write,
                      createRegisteredSequencePackagePublicationContext({
                        db,
                        runDatabase: (work) =>
                          withRendererDatabaseStatement(db, event.sender, work),
                      })
                    )
                  : await write(),
              };
            },
          })
        );
      } catch (error) {
        return serializeWorkspaceTextFileAtomicWriteFailure(error);
      }
    }
  );

  mainIpc.handle(
    'fs:publishNotebookPackageV2',
    async (event, input: SerializablePublishNotebookPackageInput) => {
      const workspaceRoot = await assertSafePath(input.workspaceRoot, { requireAbsolute: true });
      const { getDb } = await import('./database');
      const db = getDb();
      assertWorkspaceContentPublicationWritable(db, event, workspaceRoot);
      return withSafeWritablePath(input.packageRoot, (packageRoot) =>
        withDeclaredRendererFilesystemMutation({
          fileWrite: true,
          db,
          ownerId: event.sender.id,
          workspaceRoot,
          mutationPaths: [packageRoot],
          mutationToken: input.mutationToken,
          operation: async () => {
            assertWorkspaceContentPublicationWritable(db, event, workspaceRoot);
            return publishNotebookPackageV2InMain({ ...input, workspaceRoot, packageRoot }, () =>
              assertWorkspaceContentPublicationWritable(db, event, workspaceRoot)
            );
          },
        })
      );
    }
  );

  mainIpc.handle(
    'fs:migrateNotebookPackageAtPath',
    async (event, input: MigrateNotebookPackageAtPathInput) => {
      const workspaceRoot = await assertSafePath(input.workspaceRoot, { requireAbsolute: true });
      const { getDb } = await import('./database');
      return withSafeWritablePath(
        input.packageRoot,
        (packageRoot) =>
          withDeclaredRendererFilesystemMutation({
            fileWrite: true,
            db: getDb(),
            ownerId: event.sender.id,
            workspaceRoot,
            mutationPaths: [packageRoot],
            mutationToken: input.mutationToken,
            operation: () =>
              migrateNotebookPackageAtPathInMain({ ...input, workspaceRoot, packageRoot }),
          }),
        { requireAbsolute: true }
      );
    }
  );

  mainIpc.handle(
    'fs:prepareNotebookPackageRename',
    async (event, input: Omit<PrepareNotebookPackageRenameInput, 'now'>) => {
      const workspaceRoot = await assertSafePath(input.workspaceRoot, { requireAbsolute: true });
      const { getDb } = await import('./database');
      const db = getDb();
      assertWorkspaceContentPublicationWritable(db, event, workspaceRoot);
      return withSafeWritablePaths(
        [{ path: input.packageRoot }, { path: input.nextPackageRoot }],
        ([packageRoot, nextPackageRoot]) =>
          withDeclaredRendererFilesystemMutation({
            fileWrite: true,
            db,
            ownerId: event.sender.id,
            workspaceRoot,
            mutationPaths: [packageRoot, nextPackageRoot],
            mutationToken: input.mutationToken,
            operation: async () => {
              assertWorkspaceContentPublicationWritable(db, event, workspaceRoot);
              return prepareNotebookPackageRenameInMain(
                { ...input, workspaceRoot, packageRoot, nextPackageRoot },
                () => assertWorkspaceContentPublicationWritable(db, event, workspaceRoot)
              );
            },
          })
      );
    }
  );

  mainIpc.handle(
    'fs:recoverNotebookPackageRenameIfNeeded',
    async (event, input: RecoverNotebookPackageRenameInput) => {
      const workspaceRoot = await assertSafePath(input.workspaceRoot, { requireAbsolute: true });
      const { getDb } = await import('./database');
      return withSafeWritablePath(
        input.packageRoot,
        (packageRoot) =>
          withDeclaredRendererFilesystemMutation({
            fileWrite: true,
            db: getDb(),
            ownerId: event.sender.id,
            workspaceRoot,
            mutationPaths: [packageRoot],
            mutationToken: input.mutationToken,
            operation: () =>
              recoverNotebookPackageRenameIfNeededInMain({
                ...input,
                workspaceRoot,
                packageRoot,
              }),
          }),
        { requireAbsolute: true }
      );
    }
  );

  mainIpc.handle(
    'fs:packageSequenceFile',
    async (
      event,
      filePath: string,
      options?: {
        overwritePackageRoot?: string;
        requireConverted?: boolean;
      }
    ) => {
      const safeFilePath = await assertSafePath(filePath);

      const { assertInsideKnownWorkspace, assertSameKnownWorkspaceRoot } =
        await import('../workspace-git/known-workspace-scope');
      const { getDb } = await import('./database');
      const { managedRootDir } = await import('./workspace-git');
      const workspaceScope = {
        db: getDb(),
        managedRootDir: managedRootDir(),
      };
      const sourceWorkspaceRoot = await assertInsideKnownWorkspace(safeFilePath, workspaceScope);
      const safeOverwritePackageRoot = options?.overwritePackageRoot
        ? await assertSafePath(options.overwritePackageRoot, { requireAbsolute: true })
        : undefined;
      if (safeOverwritePackageRoot) {
        const overwriteWorkspaceRoot = await assertInsideKnownWorkspace(
          safeOverwritePackageRoot,
          workspaceScope
        );
        assertSameKnownWorkspaceRoot(sourceWorkspaceRoot, overwriteWorkspaceRoot);
      }
      return withSafeWritablePath(sourceWorkspaceRoot, async () => {
        const { materializeImportedSequencePackages } =
          await import('../workspace-git/sequence-package-import');
        return withWorkspaceMutation(sourceWorkspaceRoot, async () => {
          await assertUnversionedRendererFilesystemMutationAllowed(
            workspaceScope.db,
            event.sender.id,
            [safeFilePath, ...(safeOverwritePackageRoot ? [safeOverwritePackageRoot] : [])]
          );
          const sourceIdentity = options?.requireConverted
            ? await stat(safeFilePath, { bigint: true })
            : null;
          const result = await materializeImportedSequencePackages(safeFilePath, undefined, {
            overwritePackageRoot: safeOverwritePackageRoot,
          });
          if (options?.requireConverted && !result.converted) {
            const currentIdentity = await stat(safeFilePath, { bigint: true }).catch(() => null);
            const isSameSource =
              currentIdentity !== null &&
              sourceIdentity !== null &&
              currentIdentity.dev === sourceIdentity.dev &&
              currentIdentity.ino === sourceIdentity.ino &&
              currentIdentity.size === sourceIdentity.size &&
              currentIdentity.mtimeNs === sourceIdentity.mtimeNs;
            if (isSameSource) {
              await rm(safeFilePath);
            }
            throw new Error(
              `SEQUENCE_PACKAGE_REQUIRED: ${
                result.skippedReason ??
                'The sequence could not be converted to its authoritative package.'
              }`
            );
          }
          return {
            productPath: result.packages[0]?.productPath ?? safeFilePath,
            packageRoots: result.packages.map((pkg) => pkg.packageRoot),
            converted: result.converted,
            skippedReason: result.skippedReason ?? null,
          };
        });
      });
    }
  );

  mainIpc.handle(
    'fs:createPackageScratch',
    async (event, packageRoot: string, mutationToken?: string) => {
      const rendererGeneration = mutationRendererLifecycle.register(event.sender);
      const assertRendererCurrent = (): void =>
        mutationRendererLifecycle.assertCurrent(event.sender, rendererGeneration);
      return withSafeWritablePath(
        packageRoot,
        async (safePackageRoot) => {
          const { assertInsideKnownWorkspace } =
            await import('../workspace-git/known-workspace-scope');
          const { assertExistingPlasmidPackageRoot } =
            await import('../workspace-git/sequence-package-import');
          const { getDb } = await import('./database');
          const { managedRootDir } = await import('./workspace-git');
          const workspaceRoot = await assertInsideKnownWorkspace(safePackageRoot, {
            db: getDb(),
            managedRootDir: managedRootDir(),
          });

          let packageExists = true;
          let authorizedExistingMembers: string[] | undefined;
          try {
            await lstat(safePackageRoot);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            packageExists = false;
          }
          if (packageExists) {
            authorizedExistingMembers = await assertExistingPlasmidPackageRoot(safePackageRoot);
          }
          const ownerId = event.sender.id;
          const rootIdentity = workspaceMutationRootIdentity(workspaceRoot);
          const releaseQuickLookMutation = acquireQuickLookRendererMutationLease([safePackageRoot]);
          let releaseWorkspaceMutation: (() => void) | undefined;
          try {
            assertRendererCurrent();
            if (mutationToken) {
              const reentryToken = workspaceMutationCapabilities.issueReentry(
                mutationToken,
                ownerId,
                rootIdentity
              );
              if (!reentryToken) throw new Error('WORKSPACE_MUTATION_PARENT_TOKEN_INVALID');
              releaseWorkspaceMutation = () => {
                workspaceMutationCapabilities.release(reentryToken, ownerId);
              };
            } else {
              releaseWorkspaceMutation = await acquireWorkspaceMutationShared(rootIdentity);
            }
            await assertUnversionedRendererFilesystemMutationAllowed(getDb(), ownerId, [
              safePackageRoot,
            ]);
            let released = false;
            const releaseMutation = (): void => {
              if (released) return;
              released = true;
              releaseWorkspaceMutation?.();
              releaseQuickLookMutation();
            };
            const leases = await packageScratchCapabilities.issue(safePackageRoot, ownerId, {
              assertOwnerCurrent: assertRendererCurrent,
              authorizedExistingMembers,
              mutationRelease: releaseMutation,
              recovery: createPackageScratchRecoveryCallbacks(
                getDb(),
                workspaceRoot,
                safePackageRoot
              ),
            });
            return leases;
          } catch (error) {
            releaseWorkspaceMutation?.();
            releaseQuickLookMutation();
            throw error;
          }
        },
        {
          requireAbsolute: true,
          errorPrefix: 'fs:createPackageScratch',
        }
      );
    }
  );

  mainIpc.handle('fs:removePackageScratch', async (event, cleanupToken: string) => {
    const mutationPath = packageScratchCapabilities.mutationPathForOwnedLease(
      cleanupToken,
      event.sender.id
    );
    return withSafeWritablePath(mutationPath, async () => {
      const { getDb } = await import('./database');
      await assertUnversionedRendererFilesystemMutationAllowed(getDb(), event.sender.id, [
        mutationPath,
      ]);
      return packageScratchCapabilities.remove(cleanupToken, event.sender.id);
    });
  });

  mainIpc.handle(
    'fs:renamePackageScratchMember',
    async (event, cleanupToken: string, oldPath: string, newPath: string) => {
      return withSafeWritablePaths(
        [{ path: oldPath }, { path: newPath }],
        async ([safeOldPath, safeNewPath]) => {
          const { getDb } = await import('./database');
          await assertUnversionedRendererFilesystemMutationAllowed(getDb(), event.sender.id, [
            safeOldPath,
            safeNewPath,
          ]);
          return packageScratchCapabilities.renameAuthorizedMember(
            cleanupToken,
            event.sender.id,
            safeOldPath,
            safeNewPath
          );
        }
      );
    }
  );

  mainIpc.handle('fs:convertFileSrc', async (_event, filePath: string) => {
    await assertSafePath(filePath);
    return `file://${filePath}`;
  });

  const activeWatchers = new Map<string, FSWatcher>();
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const polledFiles = new Set<string>();
  const watchConsumers = new FileWatchConsumers();
  const senderCleanupRegistered = new Set<number>();

  const scheduleFileChanged = (filePath: string) => {
    const existing = debounceTimers.get(filePath);
    if (existing) clearTimeout(existing);
    debounceTimers.set(
      filePath,
      setTimeout(() => {
        debounceTimers.delete(filePath);
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            sendRendererIpc(win.webContents, 'file-changed', filePath);
          }
        }
      }, 200)
    );
  };

  const stopWatching = (filePath: string) => {
    const watcher = activeWatchers.get(filePath);
    if (watcher) {
      watcher.close();
      activeWatchers.delete(filePath);
    }
    if (polledFiles.has(filePath)) {
      unwatchFile(filePath);
      polledFiles.delete(filePath);
    }
    const timer = debounceTimers.get(filePath);
    if (timer) {
      clearTimeout(timer);
      debounceTimers.delete(filePath);
    }
  };

  const releaseWatchConsumer = (filePath: string, senderId: number, count = 1): void => {
    if (watchConsumers.release(filePath, senderId, count)) stopWatching(filePath);
  };
  handleGroup(fsContract, {
    appendProjectMemoryEvent: async (event, input) => {
      const generation = mutationRendererLifecycle.register(event.sender);
      const workspaceRoot = await assertSafePath(input.workspaceRoot, { requireAbsolute: true });
      const { getDb } = await import('./database');
      const db = getDb();
      const assertCurrent = () => {
        mutationRendererLifecycle.assertCurrent(event.sender, generation);
        assertWorkspaceContentPublicationWritable(db, event, workspaceRoot);
      };
      assertCurrent();
      return withDeclaredRendererWorkspaceMutation({
        fileWrite: true,
        db,
        ownerId: event.sender.id,
        workspaceRoot,
        mutationPaths: [join(workspaceRoot, '.waypoint', 'project-memory')],
        mutationToken: input.mutationToken,
        operation: () => appendProjectMemoryEventInMain({ ...input, workspaceRoot }, assertCurrent),
      });
    },
    isSequenceDocumentAvailable: async (_event, documentId) =>
      nativeDocuments.sequenceDocuments.available(documentId),
    retainLegacySequenceDraft: async (_event, draft) =>
      nativeDocuments.sequenceDocuments.retainLegacyDraft(draft),
    completeLegacySequenceDraftMigration: async (_event, ids: readonly string[]) =>
      nativeDocuments.sequenceDocuments.completeLegacyMigration(ids),
    sequenceDocument: async (event, request) => {
      const snapshot = await nativeDocuments.sequenceDocuments.execute(request);
      let subscription = sequenceDocumentSubscribers.get(event.sender.id);
      if (!subscription) {
        subscription = { sender: event.sender, ids: new Set() };
        sequenceDocumentSubscribers.set(event.sender.id, subscription);
      }
      subscription.ids.add(snapshot.documentId);
      return snapshot;
    },
    acknowledgeFileDocumentFlush: async (event, ack) =>
      nativeDocuments.acknowledgeFileDocumentFlush(event.sender, ack),
    completeLegacyFileDraftMigration: async (_event, pendingPaths: readonly string[]) =>
      nativeDocuments.fileDocuments.completeLegacyMigration(pendingPaths),
    retainLegacyFileDraft: async (_event, draft) =>
      nativeDocuments.fileDocuments.retainLegacyDraft(draft),
    assertFileDocumentsClean: async (_event, path: string) => {
      const safePath = await assertSafePath(path, { requireAbsolute: true });
      await nativeDocuments.fileDocuments.assertClean(safePath);
    },
    listDirtyDocuments: async (event) => {
      dirtyDocumentSubscribers.set(event.sender.id, event.sender);
      return nativeDocuments.fileDocuments.listDirty();
    },
    settleDirtyDocuments: (_event, request) => nativeDocuments.settleDirtyDocuments(request),
    fileDocument: async (event, request) => {
      const snapshot = await nativeDocuments.fileDocuments.execute(request, 'renderer');
      let subscription = fileDocumentSubscribers.get(event.sender.id);
      if (!subscription) {
        subscription = { sender: event.sender, paths: new Set(), ids: new Map() };
        fileDocumentSubscribers.set(event.sender.id, subscription);
      }
      subscription.paths.add(snapshot.path);
      subscription.ids.set(snapshot.documentId, snapshot.path);
      return snapshot;
    },
    tableDocument: async (_event, command) => {
      if (
        command.kind !== 'resolve' &&
        command.kind !== 'open' &&
        command.kind !== 'list-promotions'
      )
        await nativeDocuments.flushFileDocumentClients();
      return nativeDocuments.tableDocuments.execute(command);
    },
    canonicalPath: async (_event, path: string) => {
      const { getDb } = await import('./database');
      return resolveRegisteredProjectPath(path, {
        db: getDb(),
        admit: (candidate) =>
          assertSafePath(candidate, { requireAbsolute: true, errorPrefix: 'fs:canonicalPath' }),
      });
    },
    readTextFile: async (_event, path: string) => {
      if (!isAbsolute(path)) {
        throw new Error(
          `[fs:readTextFile] Path must be absolute, got relative: "${path}". ` +
            `Resolve workspace-relative paths before calling IPC.`
        );
      }
      await assertSafePath(path);
      const s = await stat(path);
      if (s.size > HARD_CAP_BYTES) {
        throw new OversizedFileError(s.size, path, true);
      }
      return readFile(path, 'utf-8');
    },
    readAdmittedTextFile: (_event, input) => readAdmittedTextFile(input),
    beginWorkspaceMutation: async (
      event,
      workspaceRoot: string,
      parentToken?: string,
      waitForAvailability = false
    ) => {
      const generation = mutationRendererLifecycle.register(event.sender);
      const assertRendererCurrent = (): void => {
        mutationRendererLifecycle.assertCurrent(event.sender, generation);
      };
      assertRendererCurrent();
      await assertSafePath(workspaceRoot, {
        requireAbsolute: true,
        errorPrefix: 'fs:beginWorkspaceMutation',
      });
      const { assertInsideKnownWorkspace } = await import('../workspace-git/known-workspace-scope');
      const { getDb } = await import('./database');
      const { managedRootDir } = await import('./workspace-git');
      const knownRoot = await assertInsideKnownWorkspace(workspaceRoot, {
        db: getDb(),
        managedRootDir: managedRootDir(),
      });
      assertRendererCurrent();
      const rootIdentity = workspaceMutationRootIdentity(knownRoot);
      if (parentToken) {
        const reentryToken = workspaceMutationCapabilities.issueReentry(
          parentToken,
          event.sender.id,
          rootIdentity
        );
        if (!reentryToken) throw new Error('WORKSPACE_MUTATION_PARENT_TOKEN_INVALID');
        return reentryToken;
      }
      let releaseMutation: () => void;
      if (waitForAvailability) {
        const senderWaits = pendingMutationWaits.get(event.sender) ?? new Map();
        if (senderWaits.has(rootIdentity)) {
          throw new Error('WORKSPACE_MUTATION_WAIT_ALREADY_PENDING');
        }
        if (senderWaits.size >= maxPendingMutationWaitsPerRenderer) {
          throw new Error('WORKSPACE_MUTATION_RENDERER_WAIT_LIMIT');
        }
        const waitController = new AbortController();
        senderWaits.set(rootIdentity, waitController);
        pendingMutationWaits.set(event.sender, senderWaits);
        try {
          releaseMutation = await waitForWorkspaceMutationShared(rootIdentity, {
            signal: waitController.signal,
          });
        } finally {
          senderWaits.delete(rootIdentity);
          if (senderWaits.size === 0 && pendingMutationWaits.get(event.sender) === senderWaits) {
            pendingMutationWaits.delete(event.sender);
          }
        }
      } else {
        releaseMutation = await acquireWorkspaceMutationShared(rootIdentity);
      }
      try {
        assertRendererCurrent();
        await assertWorkspaceMigrationActionsSettled(knownRoot);
        await recoverNativeCatalogRecordPublications({
          db: getDb(),
          workspacePath: knownRoot,
          runDatabase: (operation) => {
            assertRendererCurrent();
            return withRendererDatabaseStatement(getDb(), event.sender, operation);
          },
        });
        assertRendererCurrent();
        return workspaceMutationCapabilities.issue(event.sender.id, rootIdentity, releaseMutation);
      } catch (error) {
        releaseMutation();
        throw error;
      }
    },
    endWorkspaceMutation: (event, token: string) => {
      workspaceMutationCapabilities.release(token, event.sender.id);
    },
    readTextFileSlice: async (_event, path: string, maxBytes: number) => {
      if (!isAbsolute(path)) {
        throw new Error(
          `[fs:readTextFileSlice] Path must be absolute, got relative: "${path}". ` +
            `Resolve workspace-relative paths before calling IPC.`
        );
      }
      if (!Number.isFinite(maxBytes) || maxBytes <= 0 || maxBytes > HARD_CAP_BYTES) {
        throw new Error(`[fs:readTextFileSlice] maxBytes must be between 1 and ${HARD_CAP_BYTES}.`);
      }
      await assertSafePath(path);

      const handle = await open(path, 'r');
      try {
        const buffer = Buffer.alloc(Math.floor(maxBytes));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return {
          text: buffer.subarray(0, bytesRead).toString('utf-8'),
          bytesRead,
        };
      } finally {
        await handle.close();
      }
    },
    readFile: async (_event, path: string) => {
      if (!isAbsolute(path)) {
        throw new Error(
          `[fs:readFile] Path must be absolute, got relative: "${path}". ` +
            `Resolve workspace-relative paths before calling IPC.`
        );
      }
      await assertSafePath(path);
      const s = await stat(path);
      if (s.size > HARD_CAP_BYTES) {
        throw new OversizedFileError(s.size, path, true);
      }
      const buffer = await readFile(path);
      return new Uint8Array(buffer);
    },
    readFileBounded: async (_event, path: string, maxBytes: number) => {
      if (!isAbsolute(path)) {
        throw new Error(
          `[fs:readFileBounded] Path must be absolute, got relative: "${path}". ` +
            `Resolve workspace-relative paths before calling IPC.`
        );
      }
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > HARD_CAP_BYTES) {
        throw new Error(`[fs:readFileBounded] maxBytes must be between 1 and ${HARD_CAP_BYTES}.`);
      }
      await assertSafePath(path);
      return readFileBoundedFromHandle(path, maxBytes);
    },
    sha256File: async (_event, path: string) => {
      if (!isAbsolute(path)) {
        throw new Error(
          `[fs:sha256File] Path must be absolute, got relative: "${path}". ` +
            `Resolve workspace-relative paths before calling IPC.`
        );
      }
      await assertSafePath(path);
      const s = await stat(path);
      if (s.size > HARD_CAP_BYTES) {
        throw new OversizedFileError(s.size, path, true);
      }
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
      return `sha256:${hash.digest('hex')}`;
    },
    writeTextFile: async (
      event,
      path: string,
      content: string,
      options?: { append?: boolean },
      mutationToken?: string
    ) => {
      return packageScratchCapabilities.runTrackedMutation([path], event.sender.id, async () => {
        return withSafeWritablePath(path, (safePath) =>
          withKnownWorkspaceMutation(
            event.sender.id,
            [safePath],
            async (assertCurrent) => {
              packageScratchCapabilities.validateGeneratedWrite(safePath, event.sender.id, {
                content,
                append: options?.append,
              });
              try {
                const leaf = await lstat(safePath);
                if (leaf.isSymbolicLink()) {
                  throw new Error(
                    `[fs:writeTextFile] Refusing to write through a symbolic link: ${safePath}`
                  );
                }
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
              }
              assertCurrent();
              if (options?.append) {
                await writeFile(safePath, content, { encoding: 'utf-8', flag: 'a' });
              } else {
                await writeFile(safePath, content, 'utf-8');
              }
              packageScratchCapabilities.recordGeneratedWrite(safePath, event.sender.id);
            },
            mutationToken
          )
        );
      });
    },
    writeTextFileAtomic: async (event, input: TextFileAtomicWriteInput) => {
      assertTextFileAtomicWriteInput(input);
      return packageScratchCapabilities.runTrackedMutation(
        [input.path],
        event.sender.id,
        async () =>
          withSafeWritablePath(
            input.path,
            (path) =>
              withKnownWorkspaceMutation(event.sender.id, [path], async (assertCurrent) => {
                packageScratchCapabilities.validateGeneratedWrite(path, event.sender.id, {
                  content: input.content,
                });
                await writeTextFileAtomicInMain(
                  { ...input, path },
                  { beforePublish: assertCurrent }
                );
                packageScratchCapabilities.recordGeneratedWrite(path, event.sender.id);
              }),
            { requireAbsolute: true, errorPrefix: 'fs:writeTextFileAtomic' }
          )
      );
    },
    ...sequencePackageFilesystemHandlers,
    validateWorkspacePath: async (_event, input: WorkspacePathValidationInput) => {
      await assertSafePath(input.workspaceRoot);
      await assertSafePath(input.path);
      return validateWorkspacePathInMain(input);
    },
    contentHash: async (
      _event,
      input: { workspaceRoot: string; workspaceRelativePath: string }
    ) => {
      await assertSafePath(input.workspaceRoot, { requireAbsolute: true });
      return contentHashInMain(input);
    },
    readDir: async (_event, dirPath: string) => {
      await assertSafePath(dirPath);
      const entries = await readdir(dirPath, { withFileTypes: true });
      return entries.map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
      }));
    },
    mkdir: async (
      event,
      path: string,
      options?: { recursive?: boolean },
      mutationToken?: string
    ) => {
      await packageScratchCapabilities.runTrackedMutation([path], event.sender.id, async () => {
        await withSafeWritablePath(path, (safePath) =>
          withKnownWorkspaceMutation(
            event.sender.id,
            [safePath],
            async () => {
              await mkdir(safePath, { recursive: options?.recursive ?? false });
            },
            mutationToken
          )
        );
      });
    },
    stat: async (_event, path: string) => {
      const canonicalPath = await assertSafePath(path);
      const leaf = await lstat(path);
      const s = await stat(canonicalPath, { bigint: true });
      return {
        canonicalPath,
        size: Number(s.size),
        isFile: s.isFile(),
        isDirectory: s.isDirectory(),
        isSymbolicLink: leaf.isSymbolicLink(),
        mtime: Number(s.mtimeNs) / 1_000_000,
        ctime: Number(s.ctimeNs) / 1_000_000,
        mtimeNs: s.mtimeNs.toString(),
        ctimeNs: s.ctimeNs.toString(),
        ...(s.dev > 0n ? { device: s.dev.toString() } : {}),
        ...(s.ino > 0n ? { inode: s.ino.toString() } : {}),
      };
    },
    exists: async (_event, path: string) => {
      try {
        await assertSafePath(path);
        await access(path);
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return false;
        throw error;
      }
    },
    rename: async (event, oldPath: string, newPath: string, mutationToken?: string) => {
      return withSafeWritablePaths(
        [{ path: oldPath }, { path: newPath }],
        ([safeOldPath, safeNewPath]) => {
          packageScratchCapabilities.assertGenericMutationAllowed(safeOldPath, safeNewPath);
          return withKnownWorkspaceMutation(
            event.sender.id,
            [safeOldPath, safeNewPath],
            async (assertCurrent) =>
              nativeDocuments.fileDocuments.withCleanPaths([safeOldPath, safeNewPath], async () => {
                const sourceLeaf = await lstat(safeOldPath).catch(
                  (error: NodeJS.ErrnoException) => {
                    if (error.code === 'ENOENT') return null;
                    throw error;
                  }
                );
                if (sourceLeaf?.isSymbolicLink()) {
                  throw new Error(
                    `[fs:rename] Refusing to rename through a symbolic link: ${safeOldPath}`
                  );
                }
                assertCurrent();
                // workspace-entity-move: raw primitive; product callers use workspace:relocateEntityFile.
                await nativeDocuments.fileDocuments.assertClean(safeOldPath);
                await rename(safeOldPath, safeNewPath);
                try {
                  await nativeDocuments.fileDocuments.relocate(safeOldPath, safeNewPath);
                } catch (error) {
                  throw new Error(
                    `FILE_DOCUMENT_BINDING_FAILED: The file moved to ${safeNewPath}, but its document binding could not be retained: ${error instanceof Error ? error.message : String(error)}`
                  );
                }
              }),
            mutationToken
          );
        }
      );
    },
    move: async (event, sourcePath: string, destinationDir: string) => {
      return withSafeWritablePaths(
        [{ path: sourcePath }, { path: destinationDir }],
        ([safeSourcePath, safeDestinationDir]) => {
          const plan = planMoveIntoDirectory(safeSourcePath, safeDestinationDir);
          if (!plan.ok) {
            throw new Error(
              plan.reason === 'noop'
                ? 'MOVE_NOOP: the item is already in that folder'
                : 'MOVE_INTO_SELF: cannot move a folder into itself or a subfolder'
            );
          }
          const { destPath } = plan;
          packageScratchCapabilities.assertGenericMutationAllowed(
            safeSourcePath,
            safeDestinationDir,
            destPath
          );
          return withKnownWorkspaceMutation(
            event.sender.id,
            [safeSourcePath, destPath],
            async (assertCurrent) =>
              nativeDocuments.fileDocuments.withCleanPaths([safeSourcePath, destPath], async () => {
                const sourceLeaf = await lstat(safeSourcePath).catch(
                  (error: NodeJS.ErrnoException) => {
                    if (error.code === 'ENOENT') return null;
                    throw error;
                  }
                );
                if (sourceLeaf?.isSymbolicLink()) {
                  throw new Error(
                    `[fs:move] Refusing to move through a symbolic link: ${safeSourcePath}`
                  );
                }
                let destExists = false;
                try {
                  await access(destPath);
                  destExists = true;
                } catch {
                  destExists = false;
                }
                if (destExists) {
                  throw new Error(
                    `MOVE_EXISTS: an item named "${basename(destPath)}" already exists in that folder`
                  );
                }
                assertCurrent();
                try {
                  // workspace-entity-move: raw primitive with no feature caller or reference-index update.
                  await rename(safeSourcePath, destPath);
                } catch (err) {
                  if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
                    assertCurrent();
                    await cp(safeSourcePath, destPath, {
                      recursive: true,
                      force: false,
                      errorOnExist: true,
                    });
                    try {
                      assertCurrent();
                      await rm(safeSourcePath, { recursive: true, force: true });
                    } catch (rmErr) {
                      await rm(destPath, { recursive: true, force: true }).catch(() => {});
                      throw new Error(
                        `MOVE_FAILED: copied to the destination but could not remove the original (${
                          (rmErr as Error).message
                        })`
                      );
                    }
                  } else {
                    throw err;
                  }
                }
                try {
                  await nativeDocuments.fileDocuments.relocate(safeSourcePath, destPath);
                } catch (error) {
                  throw new Error(
                    `FILE_DOCUMENT_BINDING_FAILED: The file moved to ${destPath}, but its document binding could not be retained: ${error instanceof Error ? error.message : String(error)}`
                  );
                }
                return { destPath };
              })
          );
        }
      );
    },
    watchFile: async (event, filePath: string) => {
      await assertSafePath(filePath);
      const senderId = event.sender.id;
      const needsWatcher = watchConsumers.acquire(filePath, senderId);
      if (!senderCleanupRegistered.has(senderId)) {
        senderCleanupRegistered.add(senderId);
        event.sender.once('destroyed', () => {
          senderCleanupRegistered.delete(senderId);
          for (const ownedPath of watchConsumers.releaseSender(senderId)) stopWatching(ownedPath);
        });
      }
      if (!needsWatcher || activeWatchers.has(filePath) || polledFiles.has(filePath)) return;

      try {
        watchFile(filePath, { interval: 500 }, (curr, prev) => {
          if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) {
            scheduleFileChanged(filePath);
          }
        });
        polledFiles.add(filePath);
      } catch (err) {
        console.warn(`[FileWatcher] Cannot stat-poll ${filePath}:`, (err as Error).message);
      }

      try {
        const watcher = watch(filePath, { persistent: false }, () => scheduleFileChanged(filePath));
        watcher.on('error', (err) => {
          console.warn(`[FileWatcher] Error watching ${filePath}:`, err.message);
          activeWatchers.delete(filePath);
        });
        activeWatchers.set(filePath, watcher);
      } catch (err) {
        console.warn(`[FileWatcher] Cannot watch ${filePath}:`, (err as Error).message);
      }
    },
    unwatchFile: async (event, filePath: string) => {
      releaseWatchConsumer(filePath, event.sender.id);
    },
  });

  app.on('before-quit', () => {
    for (const path of [...activeWatchers.keys(), ...polledFiles]) {
      stopWatching(path);
    }
    watchConsumers.clear();
    senderCleanupRegistered.clear();
  });

  handleGroup(sequenceAlignmentHistoryContract, {
    publishSequenceAlignmentHistory: async (
      event,
      input: PublishSequenceAlignmentHistoryRequest
    ): Promise<string> => {
      if (!input || typeof input !== 'object' || !input.packageRoot)
        throw new Error('Alignment history request is malformed.');
      const { getDb } = await import('./database');
      const db = getDb();
      const root = findKnownWorkspaceRoot(db, input.packageRoot);
      if (!root || root !== findKnownWorkspaceRoot(db, input.workspaceRoot))
        throw new Error('Alignment history is outside its declared workspace.');
      return withDeclaredRendererWorkspaceMutation({
        db,
        ownerId: event.sender.id,
        workspaceRoot: root,
        mutationPaths: [input.packageRoot],
        mutationToken: input.mutationToken,
        operation: () => {
          assertWorkspaceContentPublicationWritable(db, event, root);
          return publishSequenceAlignmentHistoryInMain({ ...input, workspaceRoot: root }, () =>
            assertWorkspaceContentPublicationWritable(db, event, root)
          );
        },
      });
    },
  });
}

async function withKnownWorkspaceMutation<T>(
  ownerId: number,
  paths: readonly string[],
  operation: (assertCurrent: () => void) => Promise<T>,
  mutationToken?: string
): Promise<T> {
  const { getDb } = await import('./database');
  const db = getDb();
  assertCommittedDatabaseReadAllowed(db);
  const roots = [...new Set(paths.map((path) => findKnownWorkspaceRoot(db, path)))].filter(
    (root): root is string => root !== null
  );
  if (roots.length > 1) throw new Error('WORKSPACE_MUTATION_CROSSES_KNOWN_WORKSPACES');
  const assertCurrent = () => {
    assertCommittedDatabaseReadAllowed(db);
    assertWorkspaceWriteAllowed(db, paths);
    const currentRoots = [...new Set(paths.map((path) => findKnownWorkspaceRoot(db, path)))].filter(
      (root): root is string => root !== null
    );
    if (
      currentRoots.length !== roots.length ||
      currentRoots.some((root, index) => root !== roots[index])
    ) {
      throw new Error('The owning project changed while waiting to modify its files.');
    }
    for (const root of currentRoots) assertKnownWorkspaceContentWritable(db, root);
  };
  assertCurrent();
  return withKnownRendererFilesystemMutation({
    db,
    ownerId,
    paths,
    mutationToken,
    operation: async () => {
      assertCurrent();
      return operation(assertCurrent);
    },
  });
}
