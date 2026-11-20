import {
  userMessage,
  toUserMessage,
  userMessageWithValues,
  userMessageValue,
  userEntityLabel,
} from '@waypoint/user-messages';
import { useEntityNavigation } from './use-entity-navigation';
import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import type { QuickLookDestinationCommit } from '../components/QuickLookImportHost';
import type { RecentlyEditedItem } from '../features/home/recently-edited';
import type { OpenWorkspaceOptions, WorkspaceSource } from '../features/workspace-loader/types';
import type { TabType } from '../features/canvas/types';
import type { FileActivationDelivery } from '../shared/file-association-ipc';
import type { UseWorkspaceReturn } from './useWorkspace';
import type { WorkspaceLibraryState } from './useWorkspaceLibrary';
import { confirmDialog, promptDialog } from '../components/confirm-dialog-store';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { useToastStore } from '../stores/toast-store';
import { platform } from '../platform';
import { isBrowserOnly, isDesktopRuntime, isHostedBrowserRuntime } from '../utils/environment';
import { electronWorkspaceSessionController } from '../features/workspace-session/electron-session';
import { hostedWorkspaceRoot } from '../hosted/paths';
import { MOCK_WORKSPACE_PATH } from '../utils/browser-mocks';
import { getTabTypeForFile } from '../utils/fileTypes';
import { openDocument } from '../features/document-opening/open-document';
import { openSequenceFile } from '../features/document-opening/compat';
import { resolveActiveImportRoot } from '../features/workspace-loader/resolve-import-root';
import { openWorkspaceFromSource } from '../features/workspace-loader/open-workspace-from-source';
import {
  observeCommittedWorkspaceOpen,
  observeSampleAssetOpen,
  workspaceOpenObservation,
} from '../features/workspace-loader/workspace-telemetry';
import { runHostedImport } from '../hosted/import-workflow';
import { decideSequenceOpenRoute } from '../features/sequence/openSequenceFile';
import { useOversizedDialogStore } from '../features/sequence/oversized-dialog-store';
import {
  runSingleFileImportWrite,
  trackSingleFileImportProjectionFailed,
} from '../features/import-wizard/single-file-import-write';
import { WORKSPACE_IMPORT_FILE_FILTERS } from '../features/workspace-loader/public/import-file-filters';
import { processFileActivation } from '../features/file-associations/process-file-activation';
import { FileActivationReceiptLedger } from '../features/file-associations/file-activation-receipts';
import { watchPreviewTabs } from '../lib/preview-tab-packages';
import { openExternalPreview } from '../lib/open-external-preview';
import { useLimsOverlayStore } from '../features/lims/lims-overlay-store';
import { openRecentlyEditedItem } from '../features/home/open-recently-edited';
import { restoreRegisteredActiveProjects } from '../features/workspace-loader/restore-active-projects';
import { waitForNativeFileDocumentReadiness } from '../features/workspace/public/file-document-client';
import {
  archiveWorkspace,
  archiveWorkspaceByPath,
  listWorkspaceLibrary,
  renameWorkspaceByPath,
  trashWorkspaceByPath,
  type WorkspaceLibraryEntry,
} from '../features/workspace-loader/workspace-library';
import { renameProject } from '../features/workspace-loader/rename-project';
import { registerWorkspaceProjectControl } from '../features/workspace-loader/workspace-project-control';
import {
  isExampleWorkspaceEntry,
  selectExampleWorkspaceMount,
  consolidateExampleWorkspaceVersions,
  shouldMountExampleWorkspace,
} from '../features/workspace-loader/example-workspace-identity';
import { STANDARD_SAMPLE_WORKSPACE_SOURCE } from '../features/workspace-loader/sample-workspaces/standard-samples';
import { removalWouldLeaveNoWorkspace } from '../features/workspace-loader/workspace-existence-guard';
import { MAX_MANAGED_WORKSPACE_NAME_LENGTH } from '../shared/workspace-git-types';
import {
  WORKSPACE_FILES_CHANGED_EVENT,
  type WorkspaceFilesChangedDetail,
} from '../services/workspace-files-changed-adapter';
import {
  useWorkspaceArtifactActions,
  type WorkspaceArtifactActionsOptions,
} from './useWorkspaceArtifactActions';
import {
  useBenchlingWorkspaceActions,
  type BenchlingWorkspaceActionsOptions,
} from './useBenchlingWorkspaceActions';

import { useFirstProjectBootstrap } from './useFirstProjectBootstrap';

const EXAMPLE_WORKSPACE_SEEDED_KEY = 'waypoint:example-workspace-seeded';

type ProjectLibraryPopover = { x: number; y: number } | null;
type WorkspaceStoreState = ReturnType<typeof useWorkspaceStore.getState>;

