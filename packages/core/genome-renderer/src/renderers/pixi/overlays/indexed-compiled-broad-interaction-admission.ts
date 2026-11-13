import { TRUSTED_MAIN_COMPILED_BROAD_ANNOTATION_INTERACTION_VALIDATION_V1 } from '../overview/compiled-broad-annotation-interaction-binary-v1';

const SHA24 = /^[0-9a-f]{24}$/;
const SHA64 = /^[0-9a-f]{64}$/;

export function isCompiledBroadAnnotationInteractionAdmissible(input: {
  ownerKey: unknown;
  validationMarker: unknown;
  sourceFingerprint: unknown;
  interactionPayloadSha256: unknown;
  sourceScene:
    | {
        byteCount?: unknown;
        payloadSha256?: unknown;
        contractSha256?: unknown;
      }
    | undefined;
  metadataValid: boolean;
  metadataGenomeIdentity: string;
  metadataGenomeLengthBp: number;
  currentGenomeIdentity: string;
  currentGenomeLengthBp: number;
  policyFeatureCount: number;
  lookupFeatureCount: number;
}): boolean {
  return Boolean(
    input.validationMarker === TRUSTED_MAIN_COMPILED_BROAD_ANNOTATION_INTERACTION_VALIDATION_V1 &&
    typeof input.ownerKey === 'string' &&
    input.ownerKey.trim().length > 0 &&
    typeof input.sourceFingerprint === 'string' &&
    SHA24.test(input.sourceFingerprint) &&
    typeof input.interactionPayloadSha256 === 'string' &&
    SHA64.test(input.interactionPayloadSha256) &&
    Number.isSafeInteger(input.sourceScene?.byteCount) &&
    (input.sourceScene?.byteCount as number) > 0 &&
    typeof input.sourceScene?.payloadSha256 === 'string' &&
    SHA64.test(input.sourceScene.payloadSha256) &&
    typeof input.sourceScene?.contractSha256 === 'string' &&
    SHA64.test(input.sourceScene.contractSha256) &&
    input.metadataValid &&
    input.metadataGenomeIdentity === input.currentGenomeIdentity &&
    input.metadataGenomeLengthBp === input.currentGenomeLengthBp &&
    input.policyFeatureCount === input.lookupFeatureCount
  );
}

export function compiledBroadAnnotationInteractionConflictsWithExisting(input: {
  existing: {
    sourceFingerprint: string;
    interactionPayloadSha256: string;
    sourceScene: {
      byteCount: number;
      payloadSha256: string;
      contractSha256: string;
    };
    metadata?: unknown;
  };
  candidate: {
    sourceFingerprint: string;
    interactionPayloadSha256: string;
    sourceScene: {
      byteCount: number;
      payloadSha256: string;
      contractSha256: string;
    };
    metadata?: unknown;
  };
  metadataEqual: boolean;
}): boolean {
  return (
    input.existing.sourceFingerprint !== input.candidate.sourceFingerprint ||
    input.existing.interactionPayloadSha256 !== input.candidate.interactionPayloadSha256 ||
    input.existing.sourceScene.byteCount !== input.candidate.sourceScene.byteCount ||
    input.existing.sourceScene.payloadSha256 !== input.candidate.sourceScene.payloadSha256 ||
    input.existing.sourceScene.contractSha256 !== input.candidate.sourceScene.contractSha256 ||
    !input.metadataEqual
  );
}
