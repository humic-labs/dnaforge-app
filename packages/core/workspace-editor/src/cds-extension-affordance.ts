import type { SequenceDrawingContext } from './rendering/drawing-context';

import {
  cdsEndsInStopCodon,
  cdsStartsOnStartCodon,
  extendCdsFivePrime,
  extendCdsThreePrime,
  type CdsExtensionDirection,
} from '@waypoint/sequence-utils';
import type { CodonCellRenderData } from './codon-rendering';

const ARROW_GAP_PX = 3;
const ARROW_WIDTH_PX = 12;
const ARROW_HEIGHT_PX = 9;
const ARROW_HIT_PADDING_PX = 4;

export function positionWithinCdsBounds(
  bounds: { start: number; end: number },
  position0: number
): boolean {
  const start0 = bounds.start - 1;
  const end0 = bounds.end - 1;
  return start0 <= end0
    ? position0 >= start0 && position0 <= end0
    : position0 >= start0 || position0 <= end0;
}

export function positionWithinLine(
  lineStartPos: number,
  lineEndPos: number,
  position0: number
): boolean {
  return lineStartPos <= lineEndPos
    ? position0 >= lineStartPos && position0 < lineEndPos
    : position0 >= lineStartPos || position0 < lineEndPos;
}

export function cdsBoundsSpan(
  bounds: { start: number; end: number },
  sequenceLength: number
): number {
  const start0 = bounds.start - 1;
  const end0 = bounds.end - 1;
  return start0 <= end0 ? end0 - start0 + 1 : sequenceLength - start0 + end0 + 1;
}

function wrapPosition(position0: number, sequenceLength: number): number {
  return ((position0 % sequenceLength) + sequenceLength) % sequenceLength;
}
const ARROW_HEAD_LENGTH_PX = 5;
const ARROW_SHAFT_THICKNESS_PX = 2;

const ARROW_FILL_LIGHT = 'rgba(107, 114, 128, 0.55)';
const ARROW_FILL_DARK = 'rgba(156, 163, 175, 0.55)';
const ARROW_FILL_HOVER_LIGHT = 'rgba(55, 65, 81, 0.9)';
const ARROW_FILL_HOVER_DARK = 'rgba(209, 213, 219, 0.9)';

export type CdsExtensionArrowKind = 'extend' | 'undo';

export interface CdsExtensionArrowId {
  cdsKey: string;
  direction: CdsExtensionDirection;
  kind: CdsExtensionArrowKind;
}

export interface CdsExtensionArrowBounds extends CdsExtensionArrowId {
  x: number;
  y: number;
  width: number;
  height: number;
  pointsRight: boolean;
  anchorBp: number;
}

export interface CdsExtensionGeometryInput {
  start: number;
  end: number;
  direction: 1 | -1;
  codonStart?: 1 | 2 | 3;
  geneticCode?: number;
}

export function incompleteCdsEnds(
  cds: CdsExtensionGeometryInput,
  sequence: string,
  circular: boolean
): CdsExtensionDirection[] {
  const input = {
    start: cds.start,
    end: cds.end,
    strand: cds.direction === -1 ? ('reverse' as const) : ('forward' as const),
    codonStart: cds.codonStart,
    geneticCode: cds.geneticCode,
  };
  const ends: CdsExtensionDirection[] = [];
  const usable = (extension: { addedBases: number } | null): boolean => {
    if (extension === null || extension.addedBases <= 0) return false;
    if (!circular) return true;
    const span =
      cds.end >= cds.start ? cds.end - cds.start + 1 : sequence.length - cds.start + cds.end + 1;
    return span + extension.addedBases < sequence.length;
  };
  if (
    !cdsStartsOnStartCodon(input, sequence, { circular }) &&
    usable(extendCdsFivePrime(input, sequence, { circular }))
  ) {
    ends.push('five-prime');
  }
  if (
    !cdsEndsInStopCodon(input, sequence, { circular }) &&
    usable(extendCdsThreePrime(input, sequence, { circular }))
  ) {
    ends.push('three-prime');
  }
  return ends;
}

export function extensionRangeFor(
  cds: CdsExtensionGeometryInput,
  sequence: string,
  circular: boolean,
  direction: CdsExtensionDirection
): { start: number; end: number; openEnded: boolean; addedBases: number } | null {
  const input = {
    start: cds.start,
    end: cds.end,
    strand: cds.direction === -1 ? ('reverse' as const) : ('forward' as const),
    codonStart: cds.codonStart,
    geneticCode: cds.geneticCode,
  };
  const extension =
    direction === 'three-prime'
      ? extendCdsThreePrime(input, sequence, { circular })
      : extendCdsFivePrime(input, sequence, { circular });
  if (!extension) return null;
  return {
    start: extension.start,
    end: extension.end,
    openEnded: extension.openEnded,
    addedBases: extension.addedBases,
  };
}

