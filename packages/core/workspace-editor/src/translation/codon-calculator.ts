import {
  codonDisplay,
  codingFrameOffset,
  codonPositionOf,
  codonReaderFor,
  parseTranslExcept,
  resolveAnnotationGeneticCode,
  type RecordGeneticCodeBasis,
  reverseComplement,
  STANDARD_GENETIC_CODE_ID,
  translateCodon,
  geneticCodeKey,
  type CodonDisplay,
  type GeneticCodeSpec,
} from '@waypoint/sequence-utils';
import type { Annotation } from '@waypoint/sequence-utils';

import { isPositionDeleted } from '../utils';
import type { InsertedRange, DeletedRange } from '../types';
import { draftPositionMap } from '../draft-positions';
import { buildSplicedCodingSequence, isSplicedCDS } from './spliced-coding-sequence';
import type { SplicedCodingSequence } from './types';

const splicedCache = new Map<string, { seq: string; result: SplicedCodingSequence }>();

export function getCachedSplicedSequence(
  cds: Annotation,
  fullSequence: string,
  sequenceGeneticCode: GeneticCodeSpec = STANDARD_GENETIC_CODE_ID,
  geneticCodeBasis?: RecordGeneticCodeBasis
): SplicedCodingSequence {
  const geneticCode = resolveAnnotationGeneticCode(cds, sequenceGeneticCode, geneticCodeBasis);
  const key = JSON.stringify([
    cds.start,
    cds.end,
    cds.direction,
    cds.segments,
    cds.qualifiers,
    geneticCodeKey(geneticCode),
    geneticCodeBasis,
  ]);
  const cached = splicedCache.get(key);
  if (cached && cached.seq === fullSequence) return cached.result;
  const result = buildSplicedCodingSequence(
    cds,
    fullSequence,
    sequenceGeneticCode,
    geneticCodeBasis
  );
  splicedCache.set(key, { seq: fullSequence, result });
  return result;
}

function displayReaderFor(
  cds: Annotation,
  sequenceGeneticCode: GeneticCodeSpec,
  geneticCodeBasis?: RecordGeneticCodeBasis
): ReturnType<typeof codonReaderFor> {
  const read = codonReaderFor(cds, sequenceGeneticCode, geneticCodeBasis);

  let exceptionPositions: Set<number> | undefined;
  for (const raw of cds.qualifiers?.transl_except ?? []) {
    const exception = parseTranslExcept(raw);
    if (exception) (exceptionPositions ??= new Set()).add(exception.location.start);
  }
  const readings = new Map<string, ReturnType<typeof read>>();
  return (codon, at) => {
    if (exceptionPositions?.has(at)) return read(codon, at);
    const cached = readings.get(codon);
    if (cached) return cached;
    const reading = read(codon, at);
    if (readings.size < 128) readings.set(codon, reading);
    return reading;
  };
}

export function resolveResidueIndex(codon: { residueIndex?: number }): number | undefined {
  if (typeof codon.residueIndex === 'number') return codon.residueIndex;
  const isProd =
    typeof process !== 'undefined' && process.env && process.env.NODE_ENV === 'production';
  if (!isProd) {
    throw new Error(
      'resolveResidueIndex: codon has no biological residueIndex. A codon ' +
        'source omitted protein-order numbering — fix the source, do NOT ' +
        'infer a number from screen/genomic position (that numbers ' +
        'reverse-strand CDSs backwards). See codon-calculator.ts.'
    );
  }
  return undefined;
}

export interface CodonInfo {
  startPos: number;
  endPos: number;
  codon: string;
  aa: string;
  display?: CodonDisplay;
  visibleStart: number;
  visibleEnd: number;
  renderLetter: boolean;
  residueIndex?: number;
  isPartialPreIntron?: boolean;
  isPartialPostIntron?: boolean;
}

export interface DraftCodonInfo {
  visualStartPos: number;
  visualEndPos: number;
  effectiveStartPos: number;
  codon: string;
  aa: string;
  status: 'normal' | 'inserted' | 'frameshifted' | 'deleted';
  originalAa?: string;
}

