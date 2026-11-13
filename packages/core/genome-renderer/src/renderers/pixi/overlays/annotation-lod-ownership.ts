export const GENOME_WIDE_ANNOTATION_RASTER_EXACT_MIN_VISIBLE_FRACTION = 0.25;

export const ANNOTATION_PREBUILT_RASTER_MESH_FILL_KNEE_FRACTION = 0.72;

export const ANNOTATION_PREBUILT_RASTER_MIN_TEXELS_PER_DEVICE_PX = 1;

export type AnnotationPrebuiltRasterEligibilityReason =
  | 'eligible'
  | 'unavailable'
  | 'semantic-contract-mismatch'
  | 'invalid-viewport'
  | 'forced-mesh'
  | 'below-fill-knee'
  | 'magnified';

export type AnnotationPrebuiltRasterEligibilityInput = {
  genomeLength: number;
  visibleBp: number;
  texelsPerDevicePx: number;
  rasterAvailable: boolean;
  semanticContractMatch?: boolean;
  forceMeshOverview?: boolean;
};

export type AnnotationPrebuiltRasterEligibility = {
  eligible: boolean;
  reason: AnnotationPrebuiltRasterEligibilityReason;
  genomeFraction: number;
  fillKneeSatisfied: boolean;
  physicalSamplingSatisfied: boolean;
};

export function annotationPrebuiltRasterEligibility(
  input: AnnotationPrebuiltRasterEligibilityInput
): AnnotationPrebuiltRasterEligibility {
  const viewportValid =
    Number.isFinite(input.genomeLength) &&
    input.genomeLength > 0 &&
    Number.isFinite(input.visibleBp) &&
    input.visibleBp > 0;
  const genomeFraction = viewportValid ? input.visibleBp / input.genomeLength : 0;
  const fillKneeSatisfied =
    viewportValid && genomeFraction >= ANNOTATION_PREBUILT_RASTER_MESH_FILL_KNEE_FRACTION;
  const physicalSamplingSatisfied =
    !Number.isNaN(input.texelsPerDevicePx) &&
    input.texelsPerDevicePx >= ANNOTATION_PREBUILT_RASTER_MIN_TEXELS_PER_DEVICE_PX;

  let reason: AnnotationPrebuiltRasterEligibilityReason = 'eligible';
  if (!input.rasterAvailable) reason = 'unavailable';
  else if (input.semanticContractMatch !== true) reason = 'semantic-contract-mismatch';
  else if (!viewportValid) reason = 'invalid-viewport';
  else if (input.forceMeshOverview === true) reason = 'forced-mesh';
  else if (!fillKneeSatisfied) reason = 'below-fill-knee';
  else if (!physicalSamplingSatisfied) reason = 'magnified';

  return {
    eligible: reason === 'eligible',
    reason,
    genomeFraction,
    fillKneeSatisfied,
    physicalSamplingSatisfied,
  };
}

export function isGenomeWideRasterAnnotationOwner(input: {
  genomeLength: number;
  viewStartBp: number;
  viewEndBp: number;
}): boolean {
  if (!Number.isFinite(input.genomeLength) || input.genomeLength <= 0) return false;
  if (!Number.isFinite(input.viewStartBp) || !Number.isFinite(input.viewEndBp)) return false;
  const visibleBp = input.viewEndBp - input.viewStartBp;
  if (!Number.isFinite(visibleBp) || visibleBp <= 0) return false;
  return visibleBp > input.genomeLength * GENOME_WIDE_ANNOTATION_RASTER_EXACT_MIN_VISIBLE_FRACTION;
}
