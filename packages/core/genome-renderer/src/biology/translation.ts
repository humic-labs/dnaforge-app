import {
  projectCodingSequence,
  type CodingSequence,
  type RecordGeneticCodeBasis,
  type NucleicAcid,
  codonReaderFor,
  codonPositionOf,
  isStartCodon,
  reverseComplement as sharedReverseComplement,
  translateCodon,
  type CodonDisplay,
  type GeneticCodeSpec,
} from '@waypoint/sequence-utils';

export function translateDnaCodon(codon: string, geneticCode?: GeneticCodeSpec): string {
  return translateCodon(codon, geneticCode);
}

const reverseComplement = sharedReverseComplement;

export type CodonMutationKind =
  | 'match'
  | 'substitution'
  | 'synonymous'
  | 'inserted'
  | 'deleted'
  | 'frameshifted'
  | 'unknown';
export interface CodonMutationInfo {
  readonly kind: CodonMutationKind;
  readonly referenceCodons: readonly {
    readonly codon: string;
    readonly aa: string;
    readonly residueIndex?: number;
  }[];
  readonly referenceAa?: string;
  readonly queryAa?: string;
  readonly queryResidueIndex?: number;
  readonly frameShifted: boolean;
  readonly prematureStop: boolean;
  readonly stopLost: boolean;
}

export interface CodonInfo {
  readonly mutation?: CodonMutationInfo;

  startBp: number;

  endBp: number;

  codonStartBp?: number;

  codonEndBp?: number;

  codon: string;

  aa: string;

  display?: CodonDisplay;

  geneticCode?: GeneticCodeSpec;

  isStop: boolean;

  isStart: boolean;

  renderLetter?: boolean;

  residueIndex?: number;

  isPartialPreIntron?: boolean;

  isPartialPostIntron?: boolean;
}

export interface IntronInfo {
  number: number;
  genomicStart: number;
  genomicEnd: number;
  length: number;
  phase: number;
  donorSite: string;
  acceptorSite: string;
  codingSeqBoundary?: number;
}

interface SplicedCodingSequence extends CodingSequence {
  introns: IntronInfo[];
}

interface TranslateOptions {
  segments?: ReadonlyArray<{ start: number; end: number }>;
  qualifiers?: Record<string, string | undefined>;
  qualifierValues?: Readonly<Record<string, readonly string[]>>;

  sequenceGeneticCode?: GeneticCodeSpec;
  geneticCodeBasis?: RecordGeneticCodeBasis;
  nucleicAcid?: NucleicAcid;
}

export type BaseReader = (bp: number) => string | undefined;
type Seq = string | BaseReader;

const readBase = (s: Seq, bp: number): string | undefined =>
  typeof s === 'string' ? s[bp] : s(bp);

const seqLength = (s: Seq, fallback: number): number =>
  typeof s === 'string' ? s.length : fallback;
const hasSeq = (s: Seq): boolean => (typeof s === 'function' ? true : !!s);

export function translateCDS(
  sequence: Seq,
  cdsStart: number,
  cdsEnd: number,
  direction: 'forward' | 'reverse' | 'none',
  genomeLength: number,
  circular: boolean,
  options: TranslateOptions = {}
): CodonInfo[] {
  if (direction === 'none' || !hasSeq(sequence)) return [];

  if (cdsStart >= cdsEnd && !circular && !options.segments?.length) return [];
  return translateSplicedCDS(sequence, cdsStart, cdsEnd, direction, genomeLength, options);
}

export function getCDSIntrons(
  sequence: Seq,
  cdsStart: number,
  cdsEnd: number,
  direction: 'forward' | 'reverse' | 'none',
  options: TranslateOptions = {},
  genomeLength?: number
): IntronInfo[] {
  if (direction === 'none' || !hasSeq(sequence)) return [];
  return buildSplicedCodingSequence(sequence, cdsStart, cdsEnd, direction, options, genomeLength)
    .introns;
}

