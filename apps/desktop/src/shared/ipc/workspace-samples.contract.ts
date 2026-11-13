import type { SampleWorkspaceInstanceResult } from '../sample-workspace-ipc';
import { defineGroup, invoke } from './contract';

export const workspaceSamplesContract = defineGroup('workspace', {
  createSampleInstance: invoke<
    [
      request: {
        templateId: string;
        mode?: 'reuse' | 'fresh';
      },
    ],
    SampleWorkspaceInstanceResult
  >(),
});
