import { describe, expect, it } from 'vitest';

import {
  ANNOTATION_PREBUILT_RASTER_MESH_FILL_KNEE_FRACTION,
  ANNOTATION_PREBUILT_RASTER_MIN_TEXELS_PER_DEVICE_PX,
  annotationPrebuiltRasterEligibility,
  isGenomeWideRasterAnnotationOwner,
} from './annotation-lod-ownership';

describe('annotationPrebuiltRasterEligibility', () => {
  const genomeLength = 1_000_000;
  const rasterEligible = (visibleBp: number, texelsPerDevicePx = 1) =>
    annotationPrebuiltRasterEligibility({
      genomeLength,
      visibleBp,
      texelsPerDevicePx,
      rasterAvailable: true,
      semanticContractMatch: true,
    });

  it('changes sides only at the measured 0.72 mesh-fill knee', () => {
    const kneeBp = genomeLength * ANNOTATION_PREBUILT_RASTER_MESH_FILL_KNEE_FRACTION;

    expect(rasterEligible(kneeBp - 1)).toMatchObject({
      eligible: false,
      reason: 'below-fill-knee',
      fillKneeSatisfied: false,
      physicalSamplingSatisfied: true,
    });
    expect(rasterEligible(kneeBp)).toMatchObject({
      eligible: true,
      reason: 'eligible',
      fillKneeSatisfied: true,
      physicalSamplingSatisfied: true,
    });
    expect(rasterEligible(kneeBp + 1)).toMatchObject({
      eligible: true,
      reason: 'eligible',
      fillKneeSatisfied: true,
      physicalSamplingSatisfied: true,
    });
  });

  it('requires at least one physical raster texel per device pixel', () => {
    const kneeBp = genomeLength * ANNOTATION_PREBUILT_RASTER_MESH_FILL_KNEE_FRACTION;

    expect(rasterEligible(kneeBp, 0.999)).toMatchObject({
      eligible: false,
      reason: 'magnified',
      physicalSamplingSatisfied: false,
    });
    expect(
      rasterEligible(kneeBp, ANNOTATION_PREBUILT_RASTER_MIN_TEXELS_PER_DEVICE_PX)
    ).toMatchObject({
      eligible: true,
      reason: 'eligible',
      physicalSamplingSatisfied: true,
    });
  });

  it('fails closed for unavailable, forced-mesh, and invalid viewport states', () => {
    expect(
      annotationPrebuiltRasterEligibility({
        genomeLength,
        visibleBp: genomeLength,
        texelsPerDevicePx: 1,
        rasterAvailable: false,
        semanticContractMatch: true,
      })
    ).toMatchObject({ eligible: false, reason: 'unavailable' });
    expect(
      annotationPrebuiltRasterEligibility({
        genomeLength,
        visibleBp: genomeLength,
        texelsPerDevicePx: 1,
        rasterAvailable: true,
        semanticContractMatch: true,
        forceMeshOverview: true,
      })
    ).toMatchObject({ eligible: false, reason: 'forced-mesh' });
    expect(
      annotationPrebuiltRasterEligibility({
        genomeLength: 0,
        visibleBp: genomeLength,
        texelsPerDevicePx: 1,
        rasterAvailable: true,
        semanticContractMatch: true,
      })
    ).toMatchObject({ eligible: false, reason: 'invalid-viewport' });
  });

  it('fails closed before physical eligibility when the semantic receipt does not match', () => {
    expect(
      annotationPrebuiltRasterEligibility({
        genomeLength,
        visibleBp: genomeLength,
        texelsPerDevicePx: 1,
        rasterAvailable: true,
        semanticContractMatch: false,
      })
    ).toMatchObject({ eligible: false, reason: 'semantic-contract-mismatch' });
  });
});

describe('isGenomeWideRasterAnnotationOwner', () => {
  it('preserves the deprecated router-summary threshold until desktop migration', () => {
    const genomeLength = 1_000_000;

    expect(
      isGenomeWideRasterAnnotationOwner({
        genomeLength,
        viewStartBp: 0,
        viewEndBp: 250_000,
      })
    ).toBe(false);
    expect(
      isGenomeWideRasterAnnotationOwner({
        genomeLength,
        viewStartBp: 0,
        viewEndBp: 250_001,
      })
    ).toBe(true);
  });

  it('fails closed when the genome length or viewport range is not usable', () => {
    expect(
      isGenomeWideRasterAnnotationOwner({
        genomeLength: 0,
        viewStartBp: 0,
        viewEndBp: 1_000_000,
      })
    ).toBe(false);
    expect(
      isGenomeWideRasterAnnotationOwner({
        genomeLength: 1_000_000,
        viewStartBp: 500_000,
        viewEndBp: 500_000,
      })
    ).toBe(false);
  });
});
