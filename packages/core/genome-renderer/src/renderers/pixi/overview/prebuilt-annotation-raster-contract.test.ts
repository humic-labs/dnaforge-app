import { describe, expect, it } from 'vitest';

import {
  PREBUILT_ANNOTATION_RASTER_LANE_ARTIFACT_V1,
  PREBUILT_ANNOTATION_RASTER_LANE_PROJECTION_V1,
  PREBUILT_ANNOTATION_RASTER_PRESENTATION_V1,
  PREBUILT_ANNOTATION_RASTER_SOURCE_PLACEMENT_V1,
  PREBUILT_ANNOTATION_RASTERIZER_V1,
  isAnnotationSourcePlacementProvenanceV1,
  isPrebuiltAnnotationRasterLaneProjectionV1,
  matchPrebuiltAnnotationRasterPresentation,
  prebuiltAnnotationRasterPresentationArtifactKeyV1,
  type ActiveAnnotationRasterPresentationContract,
  type PrebuiltAnnotationRasterLaneProjectionV1,
  type PrebuiltAnnotationRasterPresentationIdentityV1,
  type PrebuiltAnnotationRasterPresentationReceiptV1,
} from './prebuilt-annotation-raster-contract';
import {
  PREPACKED_ANNOTATION_BAR_HEIGHT_PX,
  PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
  PREPACKED_ANNOTATION_LANE_STEP_PX,
  PREPACKED_ANNOTATION_LANE_TOKEN,
  PREPACKED_ANNOTATION_MAPPER_TOKEN,
} from './prepacked-annotation-scene';

function receipt(
  overrides: Partial<PrebuiltAnnotationRasterPresentationReceiptV1> = {}
): PrebuiltAnnotationRasterPresentationReceiptV1 {
  const { artifactKey: explicitArtifactKey, ...identityOverrides } = overrides;
  const identity: PrebuiltAnnotationRasterPresentationIdentityV1 = {
    contract: PREBUILT_ANNOTATION_RASTER_PRESENTATION_V1,
    sourceValidationContract: PREBUILT_ANNOTATION_RASTER_SOURCE_PLACEMENT_V1,
    genomeIdentity: 'grch38-source',
    genomeLengthBp: 3_088_269_832,
    sourceFingerprint: '0123456789abcdef01234567',
    placementFingerprint: 'ap1:0123456789abcdef01234567',
    trackType: 'mRNA',
    isoformMode: 'canonical',
    laneLimit: null,
    layerTypes: ['mRNA'],
    maxAnnotationLane: 11,
    maxCdsLane: -1,
    themeMode: 'light',
    laneArtifactContract: PREBUILT_ANNOTATION_RASTER_LANE_ARTIFACT_V1,
    annotationBarHeightPx: PREPACKED_ANNOTATION_BAR_HEIGHT_PX,
    laneStepPx: PREPACKED_ANNOTATION_LANE_STEP_PX,
    laneAlgorithmToken: PREPACKED_ANNOTATION_LANE_TOKEN,
    mapperContractToken: PREPACKED_ANNOTATION_MAPPER_TOKEN,
    geometryContractToken: PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
    rasterizerContractToken: PREBUILT_ANNOTATION_RASTERIZER_V1,
    ...identityOverrides,
  };
  return {
    artifactKey: explicitArtifactKey ?? prebuiltAnnotationRasterPresentationArtifactKeyV1(identity),
    ...identity,
  };
}

function active(
  overrides: Partial<ActiveAnnotationRasterPresentationContract> = {}
): ActiveAnnotationRasterPresentationContract {
  return {
    genomeIdentity: 'grch38-source',
    genomeLengthBp: 3_088_269_832,
    sourceFingerprint: null,
    placementFingerprint: null,
    runtimePolicy: { isoformMode: 'canonical', laneLimit: null },
    layerTypes: ['mRNA'],
    maxAnnotationLane: 11,
    maxCdsLane: -1,
    themeMode: 'light',
    ...overrides,
  };
}

function activeWithProvenance(
  overrides: Partial<ActiveAnnotationRasterPresentationContract> = {}
): ActiveAnnotationRasterPresentationContract {
  return {
    ...active(),
    sourceFingerprint: '0123456789abcdef01234567',
    placementFingerprint: 'ap1:0123456789abcdef01234567',
    ...overrides,
  };
}

