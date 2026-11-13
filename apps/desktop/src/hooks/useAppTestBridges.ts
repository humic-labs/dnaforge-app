import { waitForNativeFileDocumentReadiness } from '../features/workspace/public/file-document-client';
import { captureProjectLifecycle } from '../features/workspace-loader/workspace-telemetry';
import { useEffect, type MutableRefObject } from 'react';
import type { WorkspaceCreationContext } from '../components/FileBrowser';
import type { UseWorkspaceReturn } from './useWorkspace';
import type { OpenWorkspaceOptions, WorkspaceSource } from '../features/workspace-loader/types';
import { openSequenceFile } from '../features/document-opening/compat';
import { shouldEnableTestBridge } from '../lib/test-bridge-gate';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { waitForWorkspaceReconcileIdle } from '../services/workspace-reconcile-lifecycle';
import { reconcileMountedWorkspaceRoot } from '../services/mounted-workspace-reconcile';

type DevTestWindow = Window & {
  __test?: Record<string, unknown>;
};

type E2EParams = {
  workspace?: string;
  openFile?: string;
  e2e?: boolean;
};

type AppTestBridgesOptions = {
  readonly shellPrepared: boolean;
  readonly workspacePath: string | null;
  readonly workspaceLoading: boolean;
  readonly setWorkspacePath: UseWorkspaceReturn['setWorkspacePath'];
  readonly e2eHasInitializedRef: MutableRefObject<boolean>;
  readonly openWorkspaceSource: (
    source: WorkspaceSource,
    options?: OpenWorkspaceOptions
  ) => Promise<unknown>;
  readonly importFolderWithProgress: (
    path: string,
    options?: { inPlace?: boolean }
  ) => Promise<unknown>;
  readonly resolveImportRoot: () => string | null;
  readonly runSingleFileImport: (
    root: string,
    sourcePath: string
  ) => Promise<{ ok: boolean; destPath?: string }>;
  readonly handleNewPage: (context: WorkspaceCreationContext) => void;
  readonly handleNewDesign: (context: WorkspaceCreationContext) => void;
  readonly getE2EParams: () => E2EParams;
  readonly getDevTestWindow: () => DevTestWindow | null;
  readonly isDev: boolean;
  readonly e2eFixturesPath: string;
};

export function useAppTestBridges({
  shellPrepared,
  workspacePath,
  workspaceLoading,
  setWorkspacePath,
  e2eHasInitializedRef,
  openWorkspaceSource,
  importFolderWithProgress,
  resolveImportRoot,
  runSingleFileImport,
  handleNewPage,
  handleNewDesign,
  getE2EParams,
  getDevTestWindow,
  isDev,
  e2eFixturesPath,
}: AppTestBridgesOptions): void {
  useEffect(() => {
    const e2eParams = getE2EParams();
    if (workspacePath) e2eHasInitializedRef.current = true;

    if (e2eParams.workspace && !workspacePath && !workspaceLoading && shellPrepared) {
      console.log('[App] Setting workspace from URL:', e2eParams.workspace);
      setWorkspacePath(e2eParams.workspace);
    }

    if (!isDev || !e2eParams.e2e || !shellPrepared) return;
    console.log('[E2E] Test mode enabled');

    if (
      e2eParams.workspace &&
      !workspacePath &&
      !workspaceLoading &&
      !e2eHasInitializedRef.current
    ) {
      console.log('[E2E] Setting workspace to:', e2eParams.workspace);
      setWorkspacePath(e2eParams.workspace);
    }

    const testUtils = {
      openFile: (path: string) => {
        const fileName = path.split('/').pop() || 'Untitled';
        console.log('[E2E] Opening file:', path);
        return openSequenceFile({
          filePath: path,
          label: fileName,
          strategy: { kind: 'focused' },
          sourceSurface: 'file_tree',
        });
      },
      setWorkspace: (path: string) => {
        console.log('[E2E] Setting workspace to:', path);
        return setWorkspacePath(path);
      },
      getFixturesPath: () => e2eFixturesPath,
    };

    // @ts-expect-error - Adding test utils to window
    window.__e2eTestUtils = testUtils;
    if (e2eParams.openFile) void testUtils.openFile(e2eParams.openFile);

    return () => {
      // @ts-expect-error - Cleaning up test utils
      delete window.__e2eTestUtils;
    };
  }, [
    e2eFixturesPath,
    e2eHasInitializedRef,
    getE2EParams,
    isDev,
    setWorkspacePath,
    shellPrepared,
    workspaceLoading,
    workspacePath,
  ]);

  useEffect(() => {
    if (!shouldEnableTestBridge(import.meta.env)) return;
    const bridge = getDevTestWindow()?.__test;
    if (!bridge) return;

    bridge.projectLifecycleOperationForTest = (root: string) =>
      captureProjectLifecycle(root)?.operationId;
    bridge.openProjectSourceForTest = (source: WorkspaceSource, options: OpenWorkspaceOptions) =>
      openWorkspaceSource(source, options);
    bridge.openWorkspaceFolder = (path: string) =>
      openWorkspaceSource({ kind: 'local-folder', path }, { telemetrySource: 'e2e' });
    bridge.importFolderWithProgress = (path: string) => importFolderWithProgress(path);
    bridge.mountFolderInPlace = async (path: string) => {
      await importFolderWithProgress(path, { inPlace: true });
      await waitForNativeFileDocumentReadiness();
    };
    bridge.createEmptyWorkspace = async () => {
      await openWorkspaceSource(
        { kind: 'empty' },
        { replaceCurrent: false, telemetrySource: 'folder_picker' }
      );
    };
    bridge.getWorkspaceRootPaths = () =>
      useWorkspaceStore.getState().folders.map((folder) => folder.path);
    bridge.waitForWorkspaceReconcileIdle = (workspaceRoot: string) =>
      waitForWorkspaceReconcileIdle(workspaceRoot);
    bridge.reconcileWorkspaceRootForTest = (workspaceRoot: string) =>
      reconcileMountedWorkspaceRoot(workspaceRoot, {
        strict: true,
        waitForMutationAvailability: true,
      });
    bridge.setCompatibilityWorkspacePathForTest = (path: string) =>
      setWorkspacePath(path, { addToRecents: false });
    bridge.importFileIntoActiveWorkspace = async (sourcePath: string) => {
      const targetRoot = resolveImportRoot();
      if (!targetRoot) return { ok: false as const };
      const result = await runSingleFileImport(targetRoot, sourcePath);
      return { ...result, targetRoot };
    };
    bridge.createNotebookArtifact = (context: WorkspaceCreationContext) => handleNewPage(context);
    bridge.createAssemblyArtifact = (context: WorkspaceCreationContext) => handleNewDesign(context);

    return () => {
      delete bridge.projectLifecycleOperationForTest;
      delete bridge.openProjectSourceForTest;
      delete bridge.openWorkspaceFolder;
      delete bridge.importFolderWithProgress;
      delete bridge.mountFolderInPlace;
      delete bridge.createEmptyWorkspace;
      delete bridge.getWorkspaceRootPaths;
      delete bridge.waitForWorkspaceReconcileIdle;
      delete bridge.reconcileWorkspaceRootForTest;
      delete bridge.setCompatibilityWorkspacePathForTest;
      delete bridge.importFileIntoActiveWorkspace;
      delete bridge.createNotebookArtifact;
      delete bridge.createAssemblyArtifact;
    };
  }, [
    getDevTestWindow,
    handleNewDesign,
    handleNewPage,
    importFolderWithProgress,
    openWorkspaceSource,
    resolveImportRoot,
    runSingleFileImport,
    setWorkspacePath,
  ]);
}
