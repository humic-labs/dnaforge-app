import { defineGroup, invoke } from './contract';

export const pathContract = defineGroup('path', {
  appDataDir: invoke<[], string>(),
  referenceAssetCacheRoot: invoke<[], string>(),
  referenceAssetPublicationRoot: invoke<[], string>(),
  projectRoot: invoke<[], string | null>(),
});
