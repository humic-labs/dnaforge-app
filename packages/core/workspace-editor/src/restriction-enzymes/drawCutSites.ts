import type { SequenceDrawingContext } from '../rendering/drawing-context';

import type { ColoredCutSite } from '@waypoint/sequence-utils';
import {
  INTERNAL_CUT_SITE_STYLE,
  internalCutSiteBadgeCanvasFont,
  internalCutSiteBadgeRadiusPx,
} from '@waypoint/sequence-utils';
import type { LayoutSnapshot2D, Layout2DRow, WorkspaceEditorConfig, PrimerDisplay } from '../types';
import type { LinePositions } from '../canvas-drawing';
import { PRIMER_CANVAS_CONSTANTS } from '../canvas-constants';
import { getCanvasTheme } from '../canvas-theme';
import {
  getCutSiteLabelBg,
  lightenColor,
  darkenColor,
  cutSiteLabelMetrics,
  CUT_SITE_LABEL_BASE_FONT_SIZE,
  selectCutSiteLabelsByDensity,
  type RenderedCutSite,
} from './cut-site-styling';

export type { RenderedCutSite } from './cut-site-styling';

function findLineForPosition(
  lines: Layout2DRow[],
  position: number,
  _sequenceLength: number
): Layout2DRow | undefined {
  return lines.find((l) => {
    if (l.startPos <= l.endPos) {
      return position >= l.startPos && position < l.endPos;
    }
    return position >= l.startPos || position < l.endPos;
  });
}

function findAllLinesForPosition(
  lines: Layout2DRow[],
  position: number,
  _sequenceLength: number
): Layout2DRow[] {
  return lines.filter((l) => {
    if (l.startPos <= l.endPos) {
      return position >= l.startPos && position < l.endPos;
    }
    return position >= l.startPos || position < l.endPos;
  });
}

function getLocalPosition(
  position: number,
  lineStartPos: number,
  lineEndPos: number,
  sequenceLength: number
): number {
  if (lineStartPos <= lineEndPos) {
    return position - lineStartPos;
  }
  if (position >= lineStartPos) {
    return position - lineStartPos;
  } else {
    return sequenceLength - lineStartPos + position;
  }
}

function lookupSequenceY(
  line: Layout2DRow,
  linePositionsMap: Map<Layout2DRow, LinePositions>
): number | undefined {
  return linePositionsMap.get(line)?.sequenceY;
}

interface LabelPosition {
  cutSite: ColoredCutSite;
  lineIndex: number;
  labelX: number;
  labelY: number;
  labelWidth: number;
  labelHeight: number;
  idealLabelX: number;
  bottomCutX: number;
  topCutX: number;
  sequenceY: number;
  primerLaneOffset: number;
  mutationTrackHeight: number;
}

function isPrimerOnLine(
  primer: PrimerDisplay,
  line: Layout2DRow,
  _sequenceLength: number
): boolean {
  if (line.startPos <= line.endPos) {
    return primer.start < line.endPos && primer.end > line.startPos;
  }
  return primer.start < line.endPos || primer.end > line.startPos;
}

function getPrimerXBounds(
  primer: PrimerDisplay,
  line: Layout2DRow,
  sequenceLength: number,
  marginLeft: number,
  charWidth: number
): { startX: number; endX: number } {
  const localStart = getLocalPosition(primer.start, line.startPos, line.endPos, sequenceLength);
  const localEnd = getLocalPosition(primer.end, line.startPos, line.endPos, sequenceLength);
  const startX = marginLeft + Math.min(localStart, localEnd) * charWidth;
  const endX = marginLeft + Math.max(localStart, localEnd) * charWidth;
  return { startX, endX };
}

function rangesOverlap(x1: number, width1: number, x2: number, width2: number): boolean {
  return x1 < x2 + width2 && x1 + width1 > x2;
}

function cutSiteLineInViewport(
  line: Layout2DRow,
  viewport: { scrollTop: number; height: number } | undefined
): boolean {
  if (!viewport || viewport.height === 0) return true;
  return line.y >= viewport.scrollTop - 100 && line.y <= viewport.scrollTop + viewport.height + 100;
}

