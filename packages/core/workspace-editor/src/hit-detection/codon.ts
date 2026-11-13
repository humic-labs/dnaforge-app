import { cdsPresentationGeometry } from '../cds-presentation';

import type { ClassifiedCDS, Layout2DRow, ORFWithLane } from '../types';
import { TRANSLATION_AA_HEIGHT_RATIO } from '../layout-constants';
import { ORF_LANE_GAP } from '../orf-drawing';
import { getAlignmentCodonsForCDS } from '../translation/codon-calculator';
import { isSplicedCDS } from '../translation';
import { findSplicedCodonWithIndexAtPosition, orderedCdsSegments } from './spliced-cds';
import type {
  HitDetectionConfig,
  LineTrackBounds,
  HitTargetCodon,
  AlignmentModeHitOptions,
} from './types';

function codonHitFromRange(
  start: number,
  end: number,
  strand: 1 | -1,
  residueIndex: number
): HitTargetCodon {
  return { type: 'codon', start, end, strand, isOverlayClick: false, residueIndex };
}

function admitCodonHitClick(args: {
  mouseX: number;
  contentY: number;
  line: Layout2DRow;
  bounds: LineTrackBounds;
  config: HitDetectionConfig;
}): { cdsAnnotations: ClassifiedCDS[]; posInLine: number } | null {
  if (!args.config.showTranslation || args.bounds.translationHeight === 0) {
    return null;
  }
  const cdsAnnotations = args.line.classifiedCDSs || [];
  if (cdsAnnotations.length === 0) {
    return null;
  }
  const relativeY = args.contentY - args.line.y;
  const posInLine = Math.floor((args.mouseX - args.config.marginLeft) / args.config.charWidth);
  if (posInLine < 0 || posInLine >= args.line.sequence.length) return null;
  const laneAnnotations = cdsAnnotations.filter((cds) => {
    if (cds.translationLane < 0) return false;
    const pose = cdsPresentationGeometry(
      cds,
      args.bounds.translationY,
      args.bounds.annotationY,
      args.config
    );
    return (
      !(args.config.cdsZoomPresentation && pose.colorAlpha <= 0) &&
      pose.aaHeight > 0 &&
      relativeY >= pose.aaY &&
      relativeY <= pose.aaY + pose.aaHeight
    );
  });
  return laneAnnotations.length ? { cdsAnnotations: laneAnnotations, posInLine } : null;
}

function alignmentCodonHitForCds(
  cds: ClassifiedCDS,
  clickedColumn: number,
  alignmentMode: AlignmentModeHitOptions,
  line: Layout2DRow
): HitTargetCodon | null {
  const strand = (cds.direction ?? 1) as 1 | -1;
  const alignmentCodons = getAlignmentCodonsForCDS(
    alignmentMode.alignedRef,
    alignmentMode.alignedQuery,
    cds,
    line.startPos,
    line.endPos
  );
  if (alignmentCodons.length === 0) return null;
  let cdsMinColumn = Infinity;
  let cdsMaxColumn = -1;
  for (const codon of alignmentCodons) {
    cdsMinColumn = Math.min(cdsMinColumn, codon.columnStart);
    cdsMaxColumn = Math.max(cdsMaxColumn, codon.columnEnd);
  }
  if (clickedColumn < cdsMinColumn || clickedColumn > cdsMaxColumn) {
    return null;
  }
  for (const codon of alignmentCodons) {
    if (clickedColumn >= codon.columnStart && clickedColumn <= codon.columnEnd) {
      return codonHitFromRange(codon.columnStart, codon.columnEnd, strand, codon.codonIndex + 1);
    }
  }
  return null;
}

function alignmentModeCodonHit(
  cdsAnnotations: readonly ClassifiedCDS[],
  line: Layout2DRow,
  posInLine: number,
  alignmentMode: AlignmentModeHitOptions
): HitTargetCodon | null {
  const clickedColumn = line.startPos + posInLine;
  for (const cds of cdsAnnotations) {
    const hit = alignmentCodonHitForCds(cds, clickedColumn, alignmentMode, line);
    if (hit) return hit;
  }
  return null;
}

