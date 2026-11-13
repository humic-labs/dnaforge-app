
import { featureAliases, resolveFeaturesByName } from '@waypoint/sequence-utils';
import type { BiologyFeature } from './parse-biology-file';

const aliasesOf = (feature: BiologyFeature) =>
  featureAliases({
    type: feature.type,
    name: feature.displayName,
    qualifiers: feature.qualifiers,
  });

export function matchFeatures(
  features: BiologyFeature[],
  query?: string,
  type?: string
): BiologyFeature[] {
  let result = features;

  if (type) {
    const typeLower = type.toLowerCase();
    result = result.filter((f) => f.type.toLowerCase() === typeLower);
  }

  if (query) {
    const matched = new Set(
      resolveFeaturesByName(result, query, { aliasesOf }).map((match) => match.feature)
    );
    result = result.filter((feature) => matched.has(feature));
  }

  return result;
}