export interface AlignmentCodonInfo {
  columnStart: number;
  columnEnd: number;
  visibleColumnStart: number;
  visibleColumnEnd: number;
  renderLetter: boolean;
  isPartialAtStart: boolean;
  refAa: string;
  queryAa: string;
  status: 'match' | 'substitution' | 'deleted' | 'frameshifted' | 'insertion';
  codonIndex: number;
}

export function computeAllAlignmentCodons(
  alignedRef: string,
  alignedQuery: string,
  cds: Annotation & { startCol?: number; endCol?: number },
  sequenceGeneticCode: GeneticCodeSpec = STANDARD_GENETIC_CODE_ID,
  geneticCodeBasis?: RecordGeneticCodeBasis
): AlignmentCodonInfo[] {
  const geneticCode = resolveAnnotationGeneticCode(cds, sequenceGeneticCode, geneticCodeBasis);
  const codons: AlignmentCodonInfo[] = [];

  const cdsStartCol = cds.startCol ?? cds.start - 1;
  const cdsEndCol = cds.endCol ?? cds.end;

  if (cdsStartCol < 0 || cdsEndCol < 0 || cdsStartCol >= alignedRef.length) {
    return [];
  }

  const isReverse = cds.direction === -1;

  const refBaseColumns: number[] = [];
  for (let col = cdsStartCol; col < cdsEndCol; col++) {
    if (alignedRef[col] !== '-') {
      refBaseColumns.push(col);
    }
  }

  if (isReverse) {
    refBaseColumns.reverse();
  }

  const numCodons = Math.floor(refBaseColumns.length / 3);

  for (let i = 0; i < numCodons; i++) {
    const col1 = refBaseColumns[i * 3];
    const col2 = refBaseColumns[i * 3 + 1];
    const col3 = refBaseColumns[i * 3 + 2];

    const minCol = Math.min(col1, col2, col3);
    const maxCol = Math.max(col1, col2, col3);
    const midCol = col1 + col2 + col3 - minCol - maxCol;

    const columnStart = minCol;
    const columnEnd = maxCol;

    const refBases = alignedRef[minCol] + alignedRef[midCol] + alignedRef[maxCol];
    const refCodon = isReverse ? reverseComplement(refBases) : refBases;
    const refAa = translateCodon(refCodon, geneticCode);

    const q1 = alignedQuery[minCol];
    const q2 = alignedQuery[midCol];
    const q3 = alignedQuery[maxCol];
    const gapCount = (q1 === '-' ? 1 : 0) + (q2 === '-' ? 1 : 0) + (q3 === '-' ? 1 : 0);

    let queryAa: string;
    let status: AlignmentCodonInfo['status'];

    if (gapCount === 3) {
      queryAa = '-';
      status = 'deleted';
    } else if (gapCount > 0) {
      queryAa = 'X';
      status = 'frameshifted';
    } else {
      const queryBases = q1 + q2 + q3;
      const queryCodon = isReverse ? reverseComplement(queryBases) : queryBases;
      queryAa = translateCodon(queryCodon, geneticCode);
      status = queryAa === refAa ? 'match' : 'substitution';
    }

    codons.push({
      columnStart,
      columnEnd,
      visibleColumnStart: columnStart,
      visibleColumnEnd: columnEnd,
      renderLetter: true,
      isPartialAtStart: false,
      refAa,
      queryAa,
      status,
      codonIndex: i,
    });
  }

  codons.sort((a, b) => a.columnStart - b.columnStart);

  for (let i = 0; i < codons.length - 1; i++) {
    const nextCodonStart = codons[i + 1].columnStart;
    if (codons[i].columnEnd < nextCodonStart - 1) {
      codons[i].columnEnd = nextCodonStart - 1;
    }
  }

  return codons;
}

function shouldRenderLetter(
  visibleWidth: number,
  isPartialAtStart: boolean,
  codonColumnStart: number,
  lineStartCol: number
): boolean {
  if (visibleWidth < 2) return false;
  if (!isPartialAtStart) return true;
  const columnsOnPrevLine = lineStartCol - codonColumnStart;
  return columnsOnPrevLine < 2;
}

