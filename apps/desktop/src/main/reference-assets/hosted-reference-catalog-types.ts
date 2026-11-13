import type { AssemblySequenceAliases, AssemblySequenceRole } from '@waypoint/genome-data';
import type {
  HostedReferencePreparedBundleAssetV1,
  HostedReferenceSourceAssetV1,
} from './hosted-reference-prepared-bundle-contract';
import type { ReferencePreparationProvenanceV1 } from './reference-preparation-manifest';

export type {
  HostedReferenceFirstViewPackAssetV1,
  HostedReferenceFullTierShardAssetV1,
  HostedReferenceFullTierShardsAssetV1,
  HostedReferencePreparedBundleAssetV1,
  HostedReferenceSourceAssetV1,
} from './hosted-reference-prepared-bundle-contract';

export interface HostedReferenceContigV1 {
  readonly chrom: string;
  readonly sourceSeqId: string;
  readonly displayName: string;
  readonly lengthBp: number;
  readonly role: AssemblySequenceRole;
  readonly aliases?: AssemblySequenceAliases;
  readonly circular: boolean;
  readonly cytobandId?: string;
}

export interface HostedReferenceCatalogDefinitionV1 {
  readonly id: string;
  readonly name: string;
  readonly organism: string;
  readonly taxId?: number;
  readonly assembly?: string;
  readonly description: string;
  readonly sources: Readonly<{
    fasta: HostedReferenceSourceAssetV1;
    annotations: HostedReferenceSourceAssetV1;
  }>;
  readonly preparedBundle?: HostedReferencePreparedBundleAssetV1;
  readonly provenance: ReferencePreparationProvenanceV1;
  readonly contigs: ReadonlyArray<HostedReferenceContigV1>;
}

export interface HostedReferencePreparedCatalogDefinitionV1 extends HostedReferenceCatalogDefinitionV1 {
  readonly preparedBundle: HostedReferencePreparedBundleAssetV1;
}
