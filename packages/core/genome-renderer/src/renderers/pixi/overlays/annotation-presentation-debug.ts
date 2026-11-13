import type { UnifiedLayout } from '../shared/track-layout';
import type {
  AnnotationPresentationSnapshot,
  AnnotationResidentPagePublication,
} from '../../../types';
import {
  annotationPresentationFamilies,
  buildAnnotationPresentationOwners,
  validateAnnotationPresentationOwners,
  type AnnotationSurfaceOwnerDebug,
} from './annotation-presentation-owners';

export function recordAnnotationPresentationSnapshotApply(
  snapshot: AnnotationPresentationSnapshot | AnnotationResidentPagePublication,
  durationMs: number
): void {
  if (typeof window === 'undefined') return;
  const target = window as Window & {
    __webglAnnotationSnapshotApplyCount?: number;
    __webglAnnotationSnapshotApplyLog?: Array<{
      sourceIdentity: string;
      policyKey: string;
      generation: number;
      featureCount: number;
      exactCoverageCount: number;
      durationMs: number;
      t: number;
    }>;
  };
  target.__webglAnnotationSnapshotApplyCount =
    (target.__webglAnnotationSnapshotApplyCount ?? 0) + 1;
  const log = (target.__webglAnnotationSnapshotApplyLog ??= []);
  log.push({
    sourceIdentity: snapshot.sourceIdentity,
    policyKey: snapshot.policyKey,
    generation: snapshot.generation,
    featureCount:
      'features' in snapshot
        ? snapshot.features.length
        : snapshot.pages.reduce((count, page) => count + page.features.length, 0),
    exactCoverageCount: snapshot.exactCoverage.length,
    durationMs,
    t: typeof performance === 'undefined' ? Date.now() : performance.now(),
  });
  if (log.length > 200) log.splice(0, log.length - 200);
}

export type AnnotationDebugLayoutSnapshot = {
  viewportHeight: number;
  totalHeight: number;
  offset: number;
  annotationTop: number;
  annotationHeight: number;
  annotationLanes: number;
  cdsLanes: number;
  fwdStrandTop: number;
  revStrandBottom: number;
  rulerY: number;
  sequenceBottom: number;
  sequenceOutOfViewport: boolean;
  annotationOffset: number;
  annotationStep: number;
  cdsBarOffset: number;
  cdsLaneStep: number;
};

export type AnnotationPresentationDebugSnapshot = {
  annotationLodBackend: string | null;
  annotationPresentationStyleId: string | null;
  annotationLodContractViolation: string | null;
  annotationPresentationOwnerViolations: string[];
  layoutInvariantViolations: string[];
  annotationPresentationLayerTypes: string[];
  annotationPresentationOwners: AnnotationSurfaceOwnerDebug[];
  runtimeGenomeWideTextureVisible: boolean;
  prebuiltGenomeWideTextureVisible: boolean;
  compiledBroadRasterVisible: boolean;
  sidecarTrackRasterVisible: boolean;
  sidecarTrackRasterLayerTypes: string[];
  rasterOwnerCount: number;
  prebuiltGenomeWideTextureEligible: boolean;
  retainedLinearVisibleMeshCount: number;
  tilePyramidVectorVisibleLayerCount: number;
  tilePyramidVectorPresentingBlockCount: number;
  tilePyramidVectorCoverageLevel: number | null;
  tilePyramidVectorVisibleTileFirst: number | null;
  tilePyramidVectorVisibleTileLast: number | null;
  tilePyramidVectorExpectedVisibleTileCount: number;
  tilePyramidVectorBuiltVisibleTileCount: number;
  tilePyramidVectorMissingVisibleTileCount: number;
  tilePyramidVectorCoverageComplete: boolean;
};

