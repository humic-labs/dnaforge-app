import { CODON_FONT_WEIGHT, CODON_OUTLINE_WIDTH, codonFontSize } from '@waypoint/platform';
import type { SequenceDrawingContext } from './rendering/drawing-context';
import { repeatedTextPainter } from './rendering/repeated-text';

import {
  codonLabelThatFits,
  type CodonDisplay,
  type GeneticCodeSpec,
  codonReaderFor,
} from '@waypoint/sequence-utils';
import type { CodonInfo, AlignmentCodonInfo } from './translation';
import {
  getCodonsForSingleCDS,
  contiguousCodonRangeForLine,
  getDraftCodonsForCDS,
  getAlignmentCodonsForCDS,
  computeAllAlignmentCodons,
  filterAlignmentCodonsForLine,
  resolveResidueIndex,
} from './translation';
import {
  buildCodonCellPath,
  getCodonLetterPosition,
  buildChevronStripOuterPath,
  buildChevronStripInteriorDividersPath,
} from './rendering';
import type { CodonEdge } from './rendering';
import { computeCodonEdges } from './codon-edges';
import { getCharIndexOnLine } from './utils';
import type { InsertedRange, DeletedRange } from './types';

export interface CodonCellRenderData {
  codonX: number;
  visibleWidth: number;
  leftEdge: CodonEdge;
  rightEdge: CodonEdge;
  aa: string;

  display?: CodonDisplay;
  renderLetter: boolean;

  genomicStart?: number;

  genomicEnd?: number;

  status?: 'normal' | 'inserted' | 'frameshifted' | 'deleted' | 'match' | 'substitution';

  residueIndex?: number;
}

export type CodonCellGeometry = Pick<
  CodonCellRenderData,
  'codonX' | 'visibleWidth' | 'leftEdge' | 'rightEdge' | 'genomicStart' | 'genomicEnd'
>;

export function computeCodonEnvelopeCells(
  region: {
    start: number;
    end: number;
    direction: 1 | -1;
    segments?: Array<{ start: number; end: number }>;
    qualifiers?: Record<string, string[]>;
  },
  lineStartPos: number,
  lineEndPos: number,
  x: number,
  charWidth: number,
  sequenceLength: number
): CodonCellGeometry[] | null {
  if (!(Number.isFinite(charWidth) && charWidth > 0)) return null;
  const range = contiguousCodonRangeForLine(
    {
      name: '',
      type: 'CDS',
      start: region.start + 1,
      end: region.end + 1,
      direction: region.direction,
      segments: region.segments,
      qualifiers: region.qualifiers,
    },
    lineStartPos,
    lineEndPos,
    sequenceLength
  );
  if (!range) return null;
  const { firstStart, firstIndex, lastIndex } = range;
  if (firstIndex > lastIndex) return [];
  const indices = [firstIndex];
  if (firstIndex + 1 < lastIndex) indices.push(firstIndex + 1);
  if (lastIndex - 1 > firstIndex + 1) indices.push(lastIndex - 1);
  if (lastIndex > firstIndex) indices.push(lastIndex);
  return indices.map((index) => {
    const startPos = firstStart + (region.direction === -1 ? -3 : 3) * index;
    const endPos = startPos + 2;
    const visibleStart = Math.max(startPos, lineStartPos);
    const visibleEnd = Math.min(endPos, lineEndPos - 1);
    const firstColumn = getCharIndexOnLine(visibleStart, lineStartPos, lineEndPos, sequenceLength);
    const lastColumn = getCharIndexOnLine(visibleEnd, lineStartPos, lineEndPos, sequenceLength);
    const edges = computeCodonEdges(
      { startPos, endPos, visibleStart, visibleEnd },
      index - firstIndex,
      lastIndex - firstIndex + 1,
      region.direction,
      region.start,
      region.end + 1
    );
    return {
      codonX: x + firstColumn * charWidth,
      visibleWidth: (lastColumn - firstColumn + 1) * charWidth,
      ...edges,
      genomicStart: startPos,
      genomicEnd: endPos,
    };
  });
}

