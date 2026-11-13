import type { Graphics, Text } from 'pixi.js';
import { cdsConnectorCenterOffset } from '@waypoint/platform';
import type {
  AnnotationFlatPresentationSnapshot,
  Feature,
  Genome,
  RenderState,
} from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import { FeatureWindowIndex } from '../shared/feature-window-index';
import type { UnifiedLayout } from '../shared/track-layout';
import type { TrackContract } from '../shared/lane-contracts';
import { laneRoundedPillPolygon, normalizeBp, screenWidthToBp } from '../shared/lane-path';
import {
  cdsLabelStripOutlineCommand as annotationCdsLabelStripOutlineCommand,
  lanePillOutlineCommand as annotationLanePillOutlineCommand,
  type OutlineCommand,
} from './annotation-feature-geometry';
import { normalizeAnnotationLayerTypes } from './annotation-feature-semantics';
import { shouldRenderFeatureTextAtLod } from './feature-text-lod';
import type {
  AnnotationDrawAuditDecision,
  AnnotationDrawAuditSnapshot,
} from './annotation-draw-audit';
import { recordDrawAuditDecision as recordDrawAuditDecisionFn } from './indexed-annotation-presentation-audit';
import { strokeLanePill as strokeLanePillFn } from './indexed-annotation-draft-outlines';
import type {
  AnnotationPolicyGpuRuntimeV1,
  AnnotationPolicyGpuTrackLaneMaximaV1,
} from '../overview/annotation-policy-gpu-instances-v1';
import type { PrebuiltAnnotationRasterContractMatch } from '../overview/prebuilt-annotation-raster-contract';
import {
  applyAnnotationGenome as applyAnnotationGenomeFn,
  loadAnnotationGenome as loadAnnotationGenomeFn,
  type GenomeIngressHost,
} from './indexed-annotation-genome-ingress';
import {
  applyPrepackedAnnotationLaneEnvelope as applyPrepackedAnnotationLaneEnvelopeFn,
  commitAnnotationLaneEnvelope as commitAnnotationLaneEnvelopeFn,
  reconcileAnnotationLaneEnvelopeAuthority as reconcileAnnotationLaneEnvelopeAuthorityFn,
  type LaneEnvelopeHost,
} from './indexed-annotation-lane-envelope';
import {
  featuresInRange as featuresInRangeFn,
  hasFeaturesInRange as hasFeaturesInRangeFn,
} from './indexed-annotation-features-in-range';
import {
  cdsDetailProgress as cdsDetailProgressFn,
  cdsExonLabelAlpha as cdsExonLabelAlphaFn,
  featureEnvelope as featureEnvelopeFn,
  featureOffset as featureOffsetFn,
  overviewLabelAlpha as overviewLabelAlphaFn,
  prepackedAnnotationCenterScreenY as prepackedAnnotationCenterScreenYFn,
  prepackedAnnotationTrackBaseOffsetPx as prepackedAnnotationTrackBaseOffsetPxFn,
  renderKeyChangeReasons as renderKeyChangeReasonsFn,
  renderKeyFromParts as renderKeyFromPartsFn,
  renderKeyParts as renderKeyPartsFn,
  retainedLinearTranscriptFeatureKey as retainedLinearTranscriptFeatureKeyFn,
  retainedLinearTranscriptLayoutKey as retainedLinearTranscriptLayoutKeyFn,
  scaledBarHeight as scaledBarHeightFn,
  scaledCdsLineHeight as scaledCdsLineHeightFn,
  setOverlayLayout as setOverlayLayoutFn,
  type AnnotationRenderKeyParts,
  type OverlayLayoutHost,
} from './indexed-annotation-layout';
import {
  clearDrawState as clearDrawStateFn,
  type ClearDrawStateHost,
} from './indexed-annotation-clear-draw-state';
import type { FlatPresentationSnapshotHost } from './indexed-annotation-flat-snapshot';
import type { OverlayPresenterCollaborators } from './indexed-annotation-overlay-collaborators';

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

type CompactInteractionResident = {
  metadata: {
    genomeIdentity: string;
    genomeLengthBp: number;
  };
};

type LaneEnvelopeResident = {
  policyTrackLaneMaxima?: AnnotationPolicyGpuTrackLaneMaximaV1 | null;
  metadata: { genomeIdentity: string; genomeLengthBp: number };
};

function stubGraphics(): Graphics {
  return {
    visible: false,
    clear() {},
  } as unknown as Graphics;
}

export type AnnotationLayoutGlue = {
  lastRenderKeyParts: AnnotationRenderKeyParts | null;
  hashRetainedLinearTranscriptFeatureKey(featuresToRender: readonly Feature[]): string;
  prepackedAnnotationRuntimePolicy: AnnotationPolicyGpuRuntimeV1 | null;
  prepackedAnnotationSceneOwnerKey: string | null;
  prepackedAnnotationSceneResidents: Map<string, LaneEnvelopeResident> & {
    get(
      key: string
    ): { policyTrackLaneMaxima?: AnnotationPolicyGpuTrackLaneMaximaV1 | null } | undefined;
  };
  annotationTrackStackMaxLane(policy: AnnotationPolicyGpuRuntimeV1): number;
  prebuiltRasterEligibleForLastFrame: boolean;
  prebuiltRasterContractForLastFrame: PrebuiltAnnotationRasterContractMatch;
  compiledBroadSurfaceSourcePlacementAuthority: {
    genomeIdentity: string;
    genomeLengthBp: number;
    sourceFingerprint: string;
    placementFingerprint: string;
  } | null;
  compiledBroadSurfacePresenter: unknown;
  compiledBroadSurfaceCandidatePresenter: unknown;
  compiledBroadSurfaceTrackOwners: { readonly size: number };
  compiledBroadSurfaceTrackCandidateOwners: { readonly size: number };
  compiledBroadSurfaceRequirement: {
    genomeLengthBp?: number;
    broadCorridorFinestSpanBp?: number;
  } | null;
  compiledBroadSurfaceManifest: { genomeLengthBp?: number } | null;
  compiledBroadAnnotationInteractionResidents: Map<string, CompactInteractionResident>;
  compiledBroadAnnotationInteractionResidentGeneration: number;
  prepackedAnnotationSceneLayer: unknown;
  prepackedAnnotationSceneStatus: string;
  prepackedAnnotationSceneInput: {
    scene: unknown;
    gpuReadyScene?: { featureIndices: { readonly length: number } } | null;
  } | null;
  retainedLinearFullSetMeshResident: boolean;
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
  graphics: Graphics;
  retainedTranscriptDecorationGraphics: Graphics;
  annotationSearchFocusGraphics: Graphics;
  interactionGraphics: Graphics;
  labelIndex: number;
  curvedLabels: { reset(): void };
  labelPool: Text[];
  hitCache: unknown[];
  outlineCache: { clear(): void };
  labelOccupancyCache: unknown[];
  overviewBinDrawCount: number;
  lastInteractionOutlineCommandCount: number;
  annotationSearchFocusMaskDrawCount: number;
  annotationSearchFocusPrimitiveDrawCount: number;
  annotationSearchFocusResolvedTrackId: string | null;
  annotationSearchFocusResolvedCanonicalIdentity: string | null;
  annotationSearchFocusPresentationLane: number | null;
  clearCompiledBroadSurfaceRequirement(): void;
  disposePrepackedAnnotationScene(reason: string): void;
  resetRenderStats(): void;
  resetTilePyramid(opts: { retainRtt?: boolean }): void;
  resetRetainedOverviewDebug(opts: { preserveTranscriptMesh?: boolean }): void;
  clearDecorationCache(): void;
};

