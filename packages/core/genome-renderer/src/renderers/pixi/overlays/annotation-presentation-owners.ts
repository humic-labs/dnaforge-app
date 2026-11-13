import { isTranscriptSourceType } from '../../../feature-colors';

export type AnnotationVisualGroup =
  | 'transcript-body'
  | 'cds-exon'
  | 'intron-connector'
  | 'source-shape';

export type AnnotationPresentationFamilies = {
  transcriptLayerTypes: string[];
  sourceShapeLayerTypes: string[];
  needsTranscript: boolean;
  needsSourceShape: boolean;
};

export type AnnotationSurfaceOwnerDebug = {
  ownerId: string;
  kind:
    | 'compiled-raster-surface'
    | 'compiled-broad-raster-surface'
    | 'sidecar-track-raster-stack'
    | 'overview-glyph-tile-surface'
    | 'compiled-vector-surface'
    | 'prepacked-partitioned-vector-surface'
    | 'active-segment-retained-surface'
    | 'single-chrom-live-surface';
  role: 'floor' | 'exact' | 'live';
  visible: boolean;
  layerTypes: string[];
  visualGroups: AnnotationVisualGroup[];
  coverageComplete?: boolean;
  expectedVisibleTileCount?: number;
  missingVisibleTileCount?: number;
};

export type AnnotationPresentationOwnerValidationContext = {
  broadLod?: boolean;
  missingLayerTypes?: readonly string[];
  runtimeGenomeWideTextureVisible?: boolean;
};

export type AnnotationPresentationOwnerPlanInput = {
  requestedLayerTypes: readonly string[];
  broadLod: boolean;
  prebuiltGenomeWideTexture: {
    visible: boolean;
    layerTypes: readonly string[];
  };
  compiledBroadRaster?: {
    visible: boolean;
    layerTypes: readonly string[];
    coverageComplete: boolean;
  };

  sidecarTrackRasterStack?: {
    visible: boolean;
    layerTypes: readonly string[];
    coverageComplete: boolean;
  };
  tileVectorTranscript: {
    containerVisible: boolean;
    visibleLayerCount: number;
    presentingBlockCount: number;
    coverageComplete: boolean;
    expectedVisibleTileCount: number;
    missingVisibleTileCount: number;
  };

  overviewGlyphTiles: {
    containerVisible: boolean;
    visibleTileCount: number;
    coverageComplete: boolean;
  };
  prepackedTranscript?: {
    visible: boolean;
    layerTypes: readonly string[];
    coverageComplete: boolean;
  };
  retainedTranscript: {
    visibleBlockCount: number;
    layerTypes: readonly string[];
  };
  retainedSourceShape: {
    visibleMeshCount: number;
    layerTypes: readonly string[];
  };
  immediateLive: {
    graphicsVisible: boolean;
    drawnFeatureCount: number;
    layerTypes: readonly string[];
  };
};

export function isTranscriptPresentationLayer(layerType: string): boolean {
  return layerType === 'CDS' || isTranscriptSourceType(layerType);
}

export function annotationPresentationFamilies(
  layerTypes: readonly string[]
): AnnotationPresentationFamilies {
  const transcriptLayerTypes: string[] = [];
  const sourceShapeLayerTypes: string[] = [];
  for (const layerType of layerTypes) {
    if (isTranscriptPresentationLayer(layerType)) {
      transcriptLayerTypes.push(layerType);
    } else {
      sourceShapeLayerTypes.push(layerType);
    }
  }
  return {
    transcriptLayerTypes,
    sourceShapeLayerTypes,
    needsTranscript: transcriptLayerTypes.length > 0,
    needsSourceShape: sourceShapeLayerTypes.length > 0,
  };
}

export function transcriptVectorTilesCoverLayerTypes(layerTypes: readonly string[]): boolean {
  const families = annotationPresentationFamilies(layerTypes);
  return families.needsTranscript && !families.needsSourceShape;
}

export function visualGroupsForLayerTypes(layerTypes: readonly string[]): AnnotationVisualGroup[] {
  const groups = new Set<AnnotationVisualGroup>();
  for (const layerType of layerTypes) {
    if (isTranscriptPresentationLayer(layerType)) {
      groups.add('transcript-body');
      groups.add('cds-exon');
      groups.add('intron-connector');
    } else {
      groups.add('source-shape');
    }
  }
  return [...groups];
}