export function arrowRectForEnd(
  cells: readonly CodonCellRenderData[],
  cdsDirection: 1 | -1,
  direction: CdsExtensionDirection,
  laneY: number,
  laneHeight: number,
  endGenomicPosition: number,
  lineStartPos: number,
  lineEndPos: number,
  maxRightX?: number
): { x: number; y: number; width: number; height: number } | null {
  if (cells.length === 0) return null;

  if (!positionWithinLine(lineStartPos, lineEndPos, endGenomicPosition)) return null;

  const pointsRight = direction === 'three-prime' ? cdsDirection === 1 : cdsDirection === -1;
  const anchor = cells.reduce((best, cell) =>
    pointsRight
      ? cell.codonX > best.codonX
        ? cell
        : best
      : cell.codonX < best.codonX
        ? cell
        : best
  );

  const unclampedX = pointsRight
    ? anchor.codonX + anchor.visibleWidth + ARROW_GAP_PX
    : anchor.codonX - ARROW_GAP_PX - ARROW_WIDTH_PX;
  const x =
    maxRightX !== undefined && unclampedX + ARROW_WIDTH_PX > maxRightX
      ? maxRightX - ARROW_WIDTH_PX
      : unclampedX;

  return {
    x,
    y: laneY + (laneHeight - ARROW_HEIGHT_PX) / 2,
    width: ARROW_WIDTH_PX,
    height: ARROW_HEIGHT_PX,
  };
}

export function arrowHitTest(
  bounds: readonly CdsExtensionArrowBounds[],
  pointX: number,
  pointY: number
): CdsExtensionArrowBounds | null {
  for (const b of bounds) {
    if (
      pointX >= b.x - ARROW_HIT_PADDING_PX &&
      pointX <= b.x + b.width + ARROW_HIT_PADDING_PX &&
      pointY >= b.y - ARROW_HIT_PADDING_PX &&
      pointY <= b.y + b.height + ARROW_HIT_PADDING_PX
    ) {
      return b;
    }
  }
  return null;
}