function buildSplicedCodingSequence(
  fullSequence: Seq,
  cdsStart: number,
  cdsEnd: number,
  direction: 'forward' | 'reverse' | 'none',
  options: TranslateOptions,
  genomeLength?: number
): SplicedCodingSequence {
  const projection = projectCodingSequence(
    {
      start: cdsStart + 1,
      end: cdsEnd,
      direction: direction === 'reverse' ? -1 : 1,
      ...options,
    },
    fullSequence,
    {
      sequenceLength: genomeLength,
      sequenceGeneticCode: options.sequenceGeneticCode,
      geneticCodeBasis: options.geneticCodeBasis,
      nucleicAcid: options.nucleicAcid,
    }
  );
  const { segments, codingSequence: codingBases, codonStartOffset } = projection;
  const isReverse = direction === 'reverse';
  const seqLen = seqLength(
    fullSequence,
    genomeLength ?? Math.max(cdsEnd, ...segments.map((segment) => segment.end))
  );

  const introns: IntronInfo[] = [];
  const totalCodingBases = codingBases.length;
  let cumulativeExonBases = 0;

  for (let i = 0; i < segments.length - 1; i++) {
    const currentSegEnd = segments[i].end;
    const nextSegStart = segments[i + 1].start;
    const exonLength =
      segments[i].end >= segments[i].start
        ? segments[i].end - segments[i].start + 1
        : seqLen - segments[i].start + 1 + segments[i].end;
    cumulativeExonBases += exonLength;

    const genomicStart = currentSegEnd;
    const genomicEnd = nextSegStart - 2;

    const junctionGap = nextSegStart - currentSegEnd - 1;
    if (Math.abs(junctionGap) <= 1) continue;

    const length =
      genomicEnd >= genomicStart
        ? genomicEnd - genomicStart + 1
        : seqLen - genomicStart + genomicEnd + 1;
    const effectiveExonBases = isReverse
      ? totalCodingBases - cumulativeExonBases
      : cumulativeExonBases;
    const phase = (effectiveExonBases - codonStartOffset + 300) % 3;
    const codingSeqBoundary = isReverse
      ? totalCodingBases - cumulativeExonBases
      : cumulativeExonBases;

    let donorSite = '';
    let acceptorSite = '';
    if (isReverse) {
      donorSite = reverseComplement(
        sliceCircular(fullSequence, genomicEnd - 1, genomicEnd + 1, seqLen)
      );
      acceptorSite = reverseComplement(
        sliceCircular(fullSequence, genomicStart, genomicStart + 2, seqLen)
      );
    } else {
      donorSite = sliceCircular(fullSequence, genomicStart, genomicStart + 2, seqLen);
      acceptorSite = sliceCircular(fullSequence, genomicEnd - 1, genomicEnd + 1, seqLen);
    }

    introns.push({
      number: i + 1,
      genomicStart,
      genomicEnd,
      length,
      phase,
      donorSite: donorSite.toUpperCase(),
      acceptorSite: acceptorSite.toUpperCase(),
      codingSeqBoundary,
    });
  }

  return { ...projection, introns };
}

function sliceCircular(sequence: Seq, start: number, end: number, length: number): string {
  let result = '';
  for (let i = start; i < end; i++) {
    let idx = i % length;
    if (idx < 0) idx += length;
    result += readBase(sequence, idx) ?? 'N';
  }
  return result;
}

function splitCodonByIntron(
  genomicPositions: number[],
  introns: IntronInfo[],
  codonCodingOffset: number
): { prePositions: number[]; postPositions: number[] } | null {
  for (const intron of introns) {
    if (intron.phase === 0 || intron.codingSeqBoundary === undefined) continue;
    const boundary = intron.codingSeqBoundary;
    if (codonCodingOffset < boundary && codonCodingOffset + 3 > boundary) {
      const preCount = boundary - codonCodingOffset;
      return {
        prePositions: genomicPositions.slice(0, preCount),
        postPositions: genomicPositions.slice(preCount),
      };
    }
  }
  return null;
}

function codonFragmentInfo(inputs: {
  positions: number[];
  allPositions: number[];
  codonStr: string;
  aa: string;
  display: CodonDisplay;
  geneticCode: GeneticCodeSpec;
  residueIndex: number;
  isStart: boolean;
  isPartialPreIntron?: boolean;
  isPartialPostIntron?: boolean;
}): CodonInfo {
  const startBp = Math.min(...inputs.positions);
  const endBp = Math.max(...inputs.positions) + 1;
  return {
    startBp,
    endBp,
    codonStartBp: Math.min(...inputs.allPositions),
    codonEndBp: Math.max(...inputs.allPositions),
    codon: inputs.codonStr,
    aa: inputs.aa,
    display: inputs.display,
    geneticCode: inputs.geneticCode,
    isStop: inputs.display.kind === 'stop',
    isStart: inputs.isStart,
    renderLetter: inputs.positions.length >= 2,
    residueIndex: inputs.residueIndex,
    isPartialPreIntron: inputs.isPartialPreIntron,
    isPartialPostIntron: inputs.isPartialPostIntron,
  };
}

