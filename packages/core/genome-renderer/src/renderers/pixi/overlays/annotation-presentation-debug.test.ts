import { describe, expect, it } from 'vitest';

import {
  buildAnnotationPresentationDebug,
  type AnnotationPresentationDebugInput,
} from './annotation-presentation-debug';
import { annotationPrebuiltRasterEligibility } from './annotation-lod-ownership';

function input(
  overrides: Partial<AnnotationPresentationDebugInput> = {}
): AnnotationPresentationDebugInput {
  return {
    requestedLayerTypes: ['mRNA'],
    presentationVisible: true,
    genomeLength: 10_000,
    lastDrawAuditRange: {
      viewStartBp: 100,
      viewEndBp: 1_100,
    },
    runtimeGenomeWideTextureVisible: false,
    prebuiltGenomeWideTextureVisible: false,
    prebuiltGenomeWideTextureEligible: false,
    prebuiltGenomeWideTextureLayerTypes: ['mRNA'],
    retainedLinearVisibleMeshCount: 0,
    retainedTranscriptVisibleBlockCount: 0,
    tilePyramidVectorVisibleLayerCount: 1,
    tilePyramidVectorPresenting: true,
    tilePyramidVectorPresentingBlockCount: 1,
    tilePyramidVectorCoverageLevel: 11,
    tilePyramidVectorVisibleTileFirst: 0,
    tilePyramidVectorVisibleTileLast: 3,
    tilePyramidVectorExpectedVisibleTileCount: 4,
    tilePyramidVectorBuiltVisibleTileCount: 1,
    tilePyramidVectorMissingVisibleTileCount: 3,
    tilePyramidVectorCoverageComplete: false,
    overviewGlyphTilesPresenting: false,
    overviewGlyphTilesVisibleTileCount: 0,
    overviewGlyphTilesCoverageComplete: false,
    immediateGraphicsVisible: false,
    lastDrawnFeatureCount: 0,
    immediateDrawnLayerTypes: [],
    ...overrides,
  };
}