export function filterAlignmentCodonsForLine(
  allCodons: AlignmentCodonInfo[],
  lineStartCol: number,
  lineEndCol: number
): AlignmentCodonInfo[] {
  const result: AlignmentCodonInfo[] = [];

  for (const codon of allCodons) {
    if (codon.columnEnd < lineStartCol || codon.columnStart >= lineEndCol) {
      continue;
    }

    const visibleColumnStart = Math.max(codon.columnStart, lineStartCol);
    const visibleColumnEnd = Math.min(codon.columnEnd, lineEndCol - 1);
    const visibleWidth = visibleColumnEnd - visibleColumnStart + 1;
    const isPartialAtStart = codon.columnStart < lineStartCol;
    const renderLetter = shouldRenderLetter(
      visibleWidth,
      isPartialAtStart,
      codon.columnStart,
      lineStartCol
    );

    result.push({
      ...codon,
      visibleColumnStart,
      visibleColumnEnd,
      renderLetter,
      isPartialAtStart,
    });
  }

  return result;
}

export function getAlignmentCodonsForCDS(
  alignedRef: string,
  alignedQuery: string,
  cds: Annotation & { startCol?: number; endCol?: number },
  lineStartCol: number,
  lineEndCol: number
): AlignmentCodonInfo[] {
  const allCodons = computeAllAlignmentCodons(alignedRef, alignedQuery, cds);
  return filterAlignmentCodonsForLine(allCodons, lineStartCol, lineEndCol);
}

function columnOnLine(
  position: number,
  lineStartPos: number,
  lineEndPos: number,
  sequenceLength: number
): number | null {
  const lineSpansOrigin = lineStartPos > lineEndPos;
  const lineLength = lineSpansOrigin
    ? sequenceLength - lineStartPos + lineEndPos
    : lineEndPos - lineStartPos;
  const column = (((position - lineStartPos) % sequenceLength) + sequenceLength) % sequenceLength;
  return column < lineLength ? column : null;
}

function visibleRangesOnLine(
  start: number,
  end: number,
  lineStartPos: number,
  lineEndPos: number,
  sequenceLength: number
): Array<{ visibleStart: number; visibleEnd: number }> {
  if (sequenceLength <= 0 || end < start) return [];
  if (
    start >= 0 &&
    end < sequenceLength &&
    lineStartPos >= 0 &&
    lineEndPos <= sequenceLength &&
    lineStartPos < lineEndPos
  ) {
    const visibleStart = Math.max(start, lineStartPos);
    const visibleEnd = Math.min(end, lineEndPos - 1);
    return visibleStart <= visibleEnd ? [{ visibleStart, visibleEnd }] : [];
  }
  const ranges: Array<{ visibleStart: number; visibleEnd: number }> = [];
  let open: { visibleStart: number; visibleEnd: number; column: number } | null = null;

  for (let offset = 0; offset <= end - start; offset++) {
    const position = (((start + offset) % sequenceLength) + sequenceLength) % sequenceLength;
    const column = columnOnLine(position, lineStartPos, lineEndPos, sequenceLength);
    if (column === null) {
      if (open) ranges.push({ visibleStart: open.visibleStart, visibleEnd: open.visibleEnd });
      open = null;
      continue;
    }
    if (open && column === open.column + 1) {
      open.visibleEnd = position;
      open.column = column;
      continue;
    }
    if (open) ranges.push({ visibleStart: open.visibleStart, visibleEnd: open.visibleEnd });
    open = { visibleStart: position, visibleEnd: position, column };
  }
  if (open) ranges.push({ visibleStart: open.visibleStart, visibleEnd: open.visibleEnd });
  return ranges;
}

function pieceLength(
  piece: { visibleStart: number; visibleEnd: number },
  sequenceLength: number
): number {
  return piece.visibleEnd >= piece.visibleStart
    ? piece.visibleEnd - piece.visibleStart + 1
    : sequenceLength - piece.visibleStart + piece.visibleEnd + 1;
}