function seqPosForLineClick(line: Layout2DRow, posInLine: number): number {
  if (line.preOriginLength !== undefined && posInLine >= line.preOriginLength) {
    return posInLine - line.preOriginLength;
  }
  return line.startPos + posInLine;
}

function contiguousForwardCodonRange(
  seqPos: number,
  cdsStart: number,
  cdsEnd: number
): { codonStart: number; codonEnd: number; codonIndex: number } {
  const posInCds = seqPos - cdsStart;
  const codonIndex = Math.floor(posInCds / 3);
  const codonStart = cdsStart + codonIndex * 3;
  const codonEnd = Math.min(codonStart + 2, cdsEnd - 1);
  return { codonStart, codonEnd, codonIndex };
}

function contiguousReverseCodonRange(
  seqPos: number,
  cdsStart: number,
  cdsEnd: number
): { codonStart: number; codonEnd: number; codonIndex: number } {
  const posFromEnd = cdsEnd - 1 - seqPos;
  const codonIndex = Math.floor(posFromEnd / 3);
  const codonEnd = cdsEnd - 1 - codonIndex * 3;
  const codonStart = Math.max(codonEnd - 2, cdsStart);
  return { codonStart, codonEnd, codonIndex };
}

function originSpanningForwardCodonRange(args: {
  seqPos: number;
  cdsStart: number;
  seqLen: number;
  cdsEnd: number;
  inFirstSegment: boolean;
  firstSegmentLen: number;
}): { codonStart: number; codonEnd: number; codonIndex: number } {
  const posInCds = args.inFirstSegment
    ? args.seqPos - args.cdsStart
    : args.firstSegmentLen + args.seqPos;
  const codonIndex = Math.floor(posInCds / 3);
  const codonStartInCds = codonIndex * 3;
  if (codonStartInCds < args.firstSegmentLen) {
    const codonStart = args.cdsStart + codonStartInCds;
    const codonEndInCds = codonStartInCds + 2;
    const codonEnd =
      codonEndInCds < args.firstSegmentLen
        ? args.cdsStart + codonEndInCds
        : codonEndInCds - args.firstSegmentLen;
    return { codonStart, codonEnd, codonIndex };
  }
  return {
    codonStart: codonStartInCds - args.firstSegmentLen,
    codonEnd: Math.min(codonStartInCds - args.firstSegmentLen + 2, args.cdsEnd - 1),
    codonIndex,
  };
}

function originSpanningReverseCodonRange(args: {
  seqPos: number;
  cdsStart: number;
  seqLen: number;
  cdsEnd: number;
  inSecondSegment: boolean;
  secondSegmentLen: number;
}): { codonStart: number; codonEnd: number; codonIndex: number } {
  const posFromEnd = args.inSecondSegment
    ? args.cdsEnd - 1 - args.seqPos
    : args.secondSegmentLen + (args.seqLen - 1 - args.seqPos);
  const codonIndex = Math.floor(posFromEnd / 3);
  const codonEndInCds = codonIndex * 3;
  if (codonEndInCds < args.secondSegmentLen) {
    const codonEnd = args.cdsEnd - 1 - codonEndInCds;
    const codonStartInCds = codonEndInCds + 2;
    const codonStart =
      codonStartInCds < args.secondSegmentLen
        ? args.cdsEnd - 1 - codonStartInCds
        : args.seqLen - 1 - (codonStartInCds - args.secondSegmentLen);
    return { codonStart, codonEnd, codonIndex };
  }
  const codonEnd = args.seqLen - 1 - (codonEndInCds - args.secondSegmentLen);
  let codonStart = Math.max(codonEnd - 2, args.cdsStart);
  if (codonStart < args.cdsStart && codonEnd >= args.cdsStart) {
    codonStart = args.cdsStart;
  }
  return { codonStart, codonEnd, codonIndex };
}

