import type {
  HostedReferenceCatalogEntryV1,
  OpenReferenceVersionV1,
  PreparedReferenceAssemblyEntryV1,
  ReferenceAssetGetHostedPreparationStatusRequestV1,
  ReferenceAssetGetLocalPreparationStatusRequestV1,
  ReferenceAssetHostedInstallProgressV1,
  ReferenceAssetHostedPreparationStatusV1,
  ReferenceAssetImportHubGenomeRequestV1,
  ReferenceAssetImportHubGenomeResultV1,
  ReferenceAssetImportLocalRequestV1,
  ReferenceAssetImportLocalResultV1,
  ReferenceAssetInstallHostedRequestV1,
  ReferenceAssetInstallHostedResultV1,
  ReferenceAssetLocalPreparationStatusV1,
  ReferenceAssetPreparationProgressV1,
  ReferenceAssetRetryLocalRequestV1,
  ReferenceAssetRetryLocalResultV1,
} from './reference-assets-ipc';

export interface ReferenceAssetsBridge {
  importLocal(
    request: ReferenceAssetImportLocalRequestV1
  ): Promise<ReferenceAssetImportLocalResultV1>;
  importHubGenome(
    request: ReferenceAssetImportHubGenomeRequestV1
  ): Promise<ReferenceAssetImportHubGenomeResultV1>;
  listLocal(): Promise<ReadonlyArray<PreparedReferenceAssemblyEntryV1>>;
  getLocalPreparationStatus(
    request: ReferenceAssetGetLocalPreparationStatusRequestV1
  ): Promise<ReferenceAssetLocalPreparationStatusV1 | null>;
  retryLocal(request: ReferenceAssetRetryLocalRequestV1): Promise<ReferenceAssetRetryLocalResultV1>;
  setOpenVersions?(versions: readonly OpenReferenceVersionV1[]): Promise<void>;
  listHosted(): Promise<ReadonlyArray<HostedReferenceCatalogEntryV1>>;
  getHostedPreparationStatus(
    request: ReferenceAssetGetHostedPreparationStatusRequestV1
  ): Promise<ReferenceAssetHostedPreparationStatusV1 | null>;
  installHosted(
    request: ReferenceAssetInstallHostedRequestV1
  ): Promise<ReferenceAssetInstallHostedResultV1>;
  onPreparationProgress(
    callback: (progress: ReferenceAssetPreparationProgressV1) => void
  ): () => void;
  onHostedInstallProgress(
    callback: (progress: ReferenceAssetHostedInstallProgressV1) => void
  ): () => void;
}
