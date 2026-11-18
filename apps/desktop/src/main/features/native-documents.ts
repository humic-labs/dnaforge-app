import { createNativeNotebookWorkingCopies } from '../native-notebook-working-copies';
import { MarkdownNotebookImporter } from '../markdown-notebook-import';
import { nativeNotebookDocumentAdapter } from '../native-notebook-document-adapter';
import { requestEntityNavigation } from './entity-navigation';
import { registerWorkTaskHandlers } from '../ipc/work-tasks';
import { registerNotebookOwnerHandlers } from '../ipc/notebook';
import {
  createFileDocumentClientSync,
  type FileDocumentClientReadinessReader,
} from '../file-document-client-sync';
import { createNativeFileDocuments } from '../native-file-documents';
import { NativeTableDocumentCommands } from '../table-document-commands';
import { readTablePackageInMain } from '../table-package';
import { readProjectResourceIdentityInMain } from '../project-filesystem-authority';
import { managedProjectStorageRoot } from '../project-root-admission';
import { registerWorkspaceFileInDb } from '../catalog-entity-registration';
import { createNativeSequenceWorkingCopies } from '../native-sequence-working-copies';
import { NativeDocumentDispatcher } from '../native-document-dispatcher';
import { createWorkspaceFileRelocator } from '../workspace-file-relocation';
import { nativeSequenceDocumentAdapter } from '../native-sequence-document-adapter';
import { createNativeWorkspaceCommands } from '../native-workspace-commands';
import type { AdministrationOwner } from '../administration-owner';
import { createNativeImportReviews } from '../native-import-reviews';
import { importReviewContract } from '../../shared/ipc/import-review.contract';
import {
  settleNativeDirtyDocuments,
  type NativeDirtySettlementRequest,
} from '../../shared/native-dirty-documents';
import { registerNativeDirtyStateProvider } from '../dirty-state-cache';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { handleGroup, sendRendererIpc } from '../../shared/ipc-contract';
import type { NativeDocumentWorkspaceRootsRequest } from '../../shared/native-document-workspaces';
import type { FileDocumentFlushPurpose } from '../../shared/file-document-client-sync';
import type { NativeAnnotationDocumentBarrier } from '../managed-annotation-document-command';
import { NativeAnnotationDocumentOwner } from '../native-annotation-document-owner';
import { startNativeDocumentCommandServer } from '../native-document-command-server';
import { nativeDocumentProfileKey } from '../native-document-owner-identity';
import {
  createNativeDocumentMutationBarrier,
  createNativeDocumentRendererPublisher,
} from '../native-document-renderer';
import { NativeDocumentStartupRecovery } from '../native-document-startup-recovery';
import { NativeDocumentWorkspaces } from '../native-document-workspaces';
import { getDb } from '../ipc/database';
import {
  nativeDocumentFetch,
  registerNativeDocumentCommandServer,
  sidecarSessionAuthority,
} from '../sidecar-session-runtime';
import { withNativeDocumentSettlementTestSeam } from './test-hooks';
import { reportNativeSaveFailure } from '../save-failure-diagnostics';
import { workspaceNativeDocumentsContract } from '../../shared/ipc/workspace-native-documents.contract';
import {
  createRegisteredProjectAuthority,
  withAgentProjectScope,
} from '../registered-project-authority';

type RendererPublisher = ReturnType<typeof createNativeDocumentRendererPublisher>;
type CommandServer = Awaited<ReturnType<typeof startNativeDocumentCommandServer>>;

export interface NativeDocumentsStart {
  readonly editingClient: 'renderer' | 'none';
  readonly canAssertNoEditingClient: () => boolean;
}

export type CurrentRendererLoad = (event: IpcMainInvokeEvent, loadId: string) => boolean;