export type AnnotationPresentationDebugInput = {
  requestedLayerTypes: readonly string[];
  renderSetLayerTypes?: readonly string[] | null;
  presentationVisible: boolean;
  genomeLength: number;
  lastDrawAuditRange: { viewStartBp: number; viewEndBp: number } | null;
  runtimeGenomeWideTextureVisible: boolean;
  prebuiltGenomeWideTextureVisible: boolean;
  prebuiltGenomeWideTextureEligible: boolean;
  prebuiltGenomeWideTextureLayerTypes?: readonly string[];
  compiledBroadRasterVisible?: boolean;
  compiledBroadRasterLayerTypes?: readonly string[];
  compiledBroadRasterCoverageComplete?: boolean;
  sidecarTrackRasterVisible?: boolean;
  sidecarTrackRasterLayerTypes?: readonly string[];
  sidecarTrackRasterCoverageComplete?: boolean;
  retainedLinearVisibleMeshCount: number;
  retainedTranscriptVisibleBlockCount: number;
  tilePyramidVectorVisibleLayerCount: number;
  tilePyramidVectorPresenting: boolean;
  tilePyramidVectorPresentingBlockCount: number;
  tilePyramidVectorCoverageLevel: number | null;
  tilePyramidVectorVisibleTileFirst: number | null;
  tilePyramidVectorVisibleTileLast: number | null;
  tilePyramidVectorExpectedVisibleTileCount: number;
  tilePyramidVectorBuiltVisibleTileCount: number;
  tilePyramidVectorMissingVisibleTileCount: number;
  tilePyramidVectorCoverageComplete: boolean;
  overviewGlyphTilesPresenting: boolean;
  overviewGlyphTilesVisibleTileCount: number;
  overviewGlyphTilesCoverageComplete: boolean;
  prepackedTranscriptPresenting?: boolean;
  prepackedTranscriptLayerTypes?: readonly string[];
  prepackedTranscriptSubmittedPartitionCount?: number;
  prepackedTranscriptSubmittedInstanceCount?: number;
  immediateGraphicsVisible: boolean;
  lastDrawnFeatureCount: number;
  immediateDrawnLayerTypes: readonly string[];
};

function uniqueSortedLayerTypes(layerTypes: readonly string[]): string[] {
  return [...new Set(layerTypes)].filter(Boolean).sort((a, b) => a.localeCompare(b));
}

function presentedCount(presentationVisible: boolean, count: number): number {
  return presentationVisible ? count : 0;
}

