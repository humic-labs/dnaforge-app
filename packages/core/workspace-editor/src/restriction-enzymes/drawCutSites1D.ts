import type { ColoredCutSite } from '@waypoint/sequence-utils';
import {
  INTERNAL_CUT_SITE_STYLE,
  internalCutSiteBadgeCanvasFont,
  internalCutSiteBadgeRadiusPx,
} from '@waypoint/sequence-utils';
import type { Layout1D } from '../layout-1d';
import { getCanvasTheme } from '../canvas-theme';
import {
  getCutSiteLabelBg,
  lightenColor,
  darkenColor,
  cutSiteLabelMetrics,
  RECOGNITION_HIGHLIGHT_FILL,
  INTERNAL_RECOGNITION_HIGHLIGHT_FILL,
  getHoveredRecognitionStroke,
  type RenderedCutSite,
} from './cut-site-styling';

const LABEL_PADDING = 3;
const LABEL_GAP_BELOW_STRAND = 4;
const MAX_LABEL_SHIFT_ATTEMPTS = 20;

export interface DrawCutSites1DParams {
  ctx: CanvasRenderingContext2D;
  layout: Layout1D;
  originX: number;
  viewportLeftX: number;
  viewportRightX: number;
  cutSites: ColoredCutSite[];
  scannedCutSites?: ColoredCutSite[];
  baseFontSize: number;
  fontFamily: string;
  showReverseComplement: boolean;
  hoveredEnzymeName: string | null;
  hoveredPositionInfo: {
    enzymeName: string;
    position: number;
    recognitionStart: number;
    recognitionEnd: number;
  } | null;
  hoveredCutSite: ColoredCutSite | null;
}

type CutSiteViewportPaintArgs = {
  ctx: CanvasRenderingContext2D;
  cycleOffsets: number[];
  originX: number;
  pxPerBase: number;
  columnCount: number;
  viewportLeftX: number;
  viewportRightX: number;
  sequenceRowY: number;
  sequenceRowHeight: number;
};

function paintRecognitionHighlights(
  args: CutSiteViewportPaintArgs & { cutSites: ColoredCutSite[] }
): void {
  const {
    ctx,
    cutSites,
    cycleOffsets,
    originX,
    pxPerBase,
    columnCount,
    viewportLeftX,
    viewportRightX,
    sequenceRowY,
    sequenceRowHeight,
  } = args;
  ctx.save();
  for (const cs of cutSites) {
    ctx.fillStyle = cs.isInternalCutSite
      ? INTERNAL_RECOGNITION_HIGHLIGHT_FILL
      : RECOGNITION_HIGHLIGHT_FILL;
    const start0 = cs.recognitionStart;
    const spans = cs.recognitionEnd < cs.recognitionStart;
    const effEnd = spans ? cs.recognitionEnd + columnCount : cs.recognitionEnd;
    const widthBp = effEnd - start0;
    if (widthBp <= 0) continue;
    for (const offset of cycleOffsets) {
      const xL = originX + (start0 + offset) * pxPerBase;
      const xR = xL + widthBp * pxPerBase;
      if (xR < viewportLeftX - 2 || xL > viewportRightX + 2) continue;
      ctx.fillRect(xL, sequenceRowY, xR - xL, sequenceRowHeight);
      ctx.fillRect(xL, sequenceRowY + sequenceRowHeight, xR - xL, sequenceRowHeight);
    }
  }
  ctx.restore();
}

function paintHoveredRecognitionBorders(
  args: CutSiteViewportPaintArgs & {
    cutSites: ColoredCutSite[];
    hoveredCutSite: ColoredCutSite | null;
    hoveredEnzymeName: string | null;
    hoveredPositionInfo: DrawCutSites1DParams['hoveredPositionInfo'];
  }
): void {
  const sitesToBorder = pickSitesForBorder(
    args.cutSites,
    args.hoveredCutSite,
    args.hoveredEnzymeName,
    args.hoveredPositionInfo
  );
  if (sitesToBorder.length === 0) return;
  const {
    ctx,
    cycleOffsets,
    originX,
    pxPerBase,
    columnCount,
    viewportLeftX,
    viewportRightX,
    sequenceRowY,
    sequenceRowHeight,
  } = args;
  const stroke = getHoveredRecognitionStroke();
  ctx.save();
  ctx.strokeStyle = stroke.strokeStyle;
  ctx.lineWidth = stroke.lineWidth;
  for (const site of sitesToBorder) {
    const start0 = site.recognitionStart;
    const spans = site.recognitionEnd < site.recognitionStart;
    const effEnd = spans ? site.recognitionEnd + columnCount : site.recognitionEnd;
    const widthBp = effEnd - start0;
    if (widthBp <= 0) continue;
    for (const offset of cycleOffsets) {
      const xL = originX + (start0 + offset) * pxPerBase;
      const xR = xL + widthBp * pxPerBase;
      if (xR < viewportLeftX - 2 || xL > viewportRightX + 2) continue;
      ctx.strokeRect(xL, sequenceRowY, xR - xL, sequenceRowHeight * 2);
    }
  }
  ctx.restore();
}

