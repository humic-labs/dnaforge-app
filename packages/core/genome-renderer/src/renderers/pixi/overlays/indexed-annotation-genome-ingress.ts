import { genomeFeatures, type Feature, type Genome } from '../../../types';
import { assignFeatureLanes } from '../../../geometry/lane-assignment';
import { time as ptime } from '../../../perf-log';
import {
  isAnnotationSourcePlacementProvenanceV1,
  type PrebuiltAnnotationRasterContractMatch,
} from '../overview/prebuilt-annotation-raster-contract';
import { prepackedSceneCoversRequestedLayers } from '../overview/prepacked-annotation-scene';
import { FeatureWindowIndex } from '../shared/feature-window-index';
import { shouldClearCompiledBroadOnGenomeChange } from './indexed-compiled-broad-identity';
import { indexAnnotationFeaturesForRange } from './indexed-annotation-features-in-range';
import {
  normalizeAnnotationLayerTypes,
  stableSourceLaneAssignments,
} from './annotation-feature-semantics';

const NO_PREBUILT_RASTER_CONTRACT_MATCH: PrebuiltAnnotationRasterContractMatch = Object.freeze({
  contractMatch: false,
  sourceMatch: false,
  placementMatch: false,
  artifactLayerTypes: Object.freeze([]),
  artifactSourceFingerprint: null,
  artifactPlacementFingerprint: null,
});

type ResettableLayer = {
  resetData(): void;
};

type GenomeIdentityAuthority = {
  genomeIdentity: string;
  genomeLengthBp: number;
  sourceFingerprint: string;
  placementFingerprint: string;
};

type CompactInteractionResident = {
  metadata: {
    genomeIdentity: string;
    genomeLengthBp: number;
  };
};

export type GenomeIngressHost = {
  prebuiltRasterEligibleForLastFrame: boolean;
  prebuiltRasterContractForLastFrame: PrebuiltAnnotationRasterContractMatch;
  currentGenomeIdentity: string;
  compiledBroadSurfaceSourcePlacementAuthority: GenomeIdentityAuthority | null;
  compiledBroadSurfacePresenter: unknown;
  compiledBroadSurfaceCandidatePresenter: unknown;
  compiledBroadSurfaceTrackOwners: { readonly size: number };
  compiledBroadSurfaceTrackCandidateOwners: { readonly size: number };
  compiledBroadSurfaceRequirement: { genomeLengthBp?: number } | null;
  compiledBroadSurfaceManifest: { genomeLengthBp?: number } | null;
  prepackedAnnotationSceneResidents: {
    readonly size: number;
    values(): Iterable<{
      metadata: { genomeIdentity: string; genomeLengthBp: number };
    }>;
  };
  compiledBroadAnnotationInteractionResidents: Map<string, CompactInteractionResident>;
  compiledBroadAnnotationInteractionResidentGeneration: number;
  genomeLength: number;
  genomeCircular: boolean;
  currentGenomeAnnotationSourcePlacementProvenance: {
    sourceFingerprint: string;
    placementFingerprint: string;
  } | null;
  currentAnnotationSourceFingerprint: string | null;
  currentAnnotationPlacementFingerprint: string | null;
  features: Feature[];
  annotationRequestedLayerTypes: string[];
  annotationExactCoverage: Array<{ startBp: number; endBp: number }> | null;
  prepackedAnnotationSceneLayer: unknown;
  prepackedAnnotationSceneStatus: string;
  prepackedAnnotationSceneInput: {
    scene: unknown;
    gpuReadyScene?: { featureIndices: { readonly length: number } } | null;
  } | null;
  retainedLinearFullSetMeshResident: boolean;
  featureById: Map<number, Feature>;
  featureWindowIndex: FeatureWindowIndex;
  labelCache: { clear(): void };
  overviewCache: { invalidate(): void };
  retainedOverviewHitBins: unknown[];
  retainedOverviewPassthroughDrawn: boolean;
  lastRenderKey: string;
  retainedOverviewLayer: ResettableLayer | null;
  genomeWideTextureCacheLayer: ResettableLayer | null;
  retainedLinearFeatureLayer: ResettableLayer | null;
  retainedLinearTranscriptLayer: ResettableLayer | null;
  retainedLinearTranscriptKey: string;
  retainedLinearTranscriptFeatureSet: unknown;
  retainedLinearTranscriptMembershipNeedsRebind: boolean;
  retainedLinearSourceWindow: unknown;
  sourceMaxAnnotationLane: number;
  sourceMaxCdsLane: number;
  featuresSortedByStart: Feature[];
  longFeatures: Feature[];
  circularWrappedFeatures: Feature[];
  maxFeatureLenBp: number;
  annotationPresentationStreams: { clear(): void };
  activeAnnotationPresentationStreamKey: string | null;
  annotationResidentPageStreams: { clear(): void };
  activeAnnotationResidentPageStreamKey: string | null;
  annotationResidentPageStore: { sourceIdentity: string; genomeLengthBp: number } | null;
  residentAnnotationViewportSelectionCache: unknown;
  residentAnnotationViewportSelectionStatus: string;
  residentAnnotationViewportSelectedPageCount: number;
  residentAnnotationViewportSelectedFeatureCount: number;
  residentAnnotationViewportExpectedPageCount: number;
  residentAnnotationViewportMissingPageCount: number;
  residentAnnotationViewportCoverageComplete: boolean;
  residentAnnotationViewportProducerCoverageComplete: boolean;
  clearCompiledBroadSurfaceRequirement(): void;
  disposePrepackedAnnotationScene(reason: string): void;
  clearDrawState(): void;
  resetRenderStats(): void;
  resetTilePyramid(opts: { retainRtt?: boolean }): void;
  resetRetainedOverviewDebug(opts: { preserveTranscriptMesh?: boolean }): void;
  reconcileAnnotationLaneEnvelopeAuthority(): void;
};

