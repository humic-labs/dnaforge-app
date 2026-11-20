import { codonPositionOf, codonReaderFor } from './codon-reading';
import { isSplicedCDS, projectCodingSequence } from './coding-sequence';
import { STANDARD_GENETIC_CODE_ID, type GeneticCodeSpec } from './genetic-codes';
import type { Annotation } from './types';

export type { Annotation };

export interface Mutation {
  type: 'substitution' | 'insertion' | 'deletion';
  position: number;
  ref_base?: string;
  query_base?: string;
  ref?: string;
  alt?: string;
  length?: number;
}

export interface FunctionalImpact {
  in_annotation: boolean;
  annotation_names: string[];
  affects_cds: boolean;
  cds_name?: string;
  amino_acid_change?: string;
  classification?: 'synonymous' | 'missense' | 'nonsense' | 'frameshift' | 'readthrough';
}

export interface ClassifiedMutation extends Mutation {
  functional_impact: FunctionalImpact;
}

const AA_DISPLAY: Record<string, string> = {
  A: 'A',
  C: 'C',
  D: 'D',
  E: 'E',
  F: 'F',
  G: 'G',
  H: 'H',
  I: 'I',
  K: 'K',
  L: 'L',
  M: 'M',
  N: 'N',
  P: 'P',
  Q: 'Q',
  R: 'R',
  S: 'S',
  T: 'T',
  V: 'V',
  W: 'W',
  Y: 'Y',
  '*': '*',
  X: 'X',
};

function getAADisplay(aa: string): string {
  return AA_DISPLAY[aa] || aa;
}

function positionOverlapsAnnotation(position: number, ann: Annotation): boolean {
  if (ann.start <= ann.end) {
    return position >= ann.start && position <= ann.end;
  }
  return position >= ann.start || position <= ann.end;
}

function findOverlappingAnnotations(position: number, annotations: Annotation[]): Annotation[] {
  return annotations.filter((a) => positionOverlapsAnnotation(position, a));
}

function isPositionInExon(position: number, cds: Annotation): boolean {
  if (!isSplicedCDS(cds)) return true;
  return cds.segments!.some((seg) =>
    seg.start <= seg.end
      ? position >= seg.start && position <= seg.end
      : position >= seg.start || position <= seg.end
  );
}

function findOverlappingCDS(position: number, annotations: Annotation[]): Annotation | undefined {
  return annotations.find(
    (a) =>
      a.type === 'CDS' && positionOverlapsAnnotation(position, a) && isPositionInExon(position, a)
  );
}

function getCodonInfo(
  position: number,
  cds: Annotation,
  sequence: string
): { codon: string; positionInCodon: number; codonNumber: number; codonStart: number } {
  const coding = projectCodingSequence(cds, sequence);
  const offset = coding.genomicCoordinateMap.indexOf(position - 1) - coding.codonStartOffset;
  if (offset < 0) throw new Error('Position is outside translated coding bases');
  const codonNumber = Math.floor(offset / 3) + 1;
  const start = coding.codonStartOffset + (codonNumber - 1) * 3;
  const codonStart =
    codonPositionOf(
      coding.genomicCoordinateMap[start],
      coding.genomicCoordinateMap[start + 1],
      coding.genomicCoordinateMap[start + 2]
    ) + 1;
  return {
    codon: coding.codingSequence.slice(start, start + 3),
    positionInCodon: offset % 3,
    codonNumber,
    codonStart,
  };
}

export function classifyMutation(
  mutation: Mutation,
  referenceSeq: string,
  querySeq: string,
  annotations: Annotation[],
  sequenceGeneticCode: GeneticCodeSpec = STANDARD_GENETIC_CODE_ID
): FunctionalImpact {
  const { type, position, length = 1 } = mutation;

  const overlapping = findOverlappingAnnotations(position, annotations);

  if (overlapping.length === 0) {
    return {
      in_annotation: false,
      annotation_names: [],
      affects_cds: false,
    };
  }

  const annotationNames = overlapping.map((a) => a.name);
  const cds = findOverlappingCDS(position, annotations);

  if (!cds) {
    return {
      in_annotation: true,
      annotation_names: annotationNames,
      affects_cds: false,
    };
  }

  if (type === 'insertion' || type === 'deletion') {
    const isFrameshift = length % 3 !== 0;

    return {
      in_annotation: true,
      annotation_names: annotationNames,
      affects_cds: true,
      cds_name: cds.name,
      classification: isFrameshift ? 'frameshift' : 'missense',
    };
  }

  try {
    const refCodonInfo = getCodonInfo(position, cds, referenceSeq);
    const queryCodonInfo = getCodonInfo(position, cds, querySeq);

    const read = codonReaderFor(cds, sequenceGeneticCode);
    const refReading = read(refCodonInfo.codon, refCodonInfo.codonStart);
    const queryReading = read(queryCodonInfo.codon, queryCodonInfo.codonStart);

    if (
      (refReading.full === 'X' && /[^ACGTU]/i.test(refCodonInfo.codon)) ||
      (queryReading.full === 'X' && /[^ACGTU]/i.test(queryCodonInfo.codon))
    ) {
      return {
        in_annotation: true,
        annotation_names: annotationNames,
        affects_cds: true,
        cds_name: cds.name,
      };
    }

    const meaningOf = (reading: { kind: string; full: string }) =>
      `${reading.kind}:${reading.full}`;
    const refAA = refReading.full;
    const queryAA = queryReading.full;

    let classification: 'synonymous' | 'missense' | 'nonsense' | 'readthrough';
    let aminoAcidChange: string | undefined;

    if (queryReading.alsoTerminates && !refReading.alsoTerminates) {
      classification = 'readthrough';
      aminoAcidChange = `${getAADisplay(refAA)}${refCodonInfo.codonNumber}${queryAA}`;
    } else if (meaningOf(refReading) === meaningOf(queryReading)) {
      classification = 'synonymous';
    } else if (queryReading.alsoTerminates) {
      classification = 'readthrough';
      aminoAcidChange = `${getAADisplay(refAA)}${refCodonInfo.codonNumber}${queryAA}`;
    } else if (queryAA === '*') {
      classification = 'nonsense';
      aminoAcidChange = `${getAADisplay(refAA)}${refCodonInfo.codonNumber}${getAADisplay(queryAA)}`;
    } else {
      classification = 'missense';
      aminoAcidChange = `${getAADisplay(refAA)}${refCodonInfo.codonNumber}${getAADisplay(queryAA)}`;
    }

    return {
      in_annotation: true,
      annotation_names: annotationNames,
      affects_cds: true,
      cds_name: cds.name,
      classification,
      amino_acid_change: aminoAcidChange,
    };
  } catch {
    return {
      in_annotation: true,
      annotation_names: annotationNames,
      affects_cds: true,
      cds_name: cds.name,
    };
  }
}

export function classifyMutations(
  mutations: Mutation[],
  referenceSeq: string,
  querySeq: string,
  annotations: Annotation[],
  sequenceGeneticCode: GeneticCodeSpec = STANDARD_GENETIC_CODE_ID
): ClassifiedMutation[] {
  return mutations.map((mutation) => ({
    ...mutation,
    functional_impact: classifyMutation(
      mutation,
      referenceSeq,
      querySeq,
      annotations,
      sequenceGeneticCode
    ),
  }));
}
