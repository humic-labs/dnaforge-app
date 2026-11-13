export interface AnnotationSidecarRasterEligibilityInput {
  readonly genomeLength: number;
  readonly visibleBp: number;
  readonly tileResident: boolean;
  readonly texelsPerDevicePx: number;
}

export type AnnotationSidecarRasterEligibilityReason =
  | 'eligible'
  | 'unavailable'
  | 'magnified'
  | 'fine-vector-required'
  | 'invalid-viewport'
  | 'too-many-tiles';

export interface AnnotationSidecarRasterEligibility {
  readonly eligible: boolean;
  readonly reason: AnnotationSidecarRasterEligibilityReason;
}

const NEVER_MAGNIFY_MIN_TEXELS_PER_DEVICE_PX = 1.0;

export function annotationSidecarRasterEligibility(
  input: AnnotationSidecarRasterEligibilityInput
): AnnotationSidecarRasterEligibility {
  if (!(input.genomeLength > 0) || !(input.visibleBp > 0)) {
    return { eligible: false, reason: 'invalid-viewport' };
  }
  if (!input.tileResident) {
    return { eligible: false, reason: 'unavailable' };
  }
  if (input.texelsPerDevicePx < NEVER_MAGNIFY_MIN_TEXELS_PER_DEVICE_PX) {
    return { eligible: false, reason: 'magnified' };
  }
  return { eligible: true, reason: 'eligible' };
}