function projection(
  laneLimit: number | null,
  overrides: Partial<PrebuiltAnnotationRasterLaneProjectionV1> = {}
): PrebuiltAnnotationRasterLaneProjectionV1 {
  const sourceHeightPx = 12 * PREPACKED_ANNOTATION_LANE_STEP_PX;
  const presentedHeightPx =
    laneLimit === null ? sourceHeightPx : laneLimit * PREPACKED_ANNOTATION_LANE_STEP_PX;
  return {
    contract: PREBUILT_ANNOTATION_RASTER_LANE_PROJECTION_V1,
    laneLimit,
    sourceHeightPx,
    sourceSpineOffsetPx: sourceHeightPx - 1,
    sourceMaxAnnotationLane: 11,
    presentedHeightPx,
    presentedSpineOffsetPx: presentedHeightPx - 1,
    ...overrides,
  };
}

describe('prebuilt annotation raster semantic contract', () => {
  it('fails closed for an absent or legacy receipt', () => {
    expect(matchPrebuiltAnnotationRasterPresentation(null, active()).contractMatch).toBe(false);
    expect(
      matchPrebuiltAnnotationRasterPresentation({ isoformMode: 'canonical' }, active())
        .contractMatch
    ).toBe(false);
  });

  it('rejects cached raster bytes from the pre-final-theme color contract', () => {
    const staleV2Receipt = {
      ...receipt(),
      geometryContractToken: 'retained-linear-directional-block.track-local.v2',
    };

    expect(
      matchPrebuiltAnnotationRasterPresentation(staleV2Receipt, activeWithProvenance())
        .contractMatch
    ).toBe(false);
  });

  it('fails closed when active source-placement provenance is unavailable', () => {
    const result = matchPrebuiltAnnotationRasterPresentation(receipt(), active());
    expect(result.sourceMatch).toBe(false);
    expect(result.placementMatch).toBe(false);
    expect(result.contractMatch).toBe(false);
  });

  it('rejects the same-length wrong source independently of display identity', () => {
    const result = matchPrebuiltAnnotationRasterPresentation(
      receipt({ sourceFingerprint: 'fedcba9876543210fedcba98' }),
      activeWithProvenance()
    );
    expect(result.sourceMatch).toBe(false);
    expect(result.placementMatch).toBe(true);
    expect(result.contractMatch).toBe(false);
  });

  it('rejects the same-length wrong ordered assembly placement', () => {
    const result = matchPrebuiltAnnotationRasterPresentation(
      receipt({ placementFingerprint: 'ap1:fedcba9876543210fedcba98' }),
      activeWithProvenance()
    );
    expect(result.sourceMatch).toBe(true);
    expect(result.placementMatch).toBe(false);
    expect(result.contractMatch).toBe(false);
  });

  it('rejects a canonical uncapped artifact for canonical lane 12', () => {
    expect(
      matchPrebuiltAnnotationRasterPresentation(
        receipt(),
        activeWithProvenance({
          runtimePolicy: { isoformMode: 'canonical', laneLimit: 12 },
          maxAnnotationLane: 11,
        })
      ).contractMatch
    ).toBe(false);
  });

  it('accepts a finite ceiling only through an exact pre-derived lane projection', () => {
    const finiteActive = activeWithProvenance({
      runtimePolicy: { isoformMode: 'canonical', laneLimit: 12 },
      maxAnnotationLane: 11,
    });

    expect(
      matchPrebuiltAnnotationRasterPresentation(receipt(), finiteActive, projection(12))
        .contractMatch
    ).toBe(true);
    expect(
      matchPrebuiltAnnotationRasterPresentation(receipt(), finiteActive, projection(8))
        .contractMatch
    ).toBe(false);
    expect(
      matchPrebuiltAnnotationRasterPresentation(
        receipt(),
        finiteActive,
        projection(12, { sourceMaxAnnotationLane: 23, sourceHeightPx: 384 })
      ).contractMatch
    ).toBe(false);
  });

  it('validates the complete source and presented pixel envelopes', () => {
    expect(isPrebuiltAnnotationRasterLaneProjectionV1(projection(null))).toBe(true);
    expect(isPrebuiltAnnotationRasterLaneProjectionV1(projection(8))).toBe(true);
    expect(
      isPrebuiltAnnotationRasterLaneProjectionV1(
        projection(8, { presentedHeightPx: 127, presentedSpineOffsetPx: 126 })
      )
    ).toBe(false);
    expect(
      isPrebuiltAnnotationRasterLaneProjectionV1(
        projection(8, { sourceHeightPx: 191, sourceSpineOffsetPx: 190 })
      )
    ).toBe(false);
    expect(
      isPrebuiltAnnotationRasterLaneProjectionV1({
        ...projection(8),
        requestedLaneLimit: 8,
      })
    ).toBe(false);
  });

  it('rejects malformed projection input instead of silently treating it as uncapped', () => {
    expect(
      matchPrebuiltAnnotationRasterPresentation(receipt(), activeWithProvenance(), {
        ...projection(null),
        presentedHeightPx: 1,
      }).contractMatch
    ).toBe(false);
  });

  it('keeps runtime lane ceilings out of immutable artifact identity', () => {
    const source = receipt();
    expect(source.laneLimit).toBeNull();
    expect(
      matchPrebuiltAnnotationRasterPresentation(
        source,
        activeWithProvenance({
          runtimePolicy: { isoformMode: 'canonical', laneLimit: 8 },
          maxAnnotationLane: 7,
        }),
        projection(8)
      ).contractMatch
    ).toBe(true);
    expect(
      matchPrebuiltAnnotationRasterPresentation(
        source,
        activeWithProvenance({
          runtimePolicy: { isoformMode: 'canonical', laneLimit: 24 },
          maxAnnotationLane: 23,
        }),
        projection(24)
      ).contractMatch
    ).toBe(true);
    expect(source.artifactKey).toBe(receipt().artifactKey);
  });

  it('rejects an expanded/canonical mismatch', () => {
    expect(
      matchPrebuiltAnnotationRasterPresentation(
        receipt({ isoformMode: 'expanded' }),
        activeWithProvenance()
      ).contractMatch
    ).toBe(false);
  });

  it('rejects stale source, placement validation, and realized lane envelopes', () => {
    expect(
      matchPrebuiltAnnotationRasterPresentation(
        receipt({ genomeIdentity: 'stale-source' }),
        activeWithProvenance()
      ).sourceMatch
    ).toBe(false);
    expect(
      matchPrebuiltAnnotationRasterPresentation(
        receipt({ placementFingerprint: '' }),
        activeWithProvenance()
      ).placementMatch
    ).toBe(false);
    expect(
      matchPrebuiltAnnotationRasterPresentation(
        receipt({ maxAnnotationLane: 23 }),
        activeWithProvenance()
      ).contractMatch
    ).toBe(false);
  });

  it('accepts only the exact semantic presentation and reports artifact-owned layers', () => {
    expect(matchPrebuiltAnnotationRasterPresentation(receipt(), activeWithProvenance())).toEqual({
      contractMatch: true,
      sourceMatch: true,
      placementMatch: true,
      artifactLayerTypes: ['mRNA'],
      artifactSourceFingerprint: '0123456789abcdef01234567',
      artifactPlacementFingerprint: 'ap1:0123456789abcdef01234567',
    });
    const mismatch = matchPrebuiltAnnotationRasterPresentation(
      receipt({ layerTypes: ['enhancer', 'mRNA'] }),
      activeWithProvenance()
    );
    expect(mismatch.contractMatch).toBe(false);
    expect(mismatch.artifactLayerTypes).toEqual(['enhancer', 'mRNA']);
  });

  it('rejects extra fields and an artifact key that omits an identity change', () => {
    expect(
      matchPrebuiltAnnotationRasterPresentation(
        { ...receipt(), unexpectedRuntimeCap: 12 },
        activeWithProvenance()
      ).contractMatch
    ).toBe(false);
    const canonical = receipt();
    expect(
      matchPrebuiltAnnotationRasterPresentation(
        { ...canonical, isoformMode: 'expanded' },
        activeWithProvenance({ runtimePolicy: { isoformMode: 'expanded', laneLimit: null } })
      ).contractMatch
    ).toBe(false);
  });

  it('frames every immutable identity field so delimiter-shaped values cannot collide', () => {
    const first = receipt({ genomeIdentity: 'source|placement:ab' });
    const second = receipt({ genomeIdentity: 'source|placement:a', layerTypes: ['b', 'mRNA'] });
    expect(first.artifactKey).not.toBe(second.artifactKey);
    expect(receipt().artifactKey).not.toBe(
      receipt({ sourceFingerprint: 'fedcba9876543210fedcba98' }).artifactKey
    );
    expect(receipt().artifactKey).not.toBe(
      receipt({ placementFingerprint: 'ap1:fedcba9876543210fedcba98' }).artifactKey
    );
  });

  it('accepts only an exact independently validated active source-placement receipt', () => {
    const provenance = {
      contract: PREBUILT_ANNOTATION_RASTER_SOURCE_PLACEMENT_V1,
      sourceFingerprint: '0123456789abcdef01234567',
      placementFingerprint: 'ap1:0123456789abcdef01234567',
    };
    expect(isAnnotationSourcePlacementProvenanceV1(provenance)).toBe(true);
    expect(isAnnotationSourcePlacementProvenanceV1({ ...provenance, requestedLaneLimit: 12 })).toBe(
      false
    );
    expect(
      isAnnotationSourcePlacementProvenanceV1({
        ...provenance,
        sourceFingerprint: 'not-a-source-fingerprint',
      })
    ).toBe(false);
  });
});
