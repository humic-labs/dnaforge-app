import type { WorkspaceSyncScientificRecoveryResult } from '../workspace-sync-ipc';
import { defineGroup, invoke, type ClientOf } from './contract';

export const scientificRecoveryContract = defineGroup('cloudSync', {
  recoverScientificDrafts: invoke<
    [workspaceUuid: string, candidateId: string],
    WorkspaceSyncScientificRecoveryResult
  >(),
});

export type ScientificRecoveryPort = ClientOf<typeof scientificRecoveryContract>;
