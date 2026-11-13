import type { ChromosomeMorphologyV1 } from '@waypoint/genome-data';
import type { AssemblyReferenceAssetGenerationByThemeV1 } from './indexed-genome';
import type {
  ReferenceContentIdentity,
  ReferenceVersionIdentity,
} from './reference-content-identity';

export const REFERENCE_ASSET_IMPORT_LOCAL_CHANNEL = 'referenceAssets:importLocal';
export const REFERENCE_ASSET_LIST_LOCAL_CHANNEL = 'referenceAssets:listLocal';
export const REFERENCE_ASSET_GET_LOCAL_PREPARATION_STATUS_CHANNEL =
  'referenceAssets:getLocalPreparationStatus';
export const REFERENCE_ASSET_RETRY_LOCAL_CHANNEL = 'referenceAssets:retryLocal';
export const REFERENCE_ASSET_PREPARATION_PROGRESS_CHANNEL = 'referenceAssets:preparationProgress';
export const REFERENCE_ASSET_SET_OPEN_VERSIONS_CHANNEL = 'referenceAssets:setOpenVersions';

export interface OpenReferenceVersionV1 {
  readonly catalogId: string;
  readonly generationId: string;
}

export const REFERENCE_ASSET_LIST_HOSTED_CHANNEL = 'referenceAssets:listHosted';
export const REFERENCE_ASSET_GET_HOSTED_PREPARATION_STATUS_CHANNEL =
  'referenceAssets:getHostedPreparationStatus';
export const REFERENCE_ASSET_INSTALL_HOSTED_CHANNEL = 'referenceAssets:installHosted';
export const REFERENCE_ASSET_HOSTED_INSTALL_PROGRESS_CHANNEL =
  'referenceAssets:hostedInstallProgress';
export const REFERENCE_ASSET_IMPORT_HUB_GENOME_CHANNEL = 'referenceAssets:importHubGenome';

export type ReferenceAssetThemeModeV1 = 'light' | 'dark';

export interface ReferenceAssemblySequenceAliasesV1 {
  readonly refseq?: string;
  readonly genbank?: string;
  readonly ucsc?: string;
  readonly ensembl?: string;
}

export type ReferenceAssemblySequenceRoleV1 =
  | 'assembled-molecule'
  | 'unlocalized-scaffold'
  | 'unplaced-scaffold'
  | 'mitochondrion'
  | 'plastid'
  | 'other';

export interface PreparedReferenceMemberManifestV1 {
  readonly fastaPath: string;
  readonly faiPath: string;
  readonly gffPath?: string;
  readonly tbiPath?: string;
}

export interface PreparedReferenceAssemblyMemberV1 {
  readonly chrom: string;
  readonly displayName?: string;
  readonly lengthBp?: number;
  readonly role?: ReferenceAssemblySequenceRoleV1;
  readonly aliases?: ReferenceAssemblySequenceAliasesV1;
  readonly md5?: string;
  readonly circular?: boolean;
  readonly cytobandId?: string;
  readonly morphology?: ChromosomeMorphologyV1;
  readonly manifest?: PreparedReferenceMemberManifestV1;
}

export interface PreparedReferenceAssemblyEntryV1 {
  readonly id: string;
  readonly name: string;
  readonly organism: string;
  readonly taxId?: number;
  readonly assembly?: string;
  readonly description: string;
  readonly assetCacheKey: string;
  readonly members: ReadonlyArray<PreparedReferenceAssemblyMemberV1>;
  readonly referenceIdentity?: ReferenceContentIdentity;
  readonly referenceVersionHistory?: readonly ReferenceVersionIdentity[];
  readonly ucscTrackTarget?: Readonly<{ genomeId: string; hubUrl: string }>;
  readonly portableView?: Readonly<{
    generationRoot: string;
    bundleFingerprint: string;
    trackTypes: readonly string[];
    datasetVersion?: string;
    assetGenerationsByTheme?: AssemblyReferenceAssetGenerationByThemeV1;
    searchReady?: boolean;
  }>;
}

export interface ReferenceAssetImportLocalRequestV1 {
  readonly operationId: string;
  readonly themeMode: ReferenceAssetThemeModeV1;
  readonly sourcePath?: string;
  readonly assemblyLink?: string;
}

export type ReferenceAssetImportLocalResultV1 =
  | { readonly status: 'cancelled' }
  | {
      readonly status: 'hosted';
      readonly catalogId: string;
    }
  | {
      readonly status: 'ready';
      readonly entry: PreparedReferenceAssemblyEntryV1;
    };