type WorkspaceProjectActionsOptions = WorkspaceArtifactActionsOptions &
  Omit<BenchlingWorkspaceActionsOptions, 'openWorkspaceSource' | 'refreshWorkspaceLibrary'> & {
    readonly shellPrepared: boolean;
    readonly workspaceLoading: boolean;
    readonly workspacePath: string | null;
    readonly selectedPath: string | null;
    readonly projectHomePath: string | null;
    readonly library: WorkspaceLibraryState;
    readonly addFolder: WorkspaceStoreState['addFolder'];
    readonly removeFolder: WorkspaceStoreState['removeFolder'];
    readonly setWorkspacePath: UseWorkspaceReturn['setWorkspacePath'];
    readonly setProjectLibraryPopover: Dispatch<SetStateAction<ProjectLibraryPopover>>;
    readonly setHostedStatus: Dispatch<SetStateAction<string | null>>;
    readonly setHostedBrowserReadOpen: Dispatch<SetStateAction<boolean>>;
    readonly hostedFileInputRef: MutableRefObject<HTMLInputElement | null>;
    readonly projectCollectionRestoredRef: MutableRefObject<boolean>;
    readonly handleFileSelect: (
      path: string,
      tabType: TabType,
      label?: string,
      signal?: AbortSignal
    ) => Promise<TabType>;
    readonly trackFirstProductActionProxyOnce: () => void;
  };

function getE2EParams(): { workspace?: string; openFile?: string; e2e?: boolean } {
  if (typeof window === 'undefined') return {};
  const params = new URLSearchParams(window.location.search);
  return {
    workspace: params.get('workspace') ?? undefined,
    openFile: params.get('openFile') ?? undefined,
    e2e: params.get('e2e') === 'true',
  };
}

