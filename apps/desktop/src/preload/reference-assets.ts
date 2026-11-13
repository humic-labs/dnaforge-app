import type { IpcRendererEvent } from 'electron';

import { rendererIpc } from '../shared/ipc-contract';
import type { ReferenceAssetsBridge } from '../shared/reference-assets-bridge';
export type { ReferenceAssetsBridge } from '../shared/reference-assets-bridge';
import {
  REFERENCE_ASSET_GET_HOSTED_PREPARATION_STATUS_CHANNEL,
  REFERENCE_ASSET_HOSTED_INSTALL_PROGRESS_CHANNEL,
  REFERENCE_ASSET_GET_LOCAL_PREPARATION_STATUS_CHANNEL,
  REFERENCE_ASSET_IMPORT_HUB_GENOME_CHANNEL,
  REFERENCE_ASSET_IMPORT_LOCAL_CHANNEL,
  REFERENCE_ASSET_INSTALL_HOSTED_CHANNEL,
  REFERENCE_ASSET_LIST_HOSTED_CHANNEL,
  REFERENCE_ASSET_SET_OPEN_VERSIONS_CHANNEL,
  REFERENCE_ASSET_LIST_LOCAL_CHANNEL,
  REFERENCE_ASSET_PREPARATION_PROGRESS_CHANNEL,
  REFERENCE_ASSET_RETRY_LOCAL_CHANNEL,
  type ReferenceAssetHostedInstallProgressV1,
  type ReferenceAssetPreparationProgressV1,
} from '../shared/reference-assets-ipc';

export const referenceAssetsPreloadBridge: ReferenceAssetsBridge = {
  importLocal: (request) => rendererIpc.invoke(REFERENCE_ASSET_IMPORT_LOCAL_CHANNEL, request),
  importHubGenome: (request) =>
    rendererIpc.invoke(REFERENCE_ASSET_IMPORT_HUB_GENOME_CHANNEL, request),
  listLocal: () => rendererIpc.invoke(REFERENCE_ASSET_LIST_LOCAL_CHANNEL),
  getLocalPreparationStatus: (request) =>
    rendererIpc.invoke(REFERENCE_ASSET_GET_LOCAL_PREPARATION_STATUS_CHANNEL, request),
  retryLocal: (request) => rendererIpc.invoke(REFERENCE_ASSET_RETRY_LOCAL_CHANNEL, request),
  setOpenVersions: (versions) =>
    rendererIpc.invoke(REFERENCE_ASSET_SET_OPEN_VERSIONS_CHANNEL, versions),
  listHosted: () => rendererIpc.invoke(REFERENCE_ASSET_LIST_HOSTED_CHANNEL),
  getHostedPreparationStatus: (request) =>
    rendererIpc.invoke(REFERENCE_ASSET_GET_HOSTED_PREPARATION_STATUS_CHANNEL, request),
  installHosted: (request) => rendererIpc.invoke(REFERENCE_ASSET_INSTALL_HOSTED_CHANNEL, request),
  onPreparationProgress: (callback) => {
    const subscription = (
      _event: IpcRendererEvent,
      progress: ReferenceAssetPreparationProgressV1
    ): void => callback(progress);
    rendererIpc.on(REFERENCE_ASSET_PREPARATION_PROGRESS_CHANNEL, subscription);
    return () =>
      rendererIpc.removeListener(REFERENCE_ASSET_PREPARATION_PROGRESS_CHANNEL, subscription);
  },
  onHostedInstallProgress: (callback) => {
    const subscription = (
      _event: IpcRendererEvent,
      progress: ReferenceAssetHostedInstallProgressV1
    ): void => callback(progress);
    rendererIpc.on(REFERENCE_ASSET_HOSTED_INSTALL_PROGRESS_CHANNEL, subscription);
    return () =>
      rendererIpc.removeListener(REFERENCE_ASSET_HOSTED_INSTALL_PROGRESS_CHANNEL, subscription);
  },
};