function annotationPresentationVisibleSurfaces(input: AnnotationPresentationDebugInput): {
  requestedLayerTypes: string[];
  requiredLayerTypes: string[];
  requestedFamilies: ReturnType<typeof annotationPresentationFamilies>;
  runtimeGenomeWideTextureVisible: boolean;
  prebuiltGenomeWideTextureVisible: boolean;
  compiledBroadRasterVisible: boolean;
  sidecarTrackRasterVisible: boolean;
  retainedLinearVisibleMeshCount: number;
  retainedTranscriptVisibleBlockCount: number;
  tilePyramidVectorVisibleLayerCount: number;
  tilePyramidVectorPresentingBlockCount: number;
  tilePyramidVectorPresenting: boolean;
  tilePyramidVectorExpectedVisibleTileCount: number;
  tilePyramidVectorBuiltVisibleTileCount: number;
  tilePyramidVectorMissingVisibleTileCount: number;
  tilePyramidVectorCoverageComplete: boolean;
  overviewGlyphTilesPresenting: boolean;
  overviewGlyphTilesVisibleTileCount: number;
  overviewGlyphTilesCoverageComplete: boolean;
  prepackedTranscriptHasVisibleSubmissions: boolean;
} {
  const requestedLayerTypes = uniqueSortedLayerTypes(input.requestedLayerTypes);
  const renderSetLayerTypes =
    input.renderSetLayerTypes === null || input.renderSetLayerTypes === undefined
      ? requestedLayerTypes
      : uniqueSortedLayerTypes(input.renderSetLayerTypes);
  const renderSetLayerTypeSet = new Set(renderSetLayerTypes);
  const visible = input.presentationVisible;
  return {
    requestedLayerTypes,
    requiredLayerTypes: requestedLayerTypes.filter((layerType) =>
      renderSetLayerTypeSet.has(layerType)
    ),
    requestedFamilies: annotationPresentationFamilies(requestedLayerTypes),
    runtimeGenomeWideTextureVisible: visible && input.runtimeGenomeWideTextureVisible,
    prebuiltGenomeWideTextureVisible: visible && input.prebuiltGenomeWideTextureVisible,
    compiledBroadRasterVisible: visible && input.compiledBroadRasterVisible === true,
    sidecarTrackRasterVisible: visible && input.sidecarTrackRasterVisible === true,
    retainedLinearVisibleMeshCount: presentedCount(visible, input.retainedLinearVisibleMeshCount),
    retainedTranscriptVisibleBlockCount: presentedCount(
      visible,
      input.retainedTranscriptVisibleBlockCount
    ),
    tilePyramidVectorVisibleLayerCount: presentedCount(
      visible,
      input.tilePyramidVectorVisibleLayerCount
    ),
    tilePyramidVectorPresentingBlockCount: presentedCount(
      visible,
      input.tilePyramidVectorPresentingBlockCount
    ),
    tilePyramidVectorPresenting: visible && input.tilePyramidVectorPresenting,
    tilePyramidVectorExpectedVisibleTileCount: presentedCount(
      visible,
      input.tilePyramidVectorExpectedVisibleTileCount
    ),
    tilePyramidVectorBuiltVisibleTileCount: presentedCount(
      visible,
      input.tilePyramidVectorBuiltVisibleTileCount
    ),
    tilePyramidVectorMissingVisibleTileCount: presentedCount(
      visible,
      input.tilePyramidVectorMissingVisibleTileCount
    ),
    tilePyramidVectorCoverageComplete: visible && input.tilePyramidVectorCoverageComplete,
    overviewGlyphTilesPresenting: visible && input.overviewGlyphTilesPresenting,
    overviewGlyphTilesVisibleTileCount: presentedCount(
      visible,
      input.overviewGlyphTilesVisibleTileCount
    ),
    overviewGlyphTilesCoverageComplete: visible && input.overviewGlyphTilesCoverageComplete,
    prepackedTranscriptHasVisibleSubmissions:
      visible &&
      input.prepackedTranscriptPresenting === true &&
      Number.isSafeInteger(input.prepackedTranscriptSubmittedPartitionCount) &&
      (input.prepackedTranscriptSubmittedPartitionCount as number) > 0 &&
      Number.isSafeInteger(input.prepackedTranscriptSubmittedInstanceCount) &&
      (input.prepackedTranscriptSubmittedInstanceCount as number) > 0,
  };
}