export function buildAnnotationPresentationOwners(
  input: AnnotationPresentationOwnerPlanInput
): AnnotationSurfaceOwnerDebug[] {
  const families = annotationPresentationFamilies(input.requestedLayerTypes);
  const prebuiltGenomeWideVisible = input.prebuiltGenomeWideTexture.visible;
  const rasterVisible = prebuiltGenomeWideVisible;
  const rasterLayerTypes = prebuiltGenomeWideVisible
    ? input.prebuiltGenomeWideTexture.layerTypes
    : [];
  const compiledBroadRaster = input.compiledBroadRaster ?? {
    visible: false,
    layerTypes: [],
    coverageComplete: false,
  };
  const sidecarTrackRasterStack = input.sidecarTrackRasterStack ?? {
    visible: false,
    layerTypes: [],
    coverageComplete: false,
  };
  const vectorTranscriptVisible =
    families.needsTranscript &&
    input.tileVectorTranscript.containerVisible &&
    input.tileVectorTranscript.visibleLayerCount > 0 &&
    input.tileVectorTranscript.presentingBlockCount > 0 &&
    input.tileVectorTranscript.coverageComplete;

  const coarseRasterVisible =
    input.overviewGlyphTiles.containerVisible &&
    input.overviewGlyphTiles.visibleTileCount > 0 &&
    input.overviewGlyphTiles.coverageComplete;
  const coarseRasterLayerTypes = coarseRasterVisible
    ? mergeOwnerLayerTypes(input.requestedLayerTypes)
    : [];
  const prepackedTranscript = input.prepackedTranscript ?? {
    visible: false,
    layerTypes: [],
    coverageComplete: false,
  };
  const retainedTranscriptVisible = input.retainedTranscript.visibleBlockCount > 0;
  const retainedSourceShapeVisible = input.retainedSourceShape.visibleMeshCount > 0;
  const retainedVisible = retainedTranscriptVisible || retainedSourceShapeVisible;
  const retainedLayerTypes = mergeOwnerLayerTypes(
    retainedTranscriptVisible ? input.retainedTranscript.layerTypes : [],
    retainedSourceShapeVisible ? input.retainedSourceShape.layerTypes : []
  );
  const immediateLiveVisible =
    input.immediateLive.graphicsVisible && input.immediateLive.drawnFeatureCount > 0;
  const textureRole = input.broadLod ? 'exact' : 'floor';
  const vectorMissingVisibleTileCount = families.needsTranscript
    ? input.tileVectorTranscript.missingVisibleTileCount
    : 0;
  const vectorExpectedVisibleTileCount = families.needsTranscript
    ? input.tileVectorTranscript.expectedVisibleTileCount
    : 0;

  return [
    {
      ownerId: 'compiled-raster-surface',
      kind: 'compiled-raster-surface',
      role: textureRole,
      visible: rasterVisible,
      layerTypes: [...rasterLayerTypes],
      visualGroups: visualGroupsForLayerTypes(rasterLayerTypes),
      coverageComplete: rasterVisible,
    },
    {
      ownerId: 'compiled-broad-raster-surface',
      kind: 'compiled-broad-raster-surface',
      role: 'exact',
      visible: compiledBroadRaster.visible,
      layerTypes: compiledBroadRaster.visible ? [...compiledBroadRaster.layerTypes] : [],
      visualGroups: compiledBroadRaster.visible
        ? visualGroupsForLayerTypes(compiledBroadRaster.layerTypes)
        : [],
      coverageComplete: compiledBroadRaster.visible && compiledBroadRaster.coverageComplete,
    },
    {
      ownerId: 'sidecar-track-raster-stack',
      kind: 'sidecar-track-raster-stack',
      role: 'exact',
      visible: sidecarTrackRasterStack.visible,
      layerTypes: sidecarTrackRasterStack.visible ? [...sidecarTrackRasterStack.layerTypes] : [],
      visualGroups: sidecarTrackRasterStack.visible
        ? visualGroupsForLayerTypes(sidecarTrackRasterStack.layerTypes)
        : [],
      coverageComplete: sidecarTrackRasterStack.visible && sidecarTrackRasterStack.coverageComplete,
    },
    {
      ownerId: 'overview-glyph-tile-surface',
      kind: 'overview-glyph-tile-surface',
      role: 'exact',
      visible: coarseRasterVisible,
      layerTypes: coarseRasterLayerTypes,
      visualGroups: coarseRasterVisible ? visualGroupsForLayerTypes(input.requestedLayerTypes) : [],
      coverageComplete: coarseRasterVisible,
    },
    {
      ownerId: 'compiled-vector-surface',
      kind: 'compiled-vector-surface',
      role: 'exact',
      visible: vectorTranscriptVisible,
      layerTypes: vectorTranscriptVisible ? [...families.transcriptLayerTypes] : [],
      visualGroups: vectorTranscriptVisible
        ? visualGroupsForLayerTypes(families.transcriptLayerTypes)
        : [],
      coverageComplete: vectorTranscriptVisible,
      expectedVisibleTileCount: vectorExpectedVisibleTileCount,
      missingVisibleTileCount: vectorMissingVisibleTileCount,
    },
    {
      ownerId: 'prepacked-partitioned-vector-surface',
      kind: 'prepacked-partitioned-vector-surface',
      role: 'exact',
      visible: prepackedTranscript.visible,
      layerTypes: prepackedTranscript.visible ? [...prepackedTranscript.layerTypes] : [],
      visualGroups: prepackedTranscript.visible
        ? visualGroupsForLayerTypes(prepackedTranscript.layerTypes)
        : [],
      coverageComplete: prepackedTranscript.coverageComplete,
    },
    {
      ownerId: 'active-segment-retained-surface',
      kind: 'active-segment-retained-surface',
      role: 'exact',
      visible: retainedVisible,
      layerTypes: retainedLayerTypes,
      visualGroups: visualGroupsForLayerTypes(retainedLayerTypes),
      coverageComplete: retainedVisible,
    },
    {
      ownerId: 'single-chrom-live-surface',
      kind: 'single-chrom-live-surface',
      role: 'live',
      visible: immediateLiveVisible,
      layerTypes: immediateLiveVisible ? mergeOwnerLayerTypes(input.immediateLive.layerTypes) : [],
      visualGroups: immediateLiveVisible
        ? visualGroupsForLayerTypes(input.immediateLive.layerTypes)
        : [],
      coverageComplete: immediateLiveVisible,
    },
  ];
}