function splicedCodonHitAtPosition(
  seqPos: number,
  cds: ClassifiedCDS,
  strand: 1 | -1
): HitTargetCodon | null {
  const segments = orderedCdsSegments(cds);
  const codonStart = Number.parseInt(cds.qualifiers?.codon_start?.[0] ?? '1', 10);
  const codon = findSplicedCodonWithIndexAtPosition(seqPos, segments, {
    strand,
    codonStartOffset: Number.isFinite(codonStart) ? Math.max(0, codonStart - 1) : 0,
  });
  if (!codon) return null;
  return codonHitFromRange(codon.start, codon.end, strand, codon.codonIndex + 1);
}

function originSpanningCdsCodonHit(
  cds: ClassifiedCDS,
  seqPos: number,
  seqLen: number,
  cdsStart: number,
  cdsEnd: number,
  strand: 1 | -1
): HitTargetCodon | null {
  const inFirstSegment = seqPos >= cdsStart && seqPos < seqLen;
  const inSecondSegment = seqPos >= 0 && seqPos < cdsEnd;
  if (!(inFirstSegment || inSecondSegment)) return null;
  if (isSplicedCDS(cds, seqLen)) {
    return splicedCodonHitAtPosition(seqPos, cds, strand);
  }
  const firstSegmentLen = seqLen - cdsStart;
  const secondSegmentLen = cdsEnd;
  const range =
    strand === 1
      ? originSpanningForwardCodonRange({
          seqPos,
          cdsStart,
          seqLen,
          cdsEnd,
          inFirstSegment,
          firstSegmentLen,
        })
      : originSpanningReverseCodonRange({
          seqPos,
          cdsStart,
          seqLen,
          cdsEnd,
          inSecondSegment,
          secondSegmentLen,
        });
  return codonHitFromRange(range.codonStart, range.codonEnd, strand, range.codonIndex + 1);
}

function linearCdsCodonHit(
  cds: ClassifiedCDS,
  seqPos: number,
  cdsStart: number,
  cdsEnd: number,
  strand: 1 | -1
): HitTargetCodon | null {
  if (!(seqPos >= cdsStart && seqPos < cdsEnd)) return null;
  if (isSplicedCDS(cds)) {
    return splicedCodonHitAtPosition(seqPos, cds, strand);
  }
  const range =
    strand === 1
      ? contiguousForwardCodonRange(seqPos, cdsStart, cdsEnd)
      : contiguousReverseCodonRange(seqPos, cdsStart, cdsEnd);
  return codonHitFromRange(range.codonStart, range.codonEnd, strand, range.codonIndex + 1);
}

function codonHitForCds(cds: ClassifiedCDS, seqPos: number, seqLen: number): HitTargetCodon | null {
  const cdsStart = cds.start - 1;
  const cdsEnd = cds.end;
  const strand = (cds.direction ?? 1) as 1 | -1;
  if (cds.start > cds.end) {
    return originSpanningCdsCodonHit(cds, seqPos, seqLen, cdsStart, cdsEnd, strand);
  }
  return linearCdsCodonHit(cds, seqPos, cdsStart, cdsEnd, strand);
}

export function detectCodonHit(
  mouseX: number,
  contentY: number,
  line: Layout2DRow,
  bounds: LineTrackBounds,
  config: HitDetectionConfig,
  seqLen: number,
  alignmentMode?: AlignmentModeHitOptions
): HitTargetCodon | null {
  const admitted = admitCodonHitClick({ mouseX, contentY, line, bounds, config });
  if (!admitted) return null;
  if (alignmentMode) {
    return alignmentModeCodonHit(admitted.cdsAnnotations, line, admitted.posInLine, alignmentMode);
  }
  const seqPos = seqPosForLineClick(line, admitted.posInLine);
  for (const cds of admitted.cdsAnnotations) {
    const hit = codonHitForCds(cds, seqPos, seqLen);
    if (hit) return hit;
  }
  return null;
}

type OrfCodonHit = HitTargetCodon & { parentStart: number; parentEnd: number };