function annotationPresentationOwnerArgs(
  input: AnnotationPresentationDebugInput,
  surfaces: {
    requestedLayerTypes: string[];
    requestedFamilies: ReturnType<typeof annotationPresentationFamilies>;
    prebuiltGenomeWideTextureVisible: boolean;
    compiledBroadRasterVisible: boolean;
    sidecarTrackRasterVisible: boolean;
    retainedLinearVisibleMeshCount: number;
    retainedTranscriptVisibleBlockCount: number;
    tilePyramidVectorVisibleLayerCount: number;
    tilePyramidVectorPresentingBlockCount: number;
    tilePyramidVectorPresenting: boolean;
    tilePyramidVectorExpectedVisibleTileCount: number;
    tilePyramidVectorMissingVisibleTileCount: number;
    tilePyramidVectorCoverageComplete: boolean;
    overviewGlyphTilesPresenting: boolean;
    overviewGlyphTilesVisibleTileCount: number;
    overviewGlyphTilesCoverageComplete: boolean;
    prepackedTranscriptHasVisibleSubmissions: boolean;
    broadLod: boolean;
  }
): Parameters<typeof buildAnnotationPresentationOwners>[0] {
  return {
    requestedLayerTypes: surfaces.requestedLayerTypes,
    broadLod: surfaces.broadLod,
    prebuiltGenomeWideTexture: {
      visible: surfaces.prebuiltGenomeWideTextureVisible,
      layerTypes: input.prebuiltGenomeWideTextureLayerTypes ?? [],
    },
    compiledBroadRaster: {
      visible: surfaces.compiledBroadRasterVisible && !surfaces.sidecarTrackRasterVisible,
      layerTypes: input.compiledBroadRasterLayerTypes ?? [],
      coverageComplete: input.compiledBroadRasterCoverageComplete === true,
    },
    sidecarTrackRasterStack: {
      visible: surfaces.sidecarTrackRasterVisible,
      layerTypes: input.sidecarTrackRasterLayerTypes ?? [],
      coverageComplete: input.sidecarTrackRasterCoverageComplete === true,
    },
    tileVectorTranscript: {
      containerVisible: surfaces.tilePyramidVectorPresenting,
      visibleLayerCount: surfaces.tilePyramidVectorVisibleLayerCount,
      presentingBlockCount: surfaces.tilePyramidVectorPresentingBlockCount,
      coverageComplete: surfaces.tilePyramidVectorCoverageComplete,
      expectedVisibleTileCount: surfaces.tilePyramidVectorExpectedVisibleTileCount,
      missingVisibleTileCount: surfaces.tilePyramidVectorMissingVisibleTileCount,
    },
    overviewGlyphTiles: {
      containerVisible: surfaces.overviewGlyphTilesPresenting,
      visibleTileCount: surfaces.overviewGlyphTilesVisibleTileCount,
      coverageComplete: surfaces.overviewGlyphTilesCoverageComplete,
    },
    prepackedTranscript: {
      visible: surfaces.prepackedTranscriptHasVisibleSubmissions,
      layerTypes: input.prepackedTranscriptLayerTypes ?? [],
      coverageComplete: surfaces.prepackedTranscriptHasVisibleSubmissions,
    },
    retainedTranscript: {
      visibleBlockCount: surfaces.retainedTranscriptVisibleBlockCount,
      layerTypes: surfaces.requestedFamilies.transcriptLayerTypes,
    },
    retainedSourceShape: {
      visibleMeshCount: surfaces.retainedLinearVisibleMeshCount,
      layerTypes: surfaces.requestedFamilies.sourceShapeLayerTypes,
    },
    immediateLive: {
      graphicsVisible: input.presentationVisible && input.immediateGraphicsVisible,
      drawnFeatureCount: input.lastDrawnFeatureCount,
      layerTypes: input.immediateDrawnLayerTypes,
    },
  };
}