export function loadAnnotationGenome(host: GenomeIngressHost, genome: Genome): void {
  host.annotationPresentationStreams.clear();
  host.activeAnnotationPresentationStreamKey = null;
  host.annotationResidentPageStreams.clear();
  host.activeAnnotationResidentPageStreamKey = null;
  const nextIdentity = genome.sourceIdentity ?? genome.name;
  if (
    host.annotationResidentPageStore?.sourceIdentity !== nextIdentity ||
    host.annotationResidentPageStore?.genomeLengthBp !== genome.length
  ) {
    host.annotationResidentPageStore = null;
  }
  host.residentAnnotationViewportSelectionCache = null;
  host.residentAnnotationViewportSelectionStatus = 'unavailable';
  host.residentAnnotationViewportSelectedPageCount = 0;
  host.residentAnnotationViewportSelectedFeatureCount = 0;
  host.residentAnnotationViewportExpectedPageCount = 0;
  host.residentAnnotationViewportMissingPageCount = 0;
  host.residentAnnotationViewportCoverageComplete = false;
  host.residentAnnotationViewportProducerCoverageComplete = false;
  applyAnnotationGenome(host, genome);
}

export function applyAnnotationGenome(host: GenomeIngressHost, genome: Genome): void {
  host.prebuiltRasterEligibleForLastFrame = false;
  host.prebuiltRasterContractForLastFrame = NO_PREBUILT_RASTER_CONTRACT_MATCH;
  const previousGenomeIdentity = host.currentGenomeIdentity;
  const nextGenomeIdentity = genome.sourceIdentity ?? genome.name;
  const sourcePlacementProvenance = isAnnotationSourcePlacementProvenanceV1(
    genome.annotationSourcePlacementProvenance
  )
    ? genome.annotationSourcePlacementProvenance
    : null;
  const compiledAuthority = host.compiledBroadSurfaceSourcePlacementAuthority;
  if (
    shouldClearCompiledBroadOnGenomeChange({
      hasCompiledSurface: Boolean(
        host.compiledBroadSurfacePresenter ||
        host.compiledBroadSurfaceCandidatePresenter ||
        host.compiledBroadSurfaceTrackOwners.size > 0 ||
        host.compiledBroadSurfaceTrackCandidateOwners.size > 0 ||
        host.compiledBroadSurfaceRequirement
      ),
      currentLength:
        host.compiledBroadSurfaceManifest?.genomeLengthBp ??
        host.compiledBroadSurfaceRequirement?.genomeLengthBp,
      nextLength: genome.length,
      previousGenomeIdentity,
      nextGenomeIdentity,
      compiledAuthority,
      nextProvenance: sourcePlacementProvenance,
    })
  ) {
    host.clearCompiledBroadSurfaceRequirement();
  }
  const prepackedGenomeMatches = [...host.prepackedAnnotationSceneResidents.values()].every(
    (resident) =>
      resident.metadata.genomeIdentity === nextGenomeIdentity &&
      resident.metadata.genomeLengthBp === genome.length
  );
  if (host.prepackedAnnotationSceneResidents.size > 0 && !prepackedGenomeMatches) {
    host.disposePrepackedAnnotationScene('genome-mismatch');
  }
  let compactInteractionRosterChanged = false;
  for (const [ownerKey, resident] of host.compiledBroadAnnotationInteractionResidents) {
    if (
      resident.metadata.genomeIdentity !== nextGenomeIdentity ||
      resident.metadata.genomeLengthBp !== genome.length
    ) {
      host.compiledBroadAnnotationInteractionResidents.delete(ownerKey);
      compactInteractionRosterChanged = true;
    }
  }
  if (compactInteractionRosterChanged) {
    host.compiledBroadAnnotationInteractionResidentGeneration += 1;
  }
  const streamingUpdate =
    previousGenomeIdentity === nextGenomeIdentity &&
    host.genomeLength === genome.length &&
    host.genomeCircular === genome.circular;
  host.currentGenomeIdentity = nextGenomeIdentity;
  host.currentGenomeAnnotationSourcePlacementProvenance = sourcePlacementProvenance
    ? Object.freeze({
        sourceFingerprint: sourcePlacementProvenance.sourceFingerprint,
        placementFingerprint: sourcePlacementProvenance.placementFingerprint,
      })
    : null;
  const retainedCompiledAuthority = host.compiledBroadSurfaceSourcePlacementAuthority;
  host.currentAnnotationSourceFingerprint =
    sourcePlacementProvenance?.sourceFingerprint ??
    (retainedCompiledAuthority?.genomeIdentity === nextGenomeIdentity &&
    retainedCompiledAuthority.genomeLengthBp === genome.length
      ? retainedCompiledAuthority.sourceFingerprint
      : null);
  host.currentAnnotationPlacementFingerprint =
    sourcePlacementProvenance?.placementFingerprint ??
    (retainedCompiledAuthority?.genomeIdentity === nextGenomeIdentity &&
    retainedCompiledAuthority.genomeLengthBp === genome.length
      ? retainedCompiledAuthority.placementFingerprint
      : null);
  host.features = genomeFeatures(genome);
  host.annotationRequestedLayerTypes = normalizeAnnotationLayerTypes(
    genome.annotationLayerTypes ?? host.features.map((feature) => feature.type)
  );
  host.annotationExactCoverage = genome.annotationExactCoverage
    ? genome.annotationExactCoverage.map((coverage) => ({ ...coverage }))
    : null;
  if (host.prepackedAnnotationSceneLayer) {
    host.prepackedAnnotationSceneStatus = prepackedSceneCoversRequestedLayers(
      host.annotationRequestedLayerTypes,
      host.prepackedAnnotationSceneInput!.scene as never,
      host.prepackedAnnotationSceneInput!.gpuReadyScene?.featureIndices.length ?? 0
    )
      ? 'eligible'
      : 'mixed-layer-fallback';
  }
  host.retainedLinearFullSetMeshResident = false;
  host.featureById = new Map(host.features.map((feature) => [feature.id, feature]));
  host.featureWindowIndex = new FeatureWindowIndex({
    genomeLength: genome.length,
    circular: genome.circular,
    features: host.features,
  });
  host.genomeLength = genome.length;
  host.genomeCircular = genome.circular;
  host.clearDrawState();
  host.labelCache.clear();
  host.overviewCache.invalidate();
  host.retainedOverviewHitBins = [];
  host.retainedOverviewPassthroughDrawn = false;
  host.lastRenderKey = '';
  host.resetRenderStats();
  host.retainedOverviewLayer?.resetData();
  host.genomeWideTextureCacheLayer?.resetData();
  host.retainedLinearFeatureLayer?.resetData();
  if (!streamingUpdate) {
    host.retainedLinearTranscriptLayer?.resetData();
    host.retainedLinearTranscriptKey = '';
    host.retainedLinearTranscriptFeatureSet = null;
    host.retainedLinearTranscriptMembershipNeedsRebind = false;
  } else if (host.retainedLinearTranscriptFeatureSet !== null) {
    host.retainedLinearTranscriptMembershipNeedsRebind = true;
  }
  host.resetTilePyramid({ retainRtt: streamingUpdate });
  host.retainedLinearSourceWindow = null;
  host.resetRetainedOverviewDebug({ preserveTranscriptMesh: streamingUpdate });

  const nonCds = host.features.filter((f) => f.type !== 'CDS');
  const cds = host.features.filter((f) => f.type === 'CDS');

  const annLanes = ptime(
    'assignFeatureLanes.nonCds',
    () =>
      stableSourceLaneAssignments(nonCds) ??
      assignFeatureLanes(nonCds, genome.length).laneAssignments,
    { count: nonCds.length }
  );
  for (const [idx, lane] of annLanes) {
    nonCds[idx].lane = lane;
  }
  const cdsLaneMap = ptime(
    'assignFeatureLanes.cds',
    () =>
      stableSourceLaneAssignments(cds) ?? assignFeatureLanes(cds, genome.length).laneAssignments,
    { count: cds.length }
  );
  for (const [idx, lane] of cdsLaneMap) {
    cds[idx].lane = lane;
    cds[idx].cdsLane = lane;
  }

  host.sourceMaxAnnotationLane = -1;
  for (const f of nonCds) {
    if (f.lane > host.sourceMaxAnnotationLane) host.sourceMaxAnnotationLane = f.lane;
  }
  host.sourceMaxCdsLane = -1;
  for (const f of cds) if (f.lane > host.sourceMaxCdsLane) host.sourceMaxCdsLane = f.lane;
  if (genome.annotationLayout) {
    host.sourceMaxAnnotationLane = genome.annotationLayout.maxAnnotationLane;
    host.sourceMaxCdsLane = genome.annotationLayout.maxCdsLane;
  }
  host.reconcileAnnotationLaneEnvelopeAuthority();

  const rangeIndex = indexAnnotationFeaturesForRange(
    host.features,
    genome.length,
    host.genomeCircular
  );
  host.featuresSortedByStart = rangeIndex.sortedByStart;
  host.longFeatures = rangeIndex.longFeatures;
  host.circularWrappedFeatures = rangeIndex.circularWrappedFeatures;
  host.maxFeatureLenBp = rangeIndex.maxIndexedFeatureLenBp;
}
