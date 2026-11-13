import { describe, expect, it } from 'vitest';

import {
  buildAnnotationPresentationOwners,
  transcriptVectorTilesCoverLayerTypes,
  type AnnotationPresentationOwnerPlanInput,
  type AnnotationSurfaceOwnerDebug,
  validateAnnotationPresentationOwners,
} from './annotation-presentation-owners';

function owner(overrides: Partial<AnnotationSurfaceOwnerDebug> = {}): AnnotationSurfaceOwnerDebug {
  return {
    ownerId: 'owner',
    kind: 'compiled-vector-surface',
    role: 'exact',
    visible: true,
    layerTypes: ['mRNA'],
    visualGroups: ['transcript-body'],
    coverageComplete: true,
    ...overrides,
  };
}

function planInput(
  overrides: Partial<AnnotationPresentationOwnerPlanInput> = {}
): AnnotationPresentationOwnerPlanInput {
  return {
    requestedLayerTypes: ['mRNA', 'enhancer'],
    broadLod: false,
    prebuiltGenomeWideTexture: {
      visible: false,
      layerTypes: [],
    },
    tileVectorTranscript: {
      containerVisible: false,
      visibleLayerCount: 0,
      presentingBlockCount: 0,
      coverageComplete: false,
      expectedVisibleTileCount: 0,
      missingVisibleTileCount: 0,
    },
    overviewGlyphTiles: {
      containerVisible: false,
      visibleTileCount: 0,
      coverageComplete: false,
    },
    retainedTranscript: {
      visibleBlockCount: 0,
      layerTypes: [],
    },
    retainedSourceShape: {
      visibleMeshCount: 0,
      layerTypes: [],
    },
    immediateLive: {
      graphicsVisible: false,
      drawnFeatureCount: 0,
      layerTypes: [],
    },
    ...overrides,
  };
}

describe('transcriptVectorTilesCoverLayerTypes', () => {
  it('allows transcript-only visual families', () => {
    expect(transcriptVectorTilesCoverLayerTypes(['mRNA', 'CDS', 'lnc_RNA'])).toBe(true);
    expect(transcriptVectorTilesCoverLayerTypes(['misc_RNA', 'antisense_RNA'])).toBe(true);
  });

  it('rejects mixed transcript and source-shape visual families', () => {
    expect(transcriptVectorTilesCoverLayerTypes(['mRNA', 'enhancer'])).toBe(false);
  });

  it('rejects source-shape-only visual families', () => {
    expect(transcriptVectorTilesCoverLayerTypes(['enhancer'])).toBe(false);
  });
});

