import type { GenomeFeature, ResolvedAnnotation } from '@waypoint/genome-data';

import { markUnresolvedParents } from '../../features/sequence/components/orphan-parent-rescue';
import { uniqueAnnotationLayerTypes } from '../../features/sequence/annotation-layer-identity';
import { resolveTranscripts } from '../../features/sequence/components/spliced-feature-resolver';

export interface ViewportAnnotationTilePayload {
  features: ResolvedAnnotation[];
  featureModel: 'resolved-transcript-v2';
  sourceRecordCount: number;
  layerTypes: string[];
  unresolvedParentCount: number;
}

export interface BuildAnnotationViewportTileOptions {
  rescuedParentIds?: ReadonlySet<string>;
}

export function buildAnnotationViewportTileFromRawFeatures(
  rawFeatures: GenomeFeature[],
  options: BuildAnnotationViewportTileOptions = {}
): ViewportAnnotationTilePayload {
  const byId = new Map<string, GenomeFeature>();
  for (const f of rawFeatures) {
    const id = f.attributes.ID?.[0];
    if (id) byId.set(id, f);
  }
  const resolvedParentIds = new Set<string>(byId.keys());
  if (options.rescuedParentIds) {
    for (const id of options.rescuedParentIds) resolvedParentIds.add(id);
  }
  const unresolvedParentCount = markUnresolvedParents(rawFeatures, resolvedParentIds);

  const resolved = resolveTranscripts(rawFeatures);
  return {
    features: resolved,
    featureModel: 'resolved-transcript-v2',
    sourceRecordCount: rawFeatures.length,
    layerTypes: uniqueAnnotationLayerTypes(rawFeatures),
    unresolvedParentCount,
  };
}
