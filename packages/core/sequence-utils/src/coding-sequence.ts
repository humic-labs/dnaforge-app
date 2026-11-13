import { codonPositionOf, codonReaderFor, type CodonQualifiers } from './codon-reading';
import {
  resolveAnnotationGeneticCode,
  type GeneticCodeSpec,
  type RecordGeneticCodeBasis,
} from './genetic-codes';
import { reverseComplement, type NucleicAcid } from './iupac';

export interface CodingFeature {
  readonly start: number;
  readonly end: number;
  readonly direction?: number;
  readonly segments?: ReadonlyArray<Readonly<{ start: number; end: number }>>;
  readonly qualifiers?: CodonQualifiers;
  readonly qualifierValues?: Readonly<Record<string, readonly string[]>>;
}

export interface CodingSequenceContext {
  sequenceLength?: number;
  sequenceGeneticCode?: GeneticCodeSpec;
  geneticCodeBasis?: RecordGeneticCodeBasis;
  nucleicAcid?: NucleicAcid;
}

export interface CodingSequence {
  codingSequence: string;
  genomicCoordinateMap: number[];
  segments: ReadonlyArray<Readonly<{ start: number; end: number }>>;
  spliced: boolean;
  codonStartOffset: number;
  proteinLength: number;
  protein: string;
  translationMismatch: boolean;
  geneticCode: GeneticCodeSpec;
}

function qualifier(feature: CodingFeature, name: string): string | undefined {
  const value = feature.qualifierValues?.[name] ?? feature.qualifiers?.[name];
  return typeof value === 'string' ? value : value?.[0];
}

export function codingFrameOffset(cds: CodingFeature): 0 | 1 | 2 {
  const declaredStart = Number.parseInt(qualifier(cds, 'codon_start') ?? '1', 10);
  return declaredStart === 2 ? 1 : declaredStart === 3 ? 2 : 0;
}

export function isSplicedCDS(cds: CodingFeature, sequenceLength?: number): boolean {
  if (!cds.segments || cds.segments.length < 2) return false;
  if (/(^|\W)order\s*\(/i.test(qualifier(cds, '_locationString') ?? '')) return false;
  if (cds.start <= cds.end) return true;
  const segments = orderedSegments(cds);
  return segments.slice(0, -1).some((segment, i) => {
    const next = segments[i + 1];
    if (next.start > segment.end) return next.start - segment.end - 1 > 0;
    return sequenceLength !== undefined
      ? sequenceLength - segment.end + next.start - 1 > 0
      : next.start > 1;
  });
}

function orderedSegments(cds: CodingFeature): Array<Readonly<{ start: number; end: number }>> {
  const segments = [...(cds.segments ?? [{ start: cds.start, end: cds.end }])];
  if (cds.start > cds.end)
    segments.sort(
      (a, b) => (a.start < cds.start ? 1 : 0) - (b.start < cds.start ? 1 : 0) || a.start - b.start
    );
  return segments;
}

export function projectCodingSequence(
  cds: CodingFeature,
  sequence: string | ((position: number) => string | undefined),
  context: CodingSequenceContext = {}
): CodingSequence {
  const bounds = cds.segments?.length ? cds.segments : [cds];
  const crossesOrigin =
    cds.start > cds.end || bounds.some((segment) => segment.start > segment.end);
  if (typeof sequence === 'function' && context.sequenceLength === undefined && crossesOrigin)
    throw new Error('An origin-spanning base reader requires the actual genome length.');
  const sequenceLength =
    typeof sequence === 'string'
      ? sequence.length
      : (context.sequenceLength ?? Math.max(cds.end, ...bounds.map((segment) => segment.end)));
  const spliced = isSplicedCDS(cds, sequenceLength);
  const segments = spliced ? orderedSegments(cds) : [{ start: cds.start, end: cds.end }];
  const genomicCoordinateMap: number[] = [];
  const bases: string[] = [];
  if (sequenceLength > 0)
    for (const segment of segments) {
      const length =
        segment.start <= segment.end
          ? segment.end - segment.start + 1
          : sequenceLength - segment.start + 1 + segment.end;
      for (let offset = 0; offset < length; offset++) {
        const position = (segment.start - 1 + offset) % sequenceLength;
        genomicCoordinateMap.push(position);
        bases.push((typeof sequence === 'string' ? sequence[position] : sequence(position)) ?? 'N');
      }
    }
  let codingSequence = bases.join('');
  if (cds.direction === -1) {
    codingSequence = reverseComplement(codingSequence, context.nucleicAcid);
    genomicCoordinateMap.reverse();
  }
  const codonStartOffset = codingFrameOffset(cds);
  const proteinLength = Math.max(0, Math.floor((codingSequence.length - codonStartOffset) / 3));
  const geneticCode = resolveAnnotationGeneticCode(
    cds,
    context.sequenceGeneticCode,
    context.geneticCodeBasis
  );
  const read = codonReaderFor(cds, context.sequenceGeneticCode, context.geneticCodeBasis);
  let protein = '';
  for (let residue = 0; residue < proteinLength; residue++) {
    const offset = codonStartOffset + residue * 3;
    const at = codonPositionOf(
      genomicCoordinateMap[offset],
      genomicCoordinateMap[offset + 1],
      genomicCoordinateMap[offset + 2]
    );
    protein += read(codingSequence.slice(offset, offset + 3), at + 1).short;
  }
  protein = protein.replace(/\*$/, '');
  const stored = qualifier(cds, 'translation');
  return {
    codingSequence,
    genomicCoordinateMap,
    segments,
    spliced,
    codonStartOffset,
    proteinLength,
    protein,
    geneticCode,
    translationMismatch:
      stored !== undefined && protein !== stored.replace(/\s+/g, '').replace(/\*$/, ''),
  };
}
