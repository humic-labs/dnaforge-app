import type { GenomeFeature } from '@waypoint/genome-data';
import type { Feature } from '@waypoint/genome-renderer/pure';

import type { GenomeAnnotationFeatureModel } from '../../shared/indexed-genome';
import { annotationLayerType } from './annotation-layer-identity';
import { offsetFeaturesToGlobal } from './components/assembly-feature-offset';
import {
  applyDensityControls,
  resolveAnnotationFeaturesForViewer,
  type AnnotationLaneStackingOptions,
  type LaneLimit,
  type TranscriptCarrierFeature,
} from './components/indexed-genome-legacy-adapter';
import {
  collapseToCanonicalIsoforms,
  type TranscriptDisplayMode,
} from './components/isoform-collapse';
import { ASSEMBLY_ANNOTATION_TYPE_ORDER } from './assembly-annotation-policy-projection';

const ASSEMBLY_OVERVIEW_LANE_STACKING: AnnotationLaneStackingOptions = {
  groupByType: true,
  typeOrder: ASSEMBLY_ANNOTATION_TYPE_ORDER,
};
const EMPTY_EXPANDED_GENE_IDS: ReadonlySet<string> = new Set<string>();

export interface ProcessAssemblyOverviewChromosomeFeaturesInput {
  chrom: string;
  chromosomeLengthBp: number;
  globalStartBp: number;
  rawOrResolvedFeatures: readonly unknown[];
  featureModel: GenomeAnnotationFeatureModel;
  isoformMode: TranscriptDisplayMode;
  laneLimit?: LaneLimit;
  glyphV2Enabled: boolean;
}

export function processAssemblyOverviewChromosomeFeatures(
  input: ProcessAssemblyOverviewChromosomeFeaturesInput
): Feature[] {
  const resolved = resolveAnnotationFeaturesForViewer(
    (Array.isArray(input.rawOrResolvedFeatures)
      ? input.rawOrResolvedFeatures
      : []) as GenomeFeature[],
    input.featureModel,
    input.glyphV2Enabled
  );
  const collapsed = collapseToCanonicalIsoforms(resolved as TranscriptCarrierFeature[], {
    mode: input.isoformMode,
    expandedGeneIds: EMPTY_EXPANDED_GENE_IDS,
  });
  const presentTypes = new Set(collapsed.map((feature) => annotationLayerType(feature)));
  const { features: localFeatures } = applyDensityControls(
    collapsed,
    input.chrom,
    input.chromosomeLengthBp,
    presentTypes,
    input.laneLimit ?? null,
    ASSEMBLY_OVERVIEW_LANE_STACKING
  );
  return offsetFeaturesToGlobal(localFeatures, input.globalStartBp);
}