function assembleAnnotationPresentationDebugSnapshot(args: {
  exactOwner: AnnotationSurfaceOwnerDebug | null;
  visibleOwners: AnnotationSurfaceOwnerDebug[];
  ownerViolations: string[];
  visibleLayerTypes: string[];
  owners: AnnotationSurfaceOwnerDebug[];
  input: AnnotationPresentationDebugInput;
  runtimeGenomeWideTextureVisible: boolean;
  prebuiltGenomeWideTextureVisible: boolean;
  compiledBroadRasterVisible: boolean;
  sidecarTrackRasterVisible: boolean;
  retainedLinearVisibleMeshCount: number;
  tilePyramidVectorVisibleLayerCount: number;
  tilePyramidVectorPresentingBlockCount: number;
  tilePyramidVectorPresenting: boolean;
  tilePyramidVectorExpectedVisibleTileCount: number;
  tilePyramidVectorBuiltVisibleTileCount: number;
  tilePyramidVectorMissingVisibleTileCount: number;
  tilePyramidVectorCoverageComplete: boolean;
}): AnnotationPresentationDebugSnapshot {
  return {
    annotationLodBackend: args.exactOwner?.ownerId ?? null,
    annotationPresentationStyleId:
      args.visibleOwners.length > 0 ? 'indexed-linear-annotation-visual-contract-v1' : null,
    annotationLodContractViolation: args.ownerViolations[0] ?? null,
    annotationPresentationOwnerViolations: args.ownerViolations,
    layoutInvariantViolations: [],
    annotationPresentationLayerTypes: args.visibleLayerTypes,
    annotationPresentationOwners: args.owners,
    runtimeGenomeWideTextureVisible: args.runtimeGenomeWideTextureVisible,
    prebuiltGenomeWideTextureVisible: args.prebuiltGenomeWideTextureVisible,
    compiledBroadRasterVisible: args.compiledBroadRasterVisible,
    sidecarTrackRasterVisible: args.sidecarTrackRasterVisible,
    sidecarTrackRasterLayerTypes: args.sidecarTrackRasterVisible
      ? [...(args.input.sidecarTrackRasterLayerTypes ?? [])]
      : [],
    rasterOwnerCount:
      Number(args.prebuiltGenomeWideTextureVisible) +
      Number(args.sidecarTrackRasterVisible || args.compiledBroadRasterVisible),
    prebuiltGenomeWideTextureEligible: args.input.prebuiltGenomeWideTextureEligible,
    retainedLinearVisibleMeshCount: args.retainedLinearVisibleMeshCount,
    tilePyramidVectorVisibleLayerCount: args.tilePyramidVectorVisibleLayerCount,
    tilePyramidVectorPresentingBlockCount: args.tilePyramidVectorPresentingBlockCount,
    tilePyramidVectorCoverageLevel: args.tilePyramidVectorPresenting
      ? args.input.tilePyramidVectorCoverageLevel
      : null,
    tilePyramidVectorVisibleTileFirst: args.tilePyramidVectorPresenting
      ? args.input.tilePyramidVectorVisibleTileFirst
      : null,
    tilePyramidVectorVisibleTileLast: args.tilePyramidVectorPresenting
      ? args.input.tilePyramidVectorVisibleTileLast
      : null,
    tilePyramidVectorExpectedVisibleTileCount: args.tilePyramidVectorExpectedVisibleTileCount,
    tilePyramidVectorBuiltVisibleTileCount: args.tilePyramidVectorBuiltVisibleTileCount,
    tilePyramidVectorMissingVisibleTileCount: args.tilePyramidVectorMissingVisibleTileCount,
    tilePyramidVectorCoverageComplete: args.tilePyramidVectorCoverageComplete,
  };
}

function recordDuplicateRasterOwnerViolation(args: {
  ownerViolations: string[];
  prebuiltGenomeWideTextureVisible: boolean;
  compiledBroadRasterVisible: boolean;
  sidecarTrackRasterVisible: boolean;
}): void {
  if (
    args.prebuiltGenomeWideTextureVisible &&
    (args.compiledBroadRasterVisible || args.sidecarTrackRasterVisible)
  ) {
    args.ownerViolations.push(
      `duplicate-exact-annotation-owner:raster-surface:compiled-raster-surface+${
        args.sidecarTrackRasterVisible
          ? 'sidecar-track-raster-stack'
          : 'compiled-broad-raster-surface'
      }`
    );
  }
}

