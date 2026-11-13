import {
  projectCodingSequence,
  STANDARD_GENETIC_CODE_ID,
  type GeneticCodeSpec,
  type RecordGeneticCodeBasis,
} from '@waypoint/sequence-utils';
import type { Annotation } from '@waypoint/sequence-utils';

export function getCDSTranslation(
  cds: Annotation,
  fullSequence: string,
  sequenceGeneticCode: GeneticCodeSpec = STANDARD_GENETIC_CODE_ID,
  geneticCodeBasis?: RecordGeneticCodeBasis
): string {
  return projectCodingSequence(cds, fullSequence, { sequenceGeneticCode, geneticCodeBasis })
    .protein;
}

export type AminoAcidCreationBlockReason =
  | 'invalid_length'
  | 'internal_stop'
  | 'translation_mismatch';

export function aminoAcidCreationBlockedReason(
  cds: Annotation,
  fullSequence: string,
  sequenceGeneticCode: GeneticCodeSpec = STANDARD_GENETIC_CODE_ID,
  geneticCodeBasis?: RecordGeneticCodeBasis
): AminoAcidCreationBlockReason | null {
  const spliced = projectCodingSequence(cds, fullSequence, {
    sequenceGeneticCode,
    geneticCodeBasis,
  });
  const { codingSequence, codonStartOffset, proteinLength, translationMismatch } = spliced;
  const effectiveCodingLength = codingSequence.length - codonStartOffset;
  if (proteinLength <= 0 || effectiveCodingLength % 3 !== 0) return 'invalid_length';
  if (translationMismatch) return 'translation_mismatch';

  if (spliced.protein.includes('*')) return 'internal_stop';
  return null;
}