function widestPieceIndex(
  pieces: Array<{ visibleStart: number; visibleEnd: number }>,
  sequenceLength: number
): number {
  let best = 0;
  for (let i = 1; i < pieces.length; i++) {
    if (pieceLength(pieces[i], sequenceLength) > pieceLength(pieces[best], sequenceLength))
      best = i;
  }
  return best;
}

function isCodonVisibleOnLine(
  codonStart: number,
  codonEnd: number,
  lineStartPos: number,
  lineEndPos: number,
  sequenceLength: number
): { visible: boolean; visibleStart: number; visibleEnd: number } {
  const ranges = visibleRangesOnLine(
    codonStart,
    codonEnd,
    lineStartPos,
    lineEndPos,
    sequenceLength
  );
  if (ranges.length === 0) return { visible: false, visibleStart: 0, visibleEnd: 0 };
  const widest = ranges.reduce((best, range) => {
    const bestWidth = best.visibleEnd - best.visibleStart;
    const width = range.visibleEnd - range.visibleStart;
    return width > bestWidth ? range : best;
  });
  return { visible: true, visibleStart: widest.visibleStart, visibleEnd: widest.visibleEnd };
}

function getSplicedCodonsForLine(
  cds: Annotation,
  lineStartPos: number,
  lineEndPos: number,
  fullSequence: string,
  sequenceGeneticCode: GeneticCodeSpec = STANDARD_GENETIC_CODE_ID,
  geneticCodeBasis?: RecordGeneticCodeBasis
): CodonInfo[] {
  const splicedSeq = getCachedSplicedSequence(
    cds,
    fullSequence,
    sequenceGeneticCode,
    geneticCodeBasis
  );
  const read = displayReaderFor(cds, sequenceGeneticCode, geneticCodeBasis);
  const codons: CodonInfo[] = [];
  const sequenceLength = fullSequence.length;
  const { codingSequence, genomicCoordinateMap, codonStartOffset, introns } = splicedSeq;
  const effectiveLength = codingSequence.length - codonStartOffset;
  const numCodons = Math.floor(effectiveLength / 3);

  for (let i = 0; i < numCodons; i++) {
    const codingOffset = codonStartOffset + i * 3;
    const g0 = genomicCoordinateMap[codingOffset];
    const g1 = genomicCoordinateMap[codingOffset + 1];
    const g2 = genomicCoordinateMap[codingOffset + 2];

    const codonStr = codingSequence.slice(codingOffset, codingOffset + 3);
    const reading = read(codonStr, codonPositionOf(g0, g1, g2) + 1);
    const aa = reading.short;
    const residueIndex = i + 1;

    const genomicPositions = [g0, g1, g2];
    const isSplit = isCodonSplitByIntron(genomicPositions, introns, codingOffset);

    if (isSplit) {
      const { prePositions, postPositions } = isSplit;

      const preStart = Math.min(...prePositions);
      const preEnd = Math.max(...prePositions);
      const preVisibility = isCodonVisibleOnLine(
        preStart,
        preEnd,
        lineStartPos,
        lineEndPos,
        sequenceLength
      );
      if (preVisibility.visible) {
        codons.push({
          startPos: preStart,
          endPos: preEnd,
          codon: codonStr,
          aa,
          visibleStart: preVisibility.visibleStart,
          visibleEnd: preVisibility.visibleEnd,
          renderLetter: prePositions.length >= 2,
          residueIndex,
          isPartialPreIntron: true,
        });
      }

      const postStart = Math.min(...postPositions);
      const postEnd = Math.max(...postPositions);
      const postVisibility = isCodonVisibleOnLine(
        postStart,
        postEnd,
        lineStartPos,
        lineEndPos,
        sequenceLength
      );
      if (postVisibility.visible) {
        codons.push({
          startPos: postStart,
          endPos: postEnd,
          codon: codonStr,
          aa,
          visibleStart: postVisibility.visibleStart,
          visibleEnd: postVisibility.visibleEnd,
          renderLetter: postPositions.length >= 2,
          residueIndex,
          isPartialPostIntron: true,
        });
      }
    } else {
      const codonStart = Math.min(g0, g1, g2);
      const codonEnd = Math.max(g0, g1, g2);

      const visibility = isCodonVisibleOnLine(
        codonStart,
        codonEnd,
        lineStartPos,
        lineEndPos,
        sequenceLength
      );
      if (!visibility.visible) continue;

      const visibleNucleotides = visibility.visibleEnd - visibility.visibleStart + 1;
      codons.push({
        startPos: codonStart,
        endPos: codonEnd,
        codon: codonStr,
        aa,
        visibleStart: visibility.visibleStart,
        visibleEnd: visibility.visibleEnd,
        renderLetter: visibleNucleotides >= 2,
        residueIndex,
      });
    }
  }

  return codons;
}

