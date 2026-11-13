import {
  recordAnchorBp,
  type CatalogRecord,
  type TerminatorPart,
  type TranscriptionUnitRecord,
} from '@waypoint/genome-data/annotation-catalog';

import { scoreFraction, type CatalogScoreScale } from './catalog-derived-data';
import type { CatalogGlyphBatches } from './catalog-glyph-batches';
import { awayFromBaseline, rowBaseY } from './catalog-rows';
import type { AnnotationCatalogGeneSpan, AnnotationCatalogRowLayout } from './types';

export interface CatalogGlyphFrame {
  readonly viewStartBp: number;
  readonly pixelsPerBp: number;
  readonly rows: AnnotationCatalogRowLayout;
  readonly genesByName: ReadonlyMap<string, AnnotationCatalogGeneSpan>;
  readonly scoreScale: CatalogScoreScale | null;
}

export type CatalogGlyphDrawer = (
  batches: CatalogGlyphBatches,
  frame: CatalogGlyphFrame,
  record: CatalogRecord,
  recordIndex: number,
  lane: number,
  anchorEdgeBp: number
) => void;

export const CATALOG_POINT_GLYPH_WIDTH_PX = 6;
export const CATALOG_MIN_BRACKET_WIDTH_PX = 6;
export const CATALOG_MIN_TICK_FRACTION = 0.25;
const BOX_ARROW_TIP_PX = 4;

