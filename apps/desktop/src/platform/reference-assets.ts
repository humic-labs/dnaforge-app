import type { ReferenceAssetsBridge } from '../shared/reference-assets-bridge';
export type { ReferenceAssetsBridge } from '../shared/reference-assets-bridge';

export function createReferenceAssetsPlatformBridge(
  getReferenceAssets: () => ReferenceAssetsBridge
): ReferenceAssetsBridge {
  return {
    importLocal: (request) => getReferenceAssets().importLocal(request),
    importHubGenome: (request) => getReferenceAssets().importHubGenome(request),
    listLocal: () => getReferenceAssets().listLocal(),
    getLocalPreparationStatus: (request) => getReferenceAssets().getLocalPreparationStatus(request),
    retryLocal: (request) => getReferenceAssets().retryLocal(request),
    setOpenVersions: (versions) =>
      getReferenceAssets().setOpenVersions?.(versions) ?? Promise.resolve(),
    listHosted: () => getReferenceAssets().listHosted(),
    getHostedPreparationStatus: (request) =>
      getReferenceAssets().getHostedPreparationStatus(request),
    installHosted: (request) => getReferenceAssets().installHosted(request),
    onPreparationProgress: (callback) => getReferenceAssets().onPreparationProgress(callback),
    onHostedInstallProgress: (callback) => getReferenceAssets().onHostedInstallProgress(callback),
  };
}