function mergeOwnerLayerTypes(...groups: readonly (readonly string[])[]): string[] {
  return [...new Set(groups.flat())].sort((a, b) => a.localeCompare(b));
}

export function validateAnnotationPresentationOwners(
  owners: readonly AnnotationSurfaceOwnerDebug[],
  context: AnnotationPresentationOwnerValidationContext = {}
): string[] {
  const violations: string[] = [];
  const pushViolation = (violation: string): void => {
    if (!violations.includes(violation)) violations.push(violation);
  };
  if (context.runtimeGenomeWideTextureVisible) {
    pushViolation('forbidden-runtime-genome-wide-texture-visible');
  }
  const visibleOwners = owners.filter((owner) => owner.visible && owner.visualGroups.length > 0);
  const exactOwners = visibleOwners.filter(
    (owner) => owner.role === 'exact' || owner.role === 'live'
  );
  const floorOwners = visibleOwners.filter((owner) => owner.role === 'floor');
  const exactByGroup = new Map<AnnotationVisualGroup, AnnotationSurfaceOwnerDebug[]>();

  for (const owner of owners) {
    const expected = owner.expectedVisibleTileCount ?? 0;
    const missing = owner.missingVisibleTileCount ?? 0;
    const visiblyIncompleteExact =
      owner.visible &&
      (owner.role === 'exact' || owner.role === 'live') &&
      owner.coverageComplete === false;
    const incompleteRequestedTiles =
      expected > 0 && (missing > 0 || owner.coverageComplete === false);
    if (visiblyIncompleteExact || incompleteRequestedTiles) {
      pushViolation(`incomplete-annotation-owner:${owner.ownerId}`);
    }
  }

  for (const owner of exactOwners) {
    for (const group of owner.visualGroups) {
      const groupOwners = exactByGroup.get(group) ?? [];
      groupOwners.push(owner);
      exactByGroup.set(group, groupOwners);
    }
  }

  for (const [group, groupOwners] of exactByGroup) {
    if (groupOwners.length <= 1) continue;
    pushViolation(
      `duplicate-exact-annotation-owner:${group}:${groupOwners
        .map((owner) => owner.ownerId)
        .join('+')}`
    );
  }

  for (const floor of floorOwners) {
    for (const group of floor.visualGroups) {
      const exactForGroup = exactByGroup.get(group) ?? [];
      const forbiddenExactForGroup = exactForGroup;
      if (forbiddenExactForGroup.length <= 0) continue;
      pushViolation(
        `floor-overlaps-exact-annotation-owner:${group}:${floor.ownerId}+${forbiddenExactForGroup
          .map((owner) => owner.ownerId)
          .join('+')}`
      );
    }
  }

  const missingLayerTypes = [...(context.missingLayerTypes ?? [])].filter(Boolean);
  if (missingLayerTypes.length > 0) {
    pushViolation(`missing-annotation-layer-coverage:${missingLayerTypes.join(',')}`);
  }

  return violations;
}