export interface HubGenomeReferenceSourceV1 {
  readonly hubUrl: string;
  readonly genome: string;
  readonly twoBitPath: string;
  readonly provider: 'assembly-hub' | 'genark';
  readonly organism?: string;
  readonly assemblyName?: string;
  readonly taxId?: number;
}

export interface ReferenceAssetImportHubGenomeRequestV1 extends HubGenomeReferenceSourceV1 {
  readonly operationId: string;
  readonly themeMode: ReferenceAssetThemeModeV1;
}

export interface ReferenceAssetImportHubGenomeResultV1 {
  readonly status: 'ready';
  readonly entry: PreparedReferenceAssemblyEntryV1;
}

export interface ReferenceAssetGetLocalPreparationStatusRequestV1 {
  readonly assemblyId: string;
}

export interface ReferenceAssetLocalPreparationStatusV1 {
  readonly assemblyId: string;
  readonly status: 'preparing' | 'ready' | 'failed';
  readonly phase: string;
  readonly label: string;
  readonly completed?: number;
  readonly total?: number;
  readonly updatedAtMs: number;
}

export interface ReferenceAssetRetryLocalRequestV1 {
  readonly operationId: string;
  readonly assemblyId: string;
  readonly themeMode: ReferenceAssetThemeModeV1;
}

export interface ReferenceAssetRetryLocalResultV1 {
  readonly status: 'ready';
  readonly entry: PreparedReferenceAssemblyEntryV1;
}

export interface HostedReferenceCatalogEntryV1 {
  readonly id: string;
  readonly name: string;
  readonly organism: string;
  readonly assembly?: string;
  readonly description: string;
  readonly cacheStatus: 'cached' | 'stale' | 'not-cached';
  readonly currentVersionAvailable?: boolean;
  readonly cacheStatusReason?:
    | 'reference-definition-changed'
    | 'local-files-invalid'
    | 'prepared-files-incomplete';
  readonly preparation?: Pick<
    ReferenceAssetHostedPreparationStatusV1,
    'status' | 'phase' | 'label'
  > & { readonly active: boolean };
  readonly lengthBp: number;
  readonly contigCount: number;
  readonly downloadBytes: number;
  readonly provider: string;
  readonly datasetVersion: string;
  readonly sourceUrl?: string;
}

export interface ReferenceAssetInstallHostedRequestV1 {
  readonly catalogId: string;
  readonly themeMode: ReferenceAssetThemeModeV1;
  readonly intent: 'open-view' | 'require-ready';
}

export interface ReferenceAssetGetHostedPreparationStatusRequestV1 {
  readonly catalogId: string;
  readonly themeMode: ReferenceAssetThemeModeV1;
}

interface ReferenceAssetHostedPreparationStatusBaseV1 {
  readonly catalogId: string;
  readonly themeMode: ReferenceAssetThemeModeV1;
  readonly phase: string;
  readonly label: string;
  readonly updatedAtMs: number;
}

export type ReferenceAssetHostedPreparationStatusV1 =
  | (ReferenceAssetHostedPreparationStatusBaseV1 & {
      readonly status: 'preparing';
    })
  | (ReferenceAssetHostedPreparationStatusBaseV1 & {
      readonly status: 'annotation-ready';
      readonly phase: 'detail-ready';
      readonly capabilityGenerationId: string;
      readonly entry: PreparedReferenceAssemblyEntryV1;
    })
  | (ReferenceAssetHostedPreparationStatusBaseV1 & {
      readonly status: 'failed';
    })
  | (ReferenceAssetHostedPreparationStatusBaseV1 & {
      readonly status: 'ready';
      readonly phase: 'ready';
      readonly capabilityGenerationId: string;
      readonly entry: PreparedReferenceAssemblyEntryV1;
    });

export interface ReferenceAssetInstallHostedResultV1 {
  readonly status: 'view-ready' | 'ready';
  readonly entry: PreparedReferenceAssemblyEntryV1;
}

export interface ReferenceAssetPreparationProgressV1 {
  readonly operationId: string;
  readonly assemblyId?: string;
  readonly phase: string;
  readonly label: string;
  readonly completed?: number;
  readonly total?: number;
}

export type ReferenceAssetPreparationProgressUpdateV1 = Omit<
  ReferenceAssetPreparationProgressV1,
  'operationId'
>;

export interface ReferenceAssetHostedInstallProgressV1 extends ReferenceAssetPreparationProgressV1 {
  readonly catalogId: string;
}
