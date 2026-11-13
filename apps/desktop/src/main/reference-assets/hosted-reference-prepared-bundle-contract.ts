import type { ANNOTATION_LAYER_IDENTITY_LEGACY_RAW_QUALIFIER_CONTRACT_TOKEN } from '../../features/sequence/annotation-layer-identity';

export interface HostedReferenceSourceAssetV1 {
  readonly relativePath: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface HostedReferenceFirstViewPackAssetV1 extends HostedReferenceSourceAssetV1 {
  readonly format: 'dnaforge-portable-prepared-reference-first-view-pack.br.v1';
  readonly bundleManifestSha256: string;
  readonly bundleFingerprint: string;
  readonly tiers: readonly ['shell', 'view'];
  readonly rosterSha256: string;
  readonly memberCount: number;
  readonly uncompressedByteLength: number;
}

export interface HostedReferenceFullTierShardAssetV1 extends HostedReferenceSourceAssetV1 {
  readonly format: 'dnaforge-portable-prepared-reference-full-tier-shard.br.v1';
  readonly bundleManifestSha256: string;
  readonly bundleFingerprint: string;
  readonly shardIndex: number;
  readonly shardCount: number;
  readonly rosterSha256: string;
  readonly memberCount: number;
  readonly uncompressedByteLength: number;
}

export interface HostedReferenceFullTierShardsAssetV1 {
  readonly contract: 'dnaforge-portable-prepared-reference-full-tier-shards.v1';
  readonly bundleManifestSha256: string;
  readonly bundleFingerprint: string;
  readonly tiers: readonly ['detail', 'search'];
  readonly rosterSha256: string;
  readonly memberCount: number;
  readonly individualObjectIds: readonly string[];
  readonly shards: readonly HostedReferenceFullTierShardAssetV1[];
}

export interface HostedReferencePreparedBundleAssetV1 {
  readonly manifest: HostedReferenceSourceAssetV1;
  readonly firstViewPack?: HostedReferenceFirstViewPackAssetV1;
  readonly fullTierShards?: HostedReferenceFullTierShardsAssetV1;
  readonly legacyLayerIdentityContract?: typeof ANNOTATION_LAYER_IDENTITY_LEGACY_RAW_QUALIFIER_CONTRACT_TOKEN;
}