export function idleAnnotationLayoutGlue(): AnnotationLayoutGlue {
  const interactionResidents = new Map<string, CompactInteractionResident>();
  const prepackedResidents = new Map<string, LaneEnvelopeResident>();
  const hitCache: unknown[] = [];
  const labelPool: Text[] = [];
  let labelOccupancyCache: unknown[] = [];
  let labelIndex = 0;
  let overviewBinDrawCount = 0;
  let lastInteractionOutlineCommandCount = 0;
  let annotationSearchFocusMaskDrawCount = 0;
  let annotationSearchFocusPrimitiveDrawCount = 0;
  let annotationSearchFocusResolvedTrackId: string | null = null;
  let annotationSearchFocusResolvedCanonicalIdentity: string | null = null;
  let annotationSearchFocusPresentationLane: number | null = null;
  let lastRenderKeyParts: AnnotationRenderKeyParts | null = null;
  let prepackedAnnotationRuntimePolicy: AnnotationPolicyGpuRuntimeV1 | null = null;
  let prepackedAnnotationSceneOwnerKey: string | null = null;
  let prebuiltRasterEligibleForLastFrame = false;
  let prebuiltRasterContractForLastFrame: PrebuiltAnnotationRasterContractMatch =
    NO_PREBUILT_RASTER_CONTRACT_MATCH;
  let compiledBroadAnnotationInteractionResidentGeneration = 0;
  let prepackedAnnotationSceneLayer: unknown = null;
  let prepackedAnnotationSceneStatus = 'not-loaded';
  let prepackedAnnotationSceneInput: AnnotationLayoutGlue['prepackedAnnotationSceneInput'] = null;
  let retainedLinearFullSetMeshResident = false;
  let retainedOverviewHitBins: unknown[] = [];
  let retainedOverviewPassthroughDrawn = false;
  let lastRenderKey = '';
  let retainedLinearTranscriptKey = '';
  let retainedLinearTranscriptFeatureSet: unknown = null;
  let retainedLinearTranscriptMembershipNeedsRebind = false;
  let retainedLinearSourceWindow: unknown = null;
  let activeAnnotationResidentPageStreamKey: string | null = null;
  let annotationResidentPageStore: { sourceIdentity: string; genomeLengthBp: number } | null = null;
  let residentAnnotationViewportSelectionCache: unknown = null;
  let residentAnnotationViewportSelectionStatus = 'unavailable';
  let residentAnnotationViewportSelectedPageCount = 0;
  let residentAnnotationViewportSelectedFeatureCount = 0;
  let residentAnnotationViewportExpectedPageCount = 0;
  let residentAnnotationViewportMissingPageCount = 0;
  let residentAnnotationViewportCoverageComplete = false;
  let residentAnnotationViewportProducerCoverageComplete = false;
  const graphics = stubGraphics();
  const retainedTranscriptDecorationGraphics = stubGraphics();
  const annotationSearchFocusGraphics = stubGraphics();
  const interactionGraphics = stubGraphics();

  return {
    get lastRenderKeyParts() {
      return lastRenderKeyParts;
    },
    set lastRenderKeyParts(value) {
      lastRenderKeyParts = value;
    },
    hashRetainedLinearTranscriptFeatureKey() {
      return 'hash';
    },
    get prepackedAnnotationRuntimePolicy() {
      return prepackedAnnotationRuntimePolicy;
    },
    set prepackedAnnotationRuntimePolicy(value) {
      prepackedAnnotationRuntimePolicy = value;
    },
    get prepackedAnnotationSceneOwnerKey() {
      return prepackedAnnotationSceneOwnerKey;
    },
    set prepackedAnnotationSceneOwnerKey(value) {
      prepackedAnnotationSceneOwnerKey = value;
    },
    prepackedAnnotationSceneResidents: prepackedResidents,
    annotationTrackStackMaxLane() {
      return -1;
    },
    get prebuiltRasterEligibleForLastFrame() {
      return prebuiltRasterEligibleForLastFrame;
    },
    set prebuiltRasterEligibleForLastFrame(value) {
      prebuiltRasterEligibleForLastFrame = value;
    },
    get prebuiltRasterContractForLastFrame() {
      return prebuiltRasterContractForLastFrame;
    },
    set prebuiltRasterContractForLastFrame(value) {
      prebuiltRasterContractForLastFrame = value;
    },
    compiledBroadSurfaceSourcePlacementAuthority: null,
    compiledBroadSurfacePresenter: null,
    compiledBroadSurfaceCandidatePresenter: null,
    compiledBroadSurfaceTrackOwners: new Map(),
    compiledBroadSurfaceTrackCandidateOwners: new Map(),
    compiledBroadSurfaceRequirement: null,
    compiledBroadSurfaceManifest: null,
    compiledBroadAnnotationInteractionResidents: interactionResidents,
    get compiledBroadAnnotationInteractionResidentGeneration() {
      return compiledBroadAnnotationInteractionResidentGeneration;
    },
    set compiledBroadAnnotationInteractionResidentGeneration(value) {
      compiledBroadAnnotationInteractionResidentGeneration = value;
    },
    get prepackedAnnotationSceneLayer() {
      return prepackedAnnotationSceneLayer;
    },
    set prepackedAnnotationSceneLayer(value) {
      prepackedAnnotationSceneLayer = value;
    },
    get prepackedAnnotationSceneStatus() {
      return prepackedAnnotationSceneStatus;
    },
    set prepackedAnnotationSceneStatus(value) {
      prepackedAnnotationSceneStatus = value;
    },
    get prepackedAnnotationSceneInput() {
      return prepackedAnnotationSceneInput;
    },
    set prepackedAnnotationSceneInput(value) {
      prepackedAnnotationSceneInput = value;
    },
    get retainedLinearFullSetMeshResident() {
      return retainedLinearFullSetMeshResident;
    },
    set retainedLinearFullSetMeshResident(value) {
      retainedLinearFullSetMeshResident = value;
    },
    labelCache: { clear() {} },
    overviewCache: { invalidate() {} },
    get retainedOverviewHitBins() {
      return retainedOverviewHitBins;
    },
    set retainedOverviewHitBins(value) {
      retainedOverviewHitBins = value;
    },
    get retainedOverviewPassthroughDrawn() {
      return retainedOverviewPassthroughDrawn;
    },
    set retainedOverviewPassthroughDrawn(value) {
      retainedOverviewPassthroughDrawn = value;
    },
    get lastRenderKey() {
      return lastRenderKey;
    },
    set lastRenderKey(value) {
      lastRenderKey = value;
    },
    retainedOverviewLayer: null,
    genomeWideTextureCacheLayer: null,
    retainedLinearFeatureLayer: null,
    retainedLinearTranscriptLayer: null,
    get retainedLinearTranscriptKey() {
      return retainedLinearTranscriptKey;
    },
    set retainedLinearTranscriptKey(value) {
      retainedLinearTranscriptKey = value;
    },
    get retainedLinearTranscriptFeatureSet() {
      return retainedLinearTranscriptFeatureSet;
    },
    set retainedLinearTranscriptFeatureSet(value) {
      retainedLinearTranscriptFeatureSet = value;
    },
    get retainedLinearTranscriptMembershipNeedsRebind() {
      return retainedLinearTranscriptMembershipNeedsRebind;
    },
    set retainedLinearTranscriptMembershipNeedsRebind(value) {
      retainedLinearTranscriptMembershipNeedsRebind = value;
    },
    get retainedLinearSourceWindow() {
      return retainedLinearSourceWindow;
    },
    set retainedLinearSourceWindow(value) {
      retainedLinearSourceWindow = value;
    },
    annotationResidentPageStreams: { clear() {} },
    get activeAnnotationResidentPageStreamKey() {
      return activeAnnotationResidentPageStreamKey;
    },
    set activeAnnotationResidentPageStreamKey(value) {
      activeAnnotationResidentPageStreamKey = value;
    },
    get annotationResidentPageStore() {
      return annotationResidentPageStore;
    },
    set annotationResidentPageStore(value) {
      annotationResidentPageStore = value;
    },
    get residentAnnotationViewportSelectionCache() {
      return residentAnnotationViewportSelectionCache;
    },
    set residentAnnotationViewportSelectionCache(value) {
      residentAnnotationViewportSelectionCache = value;
    },
    get residentAnnotationViewportSelectionStatus() {
      return residentAnnotationViewportSelectionStatus;
    },
    set residentAnnotationViewportSelectionStatus(value) {
      residentAnnotationViewportSelectionStatus = value;
    },
    get residentAnnotationViewportSelectedPageCount() {
      return residentAnnotationViewportSelectedPageCount;
    },
    set residentAnnotationViewportSelectedPageCount(value) {
      residentAnnotationViewportSelectedPageCount = value;
    },
    get residentAnnotationViewportSelectedFeatureCount() {
      return residentAnnotationViewportSelectedFeatureCount;
    },
    set residentAnnotationViewportSelectedFeatureCount(value) {
      residentAnnotationViewportSelectedFeatureCount = value;
    },
    get residentAnnotationViewportExpectedPageCount() {
      return residentAnnotationViewportExpectedPageCount;
    },
    set residentAnnotationViewportExpectedPageCount(value) {
      residentAnnotationViewportExpectedPageCount = value;
    },
    get residentAnnotationViewportMissingPageCount() {
      return residentAnnotationViewportMissingPageCount;
    },
    set residentAnnotationViewportMissingPageCount(value) {
      residentAnnotationViewportMissingPageCount = value;
    },
    get residentAnnotationViewportCoverageComplete() {
      return residentAnnotationViewportCoverageComplete;
    },
    set residentAnnotationViewportCoverageComplete(value) {
      residentAnnotationViewportCoverageComplete = value;
    },
    get residentAnnotationViewportProducerCoverageComplete() {
      return residentAnnotationViewportProducerCoverageComplete;
    },
    set residentAnnotationViewportProducerCoverageComplete(value) {
      residentAnnotationViewportProducerCoverageComplete = value;
    },
    graphics,
    retainedTranscriptDecorationGraphics,
    annotationSearchFocusGraphics,
    interactionGraphics,
    get labelIndex() {
      return labelIndex;
    },
    set labelIndex(value) {
      labelIndex = value;
    },
    curvedLabels: { reset() {} },
    labelPool,
    hitCache,
    outlineCache: { clear() {} },
    get labelOccupancyCache() {
      return labelOccupancyCache;
    },
    set labelOccupancyCache(value) {
      labelOccupancyCache = value;
    },
    get overviewBinDrawCount() {
      return overviewBinDrawCount;
    },
    set overviewBinDrawCount(value) {
      overviewBinDrawCount = value;
    },
    get lastInteractionOutlineCommandCount() {
      return lastInteractionOutlineCommandCount;
    },
    set lastInteractionOutlineCommandCount(value) {
      lastInteractionOutlineCommandCount = value;
    },
    get annotationSearchFocusMaskDrawCount() {
      return annotationSearchFocusMaskDrawCount;
    },
    set annotationSearchFocusMaskDrawCount(value) {
      annotationSearchFocusMaskDrawCount = value;
    },
    get annotationSearchFocusPrimitiveDrawCount() {
      return annotationSearchFocusPrimitiveDrawCount;
    },
    set annotationSearchFocusPrimitiveDrawCount(value) {
      annotationSearchFocusPrimitiveDrawCount = value;
    },
    get annotationSearchFocusResolvedTrackId() {
      return annotationSearchFocusResolvedTrackId;
    },
    set annotationSearchFocusResolvedTrackId(value) {
      annotationSearchFocusResolvedTrackId = value;
    },
    get annotationSearchFocusResolvedCanonicalIdentity() {
      return annotationSearchFocusResolvedCanonicalIdentity;
    },
    set annotationSearchFocusResolvedCanonicalIdentity(value) {
      annotationSearchFocusResolvedCanonicalIdentity = value;
    },
    get annotationSearchFocusPresentationLane() {
      return annotationSearchFocusPresentationLane;
    },
    set annotationSearchFocusPresentationLane(value) {
      annotationSearchFocusPresentationLane = value;
    },
    clearCompiledBroadSurfaceRequirement() {},
    disposePrepackedAnnotationScene() {},
    resetRenderStats() {},
    resetTilePyramid() {},
    resetRetainedOverviewDebug() {},
    clearDecorationCache() {},
  };
}

