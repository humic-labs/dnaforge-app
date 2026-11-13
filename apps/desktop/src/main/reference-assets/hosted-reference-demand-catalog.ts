import {
  REQUIRED_HOSTED_REFERENCE_DEMAND_CATALOG_V1,
  type HostedReferenceDemandV1,
} from './hosted-reference-demand-roster';
import { HOSTED_REFERENCE_BUILD_CATALOG_V1 } from './hosted-reference-build-catalog';
import type { HostedReferenceCatalogDefinitionV1 } from './hosted-reference-catalog';

export {
  createHostedReferenceDemandRosterV1,
  REQUIRED_HOSTED_REFERENCE_DEMAND_CATALOG_V1,
  type HostedReferenceCoordinateAuthorityV1,
  type HostedReferenceDemandCohortV1,
  type HostedReferenceDemandV1,
  type NcbiAssemblyAccessionV1,
} from './hosted-reference-demand-roster';

export const IGV_REFERENCE_REGISTRY_V1 = 'https://igv.org/app/resources/genomes.json' as const;

export type HostedReferenceDemandAvailabilityV1 = 'not-published' | 'source-published' | 'prepared';

export interface HostedReferenceDemandStateV1 extends HostedReferenceDemandV1 {
  readonly availability: HostedReferenceDemandAvailabilityV1;
}

export function hostedReferenceDemandStatesV1(
  buildCatalog: readonly HostedReferenceCatalogDefinitionV1[] = HOSTED_REFERENCE_BUILD_CATALOG_V1
): readonly HostedReferenceDemandStateV1[] {
  const buildById = new Map(buildCatalog.map((definition) => [definition.id, definition]));
  return REQUIRED_HOSTED_REFERENCE_DEMAND_CATALOG_V1.map((demand) => {
    const admitted = buildById.get(demand.id);
    return Object.freeze({
      ...demand,
      availability: admitted
        ? admitted.preparedBundle
          ? 'prepared'
          : 'source-published'
        : 'not-published',
    });
  });
}