function translateSplicedCDS(
  sequence: Seq,
  cdsStart: number,
  cdsEnd: number,
  direction: 'forward' | 'reverse' | 'none',
  genomeLength: number,
  options: TranslateOptions
): CodonInfo[] {
  const read = codonReaderFor(options, options.sequenceGeneticCode, options.geneticCodeBasis);
  const spliced = buildSplicedCodingSequence(
    sequence,
    cdsStart,
    cdsEnd,
    direction,
    options,
    genomeLength
  );
  const { codingSequence, genomicCoordinateMap, codonStartOffset, introns, geneticCode } = spliced;
  const effectiveLength = codingSequence.length - codonStartOffset;
  const numCodons = Math.floor(effectiveLength / 3);
  const codons: CodonInfo[] = [];

  for (let i = 0; i < numCodons; i++) {
    const codingOffset = codonStartOffset + i * 3;
    const genomicPositions = [
      genomicCoordinateMap[codingOffset],
      genomicCoordinateMap[codingOffset + 1],
      genomicCoordinateMap[codingOffset + 2],
    ].filter((position): position is number => position !== undefined);
    if (genomicPositions.length < 3) continue;

    const codonStr = codingSequence.slice(codingOffset, codingOffset + 3).toUpperCase();

    const reading = read(
      codonStr,
      codonPositionOf(
        ...(genomicPositions.map((position) => position + 1) as [number, number, number])
      )
    );
    const aa = reading.short;
    const residueIndex = i + 1;
    if (!spliced.spliced) {
      const startBp = direction === 'reverse' ? genomicPositions[2] : genomicPositions[0];
      codons.push({
        startBp,
        endBp: (startBp + 3) % genomeLength,
        codon: codonStr,
        aa,
        display: reading,
        geneticCode,
        isStop: reading.kind === 'stop',
        isStart: i === 0 && isStartCodon(codonStr),
        renderLetter: true,
        residueIndex,
      });
      continue;
    }
    const split = splitCodonByIntron(genomicPositions, introns, codingOffset);
    if (split) {
      if (split.prePositions.length > 0) {
        codons.push(
          codonFragmentInfo({
            positions: split.prePositions,
            allPositions: genomicPositions,
            codonStr,
            aa,
            display: reading,
            geneticCode,
            residueIndex,
            isStart: i === 0 && isStartCodon(codonStr),
            isPartialPreIntron: true,
          })
        );
      }
      if (split.postPositions.length > 0) {
        codons.push(
          codonFragmentInfo({
            positions: split.postPositions,
            allPositions: genomicPositions,
            codonStr,
            aa,
            display: reading,
            geneticCode,
            residueIndex,
            isStart: i === 0 && isStartCodon(codonStr),
            isPartialPostIntron: true,
          })
        );
      }
      continue;
    }

    codons.push(
      codonFragmentInfo({
        positions: genomicPositions.map(
          (bp) => ((bp % genomeLength) + genomeLength) % genomeLength
        ),
        allPositions: genomicPositions,
        codonStr,
        aa,
        display: reading,
        geneticCode,
        residueIndex,
        isStart: i === 0 && isStartCodon(codonStr),
      })
    );
  }

  return codons;
}

export const AA_COLORS: Record<string, number> = {
  A: 0x4a72b8,
  V: 0x4a72b8,
  I: 0x4a72b8,
  L: 0x4a72b8,
  M: 0x4a72b8,
  F: 0x4a72b8,
  W: 0x4a72b8,
  P: 0x4a72b8,

  S: 0x4caf50,
  T: 0x4caf50,
  N: 0x4caf50,
  Q: 0x4caf50,
  Y: 0x4caf50,
  C: 0x4caf50,
  G: 0x4caf50,

  K: 0xe53935,
  R: 0xe53935,
  H: 0xe53935,

  D: 0x9c27b0,
  E: 0x9c27b0,

  '*': 0x9ca3af,

  '?': 0x666666,
};
