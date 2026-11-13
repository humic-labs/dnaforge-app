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

  return {
    captureIntent: () => captureSessionIntent(controller),
    configureCanvasSource: canvasBindings.configure,
    bindTab: canvasBindings.bind,
    closeFile: (relativePath: string) => controller.closeFile(relativePath),
    async openFile(absolutePath: string): Promise<string | null> {
      const root = findContainingPathBoundary(useWorkspaceStore.getState().folders, absolutePath);
      const target = adapter.resolveTarget(absolutePath, root?.path ?? null);
      if (!target) return null;

      await selectWorkspace(target.workspaceId);
      if (adapter.canReadAcknowledgedFile) {
        const acknowledged = await adapter.canReadAcknowledgedFile(absolutePath);
        const currentRoot = findContainingPathBoundary(
          useWorkspaceStore.getState().folders,
          absolutePath
        );
        const currentTarget = adapter.resolveTarget(absolutePath, currentRoot?.path ?? null);
        if (
          !currentRoot ||
          currentRoot.mountRequest !== root?.mountRequest ||
          currentTarget?.workspaceId !== target.workspaceId ||
          currentTarget.relativePath !== target.relativePath ||
          controller.getState().activeWorkspaceId !== target.workspaceId
        )
          throw new Error('The project changed while verifying the acknowledged sequence read.');
        if (acknowledged) return null;
      }
      const snapshot = adapter.refreshBeforeOpen
        ? await controller.refreshActiveWorkspace()
        : controller.getState().snapshot;
      let file = snapshot?.files.find((candidate) => candidate.path === target.relativePath);
      if (!file && !adapter.refreshBeforeOpen) {
        await controller.refreshActiveWorkspace();
        file = controller
          .getState()
          .snapshot?.files.find((candidate) => candidate.path === target.relativePath);
      }
      if (!file || file.sizeBytes >= SOFT_WARN_BYTES) return null;
      await controller.openFile(file.path);
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
