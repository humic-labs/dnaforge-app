import {
  HOSTED_REFERENCE_CATALOG_V1,
  type HostedReferenceCatalogDefinitionV1,
} from './hosted-reference-catalog';
import { HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_V1 } from './hosted-reference-rollout-source-catalog';
import { HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_V1 as HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_DNA2817_V1 } from './hosted-reference-rollout-source-catalog-public-data';
import { HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_V1 as HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_DNA2817_EXTRA_DEMAND_V1 } from './hosted-reference-rollout-source-catalog-public-data-extra-demand';
import { HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_V1 as HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_DNA2817_NIBEN_V1 } from './hosted-reference-rollout-source-catalog-public-data-niben';

const HOSTED_REFERENCE_BUILD_SOURCE_CATALOG_V1 = Object.freeze([
  ...HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_V1,
  ...HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_DNA2817_V1,
  ...HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_DNA2817_EXTRA_DEMAND_V1,
  ...HOSTED_REFERENCE_ROLLOUT_SOURCE_CATALOG_DNA2817_NIBEN_V1,
]);
const HOSTED_REFERENCE_BUILD_SOURCE_IDS_V1 = new Set<string>(
  HOSTED_REFERENCE_BUILD_SOURCE_CATALOG_V1.map(({ id }) => id)
);
if (HOSTED_REFERENCE_BUILD_SOURCE_IDS_V1.size !== HOSTED_REFERENCE_BUILD_SOURCE_CATALOG_V1.length) {
  throw new Error('Hosted-reference build source catalog contains a duplicate ID.');
}

const HOSTED_REFERENCE_RUNTIME_BY_ID_V1 = new Map(
  HOSTED_REFERENCE_CATALOG_V1.map((definition) => [definition.id, definition])
);

export const HOSTED_REFERENCE_BUILD_CATALOG_V1: ReadonlyArray<HostedReferenceCatalogDefinitionV1> =
  Object.freeze([
    ...HOSTED_REFERENCE_CATALOG_V1.filter(
      ({ id }) => !HOSTED_REFERENCE_BUILD_SOURCE_IDS_V1.has(id)
    ),
    ...HOSTED_REFERENCE_BUILD_SOURCE_CATALOG_V1.map(
      (definition) => HOSTED_REFERENCE_RUNTIME_BY_ID_V1.get(definition.id) ?? definition
    ),
  ]);