export type CodonMode =
  | { type: 'normal'; codons?: readonly CodonInfo[] }
  | {
      type: 'draft';
      insertedRanges: readonly InsertedRange[];
      deletedRanges: readonly DeletedRange[];
    }
  | {
      type: 'alignment';
      alignedRef: string;
      alignedQuery: string;
      precomputed?: Map<string, AlignmentCodonInfo[]>;
    };

export function computeCodonCells(
  region: {
    start: number;
    end: number;
    direction: 1 | -1;
    name?: string;
    segments?: Array<{ start: number; end: number }>;
    qualifiers?: Record<string, string[]>;
  },
  lineStartPos: number,
  lineEndPos: number,
  x: number,
  charWidth: number,
  fullSequence: string,
  sequenceLength: number,
  mode: CodonMode,

  sequenceGeneticCode?: GeneticCodeSpec,
  geneticCodeBasis?: import('@waypoint/sequence-utils').RecordGeneticCodeBasis
): CodonCellRenderData[] {
  switch (mode.type) {
    case 'normal':
      return computeNormalCells(
        region,
        lineStartPos,
        lineEndPos,
        x,
        charWidth,
        fullSequence,
        sequenceLength,
        sequenceGeneticCode,
        mode.codons,
        geneticCodeBasis
      );
    case 'draft':
      return computeDraftCells(
        region,
        lineStartPos,
        lineEndPos,
        x,
        charWidth,
        fullSequence,
        mode.insertedRanges,
        mode.deletedRanges,
        sequenceGeneticCode,
        geneticCodeBasis
      );
    case 'alignment':
      return computeAlignmentCells(region, lineStartPos, lineEndPos, x, charWidth, mode);
  }
}

function computeNormalCells(
  region: {
    start: number;
    end: number;
    direction: 1 | -1;
    segments?: Array<{ start: number; end: number }>;
    qualifiers?: Record<string, string[]>;
  },
  lineStartPos: number,
  lineEndPos: number,
  x: number,
  charWidth: number,
  fullSequence: string,
  sequenceLength: number,
  sequenceGeneticCode?: GeneticCodeSpec,
  computedCodons?: readonly CodonInfo[],
  geneticCodeBasis?: import('@waypoint/sequence-utils').RecordGeneticCodeBasis
): CodonCellRenderData[] {
  const read = codonReaderFor(region, sequenceGeneticCode, geneticCodeBasis);

  const tempAnnotation: {
    name: string;
    type: 'CDS';
    start: number;
    end: number;
    direction: 1 | -1;
    color: string;
    segments?: Array<{ start: number; end: number }>;
    qualifiers?: Record<string, string[]>;
  } = {
    name: '',
    type: 'CDS' as const,
    start: region.start + 1,
    end: region.end + 1,
    direction: region.direction,
    color: '',
  };

  if (region.segments) tempAnnotation.segments = region.segments;
  if (region.qualifiers) tempAnnotation.qualifiers = region.qualifiers;

  const codons =
    computedCodons ??
    getCodonsForSingleCDS(
      tempAnnotation,
      lineStartPos,
      lineEndPos,
      fullSequence,
      sequenceGeneticCode,
      geneticCodeBasis
    );
  if (codons.length === 0) return [];

  const regionStart = region.start;
  const regionEnd = region.end + 1;

  return codons.map((codonInfo, idx) => {
    const visibleCharIndexStart = getCharIndexOnLine(
      codonInfo.visibleStart,
      lineStartPos,
      lineEndPos,
      sequenceLength
    );
    const visibleCharIndexEnd = getCharIndexOnLine(
      codonInfo.visibleEnd,
      lineStartPos,
      lineEndPos,
      sequenceLength
    );
    const codonX = x + visibleCharIndexStart * charWidth;
    const visibleWidth = (visibleCharIndexEnd - visibleCharIndexStart + 1) * charWidth;

    const { leftEdge, rightEdge } = computeCodonEdges(
      codonInfo,
      idx,
      codons.length,
      region.direction,
      regionStart,
      regionEnd
    );

    const residueIndex = resolveResidueIndex(codonInfo);

    const reading = codonInfo.display ?? read(codonInfo.codon ?? '', codonInfo.startPos + 1);

    return {
      codonX,
      visibleWidth,
      leftEdge,
      rightEdge,
      aa: reading.short,
      display: reading,
      renderLetter: codonInfo.renderLetter,
      genomicStart: codonInfo.startPos,
      genomicEnd: codonInfo.endPos,
      residueIndex,
    };
  });
}