function isCodonSplitByIntron(
  genomicPositions: number[],
  introns: SplicedCodingSequence['introns'],
  codonCodingOffset?: number
): {
  prePositions: number[];
  postPositions: number[];
  intronInfo: SplicedCodingSequence['introns'][0];
} | null {
  for (const intron of introns) {
    if (intron.phase === 0) continue;

    if (codonCodingOffset !== undefined && intron.codingSeqBoundary !== undefined) {
      const boundary = intron.codingSeqBoundary;
      if (codonCodingOffset < boundary && codonCodingOffset + 3 > boundary) {
        const preCount = boundary - codonCodingOffset;
        return {
          prePositions: genomicPositions.slice(0, preCount),
          postPositions: genomicPositions.slice(preCount),
          intronInfo: intron,
        };
      }
      continue;
    }

    const prePositions = genomicPositions.filter((p) => p < intron.genomicStart);
    const postPositions = genomicPositions.filter((p) => p > intron.genomicEnd);

    if (prePositions.length > 0 && postPositions.length > 0) {
      return { prePositions, postPositions, intronInfo: intron };
    }
  }
  return null;
}

export function contiguousCodonRangeForLine(
  cds: Annotation,
  lineStartPos: number,
  lineEndPos: number,
  sequenceLength: number
): { firstStart: number; firstIndex: number; lastIndex: number } | null {
  const cdsStart = cds.start - 1;
  const cdsEnd = cds.end;
  if (
    isSplicedCDS(cds, sequenceLength) ||
    cds.start > cds.end ||
    !Number.isSafeInteger(cdsStart) ||
    !Number.isSafeInteger(cdsEnd) ||
    !Number.isSafeInteger(lineStartPos) ||
    !Number.isSafeInteger(lineEndPos) ||
    cdsStart < 0 ||
    cdsEnd > sequenceLength ||
    lineStartPos < 0 ||
    lineStartPos >= lineEndPos ||
    lineEndPos > sequenceLength
  )
    return null;
  const isReverse = cds.direction === -1;
  const offset = codingFrameOffset(cds);
  const numCodons = Math.floor(Math.max(0, cdsEnd - cdsStart - offset) / 3);
  const firstStart = isReverse ? cdsEnd - offset - 3 : cdsStart + offset;
  return {
    firstStart,
    firstIndex: Math.max(
      0,
      isReverse
        ? Math.ceil((firstStart - lineEndPos + 1) / 3)
        : Math.ceil((lineStartPos - firstStart - 2) / 3)
    ),
    lastIndex: Math.min(
      numCodons - 1,
      isReverse
        ? Math.floor((firstStart + 2 - lineStartPos) / 3)
        : Math.floor((lineEndPos - 1 - firstStart) / 3)
    ),
  };
}

