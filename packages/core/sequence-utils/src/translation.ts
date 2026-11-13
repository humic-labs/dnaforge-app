import { projectCodingSequence, type CodingSequenceContext } from './coding-sequence';
import {
  complementBase,
  reverseComplement as iupacReverseComplement,
  toNucleicAcid,
} from './iupac';
import {
  resolveGeneticCode,
  STANDARD_GENETIC_CODE,
  STANDARD_GENETIC_CODE_ID,
  type GeneticCodeInput,
} from './genetic-codes';

import type { Annotation } from './types';

export const CODON_TABLE: Readonly<Record<string, string>> = STANDARD_GENETIC_CODE.codonTable;

export const AMINO_ACID_NAMES: Record<string, string> = {
  A: 'Ala',
  C: 'Cys',
  D: 'Asp',
  E: 'Glu',
  F: 'Phe',
  G: 'Gly',
  H: 'His',
  I: 'Ile',
  K: 'Lys',
  L: 'Leu',
  M: 'Met',
  N: 'Asn',
  P: 'Pro',
  Q: 'Gln',
  R: 'Arg',
  S: 'Ser',
  T: 'Thr',
  V: 'Val',
  W: 'Trp',
  Y: 'Tyr',
  '*': 'Stop',
  X: 'Xaa',
};

export { translateCodon } from './codon-translation';
import { degenerateCodonCacheSizeForTest, translateCodon } from './codon-translation';

export function getAminoAcidName(aa: string): string {
  return AMINO_ACID_NAMES[aa.toUpperCase()] || 'Xaa';
}

export const complement = complementBase;

export const reverseComplement = iupacReverseComplement;

export function translateSequence(
  sequence: string,
  direction: 1 | -1 = 1,
  startOffset: number = 0,
  geneticCode?: GeneticCodeInput
): Array<{ position: number; codon: string; aminoAcid: string }> {
  const code = resolveGeneticCode(geneticCode);
  const result: Array<{ position: number; codon: string; aminoAcid: string }> = [];

  const ungappedSeq = sequence.replace(/-/g, '');

  const positionMap: number[] = [];
  for (let i = 0; i < sequence.length; i++) {
    if (sequence[i] !== '-') {
      positionMap.push(i);
    }
  }

  const seqToTranslate = direction === -1 ? reverseComplement(ungappedSeq) : ungappedSeq;

  for (let i = startOffset; i < seqToTranslate.length - 2; i += 3) {
    const codon = seqToTranslate.substring(i, i + 3);
    if (codon.length === 3) {
      let originalPos: number;
      if (direction === 1) {
        originalPos = positionMap[i] ?? i;
      } else {
        const revIndex = ungappedSeq.length - i - 3;
        originalPos = positionMap[revIndex] ?? revIndex;
      }

      result.push({
        position: originalPos,
        codon,
        aminoAcid: translateCodon(codon, code),
      });
    }
  }

  return result;
}

function extractCdsForwardDna(
  start: number,
  end: number,
  sequence: string,
  sequenceLength?: number
): string {
  const start0 = start - 1;
  const end0 = end - 1;
  if (start0 <= end0) {
    return sequence.slice(start0, end0 + 1);
  }
  if (!sequenceLength) {
    return '';
  }
  return sequence.slice(start0) + sequence.slice(0, end0 + 1);
}

export function cdsToProtein(
  start: number,
  end: number,
  direction: 1 | -1,
  sequence: string,
  sequenceLength?: number,
  geneticCode?: GeneticCodeInput
): string | null {
  const code = resolveGeneticCode(geneticCode);
  const forwardDna = extractCdsForwardDna(start, end, sequence, sequenceLength);
  if (forwardDna.length < 3) return null;
  const codingDna = direction === -1 ? reverseComplement(forwardDna) : forwardDna;
  let protein = '';
  for (let i = 0; i + 3 <= codingDna.length; i += 3) {
    protein += translateCodon(codingDna.slice(i, i + 3), code);
  }
  if (protein.endsWith('*')) protein = protein.slice(0, -1);
  return protein.length > 0 ? protein : null;
}

