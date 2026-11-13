import {
  STANDARD_GENETIC_CODE_ID,
  translateSequence,
  type GeneticCodeSpec,
} from '@waypoint/sequence-utils';

export type FrameStrand = 'forward' | 'reverse';
export type FrameNumber = 1 | 2 | 3;

export const FRAME_NUMBERS: readonly FrameNumber[] = [1, 2, 3];
export const FRAME_STRANDS: readonly FrameStrand[] = ['forward', 'reverse'];

const CODON_SIZE = 3;

export interface FrameTranslation {
  strand: FrameStrand;
  frame: FrameNumber;
  aminoAcids: string;
  codonCount: number;
  truncatedBases: number;
  geneticCode: GeneticCodeSpec;
}

function translateFrame(
  sequence: string,
  direction: 1 | -1,
  offset: number,
  geneticCode: GeneticCodeSpec
): string {
  return translateSequence(sequence, direction, offset, geneticCode)
    .map((translation) => translation.aminoAcid)
    .join('');
}

export function computeFrameTranslation(
  sequence: string,
  strand: FrameStrand,
  frame: FrameNumber,
  geneticCode: GeneticCodeSpec = STANDARD_GENETIC_CODE_ID
): FrameTranslation {
  const offset = frame - 1;
  const direction: 1 | -1 = strand === 'forward' ? 1 : -1;
  const sanitizedLength = sequence.replace(/-/g, '').length;
  const availableBases = Math.max(0, sanitizedLength - offset);

  return {
    strand,
    frame,
    aminoAcids: translateFrame(sequence, direction, offset, geneticCode),
    geneticCode,
    codonCount: Math.floor(availableBases / CODON_SIZE),
    truncatedBases: availableBases % CODON_SIZE,
  };
}

export function computeSixFrameTranslations(
  sequence: string,
  geneticCode: GeneticCodeSpec = STANDARD_GENETIC_CODE_ID
): FrameTranslation[] {
  const frames: FrameTranslation[] = [];
  for (const strand of FRAME_STRANDS) {
    for (const frame of FRAME_NUMBERS) {
      frames.push(computeFrameTranslation(sequence, strand, frame, geneticCode));
    }
  }
  return frames;
}