export function buildAnnotationPresentationDebug(
  input: AnnotationPresentationDebugInput
): AnnotationPresentationDebugSnapshot {
  const {
    requestedLayerTypes,
    requiredLayerTypes,
    requestedFamilies,
    runtimeGenomeWideTextureVisible,
    prebuiltGenomeWideTextureVisible,
    compiledBroadRasterVisible,
    sidecarTrackRasterVisible,
    retainedLinearVisibleMeshCount,
    retainedTranscriptVisibleBlockCount,
    tilePyramidVectorVisibleLayerCount,
    tilePyramidVectorPresentingBlockCount,
    tilePyramidVectorPresenting,
    tilePyramidVectorExpectedVisibleTileCount,
    tilePyramidVectorBuiltVisibleTileCount,
    tilePyramidVectorMissingVisibleTileCount,
    tilePyramidVectorCoverageComplete,
    overviewGlyphTilesPresenting,
    overviewGlyphTilesVisibleTileCount,
    overviewGlyphTilesCoverageComplete,
    prepackedTranscriptHasVisibleSubmissions,
  } = annotationPresentationVisibleSurfaces(input);
  const broadLod = input.prebuiltGenomeWideTextureEligible;

  const owners = buildAnnotationPresentationOwners(
    annotationPresentationOwnerArgs(input, {
      requestedLayerTypes,
      requestedFamilies,
      prebuiltGenomeWideTextureVisible,
      compiledBroadRasterVisible,
      sidecarTrackRasterVisible,
      retainedLinearVisibleMeshCount,
      retainedTranscriptVisibleBlockCount,
      tilePyramidVectorVisibleLayerCount,
      tilePyramidVectorPresentingBlockCount,
      tilePyramidVectorPresenting,
      tilePyramidVectorExpectedVisibleTileCount,
      tilePyramidVectorMissingVisibleTileCount,
      tilePyramidVectorCoverageComplete,
      overviewGlyphTilesPresenting,
      overviewGlyphTilesVisibleTileCount,
      overviewGlyphTilesCoverageComplete,
      prepackedTranscriptHasVisibleSubmissions,
      broadLod,
    })
  );
  const visibleOwners = owners.filter((owner) => owner.visible);
  const visibleLayerTypes = [...new Set(visibleOwners.flatMap((owner) => owner.layerTypes))].sort(
    (a, b) => a.localeCompare(b)
  );
  const visibleLayerTypeSet = new Set(visibleLayerTypes);
  const missingLayerTypes = requiredLayerTypes.filter(
    (layerType) => !visibleLayerTypeSet.has(layerType)
  );
  const exactOwner =
    visibleOwners.find((owner) => owner.role === 'exact' || owner.role === 'live') ?? null;
  const ownerViolations = validateAnnotationPresentationOwners(owners, {
    broadLod,
    missingLayerTypes,
    runtimeGenomeWideTextureVisible,
  });
  recordDuplicateRasterOwnerViolation({
    ownerViolations,
    prebuiltGenomeWideTextureVisible,
    compiledBroadRasterVisible,
    sidecarTrackRasterVisible,
  });

  return assembleAnnotationPresentationDebugSnapshot({
    exactOwner,
    visibleOwners,
    ownerViolations,
    visibleLayerTypes,
    owners,
    input,
    runtimeGenomeWideTextureVisible,
    prebuiltGenomeWideTextureVisible,
    compiledBroadRasterVisible,
    sidecarTrackRasterVisible,
    retainedLinearVisibleMeshCount,
    tilePyramidVectorVisibleLayerCount,
    tilePyramidVectorPresentingBlockCount,
    tilePyramidVectorPresenting,
    tilePyramidVectorExpectedVisibleTileCount,
    tilePyramidVectorBuiltVisibleTileCount,
    tilePyramidVectorMissingVisibleTileCount,
    tilePyramidVectorCoverageComplete,
  });
}

export function annotationDebugLayoutSnapshot(
  layout: UnifiedLayout | null,
  maxAnnotationLane: number,
  maxCdsLane: number,
  viewportHeight = 0
): AnnotationDebugLayoutSnapshot | null {
  if (!layout) return null;
  const sequenceBottom = Math.max(layout.revStrandBottom, layout.rulerY);
  return {
    viewportHeight,
    totalHeight: layout.totalHeight,
    offset: layout.offset,
    annotationTop: layout.annotationTop,
    annotationHeight: layout.annotationHeight,
    annotationLanes: Math.max(0, maxAnnotationLane + 1),
    cdsLanes: Math.max(0, maxCdsLane + 1),
    fwdStrandTop: layout.fwdStrandTop,
    revStrandBottom: layout.revStrandBottom,
    rulerY: layout.rulerY,
    sequenceBottom,
    sequenceOutOfViewport:
      viewportHeight > 0 &&
      (layout.fwdStrandTop < 0 ||
        layout.revStrandBottom > viewportHeight ||
        layout.rulerY > viewportHeight),
    annotationOffset: layout.annotationOffset,
    annotationStep: layout.annotationStep,
    cdsBarOffset: layout.cdsBarOffset,
    cdsLaneStep: layout.cdsLaneStep,
  };
}