function pickVisibleCutSiteLine(
  allLines: Layout2DRow[],
  viewport: { scrollTop: number; height: number } | undefined
): Layout2DRow | undefined {
  if (allLines.length === 0) return undefined;
  if (viewport && viewport.height > 0) {
    return allLines.find((line) => cutSiteLineInViewport(line, viewport));
  }
  return allLines[0];
}

function layoutCutSiteLabel(args: {
  ctx: SequenceDrawingContext;
  cutSite: ColoredCutSite;
  line: Layout2DRow;
  sequenceY: number;
  topCutX: number;
  bottomCutX: number;
  strandCount: number;
  marginLeft: number;
  charWidth: number;
  rowHeight: number;
  totalWidth: number;
  sequenceLength: number;
  labelFontSize: number;
  labelHeight: number;
  labelPadding: number;
  fontFamily: string;
  showPrimers: boolean | undefined;
  primers: PrimerDisplay[];
  linePositionsMap: Map<Layout2DRow, LinePositions>;
  labelPositions: Map<number, Array<{ x: number; width: number }>>;
}): LabelPosition {
  const {
    ctx,
    cutSite,
    line,
    sequenceY,
    topCutX,
    bottomCutX,
    strandCount,
    marginLeft,
    charWidth,
    rowHeight,
    totalWidth,
    sequenceLength,
    labelFontSize,
    labelHeight,
    labelPadding,
    fontFamily,
    showPrimers,
    primers,
    linePositionsMap,
    labelPositions,
  } = args;
  const labelText = cutSite.enzyme.name;
  ctx.font = `${labelFontSize}px ${fontFamily}`;
  const textMetrics = ctx.measureText(labelText);
  const labelWidth = textMetrics.width + labelPadding * 2;

  const lp = linePositionsMap.get(line);
  const mutationTrackHeight = lp?.hasMutationTrack ? rowHeight : 0;
  const bottomStrandBottom = sequenceY + rowHeight * strandCount + mutationTrackHeight;
  const idealLabelX = bottomCutX - labelWidth / 2;
  let labelX = idealLabelX;

  if (labelX < marginLeft) {
    labelX = marginLeft;
  }

  const lineLabels = labelPositions.get(line.lineIndex) || [];
  let attempts = 0;
  const maxAttempts = 20;

  while (attempts < maxAttempts) {
    let hasOverlap = false;
    for (const existing of lineLabels) {
      if (labelX < existing.x + existing.width + 2 && labelX + labelWidth > existing.x - 2) {
        labelX = existing.x + existing.width + 4;
        hasOverlap = true;
        break;
      }
    }
    if (!hasOverlap) break;
    attempts++;
  }

  if (labelX + labelWidth > totalWidth) {
    labelX = totalWidth - labelWidth;
  }

  const primerLabelGap = 4;
  let primerLaneOffset = 0;

  if (showPrimers && primers.length > 0) {
    const reversePrimersOnLine = primers.filter(
      (p) => p.direction === 'reverse' && isPrimerOnLine(p, line, sequenceLength)
    );

    for (const primer of reversePrimersOnLine) {
      const { startX, endX } = getPrimerXBounds(
        primer,
        line,
        sequenceLength,
        marginLeft,
        charWidth
      );
      const primerWidth = endX - startX;

      if (rangesOverlap(labelX, labelWidth, startX, primerWidth)) {
        primerLaneOffset =
          lp && lp.rulerY > lp.reversePrimerY
            ? lp.rulerY - lp.reversePrimerY + primerLabelGap
            : rowHeight * PRIMER_CANVAS_CONSTANTS.TRACK_HEIGHT_RATIO + primerLabelGap;
        break;
      }
    }
  }

  const labelY = bottomStrandBottom + 4 + primerLaneOffset;
  lineLabels.push({ x: labelX, width: labelWidth });
  labelPositions.set(line.lineIndex, lineLabels);

  return {
    cutSite,
    lineIndex: line.lineIndex,
    labelX,
    labelY,
    labelWidth,
    labelHeight,
    idealLabelX,
    bottomCutX,
    topCutX,
    sequenceY,
    primerLaneOffset,
    mutationTrackHeight,
  };
}