function paintViewportCutSiteTicks(
  args: {
    ctx: CanvasRenderingContext2D;
    sites: ColoredCutSite[];
    cycleOffsets: number[];
    originX: number;
    pxPerBase: number;
    viewportLeftX: number;
    viewportRightX: number;
    topStrandTop: number;
    sequenceRowY: number;
    sequenceRowHeight: number;
    bottomStrandBottom: number;
  },
  styleForSite?: (cs: ColoredCutSite) => { strokeStyle: string; lineWidth: number }
): void {
  const {
    ctx,
    sites,
    cycleOffsets,
    originX,
    pxPerBase,
    viewportLeftX,
    viewportRightX,
    topStrandTop,
    sequenceRowY,
    sequenceRowHeight,
    bottomStrandBottom,
  } = args;
  for (const cs of sites) {
    if (styleForSite) {
      const style = styleForSite(cs);
      ctx.strokeStyle = style.strokeStyle;
      ctx.lineWidth = style.lineWidth;
    }
    for (const offset of cycleOffsets) {
      const topCutX = originX + (cs.cutPositionTop + offset) * pxPerBase;
      const bottomCutX = originX + (cs.cutPositionBottom + offset) * pxPerBase;
      if (
        Math.max(topCutX, bottomCutX) < viewportLeftX - 2 ||
        Math.min(topCutX, bottomCutX) > viewportRightX + 2
      ) {
        continue;
      }
      drawTickPath(
        ctx,
        topCutX,
        bottomCutX,
        topStrandTop,
        sequenceRowY + sequenceRowHeight,
        bottomStrandBottom
      );
    }
  }
}

function paintScannedCutSiteTicks(args: {
  ctx: CanvasRenderingContext2D;
  scannedCutSites: ColoredCutSite[];
  cycleOffsets: number[];
  originX: number;
  pxPerBase: number;
  viewportLeftX: number;
  viewportRightX: number;
  topStrandTop: number;
  sequenceRowY: number;
  sequenceRowHeight: number;
  bottomStrandBottom: number;
}): void {
  args.ctx.save();
  args.ctx.strokeStyle = 'rgba(128, 128, 128, 0.55)';
  args.ctx.lineWidth = 1;
  args.ctx.lineJoin = 'miter';
  args.ctx.lineCap = 'square';
  paintViewportCutSiteTicks({ ...args, sites: args.scannedCutSites });
  args.ctx.restore();
}

type CutSiteLabelPos = {
  cs: ColoredCutSite;
  offset: number;
  topCutX: number;
  bottomCutX: number;
  labelX: number;
  idealLabelX: number;
  labelWidth: number;
};

function placeCutSiteLabels(args: {
  ctx: CanvasRenderingContext2D;
  cutSites: ColoredCutSite[];
  cycleOffsets: number[];
  originX: number;
  pxPerBase: number;
  viewportLeftX: number;
  viewportRightX: number;
  labelFontSize: number;
  fontFamily: string;
}): CutSiteLabelPos[] {
  const labelPositions: CutSiteLabelPos[] = [];
  const occupied: Array<{ x: number; width: number }> = [];
  args.ctx.font = `${args.labelFontSize}px ${args.fontFamily}`;
  const sortedSites = [...args.cutSites].sort((a, b) => a.cutPositionTop - b.cutPositionTop);
  for (const cs of sortedSites) {
    const labelWidth = args.ctx.measureText(cs.enzyme.name).width + LABEL_PADDING * 2;
    for (const offset of args.cycleOffsets) {
      const topCutX = args.originX + (cs.cutPositionTop + offset) * args.pxPerBase;
      const bottomCutX = args.originX + (cs.cutPositionBottom + offset) * args.pxPerBase;
      const minX = Math.min(topCutX, bottomCutX) - labelWidth / 2 - 2;
      const maxX = Math.max(topCutX, bottomCutX) + labelWidth / 2 + 2;
      if (maxX < args.viewportLeftX || minX > args.viewportRightX) continue;

      const idealLabelX = bottomCutX - labelWidth / 2;
      let labelX = idealLabelX;
      for (let attempt = 0; attempt < MAX_LABEL_SHIFT_ATTEMPTS; attempt++) {
        let hit = false;
        for (const ex of occupied) {
          if (labelX < ex.x + ex.width + 2 && labelX + labelWidth > ex.x - 2) {
            labelX = ex.x + ex.width + 4;
            hit = true;
            break;
          }
        }
        if (!hit) break;
      }
      occupied.push({ x: labelX, width: labelWidth });
      labelPositions.push({
        cs,
        offset,
        topCutX,
        bottomCutX,
        labelX,
        idealLabelX,
        labelWidth,
      });
    }
  }
  return labelPositions;
}