export class AnnotationLayoutState
  implements
    OverlayLayoutHost,
    LaneEnvelopeHost,
    ClearDrawStateHost,
    GenomeIngressHost,
    FlatPresentationSnapshotHost
{
  _layout: UnifiedLayout | null = null;
  _contract: TrackContract | null = null;
  maxAnnotationLane = 0;
  maxCdsLane = -1;
  maxLane = 0;
  sourceMaxAnnotationLane = 0;
  sourceMaxCdsLane = -1;
  features: Feature[] = [];
  featuresSortedByStart: Feature[] = [];
  longFeatures: Feature[] = [];
  circularWrappedFeatures: Feature[] = [];
  maxFeatureLenBp = 0;
  genomeLength = 0;
  genomeCircular = false;
  currentGenomeIdentity = '';
  currentAnnotationSourceFingerprint: string | null = null;
  currentAnnotationPlacementFingerprint: string | null = null;
  currentGenomeAnnotationSourcePlacementProvenance: {
    sourceFingerprint: string;
    placementFingerprint: string;
  } | null = null;
  annotationRequestedLayerTypes: string[] = [];
  annotationExactCoverage: Array<{ startBp: number; endBp: number }> | null = null;
  featureById = new Map<number, Feature>();
  featureWindowIndex = new FeatureWindowIndex({
    genomeLength: 0,
    circular: false,
    features: [],
  });
  readonly annotationPresentationStreams = new Map<
    string,
    { generation: number; snapshot: AnnotationFlatPresentationSnapshot }
  >();
  activeAnnotationPresentationStreamKey: string | null = null;

  private glue: AnnotationLayoutGlue = idleAnnotationLayoutGlue();
  private clearCompiledBroad: () => void = () => {};

  constructor() {}
  attach(collaborators: OverlayPresenterCollaborators): void {
    this.clearCompiledBroad = () =>
      collaborators.compiledBroad.clearCompiledBroadSurfaceRequirement();
    this.glue = {
      get lastRenderKeyParts() {
        return collaborators.retained.lastRenderKeyParts;
      },
      set lastRenderKeyParts(value) {
        collaborators.retained.lastRenderKeyParts = value;
      },
      hashRetainedLinearTranscriptFeatureKey: (featuresToRender) =>
        collaborators.retained.hashRetainedLinearTranscriptFeatureKey(featuresToRender),
      get prepackedAnnotationRuntimePolicy() {
        return collaborators.prepacked.prepackedAnnotationRuntimePolicy;
      },
      set prepackedAnnotationRuntimePolicy(value) {
        collaborators.prepacked.prepackedAnnotationRuntimePolicy = value;
      },
      get prepackedAnnotationSceneOwnerKey() {
        return collaborators.prepacked.prepackedAnnotationSceneOwnerKey;
      },
      set prepackedAnnotationSceneOwnerKey(value) {
        collaborators.prepacked.prepackedAnnotationSceneOwnerKey = value;
      },
      get prepackedAnnotationSceneResidents() {
        return collaborators.prepacked
          .prepackedAnnotationSceneResidents as AnnotationLayoutGlue['prepackedAnnotationSceneResidents'];
      },
      annotationTrackStackMaxLane: (policy) =>
        collaborators.compiledBroad.annotationTrackStackMaxLane(policy),
      get prebuiltRasterEligibleForLastFrame() {
        return collaborators.retained.prebuiltRasterEligibleForLastFrame;
      },
      set prebuiltRasterEligibleForLastFrame(value) {
        collaborators.retained.prebuiltRasterEligibleForLastFrame = value;
      },
      get prebuiltRasterContractForLastFrame() {
        return collaborators.retained.prebuiltRasterContractForLastFrame;
      },
      set prebuiltRasterContractForLastFrame(value) {
        collaborators.retained.prebuiltRasterContractForLastFrame = value;
      },
      get compiledBroadSurfaceSourcePlacementAuthority() {
        return collaborators.compiledBroad
          .compiledBroadSurfaceSourcePlacementAuthority as AnnotationLayoutGlue['compiledBroadSurfaceSourcePlacementAuthority'];
      },
      set compiledBroadSurfaceSourcePlacementAuthority(value) {
        collaborators.compiledBroad.compiledBroadSurfaceSourcePlacementAuthority =
          value as typeof collaborators.compiledBroad.compiledBroadSurfaceSourcePlacementAuthority;
      },
      get compiledBroadSurfacePresenter() {
        return collaborators.compiledBroad.compiledBroadSurfacePresenter;
      },
      set compiledBroadSurfacePresenter(value) {
        collaborators.compiledBroad.compiledBroadSurfacePresenter = value;
      },
      get compiledBroadSurfaceCandidatePresenter() {
        return collaborators.compiledBroad.compiledBroadSurfaceCandidatePresenter;
      },
      set compiledBroadSurfaceCandidatePresenter(value) {
        collaborators.compiledBroad.compiledBroadSurfaceCandidatePresenter = value;
      },
      get compiledBroadSurfaceTrackOwners() {
        return collaborators.compiledBroad.compiledBroadSurfaceTrackOwners;
      },
      get compiledBroadSurfaceTrackCandidateOwners() {
        return collaborators.compiledBroad.compiledBroadSurfaceTrackCandidateOwners;
      },
      get compiledBroadSurfaceRequirement() {
        return collaborators.compiledBroad.compiledBroadSurfaceRequirement;
      },
      set compiledBroadSurfaceRequirement(value) {
        if (!value) {
          collaborators.compiledBroad.clearCompiledBroadSurfaceRequirement();
          return;
        }
        collaborators.compiledBroad.requireCompiledBroadSurface({
          genomeLengthBp: value.genomeLengthBp ?? 0,
          broadCorridorFinestSpanBp: value.broadCorridorFinestSpanBp ?? 0,
        });
      },
      get compiledBroadSurfaceManifest() {
        return collaborators.compiledBroad.compiledBroadSurfaceManifest;
      },
      set compiledBroadSurfaceManifest(value) {
        collaborators.compiledBroad.compiledBroadSurfaceManifest = value;
      },
      get compiledBroadAnnotationInteractionResidents() {
        return collaborators.compiledBroad
          .compiledBroadAnnotationInteractionResidents as AnnotationLayoutGlue['compiledBroadAnnotationInteractionResidents'];
      },
      get compiledBroadAnnotationInteractionResidentGeneration() {
        return collaborators.compiledBroad.compiledBroadAnnotationInteractionResidentGeneration;
      },
      set compiledBroadAnnotationInteractionResidentGeneration(value) {
        collaborators.compiledBroad.compiledBroadAnnotationInteractionResidentGeneration = value;
      },
      get prepackedAnnotationSceneLayer() {
        return collaborators.prepacked.prepackedAnnotationSceneLayer;
      },
      set prepackedAnnotationSceneLayer(value) {
        collaborators.prepacked.prepackedAnnotationSceneLayer =
          value as typeof collaborators.prepacked.prepackedAnnotationSceneLayer;
      },
      get prepackedAnnotationSceneStatus() {
        return collaborators.prepacked.prepackedAnnotationSceneStatus;
      },
      set prepackedAnnotationSceneStatus(value) {
        collaborators.prepacked.prepackedAnnotationSceneStatus =
          value as typeof collaborators.prepacked.prepackedAnnotationSceneStatus;
      },
      get prepackedAnnotationSceneInput() {
        return collaborators.prepacked
          .prepackedAnnotationSceneInput as AnnotationLayoutGlue['prepackedAnnotationSceneInput'];
      },
      set prepackedAnnotationSceneInput(value) {
        collaborators.prepacked.prepackedAnnotationSceneInput =
          value as typeof collaborators.prepacked.prepackedAnnotationSceneInput;
      },
      get retainedLinearFullSetMeshResident() {
        return collaborators.retained.retainedLinearFullSetMeshResident;
      },
      set retainedLinearFullSetMeshResident(value) {
        collaborators.retained.retainedLinearFullSetMeshResident = value;
      },
      get labelCache() {
        return collaborators.immediateDraw.labelCache;
      },
      get overviewCache() {
        return collaborators.retained.overviewCache;
      },
      get retainedOverviewHitBins() {
        return collaborators.retained.retainedOverviewHitBins;
      },
      set retainedOverviewHitBins(value) {
        collaborators.retained.retainedOverviewHitBins =
          value as typeof collaborators.retained.retainedOverviewHitBins;
      },
      get retainedOverviewPassthroughDrawn() {
        return collaborators.retained.retainedOverviewPassthroughDrawn;
      },
      set retainedOverviewPassthroughDrawn(value) {
        collaborators.retained.retainedOverviewPassthroughDrawn = value;
      },
      get lastRenderKey() {
        return collaborators.retained.lastRenderKey;
      },
      set lastRenderKey(value) {
        collaborators.retained.lastRenderKey = value;
      },
      get retainedOverviewLayer() {
        return collaborators.retained.retainedOverviewLayer;
      },
      set retainedOverviewLayer(value) {
        collaborators.retained.retainedOverviewLayer =
          value as typeof collaborators.retained.retainedOverviewLayer;
      },
      get genomeWideTextureCacheLayer() {
        return collaborators.retained.genomeWideTextureCacheLayer;
      },
      set genomeWideTextureCacheLayer(value) {
        collaborators.retained.genomeWideTextureCacheLayer =
          value as typeof collaborators.retained.genomeWideTextureCacheLayer;
      },
      get retainedLinearFeatureLayer() {
        return collaborators.retained.retainedLinearFeatureLayer;
      },
      set retainedLinearFeatureLayer(value) {
        collaborators.retained.retainedLinearFeatureLayer =
          value as typeof collaborators.retained.retainedLinearFeatureLayer;
      },
      get retainedLinearTranscriptLayer() {
        return collaborators.retained.retainedLinearTranscriptLayer;
      },
      set retainedLinearTranscriptLayer(value) {
        collaborators.retained.retainedLinearTranscriptLayer =
          value as typeof collaborators.retained.retainedLinearTranscriptLayer;
      },
      get retainedLinearTranscriptKey() {
        return collaborators.retained.retainedLinearTranscriptKey;
      },
      set retainedLinearTranscriptKey(value) {
        collaborators.retained.retainedLinearTranscriptKey = value;
      },
      get retainedLinearTranscriptFeatureSet() {
        return collaborators.retained.retainedLinearTranscriptFeatureSet;
      },
      set retainedLinearTranscriptFeatureSet(value) {
        collaborators.retained.retainedLinearTranscriptFeatureSet =
          value as typeof collaborators.retained.retainedLinearTranscriptFeatureSet;
      },
      get retainedLinearTranscriptMembershipNeedsRebind() {
        return collaborators.retained.retainedLinearTranscriptMembershipNeedsRebind;
      },
      set retainedLinearTranscriptMembershipNeedsRebind(value) {
        collaborators.retained.retainedLinearTranscriptMembershipNeedsRebind = value;
      },
      get retainedLinearSourceWindow() {
        return collaborators.retained.retainedLinearSourceWindow;
      },
      set retainedLinearSourceWindow(value) {
        collaborators.retained.retainedLinearSourceWindow =
          value as typeof collaborators.retained.retainedLinearSourceWindow;
      },
      get annotationResidentPageStreams() {
        return collaborators.residentPages.annotationResidentPageStreams;
      },
      get activeAnnotationResidentPageStreamKey() {
        return collaborators.residentPages.activeAnnotationResidentPageStreamKey;
      },
      set activeAnnotationResidentPageStreamKey(value) {
        collaborators.residentPages.activeAnnotationResidentPageStreamKey = value;
      },
      get annotationResidentPageStore() {
        return collaborators.residentPages.annotationResidentPageStore;
      },
      set annotationResidentPageStore(value) {
        collaborators.residentPages.annotationResidentPageStore = value;
      },
      get residentAnnotationViewportSelectionCache() {
        return collaborators.residentPages.residentAnnotationViewportSelectionCache;
      },
      set residentAnnotationViewportSelectionCache(value) {
        collaborators.residentPages.residentAnnotationViewportSelectionCache = value;
      },
      get residentAnnotationViewportSelectionStatus() {
        return collaborators.residentPages.residentAnnotationViewportSelectionStatus;
      },
      set residentAnnotationViewportSelectionStatus(value) {
        collaborators.residentPages.residentAnnotationViewportSelectionStatus = value;
      },
      get residentAnnotationViewportSelectedPageCount() {
        return collaborators.residentPages.residentAnnotationViewportSelectedPageCount;
      },
      set residentAnnotationViewportSelectedPageCount(value) {
        collaborators.residentPages.residentAnnotationViewportSelectedPageCount = value;
      },
      get residentAnnotationViewportSelectedFeatureCount() {
        return collaborators.residentPages.residentAnnotationViewportSelectedFeatureCount;
      },
      set residentAnnotationViewportSelectedFeatureCount(value) {
        collaborators.residentPages.residentAnnotationViewportSelectedFeatureCount = value;
      },
      get residentAnnotationViewportExpectedPageCount() {
        return collaborators.residentPages.residentAnnotationViewportExpectedPageCount;
      },
      set residentAnnotationViewportExpectedPageCount(value) {
        collaborators.residentPages.residentAnnotationViewportExpectedPageCount = value;
      },
      get residentAnnotationViewportMissingPageCount() {
        return collaborators.residentPages.residentAnnotationViewportMissingPageCount;
      },
      set residentAnnotationViewportMissingPageCount(value) {
        collaborators.residentPages.residentAnnotationViewportMissingPageCount = value;
      },
      get residentAnnotationViewportCoverageComplete() {
        return collaborators.residentPages.residentAnnotationViewportCoverageComplete;
      },
      set residentAnnotationViewportCoverageComplete(value) {
        collaborators.residentPages.residentAnnotationViewportCoverageComplete = value;
      },
      get residentAnnotationViewportProducerCoverageComplete() {
        return collaborators.residentPages.residentAnnotationViewportProducerCoverageComplete;
      },
      set residentAnnotationViewportProducerCoverageComplete(value) {
        collaborators.residentPages.residentAnnotationViewportProducerCoverageComplete = value;
      },
      get graphics() {
        return collaborators.retained.graphics;
      },
      get retainedTranscriptDecorationGraphics() {
        return collaborators.retained.retainedTranscriptDecorationGraphics;
      },
      get annotationSearchFocusGraphics() {
        return collaborators.searchFocus.annotationSearchFocusGraphics;
      },
      get interactionGraphics() {
        return collaborators.outlines.interactionGraphics;
      },
      get labelIndex() {
        return collaborators.retained.labelIndex;
      },
      set labelIndex(value) {
        collaborators.retained.labelIndex = value;
      },
      get curvedLabels() {
        return collaborators.retained.curvedLabels;
      },
      get labelPool() {
        return collaborators.retained.labelPool;
      },
      get hitCache() {
        return collaborators.hits.hitCache;
      },
      get outlineCache() {
        return collaborators.immediateDraw.outlineCache;
      },
      get labelOccupancyCache() {
        return collaborators.retained.labelOccupancyCache;
      },
      set labelOccupancyCache(value) {
        collaborators.retained.labelOccupancyCache =
          value as typeof collaborators.retained.labelOccupancyCache;
      },
      get overviewBinDrawCount() {
        return collaborators.retained.overviewBinDrawCount;
      },
      set overviewBinDrawCount(value) {
        collaborators.retained.overviewBinDrawCount = value;
      },
      get lastInteractionOutlineCommandCount() {
        return collaborators.outlines.lastInteractionOutlineCommandCount;
      },
      set lastInteractionOutlineCommandCount(value) {
        collaborators.outlines.lastInteractionOutlineCommandCount = value;
      },
      get annotationSearchFocusMaskDrawCount() {
        return collaborators.searchFocus.annotationSearchFocusMaskDrawCount;
      },
      set annotationSearchFocusMaskDrawCount(value) {
        collaborators.searchFocus.annotationSearchFocusMaskDrawCount = value;
      },
      get annotationSearchFocusPrimitiveDrawCount() {
        return collaborators.searchFocus.annotationSearchFocusPrimitiveDrawCount;
      },
      set annotationSearchFocusPrimitiveDrawCount(value) {
        collaborators.searchFocus.annotationSearchFocusPrimitiveDrawCount = value;
      },
      get annotationSearchFocusResolvedTrackId() {
        return collaborators.searchFocus.annotationSearchFocusResolvedTrackId;
      },
      set annotationSearchFocusResolvedTrackId(value) {
        collaborators.searchFocus.annotationSearchFocusResolvedTrackId = value;
      },
      get annotationSearchFocusResolvedCanonicalIdentity() {
        return collaborators.searchFocus.annotationSearchFocusResolvedCanonicalIdentity;
      },
      set annotationSearchFocusResolvedCanonicalIdentity(value) {
        collaborators.searchFocus.annotationSearchFocusResolvedCanonicalIdentity = value;
      },
      get annotationSearchFocusPresentationLane() {
        return collaborators.searchFocus.annotationSearchFocusPresentationLane;
      },
      set annotationSearchFocusPresentationLane(value) {
        collaborators.searchFocus.annotationSearchFocusPresentationLane = value;
      },
      clearCompiledBroadSurfaceRequirement: () => this.clearCompiledBroadSurfaceRequirement(),
      disposePrepackedAnnotationScene: (reason) =>
        collaborators.prepacked.disposePrepackedAnnotationScene(reason as never),
      resetRenderStats: () => collaborators.retained.resetRenderStats(),
      resetTilePyramid: (opts) => collaborators.tilePyramid.reset(opts),
      resetRetainedOverviewDebug: (opts) => collaborators.retained.resetRetainedOverviewDebug(opts),
      clearDecorationCache: () => collaborators.retained.clearDecorationCache(),
    } as AnnotationLayoutGlue;
  }

  get lastRenderKeyParts() {
    return this.glue.lastRenderKeyParts;
  }
  set lastRenderKeyParts(value) {
    this.glue.lastRenderKeyParts = value;
  }
  hashRetainedLinearTranscriptFeatureKey(featuresToRender: readonly Feature[]): string {
    return this.glue.hashRetainedLinearTranscriptFeatureKey(featuresToRender);
  }

  get prepackedAnnotationRuntimePolicy() {
    return this.glue.prepackedAnnotationRuntimePolicy;
  }
  set prepackedAnnotationRuntimePolicy(value) {
    this.glue.prepackedAnnotationRuntimePolicy = value;
  }
  get prepackedAnnotationSceneOwnerKey() {
    return this.glue.prepackedAnnotationSceneOwnerKey;
  }
  set prepackedAnnotationSceneOwnerKey(value) {
    this.glue.prepackedAnnotationSceneOwnerKey = value;
  }
  get prepackedAnnotationSceneResidents() {
    return this.glue.prepackedAnnotationSceneResidents;
  }
  annotationTrackStackMaxLane(policy: AnnotationPolicyGpuRuntimeV1): number {
    return this.glue.annotationTrackStackMaxLane(policy);
  }
  applyPrepackedAnnotationLaneEnvelope(
    policy: AnnotationPolicyGpuRuntimeV1,
    maxima: AnnotationPolicyGpuTrackLaneMaximaV1
  ): void {
    applyPrepackedAnnotationLaneEnvelopeFn(this, policy, maxima);
  }
  commitAnnotationLaneEnvelope(maxAnnotationLane: number, maxCdsLane: number): void {
    commitAnnotationLaneEnvelopeFn(this, maxAnnotationLane, maxCdsLane);
  }
  reconcileAnnotationLaneEnvelopeAuthority(): void {
    reconcileAnnotationLaneEnvelopeAuthorityFn(this);
  }

  wrappedFeatureOverlapsRange(feature: Feature, viewStartBp: number, viewEndBp: number): boolean {
    return (
      (feature.start < viewEndBp && this.genomeLength > viewStartBp) ||
      (viewEndBp > 0 && feature.end > viewStartBp)
    );
  }
  featuresInRange(viewStartBp: number, viewEndBp: number): Feature[] {
    return featuresInRangeFn(this, viewStartBp, viewEndBp);
  }
  hasFeaturesInRange(viewStartBp: number, viewEndBp: number): boolean {
    return hasFeaturesInRangeFn(this, viewStartBp, viewEndBp);
  }

  get prebuiltRasterEligibleForLastFrame() {
    return this.glue.prebuiltRasterEligibleForLastFrame;
  }
  set prebuiltRasterEligibleForLastFrame(value) {
    this.glue.prebuiltRasterEligibleForLastFrame = value;
  }
  get prebuiltRasterContractForLastFrame() {
    return this.glue.prebuiltRasterContractForLastFrame;
  }
  set prebuiltRasterContractForLastFrame(value) {
    this.glue.prebuiltRasterContractForLastFrame = value;
  }
  get compiledBroadSurfaceSourcePlacementAuthority() {
    return this.glue.compiledBroadSurfaceSourcePlacementAuthority;
  }
  set compiledBroadSurfaceSourcePlacementAuthority(value) {
    this.glue.compiledBroadSurfaceSourcePlacementAuthority = value;
  }
  get compiledBroadSurfacePresenter() {
    return this.glue.compiledBroadSurfacePresenter;
  }
  set compiledBroadSurfacePresenter(value) {
    this.glue.compiledBroadSurfacePresenter = value;
  }
  get compiledBroadSurfaceCandidatePresenter() {
    return this.glue.compiledBroadSurfaceCandidatePresenter;
  }
  set compiledBroadSurfaceCandidatePresenter(value) {
    this.glue.compiledBroadSurfaceCandidatePresenter = value;
  }
  get compiledBroadSurfaceTrackOwners() {
    return this.glue.compiledBroadSurfaceTrackOwners;
  }
  get compiledBroadSurfaceTrackCandidateOwners() {
    return this.glue.compiledBroadSurfaceTrackCandidateOwners;
  }
  get compiledBroadSurfaceRequirement() {
    return this.glue.compiledBroadSurfaceRequirement;
  }
  set compiledBroadSurfaceRequirement(value) {
    this.glue.compiledBroadSurfaceRequirement = value;
  }
  get compiledBroadSurfaceManifest() {
    return this.glue.compiledBroadSurfaceManifest;
  }
  set compiledBroadSurfaceManifest(value) {
    this.glue.compiledBroadSurfaceManifest = value;
  }
  get compiledBroadAnnotationInteractionResidents() {
    return this.glue.compiledBroadAnnotationInteractionResidents;
  }
  get compiledBroadAnnotationInteractionResidentGeneration() {
    return this.glue.compiledBroadAnnotationInteractionResidentGeneration;
  }
  set compiledBroadAnnotationInteractionResidentGeneration(value) {
    this.glue.compiledBroadAnnotationInteractionResidentGeneration = value;
  }
  get prepackedAnnotationSceneLayer() {
    return this.glue.prepackedAnnotationSceneLayer;
  }
  set prepackedAnnotationSceneLayer(value) {
    this.glue.prepackedAnnotationSceneLayer = value;
  }
  get prepackedAnnotationSceneStatus() {
    return this.glue.prepackedAnnotationSceneStatus;
  }
  set prepackedAnnotationSceneStatus(value) {
    this.glue.prepackedAnnotationSceneStatus = value;
  }
  get prepackedAnnotationSceneInput() {
    return this.glue.prepackedAnnotationSceneInput;
  }
  set prepackedAnnotationSceneInput(value) {
    this.glue.prepackedAnnotationSceneInput = value;
  }
  get retainedLinearFullSetMeshResident() {
    return this.glue.retainedLinearFullSetMeshResident;
  }
  set retainedLinearFullSetMeshResident(value) {
    this.glue.retainedLinearFullSetMeshResident = value;
  }
  get labelCache() {
    return this.glue.labelCache;
  }
  get overviewCache() {
    return this.glue.overviewCache;
  }
  get retainedOverviewHitBins() {
    return this.glue.retainedOverviewHitBins;
  }
  set retainedOverviewHitBins(value) {
    this.glue.retainedOverviewHitBins = value;
  }
  get retainedOverviewPassthroughDrawn() {
    return this.glue.retainedOverviewPassthroughDrawn;
  }
  set retainedOverviewPassthroughDrawn(value) {
    this.glue.retainedOverviewPassthroughDrawn = value;
  }
  get lastRenderKey() {
    return this.glue.lastRenderKey;
  }
  set lastRenderKey(value) {
    this.glue.lastRenderKey = value;
  }
  get retainedOverviewLayer() {
    return this.glue.retainedOverviewLayer;
  }
  set retainedOverviewLayer(value) {
    this.glue.retainedOverviewLayer = value;
  }
  get genomeWideTextureCacheLayer() {
    return this.glue.genomeWideTextureCacheLayer;
  }
  set genomeWideTextureCacheLayer(value) {
    this.glue.genomeWideTextureCacheLayer = value;
  }
  get retainedLinearFeatureLayer() {
    return this.glue.retainedLinearFeatureLayer;
  }
  set retainedLinearFeatureLayer(value) {
    this.glue.retainedLinearFeatureLayer = value;
  }
  get retainedLinearTranscriptLayer() {
    return this.glue.retainedLinearTranscriptLayer;
  }
  set retainedLinearTranscriptLayer(value) {
    this.glue.retainedLinearTranscriptLayer = value;
  }
  get retainedLinearTranscriptKey() {
    return this.glue.retainedLinearTranscriptKey;
  }
  set retainedLinearTranscriptKey(value) {
    this.glue.retainedLinearTranscriptKey = value;
  }
  get retainedLinearTranscriptFeatureSet() {
    return this.glue.retainedLinearTranscriptFeatureSet;
  }
  set retainedLinearTranscriptFeatureSet(value) {
    this.glue.retainedLinearTranscriptFeatureSet = value;
  }
  get retainedLinearTranscriptMembershipNeedsRebind() {
    return this.glue.retainedLinearTranscriptMembershipNeedsRebind;
  }
  set retainedLinearTranscriptMembershipNeedsRebind(value) {
    this.glue.retainedLinearTranscriptMembershipNeedsRebind = value;
  }
  get retainedLinearSourceWindow() {
    return this.glue.retainedLinearSourceWindow;
  }
  set retainedLinearSourceWindow(value) {
    this.glue.retainedLinearSourceWindow = value;
  }
  get annotationResidentPageStreams() {
    return this.glue.annotationResidentPageStreams;
  }
  get activeAnnotationResidentPageStreamKey() {
    return this.glue.activeAnnotationResidentPageStreamKey;
  }
  set activeAnnotationResidentPageStreamKey(value) {
    this.glue.activeAnnotationResidentPageStreamKey = value;
  }
  get annotationResidentPageStore() {
    return this.glue.annotationResidentPageStore;
  }
  set annotationResidentPageStore(value) {
    this.glue.annotationResidentPageStore = value;
  }
  get residentAnnotationViewportSelectionCache() {
    return this.glue.residentAnnotationViewportSelectionCache;
  }
  set residentAnnotationViewportSelectionCache(value) {
    this.glue.residentAnnotationViewportSelectionCache = value;
  }
  get residentAnnotationViewportSelectionStatus() {
    return this.glue.residentAnnotationViewportSelectionStatus;
  }
  set residentAnnotationViewportSelectionStatus(value) {
    this.glue.residentAnnotationViewportSelectionStatus = value;
  }
  get residentAnnotationViewportSelectedPageCount() {
    return this.glue.residentAnnotationViewportSelectedPageCount;
  }
  set residentAnnotationViewportSelectedPageCount(value) {
    this.glue.residentAnnotationViewportSelectedPageCount = value;
  }
  get residentAnnotationViewportSelectedFeatureCount() {
    return this.glue.residentAnnotationViewportSelectedFeatureCount;
  }
  set residentAnnotationViewportSelectedFeatureCount(value) {
    this.glue.residentAnnotationViewportSelectedFeatureCount = value;
  }
  get residentAnnotationViewportExpectedPageCount() {
    return this.glue.residentAnnotationViewportExpectedPageCount;
  }
  set residentAnnotationViewportExpectedPageCount(value) {
    this.glue.residentAnnotationViewportExpectedPageCount = value;
  }
  get residentAnnotationViewportMissingPageCount() {
    return this.glue.residentAnnotationViewportMissingPageCount;
  }
  set residentAnnotationViewportMissingPageCount(value) {
    this.glue.residentAnnotationViewportMissingPageCount = value;
  }
  get residentAnnotationViewportCoverageComplete() {
    return this.glue.residentAnnotationViewportCoverageComplete;
  }
  set residentAnnotationViewportCoverageComplete(value) {
    this.glue.residentAnnotationViewportCoverageComplete = value;
  }
  get residentAnnotationViewportProducerCoverageComplete() {
    return this.glue.residentAnnotationViewportProducerCoverageComplete;
  }
  set residentAnnotationViewportProducerCoverageComplete(value) {
    this.glue.residentAnnotationViewportProducerCoverageComplete = value;
  }

  get graphics() {
    return this.glue.graphics;
  }
  get retainedTranscriptDecorationGraphics() {
    return this.glue.retainedTranscriptDecorationGraphics;
  }
  get annotationSearchFocusGraphics() {
    return this.glue.annotationSearchFocusGraphics;
  }
  get interactionGraphics() {
    return this.glue.interactionGraphics;
  }
  get labelIndex() {
    return this.glue.labelIndex;
  }
  set labelIndex(value) {
    this.glue.labelIndex = value;
  }
  get curvedLabels() {
    return this.glue.curvedLabels;
  }
  get labelPool() {
    return this.glue.labelPool;
  }
  get hitCache() {
    return this.glue.hitCache;
  }
  get outlineCache() {
    return this.glue.outlineCache;
  }
  get labelOccupancyCache() {
    return this.glue.labelOccupancyCache;
  }
  set labelOccupancyCache(value) {
    this.glue.labelOccupancyCache = value;
  }
  get overviewBinDrawCount() {
    return this.glue.overviewBinDrawCount;
  }
  set overviewBinDrawCount(value) {
    this.glue.overviewBinDrawCount = value;
  }
  get lastInteractionOutlineCommandCount() {
    return this.glue.lastInteractionOutlineCommandCount;
  }
  set lastInteractionOutlineCommandCount(value) {
    this.glue.lastInteractionOutlineCommandCount = value;
  }
  get annotationSearchFocusMaskDrawCount() {
    return this.glue.annotationSearchFocusMaskDrawCount;
  }
  set annotationSearchFocusMaskDrawCount(value) {
    this.glue.annotationSearchFocusMaskDrawCount = value;
  }
  get annotationSearchFocusPrimitiveDrawCount() {
    return this.glue.annotationSearchFocusPrimitiveDrawCount;
  }
  set annotationSearchFocusPrimitiveDrawCount(value) {
    this.glue.annotationSearchFocusPrimitiveDrawCount = value;
  }
  get annotationSearchFocusResolvedTrackId() {
    return this.glue.annotationSearchFocusResolvedTrackId;
  }
  set annotationSearchFocusResolvedTrackId(value) {
    this.glue.annotationSearchFocusResolvedTrackId = value;
  }
  get annotationSearchFocusResolvedCanonicalIdentity() {
    return this.glue.annotationSearchFocusResolvedCanonicalIdentity;
  }
  set annotationSearchFocusResolvedCanonicalIdentity(value) {
    this.glue.annotationSearchFocusResolvedCanonicalIdentity = value;
  }
  get annotationSearchFocusPresentationLane() {
    return this.glue.annotationSearchFocusPresentationLane;
  }
  set annotationSearchFocusPresentationLane(value) {
    this.glue.annotationSearchFocusPresentationLane = value;
  }

  clearCompiledBroadSurfaceRequirement(): void {
    this.clearCompiledBroad();
    this.currentAnnotationSourceFingerprint =
      this.currentGenomeAnnotationSourcePlacementProvenance?.sourceFingerprint ?? null;
    this.currentAnnotationPlacementFingerprint =
      this.currentGenomeAnnotationSourcePlacementProvenance?.placementFingerprint ?? null;
  }
  disposePrepackedAnnotationScene(reason: string): void {
    this.glue.disposePrepackedAnnotationScene(reason);
  }
  resetRenderStats(): void {
    this.glue.resetRenderStats();
  }
  resetTilePyramid(opts: { retainRtt?: boolean }): void {
    this.glue.resetTilePyramid(opts);
  }
  resetRetainedOverviewDebug(opts: { preserveTranscriptMesh?: boolean }): void {
    this.glue.resetRetainedOverviewDebug(opts);
  }
  clearDecorationCache(): void {
    this.glue.clearDecorationCache();
  }
  clearDrawState(): void {
    clearDrawStateFn(this);
  }

  setLayout(
    layout: UnifiedLayout,
    effectiveEnvelope: {
      maxAnnotationLane: number;
      maxCdsLane: number;
    }
  ): void {
    setOverlayLayoutFn(this, layout, effectiveEnvelope);
  }
  loadGenome(genome: Genome): void {
    loadAnnotationGenomeFn(this, genome);
  }
  applyGenome(genome: Genome): void {
    applyAnnotationGenomeFn(this, genome);
  }
  applyAnnotationGenome(genome: Genome): void {
    this.applyGenome(genome);
  }

  annotationLayerTypesForPresentation(): string[] {
    if (this.annotationRequestedLayerTypes.length > 0) return this.annotationRequestedLayerTypes;
    return normalizeAnnotationLayerTypes(this.features.map((feature) => feature.type));
  }

  scaledBarHeight(): number {
    return scaledBarHeightFn();
  }

  scaledCdsLineHeight(): number {
    return scaledCdsLineHeightFn();
  }

  cdsDetailProgress(): number {
    return cdsDetailProgressFn(this);
  }

  cdsExonLabelAlpha(): number {
    return cdsExonLabelAlphaFn(this);
  }

  overviewLabelAlpha(): number {
    return overviewLabelAlphaFn(this);
  }

  featureOffset(feature: Feature): number {
    return featureOffsetFn(this, feature);
  }

  featureEnvelope(feature: Feature) {
    return featureEnvelopeFn(this, feature);
  }

  renderKeyParts(state: RenderState): AnnotationRenderKeyParts {
    return renderKeyPartsFn(this, state);
  }

  renderKeyFromParts(parts: AnnotationRenderKeyParts): string {
    return renderKeyFromPartsFn(parts);
  }

  renderKeyChangeReasons(next: AnnotationRenderKeyParts): string[] {
    return renderKeyChangeReasonsFn(this, next);
  }

  retainedLinearTranscriptFeatureKey(featuresToRender: readonly Feature[]): string {
    return retainedLinearTranscriptFeatureKeyFn(this, featuresToRender);
  }

  retainedLinearTranscriptLayoutKey(state: RenderState): string {
    return retainedLinearTranscriptLayoutKeyFn(this, state);
  }

  prepackedAnnotationTrackBaseOffsetPx(): number | null {
    return prepackedAnnotationTrackBaseOffsetPxFn(this);
  }

  prepackedAnnotationCenterScreenY(path: PathMapper, localOffsetCenter: number): number | null {
    return prepackedAnnotationCenterScreenYFn(this, path, localOffsetCenter);
  }

  shouldRenderFeatureText(path: PathMapper): boolean {
    return shouldRenderFeatureTextAtLod({
      sequenceVisible: path.sequenceVisible,
      genomeLength: this.genomeLength,
      pixelsPerBp: path.pixelsPerBp,
      isArcMode: path.isArcMode,
    });
  }

  pillStartForTextCenter(
    path: PathMapper,
    centerBp: number,
    textCenterOffsetPx: number,
    offset: number
  ): number {
    const offsetBp = screenWidthToBp(path, centerBp, textCenterOffsetPx, offset);
    const startBp = centerBp - offsetBp;
    return this.genomeCircular ? normalizeBp(startBp, this.genomeLength) : startBp;
  }

  lanePillOutlineCommand(
    path: PathMapper,
    startBp: number,
    widthPx: number,
    offset: number,
    halfHeight: number
  ): OutlineCommand[] {
    return annotationLanePillOutlineCommand(
      path,
      startBp,
      widthPx,
      offset,
      halfHeight,
      this.genomeLength
    );
  }

  cdsLabelStripOutlineCommand(
    path: PathMapper,
    pillStartBp: number,
    pillWidthPx: number,
    featureEndBp: number,
    offset: number,
    pillHalfHeight: number,
    connectorHalfHeight: number
  ): OutlineCommand[] {
    return annotationCdsLabelStripOutlineCommand(
      path,
      pillStartBp,
      pillWidthPx,
      featureEndBp,
      offset,
      pillHalfHeight,
      connectorHalfHeight,
      this.genomeLength,
      cdsConnectorCenterOffset(pillHalfHeight, connectorHalfHeight)
    );
  }

  strokeLanePill(
    g: Graphics,
    path: PathMapper,
    startBp: number,
    widthPx: number,
    offset: number,
    halfHeight: number,
    color: number,
    alpha: number
  ): void {
    strokeLanePillFn(
      g,
      path,
      startBp,
      widthPx,
      offset,
      halfHeight,
      color,
      alpha,
      this.genomeLength,
      laneRoundedPillPolygon
    );
  }

  recordDrawAuditDecision(
    audit: AnnotationDrawAuditSnapshot,
    feature: Feature,
    decision: AnnotationDrawAuditDecision,
    path: PathMapper
  ): void {
    recordDrawAuditDecisionFn(this, audit, feature, decision, path);
  }
}

declare module './indexed-annotation-overlay-collaborators' {
  interface OverlayLayoutCollaborator extends AnnotationLayoutState {}
}