function computeDraftCells(
  region: { start: number; end: number; direction: 1 | -1 },
  lineStartPos: number,
  lineEndPos: number,
  x: number,
  charWidth: number,
  fullSequence: string,
  insertedRanges: readonly InsertedRange[],
  deletedRanges: readonly DeletedRange[],
  sequenceGeneticCode?: GeneticCodeSpec,
  geneticCodeBasis?: import('@waypoint/sequence-utils').RecordGeneticCodeBasis
): CodonCellRenderData[] {
  const tempAnnotation = {
    name: '',
    type: 'CDS' as const,
    start: region.start + 1,
    end: region.end + 1,
    direction: region.direction,
    color: '',
  };

  const { draftCodons } = getDraftCodonsForCDS(
    tempAnnotation,
    fullSequence,
    insertedRanges,
    deletedRanges,
    lineStartPos,
    lineEndPos,
    sequenceGeneticCode,
    geneticCodeBasis
  );

  if (draftCodons.length === 0) return [];

  const regionStart = region.start;
  const regionEnd = region.end + 1;

  return draftCodons.map((draftCodon, idx) => {
    const localStart = draftCodon.visualStartPos - lineStartPos;
    const localEnd = draftCodon.visualEndPos - lineStartPos;
    const codonX = x + localStart * charWidth;
    const visibleWidth = (localEnd - localStart + 1) * charWidth;

    const visCodon = {
      startPos: draftCodon.visualStartPos,
      endPos: draftCodon.visualEndPos,
      visibleStart: draftCodon.visualStartPos,
      visibleEnd: draftCodon.visualEndPos,
    };
    const { leftEdge, rightEdge } = computeCodonEdges(
      visCodon,
      idx,
      draftCodons.length,
      region.direction,
      regionStart,
      regionEnd
    );

    return {
      codonX,
      visibleWidth,
      leftEdge,
      rightEdge,
      aa: draftCodon.aa,
      renderLetter: true,
      status: draftCodon.status as CodonCellRenderData['status'],
    };
  });
}

function computeAlignmentCells(
  region: { start: number; end: number; direction: 1 | -1; name?: string },
  lineStartPos: number,
  lineEndPos: number,
  x: number,
  charWidth: number,
  mode: Extract<CodonMode, { type: 'alignment' }>
): CodonCellRenderData[] {
  const tempAnnotation = {
    name: region.name ?? '',
    type: 'CDS' as const,
    start: region.start + 1,
    end: region.end + 1,
    direction: region.direction,
    color: '',
  };

  const cdsKey = (region.name ?? '') + ':' + (region.start + 1) + ':' + (region.end + 1);
  const cached = mode.precomputed?.get(cdsKey);
  const alignmentCodons = cached
    ? filterAlignmentCodonsForLine(cached, lineStartPos, lineEndPos)
    : getAlignmentCodonsForCDS(
        mode.alignedRef,
        mode.alignedQuery,
        tempAnnotation,
        lineStartPos,
        lineEndPos
      );

  if (alignmentCodons.length === 0) return [];

  const sorted = [...alignmentCodons].sort((a, b) =>
    region.direction === 1 ? a.columnStart - b.columnStart : b.columnStart - a.columnStart
  );

  const allCodons = cached
    ? cached
    : computeAllAlignmentCodons(mode.alignedRef, mode.alignedQuery, tempAnnotation);
  let regionStart = Infinity;
  let regionEnd = -Infinity;
  for (const c of allCodons) {
    if (c.columnStart < regionStart) regionStart = c.columnStart;
    if (c.columnEnd > regionEnd) regionEnd = c.columnEnd;
  }
  regionEnd = regionEnd + 1;

  return sorted.map((codon, idx) => {
    const localStart = codon.visibleColumnStart - lineStartPos;
    const localEnd = codon.visibleColumnEnd - lineStartPos;
    const codonX = x + localStart * charWidth;
    const visibleWidth = (localEnd - localStart + 1) * charWidth;

    const visCodon = {
      startPos: codon.columnStart,
      endPos: codon.columnEnd,
      visibleStart: codon.visibleColumnStart,
      visibleEnd: codon.visibleColumnEnd,
    };
    const { leftEdge, rightEdge } = computeCodonEdges(
      visCodon,
      idx,
      sorted.length,
      region.direction,
      regionStart,
      regionEnd
    );

    return {
      codonX,
      visibleWidth,
      leftEdge,
      rightEdge,
      aa: codon.refAa,
      renderLetter: codon.renderLetter,
      status: codon.status as CodonCellRenderData['status'],
    };
  });
}