export function catalogX(frame: CatalogGlyphFrame, bp: number): number {
  return (bp - frame.viewStartBp) * frame.pixelsPerBp;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export const drawPromoterArrow: CatalogGlyphDrawer = (
  batches,
  frame,
  record,
  recordIndex,
  lane,
  anchorEdgeBp
) => {
  if (record.kind !== 'promoter' && record.kind !== 'tss') {
    drawIntervalBox(batches, frame, record, recordIndex, lane, anchorEdgeBp);
    return;
  }
  const forward = record.strand === '+';
  const away = awayFromBaseline(forward);
  const direction = forward ? 1 : -1;
  const rowHeight = frame.rows.rowHeightPx;
  const baseY = rowBaseY(frame.rows, away, lane);

  if (record.kind === 'promoter') {
    const bandHeight = Math.max(2, rowHeight * 0.25);
    const bandY = forward ? baseY - bandHeight : baseY;
    if (record.location.shape === 'region') {
      const x0 = catalogX(frame, record.location.start);
      const x1 = catalogX(frame, record.location.end);
      batches.band.rect(x0, bandY, Math.max(1, x1 - x0), bandHeight);
    }
    for (const box of record.boxes) {
      const x0 = catalogX(frame, box.start);
      const x1 = catalogX(frame, box.end);
      batches.body.rect(x0, bandY, Math.max(1, x1 - x0), bandHeight);
    }
  }

  const x = catalogX(frame, anchorEdgeBp);
  const headHalf = clamp(rowHeight * 0.2, 1.5, 4);
  const headLength = clamp(rowHeight * 0.3, 2, 6);
  const armLength = clamp(rowHeight * 0.5, 3, 10);
  const armY = baseY + away * Math.max(1, rowHeight - headHalf - 1);
  const headBaseX = x + direction * armLength;
  batches.line.segment(x, baseY, x, armY);
  batches.line.segment(x, armY, headBaseX, armY);
  batches.body.triangle(
    headBaseX,
    armY - headHalf,
    headBaseX + direction * headLength,
    armY,
    headBaseX,
    armY + headHalf
  );
};

export const drawTerminatorHairpin: CatalogGlyphDrawer = (
  batches,
  frame,
  record,
  recordIndex,
  lane,
  anchorEdgeBp
) => {
  if (record.kind !== 'terminator') {
    drawIntervalBox(batches, frame, record, recordIndex, lane, anchorEdgeBp);
    return;
  }
  const away = awayFromBaseline(record.strand === '+');
  const rowHeight = frame.rows.rowHeightPx;
  const baseY = rowBaseY(frame.rows, away, lane);
  const x = catalogX(frame, anchorEdgeBp);

  if (record.mechanism === 'rho-dependent') {
    let x0 = x;
    let x1 = x;
    if (record.location.shape === 'region') {
      x0 = catalogX(frame, record.location.start);
      x1 = catalogX(frame, record.location.end);
    }
    if (x1 - x0 < CATALOG_MIN_BRACKET_WIDTH_PX) {
      const middle = (x0 + x1) / 2;
      x0 = middle - CATALOG_MIN_BRACKET_WIDTH_PX / 2;
      x1 = middle + CATALOG_MIN_BRACKET_WIDTH_PX / 2;
    }
    const topY = baseY + away * Math.max(2, rowHeight * 0.5);
    batches.line.segment(x0, baseY, x0, topY);
    batches.line.segment(x0, topY, x1, topY);
    batches.line.segment(x1, topY, x1, baseY);
    return;
  }

  if (record.mechanism === 'intrinsic' || hasHairpinParts(record.parts)) {
    const radius = clamp(rowHeight * 0.18, 1.5, 4);
    const stemTopY = baseY + away * Math.max(1, rowHeight - 2 * radius - 1);
    batches.line.segment(x, baseY, x, stemTopY);
    batches.body.circle(x, stemTopY + away * radius, radius);
    return;
  }

  const topY = baseY + away * Math.max(1, rowHeight - 1.5);
  const barHalf = clamp(rowHeight * 0.25, 2, 4);
  batches.line.segment(x, baseY, x, topY);
  batches.line.segment(x - barHalf, topY, x + barHalf, topY);
};

function hasHairpinParts(parts: readonly TerminatorPart[]): boolean {
  for (const part of parts) {
    if (part.element === 'stem' || part.element === 'loop') return true;
  }
  return false;
}

export const drawPositionTick: CatalogGlyphDrawer = (
  batches,
  frame,
  record,
  _recordIndex,
  lane,
  anchorEdgeBp
) => {
  const away = awayFromBaseline(record.strand === '+');
  const baseY = rowBaseY(frame.rows, away, lane);
  const fullHeight = Math.max(1, frame.rows.rowHeightPx - 1);
  const fraction =
    frame.scoreScale === null
      ? 1
      : CATALOG_MIN_TICK_FRACTION +
        (1 - CATALOG_MIN_TICK_FRACTION) * scoreFraction(frame.scoreScale, record.score);
  const x = catalogX(frame, anchorEdgeBp);
  batches.thinLine.segment(x, baseY, x, baseY + away * fullHeight * fraction);
};

export const drawIntervalBox: CatalogGlyphDrawer = (
  batches,
  frame,
  record,
  _recordIndex,
  lane,
  _anchorEdgeBp
) => {
  const forward = record.strand === '+';
  const away = awayFromBaseline(forward);
  const rowHeight = frame.rows.rowHeightPx;
  const baseY = rowBaseY(frame.rows, away, lane);
  const inset = Math.min(1, rowHeight * 0.15);
  const top = forward ? baseY - rowHeight + inset : baseY + inset;
  const bottom = top + Math.max(1, rowHeight - 2 * inset);
  const middle = (top + bottom) / 2;

  if (record.location.shape === 'point') {
    const center = catalogX(frame, recordAnchorBp(record) + 0.5);
    const half = (forward ? 1 : -1) * (CATALOG_POINT_GLYPH_WIDTH_PX / 2);
    batches.body.triangle(center - half, top, center + half, middle, center - half, bottom);
    return;
  }

  const x0 = catalogX(frame, record.location.start);
  const x1 = Math.max(x0 + 1, catalogX(frame, record.location.end));
  const width = x1 - x0;
  const tip = width >= 3 ? Math.min(BOX_ARROW_TIP_PX, width / 2, bottom - top) : 0;
  if (tip <= 0) {
    batches.body.rect(x0, top, width, bottom - top);
  } else if (forward) {
    batches.body.pentagon(x0, top, x1 - tip, top, x1, middle, x1 - tip, bottom, x0, bottom);
  } else {
    batches.body.pentagon(x0, middle, x0 + tip, top, x1, top, x1, bottom, x0 + tip, bottom);
  }
};

export const drawTranscriptionUnitArrow: CatalogGlyphDrawer = (
  batches,
  frame,
  record,
  recordIndex,
  lane,
  anchorEdgeBp
) => {
  if (record.kind !== 'transcription_unit') {
    drawIntervalBox(batches, frame, record, recordIndex, lane, anchorEdgeBp);
    return;
  }
  const forward = record.strand === '+';
  const away = awayFromBaseline(forward);
  const rowHeight = frame.rows.rowHeightPx;
  const middle = rowBaseY(frame.rows, away, lane) + (away * rowHeight) / 2;
  const { start, end } = record.location;
  const x0 = catalogX(frame, start);
  const x1 = Math.max(x0 + 1, catalogX(frame, end));
  const width = x1 - x0;
  const headLength = width >= 4 ? Math.min(clamp(rowHeight * 0.5, 3, 7), width * 0.4) : 0;
  const headHalf = clamp(rowHeight * 0.3, 1.5, 5);

  if (forward) {
    batches.line.segment(x0, middle, x1 - headLength, middle);
    if (headLength > 0) {
      batches.body.triangle(
        x1 - headLength,
        middle - headHalf,
        x1,
        middle,
        x1 - headLength,
        middle + headHalf
      );
    }
  } else {
    batches.line.segment(x0 + headLength, middle, x1, middle);
    if (headLength > 0) {
      batches.body.triangle(
        x0 + headLength,
        middle - headHalf,
        x0,
        middle,
        x0 + headLength,
        middle + headHalf
      );
    }
  }

  const geneBatch = batches.unitColors[recordIndex % batches.unitColors.length];
  const geneHeight = Math.max(2, rowHeight * 0.55);
  const geneTop = middle - geneHeight / 2;
  const geneCount = Math.max(record.genes.length, record.geneLocusTags.length);
  for (let geneIndex = 0; geneIndex < geneCount; geneIndex++) {
    const gene = unitGeneAt(frame, record, geneIndex);
    if (!gene) continue;
    const geneStart = Math.max(gene.start, start);
    const geneEnd = Math.min(gene.end, end);
    if (geneEnd <= geneStart) continue;
    let gx0 = catalogX(frame, geneStart);
    let gx1 = catalogX(frame, geneEnd);
    if (gx1 - gx0 >= 3) {
      gx0 += 0.5;
      gx1 -= 0.5;
    }
    geneBatch.rect(gx0, geneTop, Math.max(1, gx1 - gx0), geneHeight);
  }
};

function unitGeneAt(
  frame: CatalogGlyphFrame,
  record: TranscriptionUnitRecord,
  geneIndex: number
): AnnotationCatalogGeneSpan | undefined {
  const locusTag = record.geneLocusTags[geneIndex];
  const byTag = locusTag === undefined ? undefined : frame.genesByName.get(locusTag);
  if (byTag) return byTag;
  const name = record.genes[geneIndex];
  return name === undefined ? undefined : frame.genesByName.get(name);
}
