import type {
  DeepSharePreflightResult,
  DeepSharePublishRequest,
  DeepSharePublishResult,
  DeepShareSelectionRequest,
} from '../deep-share-ipc';
import { defineGroup, invoke } from './contract';

export const cloudSyncDeepShareContract = defineGroup('cloudSync', {
  preflightDeepShare: invoke<
    [request: DeepShareSelectionRequest],
    DeepSharePreflightResult
  >().channel('deepShare:preflight'),
  publishDeepShare: invoke<[request: DeepSharePublishRequest], DeepSharePublishResult>().channel(
    'deepShare:publish'
  ),
  cancelDeepShare: invoke<[], { ok: true }>().channel('deepShare:cancel'),
});