export function getCodonsForSingleCDS(
  cds: Annotation,
  lineStartPos: number,
  lineEndPos: number,
  fullSequence: string,
  sequenceGeneticCode: GeneticCodeSpec = STANDARD_GENETIC_CODE_ID,
  geneticCodeBasis?: RecordGeneticCodeBasis
): CodonInfo[] {
  const read = displayReaderFor(cds, sequenceGeneticCode, geneticCodeBasis);
  if (isSplicedCDS(cds, fullSequence.length)) {
    return getSplicedCodonsForLine(
      cds,
      lineStartPos,
      lineEndPos,
      fullSequence,
      sequenceGeneticCode,
      geneticCodeBasis
    );
  }

  const coding = getCachedSplicedSequence(cds, fullSequence, sequenceGeneticCode, geneticCodeBasis);
  const codons: CodonInfo[] = [];
  const sequenceLength = fullSequence.length;
  const contiguous = contiguousCodonRangeForLine(cds, lineStartPos, lineEndPos, sequenceLength);
  const firstIndex = contiguous?.firstIndex ?? 0;
  const lastIndex = contiguous?.lastIndex ?? coding.proteinLength - 1;
  for (let codonIdx = firstIndex; codonIdx <= lastIndex; codonIdx++) {
    const offset = coding.codonStartOffset + codonIdx * 3;
    const positions = coding.genomicCoordinateMap.slice(offset, offset + 3);
    const codonStart = positions[cds.direction === -1 ? 2 : 0];
    const codonEnd = codonStart + 2;
    const pieces = visibleRangesOnLine(
      codonStart,
      codonEnd,
      lineStartPos,
      lineEndPos,
      sequenceLength
    );
    if (!pieces.length) continue;
    const codon = coding.codingSequence.slice(offset, offset + 3);
    const reading = read(codon, codonPositionOf(positions[0], positions[1], positions[2]) + 1);
    const widest = widestPieceIndex(pieces, sequenceLength);
    pieces.forEach((piece, pieceIdx) => {
      codons.push({
        startPos: codonStart,
        endPos: codonEnd % sequenceLength,
        codon,
        aa: reading.short,
        display: reading,
        visibleStart: piece.visibleStart,
        visibleEnd: piece.visibleEnd,
        renderLetter: pieceIdx === widest && pieceLength(piece, sequenceLength) >= 2,
        residueIndex: codonIdx + 1,
      });
    });
  }
  return codons;
}

export function getCodonsForLine(
  sequence: string,
  annotations: Annotation[],
  lineStartPos: number,
  lineEndPos: number,
  fullSequence: string,
  sequenceGeneticCode: GeneticCodeSpec = STANDARD_GENETIC_CODE_ID,
  geneticCodeBasis?: RecordGeneticCodeBasis
): CodonInfo[] {
  const codons: CodonInfo[] = [];
  const cdsAnnotations = annotations.filter((ann) => ann.type === 'CDS');

  cdsAnnotations.forEach((cds) => {
    const cdsCodens = getCodonsForSingleCDS(
      cds,
      lineStartPos,
      lineEndPos,
      fullSequence,
      sequenceGeneticCode,
      geneticCodeBasis
    );
    codons.push(...cdsCodens);
  });

  return codons;
}

