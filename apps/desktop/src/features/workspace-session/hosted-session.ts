import {
  hostedWorkspaceSessionController,
  initializeHostedWorkspaceSession,
} from '../../hosted/controller';
import { hostedWorkspaceIdFromInput, parseHostedFsPath } from '../../hosted/paths';
import { pathRelativeToBoundary } from '../../shared/path-boundary';
import { createWorkspaceSessionFileCommands } from './session-file-commands';

export const electronWorkspaceSessionController = hostedWorkspaceSessionController;

function workspaceIdFromRoot(rootPath: string | null | undefined): string | null {
  if (!rootPath) return null;
  return parseHostedFsPath(rootPath)?.workspaceId ?? null;
}

export async function initializeElectronWorkspaceSession(
  preferredWorkspaceId?: string | null
): Promise<void> {
  const nextId = hostedWorkspaceIdFromInput(preferredWorkspaceId);
  const state = hostedWorkspaceSessionController.getState();
  if (
    state.snapshot &&
    state.workspaces.length > 0 &&
    state.phase !== 'loading-index' &&
    state.phase !== 'loading-workspace'
  ) {
    if (nextId && nextId !== state.activeWorkspaceId) {
      await hostedWorkspaceSessionController.selectWorkspace(nextId);
    }
    return;
  }
  await initializeHostedWorkspaceSession(nextId);
}

export const {
  captureIntent: captureWorkspaceSessionIntent,
  configureCanvasSource: configureElectronWorkspaceSessionCanvasSource,
  openFile: openElectronWorkspaceSessionFile,
  closeFile: closeElectronWorkspaceSessionFile,
  bindTab: bindElectronWorkspaceSessionTab,
  refreshForPath: refreshElectronWorkspaceSessionForPath,
} = createWorkspaceSessionFileCommands(electronWorkspaceSessionController, {
  initialize: initializeHostedWorkspaceSession,
  refreshBeforeOpen: false,
  workspaceIdFromRoot,
  resolveTarget: (absolutePath, rootPath) => {
    const parsed = parseHostedFsPath(absolutePath);
    const workspaceId = parsed?.workspaceId ?? workspaceIdFromRoot(rootPath);
    const relativePath =
      parsed?.relativePath || (rootPath ? pathRelativeToBoundary(absolutePath, rootPath) : null);
    return workspaceId && relativePath ? { workspaceId, relativePath } : null;
  },
});