export function drawCdsExtensionArrow(
  ctx: SequenceDrawingContext,
  rect: { x: number; y: number; width: number; height: number },
  pointsRight: boolean,
  isDark: boolean,
  isHovered: boolean
): void {
  ctx.save();
  ctx.fillStyle = isHovered
    ? isDark
      ? ARROW_FILL_HOVER_DARK
      : ARROW_FILL_HOVER_LIGHT
    : isDark
      ? ARROW_FILL_DARK
      : ARROW_FILL_LIGHT;

  const headLength = Math.min(ARROW_HEAD_LENGTH_PX, rect.width);
  const shaftLength = Math.max(0, rect.width - headLength);
  const midY = rect.y + rect.height / 2;
  const shaftTop = midY - ARROW_SHAFT_THICKNESS_PX / 2;
  const shaftBottom = midY + ARROW_SHAFT_THICKNESS_PX / 2;
  const tipX = pointsRight ? rect.x + rect.width : rect.x;
  const headBaseX = pointsRight ? rect.x + shaftLength : rect.x + headLength;
  const shaftEndX = pointsRight ? rect.x : rect.x + rect.width;

  ctx.beginPath();
  ctx.moveTo(tipX, midY);
  ctx.lineTo(headBaseX, rect.y);
  ctx.lineTo(headBaseX, shaftTop);
  ctx.lineTo(shaftEndX, shaftTop);
  ctx.lineTo(shaftEndX, shaftBottom);
  ctx.lineTo(headBaseX, shaftBottom);
  ctx.lineTo(headBaseX, rect.y + rect.height);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

export function cdsExtensionKeyFor(cds: {
  name?: string;
  type?: string;
  start: number;
  end: number;
}): string {
  return `${cds.name ?? ''}|${cds.type ?? ''}|${cds.start}|${cds.end}`;
}

export const CDS_EXTENSION_ORIGINAL_QUALIFIER = '_cds_extension_original';

export const CDS_EXTENSION_DIRECTION_QUALIFIER = '_cds_extension_direction';

export const CDS_EXTENSION_HOVER_QUALIFIER = '_cds_extension_hover';

export interface CdsExtensionOriginalBounds {
  start: number;
  end: number;
}

export function cdsExtensionOriginalBounds(annotation: {
  qualifiers?: Record<string, string[]>;
}): CdsExtensionOriginalBounds | null {
  const raw = annotation.qualifiers?.[CDS_EXTENSION_ORIGINAL_QUALIFIER]?.[0];
  if (!raw) return null;
  const [a, b] = raw.split('..');
  const start = Number.parseInt(a ?? '', 10);
  const end = Number.parseInt(b ?? '', 10);
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  return { start, end };
}

export function isCdsExtensionPreview(annotation: {
  qualifiers?: Record<string, string[]>;
}): boolean {
  return cdsExtensionOriginalBounds(annotation) !== null;
}

export function cdsExtensionPreviewEnds(annotation: {
  qualifiers?: Record<string, string[]>;
}): CdsExtensionDirection[] {
  return readEnds(annotation.qualifiers?.[CDS_EXTENSION_DIRECTION_QUALIFIER]);
}

export function cdsExtensionHoveredEnds(annotation: {
  qualifiers?: Record<string, string[]>;
}): CdsExtensionDirection[] {
  return readEnds(annotation.qualifiers?.[CDS_EXTENSION_HOVER_QUALIFIER]);
}

function readEnds(raw: readonly string[] | undefined): CdsExtensionDirection[] {
  const ends: CdsExtensionDirection[] = [];
  for (const value of raw ?? []) {
    if ((value === 'five-prime' || value === 'three-prime') && !ends.includes(value)) {
      ends.push(value);
    }
  }
  return ends;
}

export function cdsExtensionPreviewDirection(annotation: {
  qualifiers?: Record<string, string[]>;
}): CdsExtensionDirection | null {
  const ends = [
    ...cdsExtensionPreviewEnds(annotation),
    ...cdsExtensionHoveredEnds(annotation).filter(
      (end) => !cdsExtensionPreviewEnds(annotation).includes(end)
    ),
  ];
  return ends.length === 1 ? ends[0]! : null;
}

export function buildExtendedCdsPreview<
  T extends {
    name?: string;
    type?: string;
    start: number;
    end: number;
    direction?: number;
    qualifiers?: Record<string, string[]>;
  },
>(parent: T, sequence: string, direction: CdsExtensionDirection, circular = false): T | null {
  return buildExtendedCdsPreviewForEnds(parent, sequence, { hovered: [direction], circular });
}

export function buildExtendedCdsPreviewForEnds<
  T extends {
    name?: string;
    type?: string;
    start: number;
    end: number;
    direction?: number;
    qualifiers?: Record<string, string[]>;
  },
>(
  parent: T,
  sequence: string,
  grown: {
    drafted?: readonly CdsExtensionDirection[];
    hovered?: readonly CdsExtensionDirection[];
    circular?: boolean;
  }
): T | null {
  const drafted = grown.drafted ?? [];
  const hovered = grown.hovered ?? [];
  const circular = grown.circular ?? false;
  const ends = [...drafted, ...hovered];
  const length = sequence.length;
  if (length === 0) return null;
  const strand = parent.direction === -1 ? -1 : 1;
  const codonStartRaw = parent.qualifiers?.codon_start?.[0];
  const parsedCodonStart = codonStartRaw ? Number.parseInt(codonStartRaw, 10) : 1;
  const transl = parent.qualifiers?.transl_table?.[0];

  const geometry: CdsExtensionGeometryInput = {
    start: parent.start - 1,
    end: parent.end - 1,
    direction: strand as 1 | -1,
    codonStart: (parsedCodonStart === 2 ? 2 : parsedCodonStart === 3 ? 3 : 1) as 1 | 2 | 3,
    geneticCode: transl ? Number.parseInt(transl, 10) : undefined,
  };

  let start = parent.start;
  let end = parent.end;
  const appliedDrafted: CdsExtensionDirection[] = [];
  const appliedHovered: CdsExtensionDirection[] = [];
  for (const direction of ['five-prime', 'three-prime'] as const) {
    if (!ends.includes(direction)) continue;
    const extension = extensionRangeFor(geometry, sequence, circular, direction);
    if (!extension || extension.addedBases <= 0) continue;
    if (circular && cdsBoundsSpan({ start, end }, length) + extension.addedBases >= length) {
      continue;
    }
    const movesHighCoordinate = direction === 'three-prime' ? strand === 1 : strand !== 1;
    if (movesHighCoordinate) {
      end = circular
        ? wrapPosition(end - 1 + extension.addedBases, length) + 1
        : Math.min(length, end + extension.addedBases);
    } else {
      start = circular
        ? wrapPosition(start - 1 - extension.addedBases, length) + 1
        : Math.max(1, start - extension.addedBases);
    }
    if (drafted.includes(direction)) appliedDrafted.push(direction);
    else appliedHovered.push(direction);
  }
  if (appliedDrafted.length === 0 && appliedHovered.length === 0) return null;

  const movesFivePrime = strand === 1 ? start !== parent.start : end !== parent.end;

  return {
    ...parent,
    start,
    end,
    qualifiers: {
      ...(parent.qualifiers ?? {}),
      ...(movesFivePrime ? { codon_start: ['1'] } : {}),
      [CDS_EXTENSION_ORIGINAL_QUALIFIER]: [`${parent.start}..${parent.end}`],
      ...(appliedDrafted.length > 0 ? { [CDS_EXTENSION_DIRECTION_QUALIFIER]: appliedDrafted } : {}),
      ...(appliedHovered.length > 0 ? { [CDS_EXTENSION_HOVER_QUALIFIER]: appliedHovered } : {}),
    },
  };
}

export function cdsExtensionIdentityKey(annotation: {
  name?: string;
  type?: string;
  start: number;
  end: number;
  qualifiers?: Record<string, string[]>;
}): string {
  const original = cdsExtensionOriginalBounds(annotation);
  return cdsExtensionKeyFor({
    name: annotation.name,
    type: annotation.type,
    start: original?.start ?? annotation.start,
    end: original?.end ?? annotation.end,
  });
}

export function cdsWithoutExtensionPreview<
  T extends { start: number; end: number; qualifiers?: Record<string, string[]> },
>(preview: T): T | null {
  const original = cdsExtensionOriginalBounds(preview);
  if (!original) return null;
  const qualifiers = { ...(preview.qualifiers ?? {}) };
  delete qualifiers[CDS_EXTENSION_ORIGINAL_QUALIFIER];
  delete qualifiers[CDS_EXTENSION_DIRECTION_QUALIFIER];
  delete qualifiers[CDS_EXTENSION_HOVER_QUALIFIER];
  return {
    ...preview,
    start: original.start,
    end: original.end,
    qualifiers,
  };
}

export function annotationsWithCdsExtensionPreview<
  T extends {
    name?: string;
    type?: string;
    start: number;
    end: number;
    direction?: number;
    qualifiers?: Record<string, string[]>;
  },
>(
  annotations: readonly T[],
  arrow: CdsExtensionArrowId | null | undefined,
  sequence: string,
  circular: boolean
): readonly T[] {
  if (!arrow || arrow.kind !== 'extend') return annotations;
  const index = annotations.findIndex((a) => cdsExtensionIdentityKey(a) === arrow.cdsKey);
  if (index < 0) return annotations;
  const current = annotations[index]!;
  const base = cdsWithoutExtensionPreview(current) ?? current;
  const drafted = cdsExtensionPreviewEnds(current);
  const hovered = drafted.includes(arrow.direction) ? [] : [arrow.direction];
  const extended = buildExtendedCdsPreviewForEnds(base, sequence, { drafted, hovered, circular });
  if (!extended) return annotations;
  const next = annotations.slice();
  next[index] = extended;
  return next;
}

export function isPredictedCodonCell(
  original: CdsExtensionOriginalBounds,
  cell: { genomicStart?: number; genomicEnd?: number }
): boolean {
  if (cell.genomicStart === undefined || cell.genomicEnd === undefined) return false;
  return !(
    positionWithinCdsBounds(original, cell.genomicStart) &&
    positionWithinCdsBounds(original, cell.genomicEnd)
  );
}

export function committedQualifiersForExtensionPreview(preview: {
  qualifiers?: Record<string, string[]>;
}): Record<string, string[]> {
  const next = { ...(preview.qualifiers ?? {}) };
  delete next[CDS_EXTENSION_ORIGINAL_QUALIFIER];
  delete next[CDS_EXTENSION_DIRECTION_QUALIFIER];
  delete next[CDS_EXTENSION_HOVER_QUALIFIER];
  delete next.translation;
  return next;
}

export function extensionQualifiersForSavedRow(
  draft: { key: string; extended: { qualifiers?: Record<string, string[]> } } | null | undefined,
  live: { name?: string; type?: string; start: number; end: number } | null | undefined
): Record<string, string[]> | undefined {
  if (!draft || !live) return undefined;
  if (cdsExtensionKeyFor(live) !== draft.key) return undefined;
  return committedQualifiersForExtensionPreview(draft.extended);
}

export function committedBoundsForExtensionPreview(preview: {
  start: number;
  end: number;
  qualifiers?: Record<string, string[]>;
}): { original: CdsExtensionOriginalBounds; next: { start: number; end: number } } | null {
  const original = cdsExtensionOriginalBounds(preview);
  if (!original) return null;
  return { original, next: { start: preview.start, end: preview.end } };
}
