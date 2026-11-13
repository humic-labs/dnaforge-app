import { INDEXED_ANNOTATION_COLOR_BASIS_THEME } from '../shared/annotation-runtime-theme';
import type { PrepackedAnnotationSceneStatus } from '../overview/prepacked-annotation-scene';

export function firstPrepackedMaterializeRejectReason(input: {
  themeMode: string;
  trackType: string;
  requestedLayerTypes: readonly string[];
  familyKinds: readonly string[];
}): Extract<
  PrepackedAnnotationSceneStatus,
  'variant-mismatch' | 'mixed-layer-fallback' | 'scene-contains-source-shape'
> | null {
  if (input.themeMode !== INDEXED_ANNOTATION_COLOR_BASIS_THEME) return 'variant-mismatch';
  if (!input.requestedLayerTypes.includes(input.trackType)) return 'mixed-layer-fallback';
  if (input.familyKinds.some((kind) => kind !== 'transcript')) return 'scene-contains-source-shape';
  return null;
}

export type PrepackedMaterializeAdmissionFlags = {
  requestedLayersCovered: boolean;
  ownerKeyValid: boolean;
  metadataValid: boolean;
  trackMatches: boolean;
  barHeightMatches: boolean;
  interactionIndexPresent: boolean;
  viewportDetailValid: boolean;
  trustedAdmissionCoherent: boolean;
  hasValidPolicyContract: boolean;
  runtimePolicyValid: boolean;
  policyFeatureCountMatches: boolean;
  partitionSpanMatches: boolean;
};

export function secondPrepackedMaterializeRejectReason(input: {
  currentGenomeIdentity: string;
  metadataGenomeIdentity: string;
  genomeLength: number;
  metadataGenomeLength: number;
  isWebgl: boolean;
}): Extract<PrepackedAnnotationSceneStatus, 'genome-mismatch' | 'unsupported-renderer'> | null {
  if (
    input.currentGenomeIdentity !== input.metadataGenomeIdentity ||
    input.genomeLength !== input.metadataGenomeLength
  ) {
    return 'genome-mismatch';
  }
  if (!input.isWebgl) return 'unsupported-renderer';
  return null;
}

export function inspectPrepackedMaterializeAdmission(flags: PrepackedMaterializeAdmissionFlags): {
  valid: boolean;
  flags: PrepackedMaterializeAdmissionFlags;
} {
  return {
    valid: Object.values(flags).every(Boolean),
    flags,
  };
}

export function isValidPrepackedPolicyContract(input: {
  hasPolicyProjection: boolean;
  hasPolicyGpuData: boolean;
  hasRuntimePolicy: boolean;
  hasSubmissionBank: boolean;
  hasSubmissionFineIndices: boolean;
}): boolean {
  const hasAnyPolicyContract =
    input.hasPolicyProjection ||
    input.hasPolicyGpuData ||
    input.hasRuntimePolicy ||
    input.hasSubmissionBank ||
    input.hasSubmissionFineIndices;
  return (
    !hasAnyPolicyContract ||
    (input.hasPolicyProjection &&
      input.hasRuntimePolicy &&
      ((input.hasPolicyGpuData && !input.hasSubmissionBank && !input.hasSubmissionFineIndices) ||
        (!input.hasPolicyGpuData && input.hasSubmissionBank && input.hasSubmissionFineIndices)))
  );
}
