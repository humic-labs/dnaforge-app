import catalogJson from './hosted-reference-browser-catalog.v1.json';
import type { HostedReferenceCatalogEntryV1 } from './reference-assets-ipc';

export const HOSTED_REFERENCE_BROWSER_CATALOG_V1_CONTRACT =
  'dnaforge-hosted-reference-browser-catalog.v1' as const;

export interface HostedReferenceBrowserCatalogDefinitionV1 {
  readonly listing: Omit<HostedReferenceCatalogEntryV1, 'cacheStatus'>;
  readonly manifest: {
    readonly relativePath: string;
    readonly sha256: string;
    readonly byteLength: number;
  };
  readonly legacyLayerIdentityContract?: string;
  readonly contigs: ReadonlyArray<{
    readonly chrom: string;
    readonly cytobandId?: string;
  }>;
}

export interface HostedReferenceBrowserCatalogV1 {
  readonly contract: typeof HOSTED_REFERENCE_BROWSER_CATALOG_V1_CONTRACT;
  readonly definitions: readonly HostedReferenceBrowserCatalogDefinitionV1[];
}

export const HOSTED_REFERENCE_BROWSER_CATALOG_V1 = catalogJson as HostedReferenceBrowserCatalogV1;