function admitOrfCodonHitClick(args: {
  mouseX: number;
  contentY: number;
  orfTrackY: number;
  orfTrackHeight: number;
  orfs: ORFWithLane[];
  line: Layout2DRow;
  config: HitDetectionConfig;
}): { clickedLane: number; posInLine: number } | null {
  if (args.orfs.length === 0 || args.orfTrackHeight === 0) return null;
  if (args.contentY < args.orfTrackY || args.contentY > args.orfTrackY + args.orfTrackHeight) {
    return null;
  }
  const laneHeight = args.config.rowHeight * TRANSLATION_AA_HEIGHT_RATIO;
  const laneStep = laneHeight + ORF_LANE_GAP;
  const relativeY = args.contentY - args.orfTrackY;
  const clickedLane = Math.floor(relativeY / laneStep);
  if (relativeY - clickedLane * laneStep > laneHeight) return null;
  const posInLine = Math.floor((args.mouseX - args.config.marginLeft) / args.config.charWidth);
  if (posInLine < 0 || posInLine >= args.line.sequence.length) return null;
  return { clickedLane, posInLine };
}

function alignmentModeOrfCodonHit(
  orfs: ORFWithLane[],
  clickedLane: number,
  line: Layout2DRow,
  posInLine: number,
  alignmentMode: AlignmentModeHitOptions
): OrfCodonHit | null {
  const clickedColumn = line.startPos + posInLine;
  for (const orf of orfs) {
    if (orf.lane !== clickedLane) continue;
    const strand = (orf.strand === '+' ? 1 : -1) as 1 | -1;
    const tempAnnotation = {
      name: '',
      type: 'CDS' as const,
      start: orf.start + 1,
      end: orf.end + 1,
      direction: strand,
      color: '',
    };
    const alignmentCodons = getAlignmentCodonsForCDS(
      alignmentMode.alignedRef,
      alignmentMode.alignedQuery,
      tempAnnotation,
      line.startPos,
      line.endPos
    );
    if (alignmentCodons.length === 0) continue;
    let orfMinColumn = Infinity;
    let orfMaxColumn = -1;
    for (const codon of alignmentCodons) {
      orfMinColumn = Math.min(orfMinColumn, codon.columnStart);
      orfMaxColumn = Math.max(orfMaxColumn, codon.columnEnd);
    }
    if (clickedColumn < orfMinColumn || clickedColumn > orfMaxColumn) {
      continue;
    }
    for (const codon of alignmentCodons) {
      if (clickedColumn >= codon.columnStart && clickedColumn <= codon.columnEnd) {
        return {
          ...codonHitFromRange(codon.columnStart, codon.columnEnd, strand, codon.codonIndex + 1),
          parentStart: orf.start,
          parentEnd: orf.end,
        };
      }
    }
  }
  return null;
}

function linearOrfCodonHit(orf: ORFWithLane, seqPos: number): OrfCodonHit | null {
  if (seqPos < orf.start || seqPos > orf.end) return null;
  const strand = (orf.strand === '+' ? 1 : -1) as 1 | -1;
  const cdsStart = orf.start;
  const cdsEnd = orf.end + 1;
  const range =
    strand === 1
      ? contiguousForwardCodonRange(seqPos, cdsStart, cdsEnd)
      : contiguousReverseCodonRange(seqPos, cdsStart, cdsEnd);
  return {
    ...codonHitFromRange(range.codonStart, range.codonEnd, strand, range.codonIndex + 1),
    parentStart: orf.start,
    parentEnd: orf.end,
  };
}

export function detectOrfCodonHit(
  mouseX: number,
  contentY: number,
  orfTrackY: number,
  orfTrackHeight: number,
  orfs: ORFWithLane[],
  line: Layout2DRow,
  config: HitDetectionConfig,
  alignmentMode?: AlignmentModeHitOptions
): OrfCodonHit | null {
  const admitted = admitOrfCodonHitClick({
    mouseX,
    contentY,
    orfTrackY,
    orfTrackHeight,
    orfs,
    line,
    config,
  });
  if (!admitted) return null;
  if (alignmentMode) {
    return alignmentModeOrfCodonHit(
      orfs,
      admitted.clickedLane,
      line,
      admitted.posInLine,
      alignmentMode
    );
  }
  const seqPos = seqPosForLineClick(line, admitted.posInLine);
  for (const orf of orfs) {
    if (orf.lane !== admitted.clickedLane) continue;
    const hit = linearOrfCodonHit(orf, seqPos);
    if (hit) return hit;
  }
  return null;
}
