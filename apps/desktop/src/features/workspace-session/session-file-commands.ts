import type { WorkspaceSessionController } from '@waypoint/domain-services';
import { findContainingPathBoundary, normalizePathForBoundary } from '../../shared/path-boundary';
import { SOFT_WARN_BYTES } from '../../shared/oversized-guard';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { createWorkspaceSessionCanvasBindings } from './canvas-session-bindings';
import { captureSessionIntent } from './session-intent';

interface WorkspaceSessionFileTarget {
  readonly workspaceId: string;
  readonly relativePath: string;
}

interface WorkspaceSessionFileAdapter {
  readonly initialize: (workspaceId: string) => Promise<void>;
  readonly refreshBeforeOpen: boolean;
  readonly canReadAcknowledgedFile?: (absolutePath: string) => Promise<boolean>;
  readonly resolveTarget: (
    absolutePath: string,
    rootPath: string | null
  ) => WorkspaceSessionFileTarget | null;
  readonly workspaceIdFromRoot: (rootPath: string | null | undefined) => string | null;
}

export function createWorkspaceSessionFileCommands(
  controller: WorkspaceSessionController,
  adapter: WorkspaceSessionFileAdapter
) {
  const canvasBindings = createWorkspaceSessionCanvasBindings(controller);

  async function selectWorkspace(workspaceId: string): Promise<void> {
    let state = controller.getState();
    if (!state.workspaces.some((workspace) => workspace.workspaceId === workspaceId)) {
      await adapter.initialize(workspaceId);
      state = controller.getState();
    }
    if (state.activeWorkspaceId !== workspaceId) {
      await controller.selectWorkspace(workspaceId);
    }
  }

  function ownsActiveFile(relativePath: string, absolutePath: string): boolean {
    const root = findContainingPathBoundary(useWorkspaceStore.getState().folders, absolutePath);
    const target = adapter.resolveTarget(absolutePath, root?.path ?? null);
    return (
      target?.workspaceId === controller.getState().activeWorkspaceId &&
      target?.relativePath === relativePath
    );
  }

  return {
    captureIntent: () => captureSessionIntent(controller),
    configureCanvasSource: canvasBindings.configure,
    bindTab(tabId: string, relativePath: string, absolutePath: string): void {
      if (ownsActiveFile(relativePath, absolutePath)) canvasBindings.bind(tabId, relativePath);
    },
    closeFile(relativePath: string, absolutePath: string): void {
      if (ownsActiveFile(relativePath, absolutePath)) controller.closeFile(relativePath);
    },
    async openFile(absolutePath: string): Promise<string | null> {
      const root = findContainingPathBoundary(useWorkspaceStore.getState().folders, absolutePath);
      const target = adapter.resolveTarget(absolutePath, root?.path ?? null);
      if (!target) return null;

      await selectWorkspace(target.workspaceId);
      const assertMountedTarget = (): void => {
        const currentRoot = findContainingPathBoundary(
          useWorkspaceStore.getState().folders,
          absolutePath
        );
        const currentTarget = adapter.resolveTarget(absolutePath, currentRoot?.path ?? null);
        if (
          !currentRoot ||
          currentRoot.mountRequest !== root?.mountRequest ||
          currentTarget?.workspaceId !== target.workspaceId ||
          currentTarget.relativePath !== target.relativePath
        )
          throw new Error('The project changed while verifying the acknowledged sequence read.');
      };
      if (adapter.canReadAcknowledgedFile) {
        const acknowledged = await adapter.canReadAcknowledgedFile(absolutePath);
        assertMountedTarget();
        if (acknowledged) return null;
      }
      let snapshot = controller.getState().snapshot;
      if (adapter.refreshBeforeOpen) {
        if (controller.getState().activeWorkspaceId === target.workspaceId)
          snapshot = await controller.refreshActiveWorkspace();
        if (snapshot?.workspaceId !== target.workspaceId)
          snapshot = await controller.peekWorkspace(target.workspaceId);
        assertMountedTarget();
      }
      let file = snapshot?.files.find((candidate) => candidate.path === target.relativePath);
      if (!file && !adapter.refreshBeforeOpen) {
        await controller.refreshActiveWorkspace();
        file = controller
          .getState()
          .snapshot?.files.find((candidate) => candidate.path === target.relativePath);
      }
      if (!file || file.sizeBytes >= SOFT_WARN_BYTES) return null;
      if (adapter.refreshBeforeOpen && snapshot && controller.getState().snapshot !== snapshot) {
        await controller.peekFile(snapshot, file);
        assertMountedTarget();
        return null;
      }
      await controller.openFile(file.path);
      if (adapter.refreshBeforeOpen) {
        assertMountedTarget();
        if (controller.getState().activeWorkspaceId !== target.workspaceId) return null;
      }
      return file.path;
    },
    async refreshForPath(
      absolutePath: string | null | undefined,
      workspaceRoot: string | null | undefined
    ): Promise<void> {
      const activeWorkspaceId = controller.getState().activeWorkspaceId;
      if (!activeWorkspaceId) return;
      const changedRoot =
        workspaceRoot ??
        (absolutePath
          ? findContainingPathBoundary(useWorkspaceStore.getState().folders, absolutePath)?.path
          : null);
      const changedWorkspaceId = adapter.workspaceIdFromRoot(changedRoot);
      if (
        !changedWorkspaceId ||
        normalizePathForBoundary(changedWorkspaceId) !== normalizePathForBoundary(activeWorkspaceId)
      ) {
        return;
      }
      await controller.refreshActiveWorkspace();
    },
  };
}