export function getDraftCodonsForCDS(
  cds: Annotation,
  fullSequence: string,
  insertedRanges: readonly InsertedRange[],
  deletedRanges: readonly DeletedRange[],
  lineStartPos: number,
  lineEndPos: number,
  sequenceGeneticCode: GeneticCodeSpec = STANDARD_GENETIC_CODE_ID,
  geneticCodeBasis?: RecordGeneticCodeBasis
): { draftCodons: DraftCodonInfo[]; originalCodons: CodonInfo[] } {
  const geneticCode = resolveAnnotationGeneticCode(cds, sequenceGeneticCode, geneticCodeBasis);
  const read = codonReaderFor(cds, sequenceGeneticCode, geneticCodeBasis);
  const draftPositions = draftPositionMap(insertedRanges);
  const cdsStart = cds.start - 1;
  const cdsEnd = cds.end;
  const isReverse = cds.direction === -1;

  const cdsDeletedRanges = deletedRanges
    .filter((range) => range.start < cdsEnd && range.end > cdsStart)
    .map((range) => ({
      start: Math.max(range.start, cdsStart),
      end: Math.min(range.end, cdsEnd),
    }))
    .sort((a, b) => a.start - b.start);

  const cdsInsertedRanges = insertedRanges.filter(
    (range) => range.start < cdsEnd && range.end > cdsStart
  );

  let effectiveSequence = '';
  const effectiveToVisualMap: number[] = [];

  for (let i = cdsStart; i < cdsEnd; i++) {
    if (!isPositionDeleted(i, deletedRanges)) {
      effectiveToVisualMap.push(i);
      effectiveSequence += fullSequence[i];
    }
  }

  const originalCodons: CodonInfo[] = [];
  const originalCdsLength = cdsEnd - cdsStart;

  if (isReverse) {
    const numOrigCodons = Math.floor(originalCdsLength / 3);
    for (let codonIdx = 0; codonIdx < numOrigCodons; codonIdx++) {
      const codonStart = cdsEnd - (codonIdx + 1) * 3;
      const codonEnd = codonStart + 2;

      if (codonEnd < lineStartPos || codonStart >= lineEndPos) continue;
      if (codonStart >= lineStartPos && codonEnd < lineEndPos) {
        const genomicCodon = fullSequence.substring(codonStart, codonStart + 3);
        if (genomicCodon.length === 3) {
          const codingCodon = reverseComplement(genomicCodon);
          const reading = read(codingCodon, codonStart + 1);
          originalCodons.push({
            startPos: codonStart,
            endPos: codonEnd,
            codon: codingCodon,
            aa: reading.short,
            display: reading,
            visibleStart: codonStart,
            visibleEnd: codonEnd,
            renderLetter: true,
          });
        }
      }
    }
  } else {
    for (let pos = cdsStart; pos < cdsEnd - 2; pos += 3) {
      const codonStart = pos;
      const codonEnd = pos + 2;

      if (codonEnd < lineStartPos || codonStart >= lineEndPos) continue;
      if (codonStart >= lineStartPos && codonEnd < lineEndPos) {
        const codon = fullSequence.substring(codonStart, codonStart + 3);
        if (codon.length === 3) {
          const reading = read(codon, codonStart + 1);
          originalCodons.push({
            startPos: codonStart,
            endPos: codonEnd,
            codon,
            aa: reading.short,
            display: reading,
            visibleStart: codonStart,
            visibleEnd: codonEnd,
            renderLetter: true,
          });
        }
      }
    }
  }

  const draftCodons: DraftCodonInfo[] = [];
  const effectiveLength = effectiveSequence.length;

  if (effectiveLength < 3) {
    return { draftCodons: [], originalCodons };
  }

  const getFrameShift = (visualPos: number, forward: boolean): number => {
    let insertions = 0;
    let deletions = 0;

    for (const range of cdsInsertedRanges) {
      if (forward ? range.end <= visualPos : range.start >= visualPos) {
        insertions += range.end - range.start;
      } else if (forward ? range.start < visualPos : range.end > visualPos) {
        insertions += forward ? visualPos - range.start : range.end - visualPos;
      }
    }

    for (const range of cdsDeletedRanges) {
      if (forward ? range.end <= visualPos : range.start >= visualPos) {
        deletions += range.end - range.start;
      } else if (forward ? range.start < visualPos : range.end > visualPos) {
        deletions += forward ? visualPos - range.start : range.end - visualPos;
      }
    }

    return insertions - deletions;
  };

  const processCodon = (effectivePos: number, codonIdx: number) => {
    const effectiveCodonStart = isReverse ? effectiveLength - (codonIdx + 1) * 3 : effectivePos;
    const effectiveCodonEnd = effectiveCodonStart + 2;

    if (effectiveCodonEnd >= effectiveLength) return;

    const visualPos0 = effectiveToVisualMap[effectiveCodonStart];
    const visualPos1 = effectiveToVisualMap[effectiveCodonStart + 1];
    const visualPos2 = effectiveToVisualMap[effectiveCodonEnd];

    const visualCodonStart = Math.min(visualPos0, visualPos1, visualPos2);
    const visualCodonEnd = Math.max(visualPos0, visualPos1, visualPos2);

    if (visualCodonStart < lineStartPos || visualCodonEnd >= lineEndPos) return;

    const effectiveCodon = effectiveSequence.substring(
      effectiveCodonStart,
      effectiveCodonStart + 3
    );
    if (effectiveCodon.length !== 3) return;

    const codingCodon = isReverse ? reverseComplement(effectiveCodon) : effectiveCodon;
    const originalCodonStart = draftPositions.originalCodonPositionOf(
      visualPos0,
      visualPos1,
      visualPos2
    );
    const aa =
      originalCodonStart === null
        ? codonDisplay(codingCodon, geneticCode).short
        : read(codingCodon, originalCodonStart + 1).short;

    let status: DraftCodonInfo['status'] = 'normal';
    let originalAa: string | undefined;

    const isCleanInsertion = cdsInsertedRanges.some(
      (range) => range.start <= visualCodonStart && range.end > visualCodonEnd
    );

    const hasPartialInsertion =
      !isCleanInsertion &&
      cdsInsertedRanges.some(
        (range) => range.start <= visualCodonEnd && range.end > visualCodonStart
      );

    const spansDeleted = visualCodonEnd - visualCodonStart > 2;

    if (isCleanInsertion) {
      status = 'inserted';
    } else if (spansDeleted || hasPartialInsertion) {
      status = 'frameshifted';
      const origCodon = originalCodons.find(
        (c) => c.startPos <= visualCodonStart && c.endPos >= visualCodonStart
      );
      if (origCodon && origCodon.aa !== aa) {
        originalAa = origCodon.aa;
      }
    } else {
      const checkPos = isReverse ? visualCodonEnd + 1 : visualCodonEnd + 1;
      const shift = getFrameShift(checkPos, !isReverse);
      if (shift % 3 !== 0) {
        status = 'frameshifted';
        const origCodon = originalCodons.find(
          (c) => c.startPos <= visualCodonStart && c.endPos >= visualCodonStart
        );
        if (origCodon && origCodon.aa !== aa) {
          originalAa = origCodon.aa;
        }
      }
    }

    draftCodons.push({
      visualStartPos: visualCodonStart,
      visualEndPos: visualCodonEnd,
      effectiveStartPos: effectiveCodonStart,
      codon: codingCodon,
      aa,
      status,
      originalAa,
    });
  };

  const numCodons = Math.floor(effectiveLength / 3);
  for (let i = 0; i < numCodons; i++) {
    processCodon(isReverse ? 0 : i * 3, i);
  }

  return { draftCodons, originalCodons };
}