export function mapCodonsToRenderData(
  codons: CodonInfo[],
  lineStartPos: number,
  lineEndPos: number,
  x: number,
  charWidth: number,
  direction: 1 | -1,
  regionStart: number,
  regionEnd: number,
  sequenceLength: number
): CodonCellRenderData[] {
  return codons.map((codonInfo, idx) => {
    const visibleCharIndexStart = getCharIndexOnLine(
      codonInfo.visibleStart,
      lineStartPos,
      lineEndPos,
      sequenceLength
    );
    const visibleCharIndexEnd = getCharIndexOnLine(
      codonInfo.visibleEnd,
      lineStartPos,
      lineEndPos,
      sequenceLength
    );
    const codonX = x + visibleCharIndexStart * charWidth;
    const visibleWidth = (visibleCharIndexEnd - visibleCharIndexStart + 1) * charWidth;

    const { leftEdge, rightEdge } = computeCodonEdges(
      codonInfo,
      idx,
      codons.length,
      direction,
      regionStart,
      regionEnd
    );

    return {
      codonX,
      visibleWidth,
      leftEdge,
      rightEdge,
      aa: codonInfo.aa,
      renderLetter: codonInfo.renderLetter,
      genomicStart: codonInfo.startPos,
      genomicEnd: codonInfo.endPos,
    };
  });
}

export function strokeCodonCells(
  ctx: SequenceDrawingContext,
  renderData: CodonCellRenderData[],
  trackY: number,
  trackHeight: number,
  chevronDepth: number,
  direction: 1 | -1,
  strokeColor: string
): void {
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = CODON_OUTLINE_WIDTH;
  ctx.globalAlpha = 1.0;

  for (const { codonX, visibleWidth, leftEdge, rightEdge } of renderData) {
    buildCodonCellPath(
      ctx,
      codonX,
      trackY,
      visibleWidth,
      trackHeight,
      chevronDepth,
      direction,
      leftEdge,
      rightEdge
    );
    ctx.stroke();
  }
}