describe('buildAnnotationPresentationOwners', () => {
  it('lets the coarse overview raster own the WHOLE >512kb band across ALL layer types ', () => {
    const owners = buildAnnotationPresentationOwners(
      planInput({
        requestedLayerTypes: ['mRNA', 'enhancer'],
        overviewGlyphTiles: {
          containerVisible: true,
          visibleTileCount: 3,
          coverageComplete: true,
        },
      })
    );
    const coarse = owners.find((o) => o.ownerId === 'overview-glyph-tile-surface');
    expect(coarse).toMatchObject({ visible: true, role: 'exact', coverageComplete: true });
    expect(coarse?.layerTypes).toEqual(['enhancer', 'mRNA']);
    expect(coarse?.visualGroups).toEqual(
      expect.arrayContaining(['transcript-body', 'cds-exon', 'intron-connector', 'source-shape'])
    );

    const visibleLayerTypes = new Set(owners.filter((o) => o.visible).flatMap((o) => o.layerTypes));
    const missing = ['mRNA', 'enhancer'].filter((t) => !visibleLayerTypes.has(t));
    expect(validateAnnotationPresentationOwners(owners, { missingLayerTypes: missing })).toEqual(
      []
    );
  });

  it('lets compiled vector tiles own only transcript presentation layers', () => {
    const owners = buildAnnotationPresentationOwners(
      planInput({
        tileVectorTranscript: {
          containerVisible: true,
          visibleLayerCount: 1,
          presentingBlockCount: 2,
          coverageComplete: true,
          expectedVisibleTileCount: 2,
          missingVisibleTileCount: 0,
        },
      })
    );
    expect(owners.find((o) => o.ownerId === 'compiled-vector-surface')).toMatchObject({
      visible: true,
      layerTypes: ['mRNA'],
      visualGroups: ['transcript-body', 'cds-exon', 'intron-connector'],
      coverageComplete: true,
      expectedVisibleTileCount: 2,
      missingVisibleTileCount: 0,
    });
  });

  it('does not expose a compiled vector owner for resident empty transcript tiles', () => {
    const owners = buildAnnotationPresentationOwners(
      planInput({
        requestedLayerTypes: ['mRNA'],
        tileVectorTranscript: {
          containerVisible: true,
          visibleLayerCount: 1,
          presentingBlockCount: 0,
          coverageComplete: true,
          expectedVisibleTileCount: 2,
          missingVisibleTileCount: 0,
        },
      })
    );

    expect(owners.find((o) => o.ownerId === 'compiled-vector-surface')).toMatchObject({
      visible: false,
      layerTypes: [],
      visualGroups: [],
      coverageComplete: false,
      expectedVisibleTileCount: 2,
      missingVisibleTileCount: 0,
    });
  });

  it('does not expose a compiled vector owner without transcript tile coverage', () => {
    const owners = buildAnnotationPresentationOwners(
      planInput({
        requestedLayerTypes: ['mRNA'],
      })
    );
    expect(owners.find((o) => o.ownerId === 'compiled-vector-surface')).toMatchObject({
      visible: false,
      layerTypes: [],
      visualGroups: [],
      expectedVisibleTileCount: 0,
      missingVisibleTileCount: 0,
    });
  });

  it('keeps a partial transcript tile range hidden and preserves its missing-tile diagnostics', () => {
    const owners = buildAnnotationPresentationOwners(
      planInput({
        requestedLayerTypes: ['mRNA'],
        tileVectorTranscript: {
          containerVisible: true,
          visibleLayerCount: 1,
          presentingBlockCount: 1,
          coverageComplete: false,
          expectedVisibleTileCount: 4,
          missingVisibleTileCount: 3,
        },
      })
    );

    expect(owners.find((o) => o.ownerId === 'compiled-vector-surface')).toMatchObject({
      visible: false,
      coverageComplete: false,
      expectedVisibleTileCount: 4,
      missingVisibleTileCount: 3,
    });
    expect(validateAnnotationPresentationOwners(owners)).toContain(
      'incomplete-annotation-owner:compiled-vector-surface'
    );
  });

  it('classifies non-coding transcript layers as transcript glyph owners, not source-shape owners', () => {
    const owners = buildAnnotationPresentationOwners(
      planInput({
        requestedLayerTypes: ['mRNA', 'lnc_RNA'],
        tileVectorTranscript: {
          containerVisible: true,
          visibleLayerCount: 1,
          presentingBlockCount: 2,
          coverageComplete: true,
          expectedVisibleTileCount: 2,
          missingVisibleTileCount: 0,
        },
      })
    );
    expect(owners.find((o) => o.ownerId === 'compiled-vector-surface')).toMatchObject({
      visible: true,
      layerTypes: ['mRNA', 'lnc_RNA'],
      visualGroups: ['transcript-body', 'cds-exon', 'intron-connector'],
      coverageComplete: true,
      expectedVisibleTileCount: 2,
      missingVisibleTileCount: 0,
    });
  });

  it('marks single-chrom live visible only when both graphics and drawn features are present', () => {
    const withGraphicsOnly = buildAnnotationPresentationOwners(
      planInput({
        immediateLive: { graphicsVisible: true, drawnFeatureCount: 0, layerTypes: ['mRNA'] },
      })
    );
    const withDrawnFeatures = buildAnnotationPresentationOwners(
      planInput({
        immediateLive: { graphicsVisible: true, drawnFeatureCount: 4, layerTypes: ['mRNA'] },
      })
    );
    expect(withGraphicsOnly.find((o) => o.ownerId === 'single-chrom-live-surface')?.visible).toBe(
      false
    );
    expect(withDrawnFeatures.find((o) => o.ownerId === 'single-chrom-live-surface')?.visible).toBe(
      true
    );
  });

  it('limits single-chrom live coverage to layer types actually drawn in the frame', () => {
    const owners = buildAnnotationPresentationOwners(
      planInput({
        requestedLayerTypes: ['mRNA', 'enhancer'],
        immediateLive: {
          graphicsVisible: true,
          drawnFeatureCount: 3,
          layerTypes: ['mRNA'],
        },
      })
    );

    expect(owners.find((o) => o.ownerId === 'single-chrom-live-surface')).toMatchObject({
      visible: true,
      layerTypes: ['mRNA'],
      visualGroups: ['transcript-body', 'cds-exon', 'intron-connector'],
    });
  });

  it('treats compiled raster surfaces as broad exact owners and detail floor owners', () => {
    const detail = buildAnnotationPresentationOwners(
      planInput({
        broadLod: false,
        prebuiltGenomeWideTexture: {
          visible: true,
          layerTypes: ['mRNA'],
        },
      })
    );
    const broad = buildAnnotationPresentationOwners(
      planInput({
        broadLod: true,
        prebuiltGenomeWideTexture: {
          visible: true,
          layerTypes: ['mRNA'],
        },
      })
    );
    expect(detail.find((o) => o.ownerId === 'compiled-raster-surface')?.role).toBe('floor');
    expect(broad.find((o) => o.ownerId === 'compiled-raster-surface')?.role).toBe('exact');
  });
});