function paintCutSiteLabels(args: {
  ctx: CanvasRenderingContext2D;
  labelPositions: CutSiteLabelPos[];
  isHovered: (cs: ColoredCutSite) => boolean;
  labelY: number;
  labelHeight: number;
  labelFontSize: number;
  fontFamily: string;
  bottomStrandBottom: number;
  rendered: RenderedCutSite[];
}): void {
  const theme = getCanvasTheme();
  const { ctx, labelY, labelHeight, labelFontSize, fontFamily, bottomStrandBottom, rendered } =
    args;
  for (const lp of args.labelPositions) {
    const { cs, topCutX, bottomCutX, labelX, idealLabelX, labelWidth } = lp;
    const hovered = args.isHovered(cs);
    const baseColor = cs.color;
    const lineColor = hovered ? lightenColor(baseColor, 20) : baseColor;
    const wasShifted = Math.abs(labelX - idealLabelX) > 2;
    if (wasShifted) {
      ctx.save();
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 0.75;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(bottomCutX, bottomStrandBottom);
      ctx.lineTo(labelX + labelWidth / 2, labelY);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
    const hoverBg = theme.isDark ? darkenColor(baseColor, 40) : lightenColor(baseColor, 85);
    const defaultBg = getCutSiteLabelBg();
    if (theme.isDark && !hovered) {
      const prevAlpha = ctx.globalAlpha;
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = defaultBg;
      ctx.fillRect(labelX, labelY, labelWidth, labelHeight);
      ctx.globalAlpha = prevAlpha;
    } else {
      ctx.fillStyle = hovered ? hoverBg : defaultBg;
      ctx.fillRect(labelX, labelY, labelWidth, labelHeight);
    }
    const isInternal = cs.isInternalCutSite === true;
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = isInternal ? 1.75 : 1.25;
    if (isInternal) {
      ctx.setLineDash([...INTERNAL_CUT_SITE_STYLE.labelBorderDash]);
    }
    ctx.strokeRect(labelX, labelY, labelWidth, labelHeight);
    if (isInternal) {
      ctx.setLineDash([]);
    }
    ctx.font = `${hovered ? 'bold ' : ''}${labelFontSize}px ${fontFamily}`;
    ctx.fillStyle = lineColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(cs.enzyme.name, labelX + labelWidth / 2, labelY + labelHeight / 2);
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
    void topCutX;
    rendered.push({
      cutSite: cs,
      labelBounds: { x: labelX, y: labelY, width: labelWidth, height: labelHeight },
      lineIndex: 0,
    });
  }
}

function paintActiveCutSiteTicks(args: {
  ctx: CanvasRenderingContext2D;
  cutSites: ColoredCutSite[];
  isHovered: (cs: ColoredCutSite) => boolean;
  cycleOffsets: number[];
  originX: number;
  pxPerBase: number;
  viewportLeftX: number;
  viewportRightX: number;
  topStrandTop: number;
  sequenceRowY: number;
  sequenceRowHeight: number;
  bottomStrandBottom: number;
}): void {
  const sortedByHover = [...args.cutSites].sort((a, b) => {
    const aH = args.isHovered(a) ? 1 : 0;
    const bH = args.isHovered(b) ? 1 : 0;
    return aH - bH;
  });
  args.ctx.lineJoin = 'miter';
  args.ctx.lineCap = 'square';
  paintViewportCutSiteTicks({ ...args, sites: sortedByHover }, (cs) => {
    const hovered = args.isHovered(cs);
    return {
      strokeStyle: hovered ? lightenColor(cs.color, 20) : cs.color,
      lineWidth: cs.isInternalCutSite ? INTERNAL_CUT_SITE_STYLE.lineWidth : hovered ? 2.5 : 1,
    };
  });
}

export function drawCutSites1D(params: DrawCutSites1DParams): RenderedCutSite[] {
  const {
    ctx,
    layout,
    originX,
    viewportLeftX,
    viewportRightX,
    cutSites,
    scannedCutSites = [],
    baseFontSize,
    fontFamily,
    showReverseComplement,
    hoveredEnzymeName,
    hoveredPositionInfo,
    hoveredCutSite,
  } = params;

  const rendered: RenderedCutSite[] = [];

  if (!showReverseComplement) return rendered;
  if (cutSites.length === 0 && scannedCutSites.length === 0) return rendered;

  const { pxPerBase, columnCount, isCircular, sequenceRowY, sequenceRowHeight, cutSiteLabelRowY } =
    layout;
  const cycleOffsets: number[] = isCircular ? [-columnCount, 0, columnCount] : [0];

  const labelMetrics = cutSiteLabelMetrics(baseFontSize);
  const labelFontSize = labelMetrics.size;
  const labelHeight = labelMetrics.height;

  const topStrandTop = sequenceRowY;
  const bottomStrandBottom = sequenceRowY + sequenceRowHeight * 2;
  const labelY = cutSiteLabelRowY + LABEL_GAP_BELOW_STRAND;

  const isHovered = (cs: ColoredCutSite): boolean => {
    if (
      hoveredCutSite !== null &&
      hoveredCutSite.enzyme.name === cs.enzyme.name &&
      hoveredCutSite.cutPositionTop === cs.cutPositionTop
    ) {
      return true;
    }
    if (hoveredEnzymeName !== null && hoveredEnzymeName === cs.enzyme.name) return true;
    if (
      hoveredPositionInfo !== null &&
      hoveredPositionInfo.enzymeName === cs.enzyme.name &&
      hoveredPositionInfo.position - 1 === cs.cutPositionTop
    ) {
      return true;
    }
    return false;
  };

  paintRecognitionHighlights({
    ctx,
    cutSites,
    cycleOffsets,
    originX,
    pxPerBase,
    columnCount,
    viewportLeftX,
    viewportRightX,
    sequenceRowY,
    sequenceRowHeight,
  });
  paintHoveredRecognitionBorders({
    ctx,
    cutSites,
    hoveredCutSite,
    hoveredEnzymeName,
    hoveredPositionInfo,
    cycleOffsets,
    originX,
    pxPerBase,
    columnCount,
    viewportLeftX,
    viewportRightX,
    sequenceRowY,
    sequenceRowHeight,
  });

  const labelPositions = placeCutSiteLabels({
    ctx,
    cutSites,
    cycleOffsets,
    originX,
    pxPerBase,
    viewportLeftX,
    viewportRightX,
    labelFontSize,
    fontFamily,
  });

  paintScannedCutSiteTicks({
    ctx,
    scannedCutSites,
    cycleOffsets,
    originX,
    pxPerBase,
    viewportLeftX,
    viewportRightX,
    topStrandTop,
    sequenceRowY,
    sequenceRowHeight,
    bottomStrandBottom,
  });
  paintActiveCutSiteTicks({
    ctx,
    cutSites,
    isHovered,
    cycleOffsets,
    originX,
    pxPerBase,
    viewportLeftX,
    viewportRightX,
    topStrandTop,
    sequenceRowY,
    sequenceRowHeight,
    bottomStrandBottom,
  });

  paintCutSiteLabels({
    ctx,
    labelPositions,
    isHovered,
    labelY,
    labelHeight,
    labelFontSize,
    fontFamily,
    bottomStrandBottom,
    rendered,
  });

  return rendered;
}

function pickSitesForBorder(
  cutSites: ColoredCutSite[],
  hoveredCutSite: ColoredCutSite | null,
  hoveredEnzymeName: string | null,
  hoveredPositionInfo: {
    enzymeName: string;
    position: number;
    recognitionStart: number;
    recognitionEnd: number;
  } | null
): ColoredCutSite[] {
  if (hoveredCutSite) return [hoveredCutSite];
  if (hoveredPositionInfo) {
    const match = cutSites.find(
      (cs) =>
        cs.enzyme.name === hoveredPositionInfo.enzymeName &&
        cs.cutPositionTop === hoveredPositionInfo.position - 1
    );
    return match ? [match] : [];
  }
  if (hoveredEnzymeName) {
    return cutSites.filter((cs) => cs.enzyme.name === hoveredEnzymeName);
  }
  return [];
}

export function hitTestCutSiteLabel1D(
  rendered: RenderedCutSite[],
  layoutX: number,
  layoutY: number
): RenderedCutSite | null {
  for (const r of rendered) {
    const b = r.labelBounds;
    if (layoutX >= b.x && layoutX <= b.x + b.width && layoutY >= b.y && layoutY <= b.y + b.height) {
      return r;
    }
  }
  return null;
}

function drawTickPath(
  ctx: CanvasRenderingContext2D,
  topCutX: number,
  bottomCutX: number,
  topStrandTop: number,
  strandBoundary: number,
  bottomStrandBottom: number
): void {
  ctx.beginPath();
  ctx.moveTo(topCutX, topStrandTop);
  ctx.lineTo(topCutX, strandBoundary);
  if (topCutX !== bottomCutX) {
    ctx.lineTo(bottomCutX, strandBoundary);
  }
  ctx.lineTo(bottomCutX, bottomStrandBottom);
  ctx.stroke();
}