function cutSiteStrokeStyle(
  cutSite: ColoredCutSite,
  isHovered: boolean
): { isInternal: boolean; baseColor: string; lineColor: string; lineWidth: number } {
  const isInternal = cutSite.isInternalCutSite === true;
  const baseColor = cutSite.color;
  return {
    isInternal,
    baseColor,
    lineColor: isHovered ? lightenColor(baseColor, 20) : baseColor,
    lineWidth: isInternal ? INTERNAL_CUT_SITE_STYLE.lineWidth : isHovered ? 2.5 : 1,
  };
}

function paintCutSiteStrandMarks(args: {
  ctx: SequenceDrawingContext;
  cutSite: ColoredCutSite;
  topLines: Layout2DRow[];
  bottomLines: Layout2DRow[];
  viewport: { scrollTop: number; height: number } | undefined;
  linePositionsMap: Map<Layout2DRow, LinePositions>;
  marginLeft: number;
  charWidth: number;
  rowHeight: number;
  strandCount: number;
  sequenceLength: number;
}): void {
  const {
    ctx,
    cutSite,
    topLines,
    bottomLines,
    viewport,
    linePositionsMap,
    marginLeft,
    charWidth,
    rowHeight,
    strandCount,
    sequenceLength,
  } = args;

  for (const topLine of topLines) {
    if (!cutSiteLineInViewport(topLine, viewport)) continue;

    const sequenceY = lookupSequenceY(topLine, linePositionsMap);
    if (sequenceY === undefined) continue;

    const topLocalPos = getLocalPosition(
      cutSite.cutPositionTop,
      topLine.startPos,
      topLine.endPos,
      sequenceLength
    );
    const topCutX = marginLeft + topLocalPos * charWidth;
    const topStrandTop = sequenceY;
    const topStrandBottom = sequenceY + rowHeight;
    const bottomOnSameLine = bottomLines.find((bl) => bl.lineIndex === topLine.lineIndex);

    if (bottomOnSameLine) {
      const bottomLocalPos = getLocalPosition(
        cutSite.cutPositionBottom,
        topLine.startPos,
        topLine.endPos,
        sequenceLength
      );
      const bottomCutX = marginLeft + bottomLocalPos * charWidth;
      const topLp = linePositionsMap.get(topLine);
      const topMutH = topLp?.hasMutationTrack ? rowHeight : 0;
      const bottomStrandBottom = sequenceY + rowHeight * strandCount + topMutH;

      ctx.beginPath();
      ctx.moveTo(topCutX, topStrandTop);
      ctx.lineTo(topCutX, topStrandBottom);
      if (topCutX !== bottomCutX) {
        ctx.lineTo(bottomCutX, topStrandBottom);
      }
      ctx.lineTo(bottomCutX, bottomStrandBottom);
      ctx.stroke();
    } else {
      const lineRightEdge = marginLeft + topLine.sequence.length * charWidth;
      ctx.beginPath();
      ctx.moveTo(topCutX, topStrandTop);
      ctx.lineTo(topCutX, topStrandBottom);
      if (cutSite.cutPositionBottom > cutSite.cutPositionTop) {
        ctx.lineTo(lineRightEdge, topStrandBottom);
      }
      ctx.stroke();
    }
  }

  for (const bottomLine of bottomLines) {
    const topOnSameLine = topLines.find((tl) => tl.lineIndex === bottomLine.lineIndex);
    if (topOnSameLine) continue;

    if (!cutSiteLineInViewport(bottomLine, viewport)) continue;

    const sequenceY = lookupSequenceY(bottomLine, linePositionsMap);
    if (sequenceY === undefined) continue;

    const bottomLocalPos = getLocalPosition(
      cutSite.cutPositionBottom,
      bottomLine.startPos,
      bottomLine.endPos,
      sequenceLength
    );
    const bottomCutX = marginLeft + bottomLocalPos * charWidth;
    const topStrandBottom = sequenceY + rowHeight;
    const bottomLp = linePositionsMap.get(bottomLine);
    const bottomMutH = bottomLp?.hasMutationTrack ? rowHeight : 0;
    const bottomStrandBottom = sequenceY + rowHeight * strandCount + bottomMutH;

    ctx.beginPath();
    if (cutSite.cutPositionBottom > cutSite.cutPositionTop) {
      ctx.moveTo(marginLeft, topStrandBottom);
      ctx.lineTo(bottomCutX, topStrandBottom);
      ctx.lineTo(bottomCutX, bottomStrandBottom);
    } else {
      ctx.moveTo(bottomCutX, topStrandBottom);
      ctx.lineTo(bottomCutX, bottomStrandBottom);
    }
    ctx.stroke();
  }
}