describe('validateAnnotationPresentationOwners', () => {
  it('accepts one complete exact owner per visual group', () => {
    expect(
      validateAnnotationPresentationOwners([
        owner({ ownerId: 'compiled-vector-surface', visualGroups: ['transcript-body'] }),
        owner({
          ownerId: 'active-segment-retained-surface',
          kind: 'active-segment-retained-surface',
          layerTypes: ['enhancer'],
          visualGroups: ['source-shape'],
        }),
      ])
    ).toEqual([]);
  });

  it('rejects duplicate exact owners for the same visual group', () => {
    expect(
      validateAnnotationPresentationOwners([
        owner({ ownerId: 'compiled-vector-surface' }),
        owner({
          ownerId: 'active-segment-retained-surface',
          kind: 'active-segment-retained-surface',
        }),
      ])
    ).toContain(
      'duplicate-exact-annotation-owner:transcript-body:compiled-vector-surface+active-segment-retained-surface'
    );
  });

  it('rejects the compiled raster floor under compiled vector detail for the same visual group', () => {
    expect(
      validateAnnotationPresentationOwners([
        owner({
          ownerId: 'compiled-raster-surface',
          kind: 'compiled-raster-surface',
          role: 'floor',
        }),
        owner({ ownerId: 'compiled-vector-surface' }),
      ])
    ).toContain(
      'floor-overlaps-exact-annotation-owner:transcript-body:compiled-raster-surface+compiled-vector-surface'
    );
  });

  it('rejects a floor owner visible under a non-vector exact owner for the same visual group', () => {
    expect(
      validateAnnotationPresentationOwners([
        owner({
          ownerId: 'compiled-raster-surface',
          kind: 'compiled-raster-surface',
          role: 'floor',
        }),
        owner({
          ownerId: 'active-segment-retained-surface',
          kind: 'active-segment-retained-surface',
        }),
      ])
    ).toContain(
      'floor-overlaps-exact-annotation-owner:transcript-body:compiled-raster-surface+active-segment-retained-surface'
    );
  });

  it('rejects a non-raster floor owner visible under an exact owner for the same visual group', () => {
    expect(
      validateAnnotationPresentationOwners([
        owner({
          ownerId: 'unexpected-floor-owner',
          kind: 'active-segment-retained-surface',
          role: 'floor',
        }),
        owner({ ownerId: 'compiled-vector-surface' }),
      ])
    ).toContain(
      'floor-overlaps-exact-annotation-owner:transcript-body:unexpected-floor-owner+compiled-vector-surface'
    );
  });

  it('rejects compiled raster as exact when it overlaps compiled vector detail', () => {
    expect(
      validateAnnotationPresentationOwners([
        owner({
          ownerId: 'compiled-raster-surface',
          kind: 'compiled-raster-surface',
          role: 'exact',
        }),
        owner({ ownerId: 'compiled-vector-surface' }),
      ])
    ).toContain(
      'duplicate-exact-annotation-owner:transcript-body:compiled-raster-surface+compiled-vector-surface'
    );
  });

  it('reports every exact owner hidden under a detail raster floor', () => {
    expect(
      validateAnnotationPresentationOwners([
        owner({
          ownerId: 'compiled-raster-surface',
          kind: 'compiled-raster-surface',
          role: 'floor',
        }),
        owner({ ownerId: 'compiled-vector-surface' }),
        owner({
          ownerId: 'active-segment-retained-surface',
          kind: 'active-segment-retained-surface',
        }),
      ])
    ).toContain(
      'floor-overlaps-exact-annotation-owner:transcript-body:compiled-raster-surface+compiled-vector-surface+active-segment-retained-surface'
    );
  });

  it('rejects visible exact owners with incomplete coverage', () => {
    expect(
      validateAnnotationPresentationOwners([
        owner({ ownerId: 'compiled-vector-surface', coverageComplete: false }),
      ])
    ).toContain('incomplete-annotation-owner:compiled-vector-surface');
  });

  it('rejects missing selected layer coverage', () => {
    expect(validateAnnotationPresentationOwners([], { missingLayerTypes: ['enhancer'] })).toContain(
      'missing-annotation-layer-coverage:enhancer'
    );
  });

  it('rejects visible runtime genome-wide textures outside the owner surface model', () => {
    expect(
      validateAnnotationPresentationOwners([], {
        runtimeGenomeWideTextureVisible: true,
      })
    ).toContain('forbidden-runtime-genome-wide-texture-visible');
  });
});
