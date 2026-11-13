import { WorkspaceSessionController } from '@waypoint/domain-services';
import { pathRelativeToBoundary } from '../../shared/path-boundary';
import { createElectronWorkspaceRuntime } from './electron-runtime';
import { isDeveloperImportSourcePath } from '../../shared/developer-import-sources';
import { createWorkspaceSessionFileCommands } from './session-file-commands';
import { canReadAcknowledgedSequence } from '../../services/acknowledged-sequence-read';

export const electronWorkspaceSessionController = new WorkspaceSessionController(
  createElectronWorkspaceRuntime()
);
export async function initializeElectronWorkspaceSession(
  preferredWorkspaceId?: string | null
): Promise<void> {
  await electronWorkspaceSessionController.initialize(preferredWorkspaceId);
}

export const {
  captureIntent: captureWorkspaceSessionIntent,
  configureCanvasSource: configureElectronWorkspaceSessionCanvasSource,
  openFile: openElectronWorkspaceSessionFile,
  closeFile: closeElectronWorkspaceSessionFile,
  bindTab: bindElectronWorkspaceSessionTab,
  refreshForPath: refreshElectronWorkspaceSessionForPath,
} = createWorkspaceSessionFileCommands(electronWorkspaceSessionController, {
  initialize: initializeElectronWorkspaceSession,
  refreshBeforeOpen: true,
  canReadAcknowledgedFile: canReadAcknowledgedSequence,
  workspaceIdFromRoot: (root) => root ?? null,
  resolveTarget: (absolutePath, rootPath) => {
    if (!rootPath || isDeveloperImportSourcePath(absolutePath)) return null;
    const relativePath = pathRelativeToBoundary(absolutePath, rootPath);
    return relativePath ? { workspaceId: rootPath, relativePath } : null;
  },
});