describe('buildAnnotationPresentationDebug', () => {
  it('counts a leaked legacy bitmap and compiled broad raster as independent exact owners', () => {
    const snapshot = buildAnnotationPresentationDebug(
      input({
        prebuiltGenomeWideTextureVisible: true,
        prebuiltGenomeWideTextureEligible: true,
        compiledBroadRasterVisible: true,
        compiledBroadRasterLayerTypes: ['mRNA'],
        compiledBroadRasterCoverageComplete: true,
        tilePyramidVectorPresenting: false,
        tilePyramidVectorVisibleLayerCount: 0,
        tilePyramidVectorPresentingBlockCount: 0,
        tilePyramidVectorExpectedVisibleTileCount: 0,
        tilePyramidVectorBuiltVisibleTileCount: 0,
        tilePyramidVectorMissingVisibleTileCount: 0,
        tilePyramidVectorCoverageComplete: false,
      })
    );

    expect(
      snapshot.annotationPresentationOwners
        .filter((owner) => owner.visible)
        .map((owner) => owner.ownerId)
    ).toEqual(['compiled-raster-surface', 'compiled-broad-raster-surface']);
    expect(snapshot.annotationPresentationOwnerViolations).toEqual(
      expect.arrayContaining([expect.stringContaining('duplicate-exact-annotation-owner:')])
    );
  });

  it('reports compiled mRNA plus independently resident sidecar types as one track raster stack', () => {
    const snapshot = buildAnnotationPresentationDebug(
      input({
        requestedLayerTypes: ['mRNA', 'lnc_RNA'],
        compiledBroadRasterVisible: true,
        compiledBroadRasterLayerTypes: ['mRNA'],
        compiledBroadRasterCoverageComplete: true,
        sidecarTrackRasterVisible: true,
        sidecarTrackRasterLayerTypes: ['mRNA', 'lnc_RNA'],
        sidecarTrackRasterCoverageComplete: true,
        tilePyramidVectorPresenting: false,
        tilePyramidVectorVisibleLayerCount: 0,
        tilePyramidVectorPresentingBlockCount: 0,
        tilePyramidVectorExpectedVisibleTileCount: 0,
        tilePyramidVectorBuiltVisibleTileCount: 0,
        tilePyramidVectorMissingVisibleTileCount: 0,
        tilePyramidVectorCoverageComplete: false,
      })
    );

    expect(
      snapshot.annotationPresentationOwners
        .filter((owner) => owner.visible)
        .map((owner) => owner.ownerId)
    ).toEqual(['sidecar-track-raster-stack']);
    expect(snapshot.annotationLodBackend).toBe('sidecar-track-raster-stack');
    expect(snapshot.annotationPresentationLayerTypes).toEqual(['lnc_RNA', 'mRNA']);
    expect(snapshot.annotationPresentationOwnerViolations).toEqual([]);
    expect(snapshot.rasterOwnerCount).toBe(1);
  });

  it('does not promote partial transcript vector coverage to the exact annotation backend', () => {
    const snapshot = buildAnnotationPresentationDebug(
      input({ tilePyramidVectorPresenting: false })
    );
    const vectorOwner = snapshot.annotationPresentationOwners.find(
      (owner) => owner.ownerId === 'compiled-vector-surface'
    );

    expect(snapshot.annotationLodBackend).toBeNull();
    expect(vectorOwner).toMatchObject({
      visible: false,
      coverageComplete: false,
      expectedVisibleTileCount: 4,
      missingVisibleTileCount: 3,
    });
    expect(snapshot.tilePyramidVectorExpectedVisibleTileCount).toBe(4);
    expect(snapshot.tilePyramidVectorBuiltVisibleTileCount).toBe(1);
    expect(snapshot.tilePyramidVectorMissingVisibleTileCount).toBe(3);
    expect(snapshot.tilePyramidVectorCoverageComplete).toBe(false);
  });

  it('keeps a detail raster floor from becoming the annotation backend without an exact owner', () => {
    const snapshot = buildAnnotationPresentationDebug(
      input({
        prebuiltGenomeWideTextureVisible: true,
        tilePyramidVectorPresenting: false,
        tilePyramidVectorVisibleLayerCount: 0,
        tilePyramidVectorExpectedVisibleTileCount: 0,
        tilePyramidVectorBuiltVisibleTileCount: 0,
        tilePyramidVectorMissingVisibleTileCount: 0,
        tilePyramidVectorCoverageComplete: false,
      })
    );

    expect(snapshot.annotationLodBackend).toBeNull();
    expect(snapshot.annotationPresentationLayerTypes).toEqual(['mRNA']);
    expect(
      snapshot.annotationPresentationOwners.find(
        (owner) => owner.ownerId === 'compiled-raster-surface'
      )
    ).toMatchObject({
      visible: true,
      role: 'floor',
      coverageComplete: true,
    });
    expect(snapshot.annotationPresentationOwnerViolations).toEqual([]);
  });

  it('never promotes a visible raster in the legacy 25%-to-72% corridor to exact', () => {
    const rasterEligibility = annotationPrebuiltRasterEligibility({
      genomeLength: 1_000_000,
      visibleBp: 500_000,
      texelsPerDevicePx: 1,
      rasterAvailable: true,
      semanticContractMatch: true,
    });
    const snapshot = buildAnnotationPresentationDebug(
      input({
        genomeLength: 1_000_000,
        lastDrawAuditRange: { viewStartBp: 0, viewEndBp: 500_000 },
        prebuiltGenomeWideTextureVisible: true,
        prebuiltGenomeWideTextureEligible: rasterEligibility.eligible,
        tilePyramidVectorPresenting: false,
        tilePyramidVectorVisibleLayerCount: 0,
        tilePyramidVectorExpectedVisibleTileCount: 0,
        tilePyramidVectorBuiltVisibleTileCount: 0,
        tilePyramidVectorMissingVisibleTileCount: 0,
        tilePyramidVectorCoverageComplete: false,
      })
    );

    expect(rasterEligibility).toMatchObject({
      eligible: false,
      reason: 'below-fill-knee',
      physicalSamplingSatisfied: true,
    });
    expect(snapshot.prebuiltGenomeWideTextureEligible).toBe(false);
    expect(snapshot.annotationLodBackend).toBeNull();
    expect(
      snapshot.annotationPresentationOwners.find(
        (owner) => owner.ownerId === 'compiled-raster-surface'
      )
    ).toMatchObject({ visible: true, role: 'floor' });
  });

  it('reports requested layer coverage even when the rendered feature set omitted that layer', () => {
    const snapshot = buildAnnotationPresentationDebug(
      input({
        requestedLayerTypes: ['mRNA', 'enhancer'],
        tilePyramidVectorPresenting: false,
        tilePyramidVectorVisibleLayerCount: 0,
        tilePyramidVectorExpectedVisibleTileCount: 0,
        tilePyramidVectorBuiltVisibleTileCount: 0,
        tilePyramidVectorMissingVisibleTileCount: 0,
        tilePyramidVectorCoverageComplete: false,
        retainedTranscriptVisibleBlockCount: 2,
      })
    );

    expect(snapshot.annotationPresentationLayerTypes).toEqual(['mRNA']);
    expect(snapshot.annotationPresentationOwnerViolations).toContain(
      'missing-annotation-layer-coverage:enhancer'
    );
  });

  it('does not require a visual owner for selected layers with no in-viewport features', () => {
    const snapshot = buildAnnotationPresentationDebug(
      input({
        requestedLayerTypes: ['mRNA'],
        renderSetLayerTypes: [],
        tilePyramidVectorPresenting: false,
        tilePyramidVectorVisibleLayerCount: 0,
        tilePyramidVectorPresentingBlockCount: 0,
        tilePyramidVectorExpectedVisibleTileCount: 0,
        tilePyramidVectorBuiltVisibleTileCount: 0,
        tilePyramidVectorMissingVisibleTileCount: 0,
        tilePyramidVectorCoverageComplete: false,
      })
    );

    expect(snapshot.annotationPresentationLayerTypes).toEqual([]);
    expect(snapshot.annotationPresentationOwnerViolations).not.toContain(
      'missing-annotation-layer-coverage:mRNA'
    );
  });

  it('does not promote resident empty vector tiles to the exact annotation backend', () => {
    const snapshot = buildAnnotationPresentationDebug(
      input({
        requestedLayerTypes: ['mRNA'],
        tilePyramidVectorPresenting: true,
        tilePyramidVectorVisibleLayerCount: 1,
        tilePyramidVectorPresentingBlockCount: 0,
        tilePyramidVectorExpectedVisibleTileCount: 2,
        tilePyramidVectorBuiltVisibleTileCount: 2,
        tilePyramidVectorMissingVisibleTileCount: 0,
        tilePyramidVectorCoverageComplete: true,
      })
    );

    expect(snapshot.annotationLodBackend).toBeNull();
    expect(snapshot.tilePyramidVectorPresentingBlockCount).toBe(0);
    expect(
      snapshot.annotationPresentationOwners.find(
        (owner) => owner.ownerId === 'compiled-vector-surface'
      )
    ).toMatchObject({
      visible: false,
      coverageComplete: false,
      expectedVisibleTileCount: 2,
      missingVisibleTileCount: 0,
    });
    expect(snapshot.annotationPresentationOwnerViolations).toContain(
      'missing-annotation-layer-coverage:mRNA'
    );
  });

  it('does not let immediate live graphics claim undrawn source-shape layers', () => {
    const snapshot = buildAnnotationPresentationDebug(
      input({
        requestedLayerTypes: ['mRNA', 'enhancer'],
        tilePyramidVectorPresenting: false,
        tilePyramidVectorVisibleLayerCount: 0,
        tilePyramidVectorExpectedVisibleTileCount: 0,
        tilePyramidVectorBuiltVisibleTileCount: 0,
        tilePyramidVectorMissingVisibleTileCount: 0,
        tilePyramidVectorCoverageComplete: false,
        immediateGraphicsVisible: true,
        lastDrawnFeatureCount: 3,
        immediateDrawnLayerTypes: ['mRNA'],
      })
    );

    expect(snapshot.annotationPresentationLayerTypes).toEqual(['mRNA']);
    expect(
      snapshot.annotationPresentationOwners.find(
        (owner) => owner.ownerId === 'single-chrom-live-surface'
      )
    ).toMatchObject({
      visible: true,
      layerTypes: ['mRNA'],
    });
    expect(snapshot.annotationPresentationOwnerViolations).toContain(
      'missing-annotation-layer-coverage:enhancer'
    );
  });

  it('does not let transcript-only prebuilt raster claim source-shape layer coverage', () => {
    const snapshot = buildAnnotationPresentationDebug(
      input({
        requestedLayerTypes: ['mRNA', 'enhancer'],
        lastDrawAuditRange: {
          viewStartBp: 0,
          viewEndBp: 8_000,
        },
        prebuiltGenomeWideTextureVisible: true,
        prebuiltGenomeWideTextureEligible: true,
        tilePyramidVectorPresenting: false,
        tilePyramidVectorVisibleLayerCount: 0,
        tilePyramidVectorExpectedVisibleTileCount: 0,
        tilePyramidVectorBuiltVisibleTileCount: 0,
        tilePyramidVectorMissingVisibleTileCount: 0,
        tilePyramidVectorCoverageComplete: false,
      })
    );

    expect(snapshot.annotationLodBackend).toBe('compiled-raster-surface');
    expect(snapshot.annotationPresentationLayerTypes).toEqual(['mRNA']);
    expect(
      snapshot.annotationPresentationOwners.find(
        (owner) => owner.ownerId === 'compiled-raster-surface'
      )
    ).toMatchObject({
      visible: true,
      role: 'exact',
      layerTypes: ['mRNA'],
      visualGroups: ['transcript-body', 'cds-exon', 'intron-connector'],
    });
    expect(snapshot.annotationPresentationOwnerViolations).toContain(
      'missing-annotation-layer-coverage:enhancer'
    );
  });

  it('does not call a visible prepacked container complete when it submitted no partitions or instances', () => {
    const snapshot = buildAnnotationPresentationDebug(
      input({
        tilePyramidVectorPresenting: false,
        tilePyramidVectorVisibleLayerCount: 0,
        tilePyramidVectorPresentingBlockCount: 0,
        tilePyramidVectorExpectedVisibleTileCount: 0,
        tilePyramidVectorBuiltVisibleTileCount: 0,
        tilePyramidVectorMissingVisibleTileCount: 0,
        tilePyramidVectorCoverageComplete: false,
        prepackedTranscriptPresenting: true,
        prepackedTranscriptLayerTypes: ['mRNA'],
        prepackedTranscriptSubmittedPartitionCount: 0,
        prepackedTranscriptSubmittedInstanceCount: 0,
      })
    );

    expect(snapshot.annotationLodBackend).toBeNull();
    expect(
      snapshot.annotationPresentationOwners.find(
        (owner) => owner.ownerId === 'prepacked-partitioned-vector-surface'
      )
    ).toMatchObject({ visible: false, coverageComplete: false });
    expect(snapshot.annotationPresentationOwnerViolations).toContain(
      'missing-annotation-layer-coverage:mRNA'
    );
  });

  it('accepts the exact prepacked owner only with nonzero source submissions', () => {
    const snapshot = buildAnnotationPresentationDebug(
      input({
        tilePyramidVectorPresenting: false,
        tilePyramidVectorVisibleLayerCount: 0,
        tilePyramidVectorPresentingBlockCount: 0,
        tilePyramidVectorExpectedVisibleTileCount: 0,
        tilePyramidVectorBuiltVisibleTileCount: 0,
        tilePyramidVectorMissingVisibleTileCount: 0,
        tilePyramidVectorCoverageComplete: false,
        prepackedTranscriptPresenting: true,
        prepackedTranscriptLayerTypes: ['mRNA'],
        prepackedTranscriptSubmittedPartitionCount: 3,
        prepackedTranscriptSubmittedInstanceCount: 41,
      })
    );

    expect(snapshot.annotationLodBackend).toBe('prepacked-partitioned-vector-surface');
    expect(
      snapshot.annotationPresentationOwners.find(
        (owner) => owner.ownerId === 'prepacked-partitioned-vector-surface'
      )
    ).toMatchObject({ visible: true, coverageComplete: true });
    expect(snapshot.annotationPresentationLayerTypes).toEqual(['mRNA']);
    expect(snapshot.annotationPresentationOwnerViolations).toEqual([]);
  });
});
