import type {
  HostedReferenceBrowserCatalogDefinitionV1,
  HostedReferenceBrowserCatalogV1,
} from '../../shared/hosted-reference-browser-catalog';
import { HOSTED_REFERENCE_BROWSER_CATALOG_V1_CONTRACT } from '../../shared/hosted-reference-browser-catalog';
import {
  HOSTED_REFERENCE_CATALOG_V1,
  hostedReferenceCatalogEntryV1,
  type HostedReferenceCatalogDefinitionV1,
} from './hosted-reference-catalog';

export function hostedReferenceBrowserCatalogV1(
  catalog: ReadonlyArray<HostedReferenceCatalogDefinitionV1> = HOSTED_REFERENCE_CATALOG_V1
): HostedReferenceBrowserCatalogV1 {
  return {
    contract: HOSTED_REFERENCE_BROWSER_CATALOG_V1_CONTRACT,
    definitions: catalog.flatMap((definition) => {
      const bundle = definition.preparedBundle;
      if (!bundle) return [];
      const { cacheStatus: _cacheStatus, ...listing } = hostedReferenceCatalogEntryV1(definition);
      const projected: HostedReferenceBrowserCatalogDefinitionV1 = {
        listing,
        manifest: { ...bundle.manifest },
        ...(bundle.legacyLayerIdentityContract
          ? { legacyLayerIdentityContract: bundle.legacyLayerIdentityContract }
          : {}),
        contigs: definition.contigs.map((contig) => ({
          chrom: contig.chrom,
          ...(contig.cytobandId ? { cytobandId: contig.cytobandId } : {}),
        })),
      };
      return [projected];
    }),
  };
}
