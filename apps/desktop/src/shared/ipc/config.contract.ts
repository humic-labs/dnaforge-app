import { defineGroup, invoke } from './contract';

export const configContract = defineGroup('config', {
  getApiUrl: invoke<[], string>(),
  getSidecarStatus: invoke<[], string>(),
  restartSidecar: invoke<[], string>(),
});