export function fillCodonCells(
  ctx: SequenceDrawingContext,
  renderData: CodonCellRenderData[],
  trackY: number,
  trackHeight: number,
  chevronDepth: number,
  direction: 1 | -1,
  fillColor: string,
  borderColor: string,
  fillAlpha: number = 0.3,
  borderAlpha: number = 0.3,
  colorFn?: (
    idx: number,
    rd: CodonCellRenderData
  ) => { fill: string; alpha: number; border?: string; borderAlpha?: number } | null,
  overallAlpha: number = 1.0,
  outlineOnly: boolean = false,
  sharedBorders: boolean = false
): void {
  const borders: number[] = [];
  const borderCells: CodonCellRenderData[] = [];
  const defaultBorder = { color: borderColor, alpha: borderAlpha * overallAlpha };
  let borderStyles: Map<number, typeof defaultBorder> | undefined;
  const borderStyle = (index: number) => borderStyles?.get(index) ?? defaultBorder;
  const preparedFills =
    ctx.prepareRepeatedPath && !outlineOnly
      ? new Map<string, ((offsetX: number) => void) | null>()
      : null;
  let previousWidth = NaN;
  let previousLeft: CodonCellRenderData['leftEdge'] | undefined;
  let previousRight: CodonCellRenderData['rightEdge'] | undefined;
  let previousPaint: ((offsetX: number) => void) | null | undefined;
  const buildPath = (cell: CodonCellRenderData) =>
    buildCodonCellPath(
      ctx,
      cell.codonX,
      trackY,
      cell.visibleWidth,
      trackHeight,
      chevronDepth,
      direction,
      cell.leftEdge,
      cell.rightEdge
    );
  renderData.forEach((rd, idx) => {
    const { codonX, visibleWidth, leftEdge, rightEdge } = rd;

    if (outlineOnly) {
      buildPath(rd);

      ctx.strokeStyle = fillColor;
      ctx.lineWidth = CODON_OUTLINE_WIDTH;
      ctx.globalAlpha = overallAlpha;
      ctx.stroke();
      ctx.globalAlpha = 1.0;
    } else {
      const override = colorFn?.(idx, rd);
      ctx.fillStyle = override?.fill ?? fillColor;
      ctx.globalAlpha = (override?.alpha ?? fillAlpha) * overallAlpha;
      let paint: ((offsetX: number) => void) | null | undefined;
      if (preparedFills) {
        if (
          visibleWidth === previousWidth &&
          leftEdge === previousLeft &&
          rightEdge === previousRight
        ) {
          paint = previousPaint;
        } else {
          const key = `${visibleWidth}:${leftEdge}:${rightEdge}`;
          paint = preparedFills.get(key);
          if (paint === undefined) {
            const points: [number, number][] = [];
            buildCodonCellPath(
              {
                beginPath() {},
                moveTo: (x, y) => points.push([x, y]),
                lineTo: (x, y) => points.push([x, y]),
                closePath() {},
              },
              0,
              trackY,
              visibleWidth,
              trackHeight,
              chevronDepth,
              direction,
              leftEdge,
              rightEdge
            );
            paint = ctx.prepareRepeatedPath!(points, 'fill', true);
            preparedFills.set(key, paint);
          }
          previousWidth = visibleWidth;
          previousLeft = leftEdge;
          previousRight = rightEdge;
          previousPaint = paint;
        }
      }
      if (paint) paint(codonX);
      else {
        buildPath(rd);
        ctx.fill();
      }

      if (sharedBorders) {
        const borderIndex = borderCells.length;
        borderCells.push(rd);
        borders.push(borderIndex);
        const color = override?.border ?? borderColor;
        const alpha = (override?.borderAlpha ?? borderAlpha) * overallAlpha;

        if (color !== defaultBorder.color || !Object.is(alpha, defaultBorder.alpha)) {
          borderStyles ??= new Map();
          borderStyles.set(borderIndex, { color, alpha });
        }
      } else {
        if (paint) buildPath(rd);
        ctx.strokeStyle = override?.border ?? borderColor;
        ctx.lineWidth = CODON_OUTLINE_WIDTH;
        ctx.globalAlpha = (override?.borderAlpha ?? borderAlpha) * overallAlpha;
        ctx.stroke();
      }
      ctx.globalAlpha = 1.0;
    }
  });
  if (sharedBorders && borders.length) {
    let ordered = true;
    for (let index = 1; index < borders.length; index++) {
      const previousX = borderCells[borders[index - 1]].codonX;
      const nextX = borderCells[borders[index]].codonX;
      if (typeof previousX !== 'number' || typeof nextX !== 'number' || !(previousX <= nextX)) {
        ordered = false;
        break;
      }
    }
    if (!ordered) borders.sort((a, b) => borderCells[a].codonX - borderCells[b].codonX);
    let start = 0;
    while (start < borders.length) {
      const style = borderStyle(borders[start]);
      let end = start + 1;
      while (end < borders.length) {
        const previous = borderCells[borders[end - 1]];
        const next = borderCells[borders[end]];
        const nextStyle = borderStyle(borders[end]);
        if (
          !(
            nextStyle.color === style.color &&
            nextStyle.alpha === style.alpha &&
            Math.abs(previous.codonX + previous.visibleWidth - next.codonX) < 1e-6 &&
            previous.rightEdge === 'chevron' &&
            next.leftEdge === 'chevron'
          )
        )
          break;
        end++;
      }
      const cells: CodonCellRenderData[] = [];
      for (let index = start; index < end; index++) cells.push(borderCells[borders[index]]);
      ctx.strokeStyle = style.color;
      ctx.globalAlpha = style.alpha;
      ctx.lineWidth = CODON_OUTLINE_WIDTH;
      buildChevronStripOuterPath(ctx, cells, trackY, trackHeight, chevronDepth, direction);
      ctx.stroke();
      if (cells.length > 1) {
        const paintDivider = ctx.prepareRepeatedPath?.(
          [
            [0, trackY],
            [direction * chevronDepth, trackY + trackHeight / 2],
            [0, trackY + trackHeight],
          ],
          'stroke'
        );
        if (paintDivider) {
          for (let i = 0; i < cells.length - 1; i++)
            paintDivider(cells[i].codonX + cells[i].visibleWidth);
        } else {
          buildChevronStripInteriorDividersPath(
            ctx,
            cells,
            trackY,
            trackHeight,
            chevronDepth,
            direction
          );
          ctx.stroke();
        }
      }
      start = end;
    }
    ctx.globalAlpha = 1;
  }
}