export function createNativeDocuments(
  options: { registerDirtyState?: typeof registerNativeDirtyStateProvider } = {}
) {
  const projectAuthority = createRegisteredProjectAuthority({ db: getDb });
  const workspaces = new NativeDocumentWorkspaces({
    authority: projectAuthority,
  });
  let profileKey: string | null = null;
  let profileDirectory: string | null = null;
  const fileRelocations = createWorkspaceFileRelocator({
    db: getDb,
    fileDocuments: () => fileDocuments,
  });
  const sequenceDocuments = createNativeSequenceWorkingCopies({
    db: getDb,
    workspaceRoots: () => workspaces.readableRoots(),
    writableWorkspaceRoots: () => workspaces.roots(),
    captureWorkspace: (root, mutating) =>
      mutating ? workspaces.capture(root) : workspaces.captureReadable(root),
    profileDirectory: () => {
      if (!profileDirectory) throw new Error('Sequence documents started before their profile.');
      return profileDirectory;
    },
  });
  const ordinaryFiles = createNativeFileDocuments({
    db: getDb,
    workspaceRoots: () => workspaces.readableRoots(),
    writableWorkspaceRoots: () => workspaces.roots(),
    captureWorkspace: (root, mutating) =>
      mutating ? workspaces.capture(root) : workspaces.captureReadable(root),
    profileDirectory: () => {
      if (!profileDirectory) throw new Error('File documents started before their profile.');
      return profileDirectory;
    },
  });
  const notebookDocuments = createNativeNotebookWorkingCopies({
    db: getDb,
    tableDocuments: () => tableDocuments,
    workspaceAccess: (root) => workspaces.access(root),
    relocateEntityFile: (input) => fileRelocations.relocateEntityFile(input),
    workspaceRoots: () => workspaces.readableRoots(),
    writableWorkspaceRoots: () => workspaces.roots(),
    captureWorkspace: (root, mutating) =>
      mutating ? workspaces.capture(root) : workspaces.captureReadable(root),
    profileDirectory: () => {
      if (!profileDirectory) throw new Error('Notebook documents started before their profile.');
      return profileDirectory;
    },
  });
  const fileDocuments = new NativeDocumentDispatcher({
    db: getDb,
    workspaceRoots: () => workspaces.readableRoots(),
    ordinary: ordinaryFiles,
    adapters: [
      nativeSequenceDocumentAdapter(sequenceDocuments),
      nativeNotebookDocumentAdapter(notebookDocuments),
    ],
  });
  const tableDocuments = new NativeTableDocumentCommands({
    db: getDb,
    workspaceRoots: () => workspaces.readableRoots(),
    writableWorkspaceRoots: () => workspaces.roots(),
    workspaceAccess: (root) => workspaces.access(root),
    managedRootDir: managedProjectStorageRoot,
    captureWorkspace: (root, mutating) =>
      mutating ? workspaces.capture(root) : workspaces.captureReadable(root),
    files: ordinaryFiles,
    notebookTables: notebookDocuments.tableTransitions,
    reconcileTablePackage: async (location) => {
      const assertCurrent = workspaces.capture(location.workspaceRoot);
      const actual = await readTablePackageInMain(location);
      const identity = await readProjectResourceIdentityInMain(location, {
        db: getDb(),
        managedRootDir: managedProjectStorageRoot(),
      });
      assertCurrent();
      if (!identity) throw new Error('The table project has no portable identity.');
      registerWorkspaceFileInDb(getDb(), {
        path: actual.headPath,
        workspaceRoot: location.workspaceRoot,
        entityType: 'file',
        fileKind: 'dnaforge-table',
        name: actual.snapshot.title,
      });
      const copy = await ordinaryFiles.execute({
        target: { path: actual.headPath, workspaceRoot: location.workspaceRoot },
        operation: {
          kind: 'inspect',
          offset: 0,
          limit: 2000,
          rowOffset: 0,
          rowLimit: 20,
          columnOffset: 0,
          columnLimit: 20,
        },
      });
      assertCurrent();
      if (!copy.ready || copy.tableDocument?.id !== actual.head.id)
        throw new Error('The native file owner could not verify the table package.');
      return {
        projectId: identity.projectId,
        tableId: actual.head.id,
        fileDocumentId: copy.documentId,
        headPath: actual.headPath,
      };
    },
  });
  const markdownImporter = new MarkdownNotebookImporter({
    onMigrationCandidatesChanged: (workspaceRoot) => {
      const target = notebookTarget?.();
      if (!target || target.isDestroyed()) return false;
      sendRendererIpc(target, 'workspace:migrationCandidatesChanged', { workspaceRoot });
      return true;
    },
    readableRoots: () => workspaces.observedReadableRoots(),
    onIssue: (issue) => {
      const target = notebookTarget?.();
      if (target && !target.isDestroyed())
        sendRendererIpc(target, 'notebook:markdownAdoptionFailed', issue);
    },
    db: getDb,
    roots: () => workspaces.observedRoots(),
    captureWorkspace: (root) => workspaces.capture(root),
    withCleanPaths: async (paths, operation) => {
      await flushFileDocumentClients();
      return fileDocuments.withCleanPaths(paths, operation);
    },
    onAdopted: (result) => {
      const target = notebookTarget?.();
      if (target && !target.isDestroyed())
        sendRendererIpc(target, 'notebook:markdownAdopted', result);
    },
  });
  const importReviews = createNativeImportReviews({
    db: getDb,
    workspaceRoots: () => workspaces.readableRoots(),
    captureWorkspace: (root) => workspaces.capture(root),
    profileDirectory: () => {
      if (!profileDirectory) throw new Error('Import reviews started before their profile.');
      return profileDirectory;
    },
  });
  const legacyDraftMigrationListeners = new Set<() => void>();
  let publishHistory: ((root: string) => void) | undefined;
  const workspaceCommands = createNativeWorkspaceCommands({
    db: getDb,
    readableRoots: () => workspaces.readableRoots(),
    writableRoots: () => workspaces.roots(),
    captureWorkspace: (root, mutating) =>
      mutating ? workspaces.capture(root) : workspaces.captureReadable(root),
    assertFileSaved: (path) => fileDocuments.assertClean(path),
    publishHistory: (root) => publishHistory?.(root),
  });
  let administration: AdministrationOwner | null = null;
  let notebookTarget: (() => WebContents | null) | null = null;
  let notebookHandlersRegistered = false;
  let detachImportReviewPublisher: (() => void) | null = null;
  let rendererPublisher: RendererPublisher | null = null;
  let fileClientSync: ReturnType<typeof createFileDocumentClientSync> | null = null;
  let fileEditingClient: 'renderer' | 'none' = 'renderer';
  let assertNoFileEditingClient: (() => boolean) | undefined;
  let commandServer: CommandServer | null = null;
  let detachCommandServer: (() => void) | null = null;
  let startupRecovery: NativeDocumentStartupRecovery | null = null;
  const dirtyStateProvider = options.registerDirtyState?.({
    listDirty: () => fileDocuments.listDirty(),
    subscribe: (listener) => fileDocuments.subscribe(listener),
    flush: flushDirtyDocumentClients,
  });

  function bindProfile(userDataPath: string): void {
    profileDirectory = userDataPath;
    profileKey = nativeDocumentProfileKey(userDataPath);
    sidecarSessionAuthority.bindNativeDocumentProfile(profileKey);
    void dirtyStateProvider?.refresh();
  }

  async function start({ editingClient, canAssertNoEditingClient }: NativeDocumentsStart) {
    fileEditingClient = editingClient;
    assertNoFileEditingClient = canAssertNoEditingClient;
    if (profileKey === null) throw new Error('Native documents started before their profile.');
    const boundProfileKey = profileKey;
    const nativeAuthority = sidecarSessionAuthority.nativeDocumentAuthority(
      sidecarSessionAuthority.snapshot()
    );
    if (!nativeAuthority && editingClient === 'none') {
      throw new Error('The managed runtime requires its own native document authority.');
    }
    if (!nativeAuthority) return;
    const owner = new NativeAnnotationDocumentOwner({
      nativeOwnerInstanceId: nativeAuthority.ownerInstanceId,
      db: getDb,
      workspaceRoots: () => workspaces.roots(),
      fetch: withNativeDocumentSettlementTestSeam(nativeDocumentFetch),
      prepare: async (actionId, document) => {
        const assertWorkspace = workspaces.capture(document.workspaceRoot);
        let barrier: NativeAnnotationDocumentBarrier;
        if (editingClient === 'none') {
          const assertNoEditingClient = () => {
            if (!canAssertNoEditingClient()) {
              throw new Error('This runtime cannot assert that no editing client exists.');
            }
          };
          assertNoEditingClient();
          let settled = false;
          barrier = {
            assertCurrent() {
              if (settled) throw new Error('Document protection was already released.');
              assertNoEditingClient();
            },
            async finish() {
              assertNoEditingClient();
              settled = true;
              return 'not-required';
            },
            abort() {
              settled = true;
            },
          };
        } else {
          const publisher = rendererPublisher;
          if (!publisher) throw new Error('Document editing protection is unavailable.');
          barrier = await createNativeDocumentMutationBarrier(publisher, actionId)(document);
        }
        let nativeProtection: Awaited<ReturnType<typeof sequenceDocuments.protectCleanDocument>>;
        try {
          await flushFileDocumentClients();
          nativeProtection = await sequenceDocuments.protectCleanDocument(
            document.documentId,
            document.sourcePath
          );
        } catch (error) {
          barrier.abort('unchanged');
          throw error;
        }
        return {
          assertCurrent() {
            assertWorkspace();
            barrier.assertCurrent();
            nativeProtection.assertCurrent();
          },
          async finish() {
            await nativeProtection.finish();
            return barrier.finish();
          },
          abort(disposition) {
            nativeProtection.abort(disposition);
            barrier.abort(disposition);
          },
        };
      },
    });
    commandServer = await startNativeDocumentCommandServer({
      projectAuthority,
      owner,
      fileOwner: fileDocuments,
      sequenceOwner: sequenceDocuments,
      notebookOwner: notebookDocuments,
      tableOwner: tableDocuments,
      flushFileClients: () => flushFileDocumentClients(),
      workspaceCommands,
      importReviews,
      administration: {
        execute: (input, assertCurrent, agent) => {
          if (!administration)
            throw new Error(
              'ADMINISTRATION_UNAVAILABLE: The native administration owner is not ready.'
            );
          return administration.execute(input, assertCurrent, agent);
        },
      },
      getAuthority() {
        const current = sidecarSessionAuthority.snapshot();
        return current.state === 'ready'
          ? (sidecarSessionAuthority.nativeDocumentAuthority(current) ?? null)
          : null;
      },
    });
    detachCommandServer = registerNativeDocumentCommandServer(
      commandServer.url,
      nativeAuthority.ownerInstanceId
    );
    startupRecovery = new NativeDocumentStartupRecovery({
      owner,
      nativeOwnerInstanceId: nativeAuthority.ownerInstanceId,
      profileKey: boundProfileKey,
      ready: async () => {
        const snapshot = await sidecarSessionAuthority.waitForReadySnapshot();
        return () => sidecarSessionAuthority.isCurrent(snapshot);
      },
      report: (result) => console.log('[NativeDocuments] Startup observation:', result),
    });
    if (workspaces.observedRoots().length > 0) {
      requestObservedRecovery();
    }
  }

  function startRendererPublisher(
    getTarget: () => WebContents | null,
    getReadiness: FileDocumentClientReadinessReader = () => undefined
  ): void {
    notebookTarget = getTarget;
    if (!notebookHandlersRegistered) {
      registerWorkTaskHandlers(notebookDocuments, requestEntityNavigation, getDb);
      registerNotebookOwnerHandlers(
        notebookDocuments,
        () => notebookTarget?.() ?? null,
        markdownImporter,
        flushFileDocumentClients,
        () => {
          for (const listener of legacyDraftMigrationListeners) {
            try {
              listener();
            } catch (error) {
              console.warn('[Native notebook recovery] Draft completion listener failed:', error);
            }
          }
        }
      );
      notebookHandlersRegistered = true;
    }
    publishHistory = (root) => {
      const target = getTarget();
      if (target && !target.isDestroyed())
        sendRendererIpc(target, 'shell:projectHistoryChanged', root);
    };
    fileClientSync?.close();
    fileClientSync = createFileDocumentClientSync(getTarget, getReadiness);
    detachImportReviewPublisher?.();
    detachImportReviewPublisher = importReviews.subscribe((event) => {
      const target = getTarget();
      if (target && !target.isDestroyed()) sendRendererIpc(target, 'importReview:changed', event);
    });
    rendererPublisher = createNativeDocumentRendererPublisher(getTarget);
    rendererPublisher.start();
  }

  function registerWorkspaceRootsHandler(isCurrentRendererLoad: CurrentRendererLoad): void {
    handleGroup(importReviewContract, {
      call: (_event, request) => importReviews.call(request),
      snapshot: (_event, id) => importReviews.snapshot(id),
    });
    handleGroup(workspaceNativeDocumentsContract, {
      listRegisteredProjects: () => projectAuthority.folders(),
      resolveRegisteredProject: (_event, reference) => {
        if (typeof reference !== 'string' || reference.length === 0 || reference.length > 4096)
          throw new Error('A registered project reference is required.');
        const project = projectAuthority.resolve(reference);
        return project
          ? { path: project.path, name: project.name, addedAt: 0, pinned: project.pinned }
          : null;
      },
      setDocumentCommandRoots: async (
        event,
        request: NativeDocumentWorkspaceRootsRequest
      ): Promise<boolean> => {
        const isCurrent = () =>
          typeof request?.loadId === 'string' && isCurrentRendererLoad(event, request.loadId);
        if (!isCurrent()) throw new Error('Untrusted document workspace enrollment sender.');
        const enrolled = await workspaces.replaceRoots(
          request.roots,
          isCurrent,
          request.readableRoots ?? request.roots
        );
        void dirtyStateProvider?.refresh();
        if (enrolled) {
          fileDocuments.beginLegacyMigration();
          sequenceDocuments.beginLegacyMigration();
          notebookDocuments.beginLegacyMigration();
          markdownImporter.refreshRoots();
          requestObservedRecovery();
        }
        return enrolled;
      },
    });
  }

  function requestObservedRecovery(): void {
    void withAgentProjectScope(
      { kind: 'project-roots', roots: [...workspaces.observedReadableRoots()] },
      () => startupRecovery?.request()
    );
  }

  async function closeServerAndRecovery(): Promise<void> {
    await markdownImporter.close();
    const recovery = startupRecovery;
    const server = commandServer;
    startupRecovery = null;
    commandServer = null;
    await Promise.all([recovery?.close(), server?.close()]);
    await fileDocuments.close();
  }

  function detachServer(): void {
    const detach = detachCommandServer;
    detachCommandServer = null;
    detach?.();
  }

  function stopRendererPublisher(): void {
    notebookTarget = null;
    publishHistory = undefined;
    fileClientSync?.close();
    fileClientSync = null;
    detachImportReviewPublisher?.();
    detachImportReviewPublisher = null;
    const publisher = rendererPublisher;
    rendererPublisher = null;
    publisher?.stop();
  }

  async function flushFileDocumentClients(
    purpose: FileDocumentFlushPurpose = 'synchronize'
  ): Promise<void> {
    if (fileEditingClient === 'none') {
      if (!assertNoFileEditingClient?.())
        throw new Error('The native runtime cannot assert that no editing client exists.');
      return;
    }
    if (!fileClientSync) throw new Error('FILE_DOCUMENT_CLIENT_NOT_READY');
    await fileClientSync.flush(purpose);
  }

  async function flushDirtyDocumentClients(
    purpose: FileDocumentFlushPurpose = 'synchronize'
  ): Promise<void> {
    if (fileEditingClient === 'none' || fileClientSync?.hasLiveTarget())
      await flushFileDocumentClients(purpose);
  }

  async function settleDirtyDocuments(request: NativeDirtySettlementRequest) {
    const reported = new Set<unknown>();
    const reportedMessages = new Set<string>();
    const report = (error: unknown): void => {
      if (request.action !== 'save' || reported.has(error)) return;
      reported.add(error);
      reportedMessages.add(error instanceof Error ? error.message : String(error));
      reportNativeSaveFailure(error);
    };
    const observe = async <T>(run: () => Promise<T>): Promise<T> => {
      try {
        return await run();
      } catch (error) {
        report(error);
        throw error;
      }
    };
    try {
      const result = await settleNativeDirtyDocuments(request, {
        listDirty: () => observe(() => fileDocuments.listDirty()),
        execute: (command) => observe(() => fileDocuments.execute(command)),
        beforeList: () =>
          observe(() =>
            flushDirtyDocumentClients(request.action === 'discard' ? 'discard' : 'synchronize')
          ),
      });
      if (request.action === 'save') {
        for (const failure of result.failures)
          if (!reportedMessages.has(failure.error)) report(failure.error);
        if (!result.failures.length && result.remaining.length)
          report('Some native documents still have unsaved work.');
      }
      return result;
    } catch (error) {
      report(error);
      throw error;
    }
  }

  return {
    workspaces,
    onLegacyDraftMigrationCompleted(listener: () => void) {
      legacyDraftMigrationListeners.add(listener);
      return () => {
        legacyDraftMigrationListeners.delete(listener);
      };
    },
    sequenceDocuments,
    notebookDocuments,
    fileDocuments,
    tableDocuments,
    fileRelocations,
    flushFileDocumentClients,
    flushDirtyDocumentClients,
    settleDirtyDocuments,
    workspaceCommands,
    setAdministration: (owner: AdministrationOwner) => {
      if (administration && administration !== owner)
        throw new Error('The native administration owner is already bound.');
      administration = owner;
    },
    acknowledgeFileDocumentFlush: (
      sender: WebContents,
      ack: import('../../shared/file-document-client-sync').FileDocumentClientFlushAck
    ) => fileClientSync?.acknowledge(sender, ack) ?? false,
    importReviews,
    bindProfile,
    start,
    startRendererPublisher,
    rendererPublisher: (): RendererPublisher | null => rendererPublisher,
    registerWorkspaceRootsHandler,
    closeServerAndRecovery,
    detachCommandServer: detachServer,
    stopRendererPublisher,
  };
}

export const nativeDocuments = createNativeDocuments({
  registerDirtyState: registerNativeDirtyStateProvider,
});
