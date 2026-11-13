import { computeChecksum } from '@waypoint/sequence-utils';
import {
  normalizeProteinSequence,
  proteinSequenceValidationError,
} from '@waypoint/sequence-utils/protein-sequence';
import type { ProteinSequenceRef, InlineAminoAcidSequenceRef } from '../lims';
export {
  normalizeProteinSequence,
  proteinSequenceValidationError,
} from '@waypoint/sequence-utils/protein-sequence';

export async function buildInlineProteinSequenceRef(
  value: string
): Promise<Extract<ProteinSequenceRef, { mode: 'inline' }>> {
  const aminoAcids = normalizeProteinSequence(value);
  const error = proteinSequenceValidationError(aminoAcids);
  if (error) throw new Error(error);
  return {
    mode: 'inline',
    aminoAcids,
    length: aminoAcids.length,
    contentHash: await computeChecksum(aminoAcids),
  };
}

export async function buildInlineAminoAcidSequenceRef(
  bases: string
): Promise<InlineAminoAcidSequenceRef> {
  const cleaned = bases.replace(/\s/g, '').toUpperCase();
  return {
    mode: 'inline',
    bases: cleaned,
    length: cleaned.length,
    contentHash: await computeChecksum(cleaned),
  };
}