export function getDeletedCodons(
  originalCodons: CodonInfo[],
  draftCodons: DraftCodonInfo[],
  deletedRanges: DeletedRange[]
): CodonInfo[] {
  return originalCodons.filter((orig) => {
    const overlapsDelete = deletedRanges.some(
      (range) => range.start <= orig.endPos && range.end > orig.startPos
    );
    if (!overlapsDelete) return false;

    const hasDraftAtSamePos = draftCodons.some((draft) => draft.visualStartPos === orig.startPos);

    return !hasDraftAtSamePos;
  });
}

export function getFrameshiftRanges(
  annotations: Annotation[],
  insertedRanges: InsertedRange[]
): InsertedRange[] {
  const frameshiftRanges: InsertedRange[] = [];
  const cdsAnnotations = annotations.filter((ann) => ann.type === 'CDS');

  for (const cds of cdsAnnotations) {
    const cdsStart = cds.start - 1;
    const cdsEnd = cds.end;
    const isReverse = cds.direction === -1;

    for (const insertion of insertedRanges) {
      const insertionLength = insertion.end - insertion.start;

      if (insertion.start >= cdsStart && insertion.start < cdsEnd) {
        if (insertionLength % 3 !== 0) {
          if (isReverse) {
            const frameshiftStart = cdsStart;
            const frameshiftEnd = insertion.start;
            if (frameshiftEnd > frameshiftStart) {
              frameshiftRanges.push({ start: frameshiftStart, end: frameshiftEnd });
            }
          } else {
            const frameshiftStart = insertion.end;
            const frameshiftEnd = cdsEnd;
            if (frameshiftEnd > frameshiftStart) {
              frameshiftRanges.push({ start: frameshiftStart, end: frameshiftEnd });
            }
          }
        }
      }
    }
  }

  return frameshiftRanges;
}
