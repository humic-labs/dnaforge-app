import { defineGroup, invoke } from './contract';

export const updateContract = defineGroup('update', {
  install: invoke<[expectedVersion?: string], import('../update-ipc').UpdateInstallResult>(),
  retry: invoke<[], void>(),
  checkManual: invoke<[], void>().channel('update:check-manual'),
});