export function drawCodonLetters(
  ctx: SequenceDrawingContext,
  renderData: CodonCellRenderData[],
  trackY: number,
  trackHeight: number,
  chevronDepth: number,
  direction: 1 | -1,
  textColor: string,
  fontSize: number,
  fontFamily: string
): void {
  const aaFontSize = codonFontSize(fontSize);
  ctx.font = `${CODON_FONT_WEIGHT} ${aaFontSize}px ${fontFamily}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const measured = new Map<string, number>();
  const measureLabel = (text: string): number => {
    const cached = measured.get(text);
    if (cached !== undefined) return cached;
    const width = ctx.measureText(text).width;
    measured.set(text, width);
    return width;
  };

  const preparedLabels = ctx.prepareRepeatedText
    ? new Map<string, Map<number, ReturnType<typeof repeatedTextPainter>>>()
    : null;
  const paintLabel = (text: string, x: number, y: number) => {
    if (!preparedLabels) {
      ctx.fillText(text, x, y);
      return;
    }
    let positions = preparedLabels.get(ctx.font);
    if (!positions) {
      positions = new Map();
      preparedLabels.set(ctx.font, positions);
    }
    let paint = positions.get(y);
    if (!paint) {
      paint = repeatedTextPainter(ctx, y);
      positions.set(y, paint);
    }
    paint(text, x);
  };

  for (const { aa, display, renderLetter, codonX, visibleWidth } of renderData) {
    if (!renderLetter) continue;

    const pos = getCodonLetterPosition(
      codonX,
      visibleWidth,
      trackY,
      trackHeight,
      chevronDepth,
      direction,
      aaFontSize
    );

    const fit = display
      ? codonLabelThatFits(display, visibleWidth, aaFontSize, measureLabel)
      : { text: aa, scale: 1 };
    const isStop = display ? display.kind === 'stop' : aa === '*';
    ctx.fillStyle = isStop || display?.kind === 'unassigned' ? '#cc0000' : textColor;
    if (fit.scale !== 1) {
      ctx.font = `${CODON_FONT_WEIGHT} ${Math.max(1, Math.round(aaFontSize * fit.scale))}px ${fontFamily}`;
      paintLabel(fit.text, pos.x, pos.y);
      ctx.font = `${CODON_FONT_WEIGHT} ${aaFontSize}px ${fontFamily}`;
    } else {
      paintLabel(fit.text, pos.x, pos.y);
    }
  }
}
