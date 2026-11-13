import { handleGroup } from '../../shared/ipc-contract';
import { app } from 'electron';
import type { CreateSampleWorkspaceInstanceRequest } from '../../shared/sample-workspace-ipc';
import {
  createSampleWorkspaceInstanceWithLock,
  resolveSampleWorkspaceResourceRoot,
} from '../sample-workspaces/factory';
import { workspaceSamplesContract } from '../../shared/ipc/workspace-samples.contract';

export function registerSampleWorkspaceHandlers(): void {
  handleGroup(workspaceSamplesContract, {
    createSampleInstance: async (_event, request: CreateSampleWorkspaceInstanceRequest) => {
      const resourcesRootPath = resolveSampleWorkspaceResourceRoot({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        appPath: app.getAppPath(),
      });
      return createSampleWorkspaceInstanceWithLock(request, {
        userDataPath: app.getPath('userData'),
        resourcesRootPath,
      });
    },
  });
}