export function cdsToProteinSpliced(
  annotation: Annotation,
  sequence: string,
  opts: CodingSequenceContext = {}
): string | null {
  if (annotation.direction !== 1 && annotation.direction !== -1) return null;
  return projectCodingSequence(annotation, sequence, opts).protein || null;
}

export function isStartCodon(codon: string, geneticCode?: GeneticCodeInput): boolean {
  const upper = toNucleicAcid(codon.toUpperCase(), 'dna');
  if (geneticCode === undefined) return upper === 'ATG';
  return resolveGeneticCode(geneticCode).startCodons.has(upper);
}

export function isStopCodon(codon: string, geneticCode?: GeneticCodeInput): boolean {
  return resolveGeneticCode(geneticCode).stopCodons.has(toNucleicAcid(codon.toUpperCase(), 'dna'));
}

export function isFullCDS(
  cdsStart: number,
  cdsEnd: number,
  sequence: string,
  direction: number,
  sequenceLength?: number,
  geneticCode?: GeneticCodeInput
): boolean {
  const code = resolveGeneticCode(geneticCode);
  const seqLen = sequenceLength || sequence.length;

  const getCodonAt = (pos: number): string => {
    let codon = '';
    for (let i = 0; i < 3; i++) {
      const idx = sequenceLength ? (((pos + i) % seqLen) + seqLen) % seqLen : pos + i;
      if (idx >= 0 && idx < sequence.length) {
        codon += sequence[idx];
      }
    }
    return codon;
  };

  const start0 = cdsStart - 1;
  const end0 = cdsEnd - 1;

  if (direction === 1) {
    const cdsLength = (end0 - start0 + 1 + seqLen) % seqLen || seqLen;

    const lastCodonStart = start0 + Math.floor((cdsLength - 1) / 3) * 3;
    const lastCodon = getCodonAt(lastCodonStart % seqLen);

    if (lastCodon.length === 3 && isStopCodon(lastCodon, code)) {
      return true;
    }

    const nextCodonStart = (end0 + 1) % seqLen;
    const nextCodon = getCodonAt(nextCodonStart);

    if (nextCodon.length === 3 && isStopCodon(nextCodon, code)) {
      return true;
    }
  } else {
    const _cdsLength = (end0 - start0 + 1 + seqLen) % seqLen || seqLen;

    const _lastCodonEnd = start0 + 2;
    let lastCodon = '';
    for (let i = 2; i >= 0; i--) {
      const idx = sequenceLength ? (((start0 + i) % seqLen) + seqLen) % seqLen : start0 + i;
      if (idx >= 0 && idx < sequence.length) {
        lastCodon += complement(sequence[idx]);
      }
    }

    if (lastCodon.length === 3 && isStopCodon(lastCodon, code)) {
      return true;
    }

    let nextCodon = '';
    for (let i = 2; i >= 0; i--) {
      const idx = sequenceLength ? (((start0 - 3 + i) % seqLen) + seqLen) % seqLen : start0 - 3 + i;
      if (idx >= 0 && idx < sequence.length) {
        nextCodon += complement(sequence[idx]);
      }
    }

    if (nextCodon.length === 3 && isStopCodon(nextCodon, code)) {
      return true;
    }
  }

  return false;
}

export function areInFrame(cds1Start: number, cds2Start: number): boolean {
  return Math.abs(cds1Start - cds2Start) % 3 === 0;
}

export const translationInternals = {
  DEGENERATE_CODON_CACHE_SIZE_FOR_TEST: (
    geneticCode: GeneticCodeInput = STANDARD_GENETIC_CODE_ID
  ): number => degenerateCodonCacheSizeForTest(geneticCode),
};