function paintCutSiteLabel(args: {
  ctx: SequenceDrawingContext;
  cutSite: ColoredCutSite;
  pos: LabelPosition;
  isHovered: boolean;
  isInternal: boolean;
  baseColor: string;
  lineColor: string;
  rowHeight: number;
  labelFontSize: number;
  fontFamily: string;
}): RenderedCutSite {
  const {
    ctx,
    cutSite,
    pos,
    isHovered,
    isInternal,
    baseColor,
    lineColor,
    rowHeight,
    labelFontSize,
    fontFamily,
  } = args;
  const {
    labelX,
    labelY,
    labelWidth,
    labelHeight,
    idealLabelX,
    bottomCutX,
    sequenceY,
    primerLaneOffset,
    mutationTrackHeight: posMutH,
  } = pos;
  const bottomStrandBottom = sequenceY + rowHeight * 2 + posMutH;
  const wasHorizontallyOffset = Math.abs(labelX - idealLabelX) > 2;
  const wasVerticallyOffset = primerLaneOffset > 0;

  if (wasHorizontallyOffset || wasVerticallyOffset) {
    const labelTopCenterX = labelX + labelWidth / 2;
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 0.75;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(bottomCutX, bottomStrandBottom);
    ctx.lineTo(labelTopCenterX, labelY);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  const theme = getCanvasTheme();
  const hoverBg = theme.isDark ? darkenColor(baseColor, 40) : lightenColor(baseColor, 85);
  const defaultBg = getCutSiteLabelBg();

  if (theme.isDark && !isHovered) {
    const prevAlpha = ctx.globalAlpha;
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = defaultBg;
    ctx.fillRect(labelX, labelY, labelWidth, labelHeight);
    ctx.globalAlpha = prevAlpha;
  } else {
    ctx.fillStyle = isHovered ? hoverBg : defaultBg;
    ctx.fillRect(labelX, labelY, labelWidth, labelHeight);
  }

  ctx.strokeStyle = lineColor;
  ctx.lineWidth = isInternal ? 1.75 : 1.25;
  if (isInternal) {
    ctx.setLineDash([...INTERNAL_CUT_SITE_STYLE.labelBorderDash]);
  }
  ctx.strokeRect(labelX, labelY, labelWidth, labelHeight);
  if (isInternal) {
    ctx.setLineDash([]);
  }

  ctx.font = `${isHovered ? 'bold ' : ''}${labelFontSize}px ${fontFamily}`;
  ctx.fillStyle = lineColor;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const labelCapHeight = labelFontSize * 0.7;
  ctx.fillText(
    cutSite.enzyme.name,
    labelX + labelWidth / 2,
    labelY + labelHeight / 2 + labelCapHeight / 2
  );

  if (isInternal) {
    const badgeR = internalCutSiteBadgeRadiusPx(labelHeight);
    const badgeCX = labelX + labelWidth + badgeR + 2;
    const badgeCY = labelY + labelHeight / 2;
    ctx.beginPath();
    ctx.arc(badgeCX, badgeCY, badgeR, 0, Math.PI * 2);
    ctx.fillStyle = INTERNAL_CUT_SITE_STYLE.colorHex;
    ctx.fill();
    ctx.lineWidth = INTERNAL_CUT_SITE_STYLE.badgeStrokeWidth;
    ctx.strokeStyle = INTERNAL_CUT_SITE_STYLE.badgeStrokeHex;
    ctx.stroke();
    ctx.fillStyle = INTERNAL_CUT_SITE_STYLE.badgeGlyphHex;
    ctx.font = internalCutSiteBadgeCanvasFont(badgeR, fontFamily);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(INTERNAL_CUT_SITE_STYLE.badgeChar, badgeCX, badgeCY);
  }

  return {
    cutSite,
    labelBounds: {
      x: labelX,
      y: labelY,
      width: labelWidth,
      height: labelHeight,
    },
    lineIndex: pos.lineIndex,
  };
}

export function drawCutSites(
  ctx: SequenceDrawingContext,
  cutSites: ColoredCutSite[],
  layout: LayoutSnapshot2D,
  config: WorkspaceEditorConfig,
  viewport: { scrollTop: number; height: number } | undefined,
  hoveredCutSite: ColoredCutSite | null,
  showReverseComplement: boolean,
  linePositions: LinePositions[],
  skipLabels: boolean = false,
  hoveredEnzymeName: string | null = null,
  hoveredPosition: { enzymeName: string; position: number } | null = null,
  primers: PrimerDisplay[] = [],
  initialLabelPositions?: Map<number, Array<{ x: number; width: number }>>
): RenderedCutSite[] {
  const renderedSites: RenderedCutSite[] = [];
  const { marginLeft, charWidth, rowHeight } = config;
  const strandCount = showReverseComplement ? 2 : 1;
  const { size: labelFontSize, height: labelHeight } = cutSiteLabelMetrics(
    CUT_SITE_LABEL_BASE_FONT_SIZE
  );

  const linePositionsMap = new Map<Layout2DRow, LinePositions>();
  for (const lp of linePositions) {
    linePositionsMap.set(lp.line, lp);
  }

  const stableSortedSites = [...cutSites].sort((a, b) => a.cutPositionTop - b.cutPositionTop);
  const labelPositionMap = new Map<string, LabelPosition>();
  const labelPositions =
    initialLabelPositions ?? new Map<number, Array<{ x: number; width: number }>>();

  const sequenceLength = layout.sequenceLength || 0;

  const isEnzymeHovered = (site: ColoredCutSite) =>
    (hoveredCutSite?.enzyme.name === site.enzyme.name &&
      hoveredCutSite?.cutPositionTop === site.cutPositionTop) ||
    hoveredEnzymeName === site.enzyme.name ||
    (hoveredPosition !== null &&
      hoveredPosition.enzymeName === site.enzyme.name &&
      hoveredPosition.position - 1 === site.cutPositionTop);

  const labelPadding = 3;
  ctx.font = `${labelFontSize}px ${config.fontFamily}`;
  const labelsToShow = skipLabels
    ? new Set<ColoredCutSite>()
    : selectCutSiteLabelsByDensity(
        stableSortedSites,
        (name) => ctx.measureText(name).width + labelPadding * 2,
        sequenceLength * charWidth,
        isEnzymeHovered
      );

  for (const cutSite of stableSortedSites) {
    const allLines = findAllLinesForPosition(layout.lines, cutSite.cutPositionTop, sequenceLength);
    const line = pickVisibleCutSiteLine(allLines, viewport);
    if (!line) continue;

    const sequenceY = lookupSequenceY(line, linePositionsMap);
    if (sequenceY === undefined) continue;

    const topLocalPos = getLocalPosition(
      cutSite.cutPositionTop,
      line.startPos,
      line.endPos,
      sequenceLength
    );
    const bottomLocalPos = getLocalPosition(
      cutSite.cutPositionBottom,
      line.startPos,
      line.endPos,
      sequenceLength
    );
    const topCutX = marginLeft + topLocalPos * charWidth;
    const bottomCutX = marginLeft + bottomLocalPos * charWidth;

    if (!skipLabels && labelsToShow.has(cutSite)) {
      const key = `${cutSite.enzyme.name}-${cutSite.cutPositionTop}`;
      labelPositionMap.set(
        key,
        layoutCutSiteLabel({
          ctx,
          cutSite,
          line,
          sequenceY,
          topCutX,
          bottomCutX,
          strandCount,
          marginLeft,
          charWidth,
          rowHeight,
          totalWidth: layout.totalWidth,
          sequenceLength,
          labelFontSize,
          labelHeight,
          labelPadding,
          fontFamily: config.fontFamily,
          showPrimers: config.showPrimers,
          primers,
          linePositionsMap,
          labelPositions,
        })
      );
    }
  }

  const hoverSortedSites = [...cutSites].sort((a, b) => {
    const aHovered = isEnzymeHovered(a);
    const bHovered = isEnzymeHovered(b);
    return (aHovered ? 1 : 0) - (bHovered ? 1 : 0);
  });

  for (const cutSite of hoverSortedSites) {
    const isHovered = isEnzymeHovered(cutSite);
    const topLines = findAllLinesForPosition(layout.lines, cutSite.cutPositionTop, sequenceLength);
    const bottomLines = findAllLinesForPosition(
      layout.lines,
      cutSite.cutPositionBottom,
      sequenceLength
    );
    if (topLines.length === 0 && bottomLines.length === 0) continue;

    const { isInternal, baseColor, lineColor, lineWidth } = cutSiteStrokeStyle(cutSite, isHovered);
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = lineWidth;
    ctx.lineJoin = 'miter';
    ctx.lineCap = 'square';

    paintCutSiteStrandMarks({
      ctx,
      cutSite,
      topLines,
      bottomLines,
      viewport,
      linePositionsMap,
      marginLeft,
      charWidth,
      rowHeight,
      strandCount,
      sequenceLength,
    });

    const line = topLines[0] || bottomLines[0];
    if (!line) continue;
    if (skipLabels) continue;
    const pos = labelPositionMap.get(`${cutSite.enzyme.name}-${cutSite.cutPositionTop}`);
    if (!pos) continue;
    renderedSites.push(
      paintCutSiteLabel({
        ctx,
        cutSite,
        pos,
        isHovered,
        isInternal,
        baseColor,
        lineColor,
        rowHeight,
        labelFontSize,
        fontFamily: config.fontFamily,
      })
    );
  }

  return renderedSites;
}

export function hitTestLabel(
  x: number,
  y: number,
  renderedSites: RenderedCutSite[],
  _viewport: { scrollTop: number } | undefined
): ColoredCutSite | null {
  for (const rendered of renderedSites) {
    const bounds = rendered.labelBounds;

    if (
      x >= bounds.x &&
      x <= bounds.x + bounds.width &&
      y >= bounds.y &&
      y <= bounds.y + bounds.height
    ) {
      return rendered.cutSite;
    }
  }
  return null;
}

export function hitTestCutLine(
  x: number,
  y: number,
  cutSites: ColoredCutSite[],
  layout: LayoutSnapshot2D,
  config: WorkspaceEditorConfig,
  viewport: { scrollTop: number } | undefined,
  absoluteLinePositions: LinePositions[] = []
): ColoredCutSite | null {
  const { marginLeft, charWidth, rowHeight } = config;
  const hitTolerance = 5;

  const contentY = viewport ? y + viewport.scrollTop : y;
  const sequenceLength = layout.sequenceLength || 0;

  const lpMap = new Map<Layout2DRow, LinePositions>();
  for (const lp of absoluteLinePositions) {
    lpMap.set(lp.line, lp);
  }

  for (const cutSite of cutSites) {
    const line = findLineForPosition(layout.lines, cutSite.cutPositionTop, sequenceLength);

    if (!line) continue;

    const lp = lpMap.get(line);
    if (!lp) continue;
    const sequenceY = lp.sequenceY;

    const localPos = getLocalPosition(
      cutSite.cutPositionTop,
      line.startPos,
      line.endPos,
      sequenceLength
    );
    const cutX = marginLeft + localPos * charWidth;

    if (Math.abs(x - cutX) <= hitTolerance) {
      const topY = sequenceY;
      const hitMutH = lp.hasMutationTrack ? rowHeight : 0;
      const bottomY = sequenceY + rowHeight * 2 + hitMutH;

      if (contentY >= topY && contentY <= bottomY) {
        return cutSite;
      }
    }
  }

  return null;
}