export function useWorkspaceProjectActions(options: WorkspaceProjectActionsOptions) {
  const {
    shellPrepared,
    workspaceLoading,
    workspacePath,
    folders,
    selectedPath,
    projectHomePath,
    library,
    addFolder,
    removeFolder,
    setWorkspacePath,
    setProjectHomePath,
    setProjectLibraryPopover,
    setCreateDestinationRequest,
    setHostedStatus,
    setHostedBrowserReadOpen,
    hostedFileInputRef,
    projectCollectionRestoredRef,
    handleFileSelect,
    reconcileChangedWorkspace,
    handleCreateEntity,
    handleViewChange,
    trackFirstProductActionProxyOnce,
    workspaceRootFromCreationContext,
    artifactTitleFromCreationContext,
  } = options;
  const {
    workspaceLibrary,
    registeredProjectFolders,
    workspaceLibraryEntries,
    libraryLoaded,
    setWorkspaceLibrary,
    refreshWorkspaceLibrary,
  } = library;

  const openWorkspaceSource = useCallback(
    async (source: WorkspaceSource, options: OpenWorkspaceOptions = {}) => {
      try {
        const result = await openWorkspaceFromSource(source, options, {
          openFile: async ({ filePath, label, signal }) => {
            const tabType = getTabTypeForFile(filePath);
            if (tabType === 'sequence') {
              await openSequenceFile({
                filePath,
                label,
                signal,
                strategy: { kind: 'focused' },
                sourceSurface:
                  options.telemetrySource === 'recent'
                    ? 'recent'
                    : options.telemetrySource === 'startup_arg'
                      ? 'startup'
                      : 'unknown',
              });
              return;
            }

            await handleFileSelect(filePath, tabType, label, signal);
          },
          onWorkspaceCommitted: ({ instance, options: committedOptions }) => {
            const observation = workspaceOpenObservation(instance, committedOptions);
            if (observation) observeCommittedWorkspaceOpen(observation);
          },
        });
        if (result.superseded) return false;
        if (result.assetOpenError) {
          console.warn(
            '[App] Workspace opened, but its landing asset did not:',
            result.assetOpenError
          );
          useToastStore
            .getState()
            .addToast(
              userMessage('notice.project-opened-but-its-landing-document-could-not-be-opened'),
              {
                definition: 'app-project-opened-but-its-landing-document-could-not-be-opened',
              }
            );
        }
        if (source.kind === 'sample-template' && result.openedAssetPath) {
          const deliberate = observeSampleAssetOpen(options.telemetrySource ?? 'unknown');
          if (deliberate) trackFirstProductActionProxyOnce();
        }
        await refreshWorkspaceLibrary();
        return true;
      } catch (err) {
        console.error('[App] Failed to open workspace source:', err);
        useToastStore.getState().addToast(toUserMessage(err, 'failure.failed-to-open-project'), {
          definition: 'app-failed-to-open-project',
        });
        return false;
      }
    },
    [refreshWorkspaceLibrary, handleFileSelect, trackFirstProductActionProxyOnce]
  );

  const { handleBenchlingMigrationUnlocked, handleOpenBenchlingWorkspace, migrationSettings } =
    useBenchlingWorkspaceActions({ ...options, refreshWorkspaceLibrary, openWorkspaceSource });

  const importFolderWithProgress = useCallback(
    async (
      path: string,
      opts?: { inPlace?: boolean; telemetrySource?: OpenWorkspaceOptions['telemetrySource'] }
    ) => {
      const importId = crypto.randomUUID();
      const displayName = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
      useWorkspaceStore.getState().startPendingImport({
        id: importId,
        originPath: path,
        displayName,
        kind: 'folder',
        status: 'scanning',
      });
      try {
        await openWorkspaceSource(
          { kind: 'local-folder', path },
          {
            importId,
            inPlace: opts?.inPlace,
            telemetrySource: opts?.telemetrySource ?? 'folder_picker',
          }
        );
      } finally {
        useWorkspaceStore.getState().finishPendingImport(importId);
      }
    },
    [openWorkspaceSource]
  );

  useEffect(() => {
    const onNewWorkspaceImport = (event: Event) => {
      const detail = (event as CustomEvent<WorkspaceFilesChangedDetail | undefined>).detail;
      if (!detail?.createdNewWorkspace || !detail.workspaceRoot) return;
      const root = detail.workspaceRoot;
      void openWorkspaceSource({ kind: 'local-folder', path: root })
        .then(() => {
          if (detail.createdWorkspaceName) {
            useWorkspaceStore.getState().renameFolder(root, detail.createdWorkspaceName);
          }
          if (detail.revealPaths) {
            window.dispatchEvent(
              new CustomEvent(WORKSPACE_FILES_CHANGED_EVENT, {
                detail: { ...detail, createdNewWorkspace: false },
              })
            );
          } else if (detail.revealPath) {
            useWorkspaceStore.getState().revealPath(detail.revealPath);
          }
        })
        .catch((err) => console.warn('[App] Failed to mount imported new workspace:', err));
    };
    window.addEventListener(WORKSPACE_FILES_CHANGED_EVENT, onNewWorkspaceImport);
    return () => window.removeEventListener(WORKSPACE_FILES_CHANGED_EVENT, onNewWorkspaceImport);
  }, [openWorkspaceSource]);

  const handleQuickLookDestinationCommit = useCallback(
    async (commit: QuickLookDestinationCommit): Promise<void> => {
      if (commit.createdNewWorkspace) {
        const opened = await openWorkspaceSource({
          kind: 'local-folder',
          path: commit.workspaceRoot,
        });
        if (!opened) {
          throw new Error(
            'The package was imported, but its destination project could not be opened in the sidebar.'
          );
        }
        if (commit.createdWorkspaceName) {
          useWorkspaceStore
            .getState()
            .renameFolder(commit.workspaceRoot, commit.createdWorkspaceName);
        }
      } else {
        await reconcileChangedWorkspace(commit.workspaceRoot, { rejectOnFailure: true });
      }
      useWorkspaceStore.getState().revealPath(commit.revealPath);
    },
    [reconcileChangedWorkspace, openWorkspaceSource]
  );

  useEffect(() => {
    if (
      projectCollectionRestoredRef.current ||
      !isDesktopRuntime() ||
      !libraryLoaded ||
      workspaceLoading ||
      getE2EParams().e2e
    ) {
      return;
    }
    restoreRegisteredActiveProjects(registeredProjectFolders);
    projectCollectionRestoredRef.current = true;
  }, [libraryLoaded, projectCollectionRestoredRef, workspaceLoading, registeredProjectFolders]);

  const autoSeedAttempted = useRef(false);
  useEffect(() => {
    if (autoSeedAttempted.current || !isDesktopRuntime() || !libraryLoaded || workspaceLoading)
      return;
    autoSeedAttempted.current = true;

    if (getE2EParams().e2e) return;

    let materialized = false;
    try {
      materialized = globalThis.localStorage?.getItem(EXAMPLE_WORKSPACE_SEEDED_KEY) === '1';
    } catch {}
    const dismissed = [...workspaceLibrary.archived, ...workspaceLibrary.trashed].some(
      isExampleWorkspaceEntry
    );
    const exampleMount = selectExampleWorkspaceMount(workspaceLibrary.active);
    const activeExample = exampleMount.selected !== null || exampleMount.superseded.length > 0;
    if (!shouldMountExampleWorkspace({ materialized, active: activeExample, dismissed })) return;
    const importId = crypto.randomUUID();
    useWorkspaceStore.getState().startPendingImport({
      id: importId,
      originPath: 'sample:standard-samples',
      displayName: 'DNAForge Samples',
      kind: 'folder',
      status: 'scanning',
    });
    const source: WorkspaceSource = exampleMount.selected
      ? {
          kind: 'local-folder',
          path: exampleMount.selected.repoPath,
          name: exampleMount.selected.name,
        }
      : STANDARD_SAMPLE_WORKSPACE_SOURCE;

    void consolidateExampleWorkspaceVersions({
      superseded: exampleMount.superseded,
      openCurrent: () =>
        openWorkspaceSource(source, {
          importId,

          inPlace: exampleMount.selected !== null,
          telemetrySource: 'automatic_sample',
        }),
      archive: async (repoUuid) => {
        await waitForNativeFileDocumentReadiness();
        return archiveWorkspace(repoUuid);
      },
      loadLibrary: () => listWorkspaceLibrary(),
    })
      .then(({ opened, library }) => {
        if (!opened || !library) return;
        for (const workspace of exampleMount.superseded) {
          useWorkspaceStore.getState().removeFolder(workspace.repoPath);
        }
        setWorkspaceLibrary(library);
        try {
          globalThis.localStorage?.setItem(EXAMPLE_WORKSPACE_SEEDED_KEY, '1');
        } catch {}
      })
      .catch((error) => {
        console.error('[App] Failed to consolidate the Samples project:', error);
        useToastStore
          .getState()
          .addToast(
            userMessage(
              'notice.the-current-samples-project-is-available-but-dnaforge-could-not-retire'
            ),
            {
              definition:
                'app-the-current-samples-project-is-available-but-dnaforge-could-not-retire-an-old',
            }
          );
      })
      .finally(() => useWorkspaceStore.getState().finishPendingImport(importId));
  }, [
    libraryLoaded,
    workspaceLoading,
    workspaceLibrary,
    openWorkspaceSource,
    refreshWorkspaceLibrary,
    setWorkspaceLibrary,
  ]);

  useFirstProjectBootstrap({
    libraryLoaded,
    workspaceLoading,
    workspacePath,
    registeredProjectFolders,
    activeProjects: workspaceLibrary.active,
    e2e: getE2EParams().e2e === true,
    setWorkspacePath,
    refreshWorkspaceLibrary,
  });

  const handleAddFolder = useCallback(async () => {
    if (isHostedBrowserRuntime()) {
      const proposed = window.prompt('Project name', 'Untitled project')?.trim();
      if (!proposed) return;
      try {
        const created = await electronWorkspaceSessionController.createWorkspace(proposed);
        addFolder(hostedWorkspaceRoot(created.workspaceId), created.displayName);
        await setWorkspacePath(hostedWorkspaceRoot(created.workspaceId));
      } catch (error: unknown) {
        console.error('[Hosted] Failed to create project:', error);
        useToastStore
          .getState()
          .addToast(toUserMessage(error, 'failure.could-not-create-the-project'), {
            definition: 'app-could-not-create-the-project',
          });
      }
      return;
    }
    if (isBrowserOnly()) {
      await openWorkspaceSource(
        { kind: 'local-folder', path: MOCK_WORKSPACE_PATH },
        { telemetrySource: 'folder_picker' }
      );
      return;
    }

    const result = await platform().dialog.open({
      directory: true,
      multiple: false,
      title: 'Open Folder',
    });
    if (typeof result !== 'string') return;
    await importFolderWithProgress(result);
  }, [addFolder, importFolderWithProgress, openWorkspaceSource, setWorkspacePath]);

  const _handleAddFolderInPlace = useCallback(async () => {
    if (isBrowserOnly()) {
      await openWorkspaceSource(
        { kind: 'local-folder', path: MOCK_WORKSPACE_PATH },
        { inPlace: true, telemetrySource: 'folder_picker' }
      );
      return;
    }
    const result = await platform().dialog.open({
      directory: true,
      multiple: false,
      title: 'Open Folder in Place (edit original files)',
    });
    if (typeof result !== 'string') return;
    await importFolderWithProgress(result, { inPlace: true });
  }, [openWorkspaceSource, importFolderWithProgress]);

  const handleCreateEmptyWorkspace = useCallback(
    async (name?: string): Promise<boolean> => {
      if (isHostedBrowserRuntime()) {
        try {
          const created = await electronWorkspaceSessionController.createWorkspace(
            name?.trim() || 'Untitled project'
          );
          addFolder(hostedWorkspaceRoot(created.workspaceId), created.displayName);
          await setWorkspacePath(hostedWorkspaceRoot(created.workspaceId));
          return true;
        } catch (error: unknown) {
          console.error('[Hosted] Failed to create project:', error);
          useToastStore
            .getState()
            .addToast(toUserMessage(error, 'failure.could-not-create-the-project'), {
              definition: 'app-could-not-create-the-project',
            });
          return false;
        }
      }
      return openWorkspaceSource(
        { kind: 'empty', name },
        { replaceCurrent: false, makeCurrent: true, telemetrySource: 'folder_picker' }
      );
    },
    [addFolder, openWorkspaceSource, setWorkspacePath]
  );

  const resolveImportRoot = useCallback(
    () =>
      resolveActiveImportRoot({
        folders,
        selectedPath,
        focusedRootPath: projectHomePath,
        workspacePath,
      }),
    [folders, selectedPath, projectHomePath, workspacePath]
  );

  const runSingleFileImport = useCallback(
    async (targetRoot: string, sourcePath: string): Promise<{ ok: boolean; destPath?: string }> => {
      const label = sourcePath.split(/[\\/]/).filter(Boolean).pop() ?? sourcePath;

      let sizeBytes = 0;
      try {
        const stat = await platform().fs.stat(sourcePath);
        if (!stat) {
          useToastStore.getState().addToast(
            userMessageWithValues('notice.couldn-t-read-value', {
              value0: userMessageValue(label),
            }),
            { definition: 'app-couldn-t-read-example' }
          );
          return { ok: false };
        }
        sizeBytes = stat.size;
      } catch {
        useToastStore.getState().addToast(
          userMessageWithValues('notice.couldn-t-read-value', {
            value0: userMessageValue(label),
          }),
          { definition: 'app-couldn-t-read-example' }
        );
        return { ok: false };
      }
      const route = decideSequenceOpenRoute(sourcePath, sizeBytes);
      if (route === 'block') {
        await useOversizedDialogStore.getState().requestBlock({ filePath: sourcePath, sizeBytes });
        return { ok: false };
      }
      if (route === 'warn') {
        const proceed = await useOversizedDialogStore
          .getState()
          .requestWarn({ filePath: sourcePath, sizeBytes });
        if (!proceed) return { ok: false };
      }

      let destPath: string;
      let importOperationId: string;
      try {
        const measuredWrite = await runSingleFileImportWrite({
          targetRoot,
          sourcePath,
          importFile: (request) => platform().workspace.importFile(request),
        });
        destPath = measuredWrite.result.destPath;
        importOperationId = measuredWrite.operationId;
      } catch (err) {
        console.error('[App] Failed to import file:', err);
        useToastStore.getState().addToast(toUserMessage(err, 'failure.failed-to-import-file'), {
          definition: 'app-failed-to-import-file',
        });
        return { ok: false };
      }

      try {
        await reconcileChangedWorkspace(targetRoot);
        useWorkspaceStore.getState().revealPath(destPath);

        const tabType = getTabTypeForFile(destPath);
        if (tabType === 'sequence') {
          await openSequenceFile({
            filePath: destPath,
            label,
            strategy: { kind: 'focused' },
            skipOversizedPrompt: true,
            sourceSurface: 'sidebar',
            importOperationId,
          });
        } else {
          await handleFileSelect(destPath, tabType);
        }
        return { ok: true, destPath };
      } catch (err) {
        trackSingleFileImportProjectionFailed(importOperationId);
        console.error('[App] Imported file but failed to refresh or open it:', err);
        useToastStore
          .getState()
          .addToast(
            userMessageWithValues(
              'notice.imported-value-but-couldn-t-open-it-it-remains-in-the-project',
              { value0: userMessageValue(label) }
            ),
            {
              definition: 'app-imported-example-but-couldn-t-open-it-it-remains-in-the-project',
            }
          );
        return { ok: false };
      }
    },
    [reconcileChangedWorkspace, handleFileSelect]
  );

  useEffect(() => {
    if (isDesktopRuntime() && shellPrepared && !workspaceLoading) return watchPreviewTabs();
  }, [shellPrepared, workspaceLoading]);

  const handleFileActivation = useCallback(
    async (delivery: FileActivationDelivery): Promise<void> => {
      await processFileActivation(delivery, {
        openQuickLook: (activation) => openExternalPreview(activation.path, 'startup'),
        reportError: (message) =>
          useToastStore
            .getState()
            .addToast(toUserMessage(message), { definition: 'file-open-failed' }),
      });
    },
    []
  );

  useEntityNavigation(shellPrepared && !workspaceLoading);
  const fileActivationHandlerRef = useRef(handleFileActivation);
  const fileActivationProcessingRef = useRef<Promise<void>>(Promise.resolve());
  const fileActivationReceiptsRef = useRef(new FileActivationReceiptLedger());
  fileActivationHandlerRef.current = handleFileActivation;

  useEffect(() => {
    if (!isDesktopRuntime() || !shellPrepared || workspaceLoading) return;
    let disposed = false;
    const enqueue = (deliveries: FileActivationDelivery[]): void => {
      if (disposed) return;
      const admitted = deliveries.filter((delivery) =>
        fileActivationReceiptsRef.current.admit(delivery.deliveryId)
      );
      if (admitted.length === 0) return;
      fileActivationProcessingRef.current = fileActivationProcessingRef.current.then(async () => {
        for (const delivery of admitted) {
          if (disposed) return;
          await fileActivationHandlerRef.current(delivery);
        }
      });
    };
    const unsubscribe = platform().fileAssociations.onOpenFiles(enqueue);
    void platform()
      .fileAssociations.takePendingActivations()
      .then(enqueue)
      .catch((error) => {
        console.error('[App] Failed to take pending file activations:', error);
        useToastStore
          .getState()
          .addToast(userMessage('notice.dnaforge-could-not-receive-the-file-open-request'), {
            definition: 'app-dnaforge-could-not-receive-the-file-open-request',
          });
      });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [shellPrepared, workspaceLoading]);

  const handleHostedImport = useCallback(
    async (files: readonly File[]) => {
      try {
        await runHostedImport(files, {
          handleFileSelect,
          bumpFileTreeRefresh: () => useWorkspaceStore.getState().bumpFileTreeRefresh(),
          revealPath: (path) => useWorkspaceStore.getState().revealPath(path),
          setStatus: setHostedStatus,
        });
      } catch (error: unknown) {
        setHostedStatus(error instanceof Error ? error.message : 'Import failed.');
      } finally {
        if (hostedFileInputRef.current) hostedFileInputRef.current.value = '';
      }
    },
    [handleFileSelect, hostedFileInputRef, setHostedStatus]
  );

  const handleHostedSignOut = useCallback(async () => {
    try {
      setHostedBrowserReadOpen(false);
      const { signOutHostedWorkspace } = await import('../hosted/api');
      const { hostedWorkspaceSessionController, hostedDurableSync } =
        await import('../hosted/controller');
      await signOutHostedWorkspace();
      await hostedDurableSync.signOut();
      hostedWorkspaceSessionController.reset();
      window.location.assign('/hosted.html');
    } catch (error: unknown) {
      setHostedStatus(error instanceof Error ? error.message : 'Sign out failed.');
    }
  }, [setHostedBrowserReadOpen, setHostedStatus]);

  const handleImportFile = useCallback(async () => {
    if (isHostedBrowserRuntime()) {
      hostedFileInputRef.current?.click();
      return;
    }
    const targetRoot = resolveImportRoot();
    if (!targetRoot) {
      useToastStore
        .getState()
        .addToast(
          folders.length > 1
            ? userMessage('notice.click-into-the-project-you-want-to-import-the-file-into-first')
            : userMessage('notice.open-or-create-a-project-first-then-import-files-into-it'),
          { definition: 'app-open-or-create-a-project-first-then-import-files-into-it' }
        );
      return;
    }
    if (isBrowserOnly()) {
      useToastStore
        .getState()
        .addToast(userMessage('notice.file-import-is-only-available-in-the-desktop-app'), {
          definition: 'app-file-import-is-only-available-in-the-desktop-app',
        });
      return;
    }
    const picked = await platform().dialog.open({
      directory: false,
      multiple: false,
      title: 'Import File',
      filters: WORKSPACE_IMPORT_FILE_FILTERS,
    });
    if (typeof picked !== 'string') return;
    await runSingleFileImport(targetRoot, picked);
  }, [hostedFileInputRef, resolveImportRoot, folders.length, runSingleFileImport]);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    return platform().workspace.onImportProgress((event) => {
      useWorkspaceStore.getState().updatePendingImport(event.importId, {
        status: event.status,
        filesCopied: event.filesCopied,
        totalFiles: event.totalFiles,
        bytesCopied: event.bytesCopied,
        totalBytes: event.totalBytes,
      });
    });
  }, []);

  const handleOpenRecentlyEdited = useCallback(
    (item: RecentlyEditedItem) =>
      openRecentlyEditedItem(item, {
        isWorkspaceMounted: (path) =>
          useWorkspaceStore.getState().folders.some((folder) => folder.path === path),
        mountWorkspace: openWorkspaceSource,
        openTarget: async (recentItem) => {
          let result;
          if (recentItem.open.kind === 'file') {
            result = await openDocument({
              target: {
                kind: 'file',
                path: recentItem.open.path,
                tabType: recentItem.open.tabType,
              },
              label: recentItem.title,
              placement: { kind: 'focused' },
              source: 'recent',
            });
          } else if (recentItem.open.tabType === 'sequence') {
            const { resolveSequenceDocumentById } =
              await import('../features/sequence/sequence-document-repository');
            const document = await resolveSequenceDocumentById(
              recentItem.open.entityId,
              useWorkspaceStore.getState().folders.map((folder) => folder.path)
            );
            result = await openDocument({
              target: { kind: 'sequence-document', document: document.ref },
              label: recentItem.title,
              source: 'recent',
            });
          } else {
            result = await openDocument({
              target: {
                kind: 'record',
                tabType: recentItem.open.tabType,
                entityId: recentItem.open.entityId,
              },
              label: recentItem.title,
              source: 'recent',
            });
          }

          if (result.status === 'presented') return true;
          if ('message' in result)
            useToastStore.getState().addToast(toUserMessage(result, 'operation.failed'), {
              definition: 'file-import-failed',
            });
          return false;
        },
      }),
    [openWorkspaceSource]
  );

  const openProject = useCallback(
    (project: { repoPath: string; name?: string }) => {
      setProjectHomePath(null);
      setProjectLibraryPopover(null);
      useLimsOverlayStore.getState().setActive(false);
      void openWorkspaceSource(
        {
          kind: 'local-folder',
          path: project.repoPath,
          ...(project.name ? { name: project.name } : {}),
        },

        { telemetrySource: 'recent', inPlace: true }
      );
    },
    [openWorkspaceSource, setProjectHomePath, setProjectLibraryPopover]
  );

  const handleOpenLibraryProject = useCallback(
    (workspace: WorkspaceLibraryEntry) => {
      openProject({ repoPath: workspace.repoPath, name: workspace.name });
    },
    [openProject]
  );

  const unmountManagedProject = useCallback(
    async (repoPath: string) => {
      const mountedFolders = useWorkspaceStore.getState().folders;
      const wasMounted = mountedFolders.some(
        (folder) => !folder.pinned && folder.path === repoPath
      );
      if (wasMounted) {
        removeFolder(repoPath);
      }
      if (projectHomePath === repoPath) setProjectHomePath(null);
    },
    [projectHomePath, removeFolder, setProjectHomePath]
  );

  useEffect(
    () =>
      registerWorkspaceProjectControl({
        open: openWorkspaceSource,
        unmount: unmountManagedProject,
        refresh: refreshWorkspaceLibrary,
      }),
    [openWorkspaceSource, unmountManagedProject, refreshWorkspaceLibrary]
  );

  const handleArchiveProject = useCallback(
    async (repoPath: string) => {
      const project =
        workspaceLibraryEntries.find((workspace) => workspace.repoPath === repoPath) ?? null;
      const label = project?.name ?? repoPath.split('/').filter(Boolean).pop() ?? repoPath;

      if (!getE2EParams().e2e && removalWouldLeaveNoWorkspace(folders, repoPath)) {
        useToastStore
          .getState()
          .addToast(
            userMessageWithValues(
              'notice.you-can-t-archive-value-it-s-your-only-project-and-dnaforge-always-kee',
              { value0: userMessageValue(label) }
            ),
            {
              definition:
                'app-you-can-t-archive-example-it-s-your-only-project-and-dnaforge-always-keep',
            }
          );
        return;
      }
      if (
        !(await confirmDialog({
          title: userMessage('dialog.archive-project'),
          message: userMessageWithValues('project.archiveConfirm', {
            name: userMessageValue(userEntityLabel(label, 'project.untitled')),
          }),
          confirmLabel: userMessage('dialog.archive'),
        }))
      ) {
        return;
      }

      let changed = 0;
      try {
        changed = await archiveWorkspaceByPath(repoPath);
      } catch (err) {
        useToastStore.getState().addToast(toUserMessage(err, 'operation.failed'), {
          definition: 'app-couldn-t-archive-example',
        });
        return;
      }

      if (changed === 0) {
        useToastStore.getState().addToast(
          userMessageWithValues('notice.couldn-t-archive-value-it-isn-t-a-managed-project-yet', {
            value0: userMessageValue(label),
          }),
          {
            definition: 'app-couldn-t-archive-example-it-isn-t-a-managed-project-yet',
          }
        );
        return;
      }

      await unmountManagedProject(repoPath);
      await refreshWorkspaceLibrary();
    },
    [folders, refreshWorkspaceLibrary, unmountManagedProject, workspaceLibraryEntries]
  );

  const handleTrashProject = useCallback(
    async (repoPath: string) => {
      const project =
        workspaceLibraryEntries.find((workspace) => workspace.repoPath === repoPath) ?? null;
      const label = project?.name ?? repoPath.split('/').filter(Boolean).pop() ?? repoPath;

      if (!getE2EParams().e2e && removalWouldLeaveNoWorkspace(folders, repoPath)) {
        useToastStore
          .getState()
          .addToast(
            userMessageWithValues(
              'notice.you-can-t-move-value-to-trash-it-s-your-only-project-and-dnaforge-alwa',
              { value0: userMessageValue(label) }
            ),
            {
              definition:
                'app-you-can-t-move-example-to-trash-it-s-your-only-project-and-dnaforge-alway',
            }
          );
        return;
      }
      if (
        !(await confirmDialog({
          title: userMessage('dialog.move-to-trash'),
          message: userMessageWithValues('project.trashConfirm', {
            name: userMessageValue(userEntityLabel(label, 'project.untitled')),
          }),
          confirmLabel: userMessage('dialog.move-to-trash'),
          tone: 'danger',
        }))
      ) {
        return;
      }

      let changed = 0;
      try {
        changed = await trashWorkspaceByPath(repoPath);
      } catch (err) {
        useToastStore.getState().addToast(toUserMessage(err, 'operation.failed'), {
          definition: 'app-couldn-t-move-example-to-trash',
        });
        return;
      }
      if (changed === 0) {
        useToastStore.getState().addToast(
          userMessageWithValues('notice.couldn-t-trash-value-it-isn-t-a-managed-project-yet', {
            value0: userMessageValue(label),
          }),
          {
            definition: 'app-couldn-t-trash-example-it-isn-t-a-managed-project-yet',
          }
        );
        return;
      }

      await unmountManagedProject(repoPath);
      await refreshWorkspaceLibrary();
      useToastStore
        .getState()
        .addToast(
          userMessageWithValues('notice.moved-value-to-trash', { value0: userMessageValue(label) }),
          { definition: 'app-moved-example-to-trash' }
        );
    },
    [folders, refreshWorkspaceLibrary, unmountManagedProject, workspaceLibraryEntries]
  );

  const handleRenameProject = useCallback(
    async (repoPath: string) => {
      const project =
        workspaceLibraryEntries.find((workspace) => workspace.repoPath === repoPath) ?? null;
      const currentName = project?.name ?? repoPath.split('/').filter(Boolean).pop() ?? repoPath;
      await renameProject(
        { repoPath, currentName },
        {
          promptForName: (name) =>
            promptDialog({
              title: userMessage('dialog.rename-project'),
              message: userMessageWithValues('project.renamePrompt', {
                name: userMessageValue(userEntityLabel(name, 'project.untitled')),
              }),
              confirmLabel: userMessage('dialog.rename'),
              input: {
                defaultValue: name,
                label: userMessage('dialog.project-name'),
                maxLength: MAX_MANAGED_WORKSPACE_NAME_LENGTH,
              },
            }),
          rename: renameWorkspaceByPath,
          renameMountedFolder: (path, name) =>
            useWorkspaceStore.getState().renameFolder(path, name),
          refreshLibrary: refreshWorkspaceLibrary,
          toast: (message, tone) =>
            useToastStore.getState().addToast(toUserMessage(message), {
              definition: 'entity-creation-result',
              variant: tone,
            }),
        }
      );
    },
    [refreshWorkspaceLibrary, workspaceLibraryEntries]
  );

  const handleOpenProjectHome = useCallback(
    (repoPath: string) => {
      useLimsOverlayStore.getState().setActive(false);
      handleViewChange('files');
      setProjectHomePath(repoPath);
    },
    [handleViewChange, setProjectHomePath]
  );

  const handleOpenRegistryFromProjectHome = useCallback(() => {
    setProjectHomePath(null);
    useLimsOverlayStore.getState().setActive(false);
    handleViewChange('lims');
  }, [handleViewChange, setProjectHomePath]);

  const handleRevealProject = useCallback(async (repoPath: string) => {
    try {
      await platform().shell.revealItemInDir(repoPath);
    } catch (err) {
      console.warn('[App] Failed to reveal project:', err);
    }
  }, []);

  const handleOpenProjectSwitcherFromHome = useCallback(() => {
    setProjectLibraryPopover({ x: 92, y: 44 });
  }, [setProjectLibraryPopover]);

  const artifactActions = useWorkspaceArtifactActions({
    folders,
    setCreateDestinationRequest,
    reconcileChangedWorkspace,
    handleCreateEntity,
    handleViewChange,
    workspaceRootFromCreationContext,
    artifactTitleFromCreationContext,
  });

  return {
    openWorkspaceSource,
    handleBenchlingMigrationUnlocked,
    handleOpenBenchlingWorkspace,
    migrationSettings,
    importFolderWithProgress,
    handleQuickLookDestinationCommit,
    handleAddFolder,
    _handleAddFolderInPlace,
    handleCreateEmptyWorkspace,
    resolveImportRoot,
    runSingleFileImport,
    handleHostedImport,
    handleHostedSignOut,
    handleImportFile,
    handleOpenRecentlyEdited,
    handleOpenLibraryProject,
    handleArchiveProject,
    handleTrashProject,
    handleRenameProject,
    handleOpenProjectHome,
    handleOpenRegistryFromProjectHome,
    handleRevealProject,
    handleOpenProjectSwitcherFromHome,
    ...artifactActions,
  };
}
