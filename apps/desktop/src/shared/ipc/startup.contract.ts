import { defineGroup, invoke } from './contract';

export interface ShellReadinessSnapshot {
  loadId: string;
  pageLoaded: boolean;
  shellReady: boolean;
}

export const startupContract = defineGroup('startup', {
  getState: invoke<[], ShellReadinessSnapshot>(),
  isErrorReportingEnabled: invoke<[], boolean>(),
  acknowledge: invoke<[loadId: string], boolean>(),
});
