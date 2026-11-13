import { rectangleContour, type OutlinePoint } from '@waypoint/platform';
import {
  cdsDetailProgress,
  cdsPresentationGeometry,
  cdsPresentationPhases,
} from './cds-presentation';
import { CDS_GLYPH_STYLE, indexedCodonLettersVisible } from '@waypoint/platform';
import {
  paintCdsGlyph,
  paintCdsGlyphLabels,
  paintCdsGlyphOutline,
  paintCdsBarColors,
  type CdsGlyphPaintPlan,
  pathContour,
} from './cds-glyph-drawing';
import { paintCdsCompoundChip } from './cds-chip-drawing';
import { placeCompoundLabels } from './compound-label-layout';
import { paintTranscriptGlyph, type IntronConnectorStroke } from './transcript-drawing';
import { TRANSLATION_PILL_HEIGHT } from './layout-constants';
import type { SequenceDrawingContext } from './rendering/drawing-context';

import { getAnnotationDisplayColor, rangeOverlapsInsertions, getCDSVisibleSegments } from './utils';
import { parseAnyColorToRgb } from './utils/color-utils';
import {
  annotationRenderState,
  annotationOutlineStrokeSpec,
  paintAnnotationOutline,
} from './annotation-render-state';
import {
  ANNOTATION_DRAFT_OUTLINE_ALPHA,
  ANNOTATION_DRAFT_OUTLINE_DASH,
  ANNOTATION_DRAFT_OUTLINE_WIDTH,
  resolveAnnotationDraftStyle,
} from './annotation-draft-style';

import {
  CHEVRON_WIDTH_RATIO,
  getCodonLetterPosition,
  drawChevronSeparatorLine,
  drawChevronRect,
  buildCodonCellPath,
  buildChevronStripOuterPath,
  buildChevronStripInteriorDividersPath,
} from './rendering';

import {
  getCodonsForSingleCDS,
  getCodonsForLine,
  getDraftCodonsForCDS,
  getDeletedCodons,
  getFrameshiftRanges,
  getAlignmentCodonsForCDS,
  computeAllAlignmentCodons,
  filterAlignmentCodonsForLine,
  isSplicedCDS,
} from './translation';

import {
  codonLabelThatFits,
  nonStandardResidueColor,
  type CodonDisplay,
} from '@waypoint/sequence-utils';
import {
  CDS_MUTATION_MARKUP,
  sequenceEditMarkupCss,
} from '@waypoint/sequence-utils/sequence-edit-markup';
import type { GeneticCodeSpec } from '@waypoint/sequence-utils';
import type { Annotation, CdsExtensionDirection } from '@waypoint/sequence-utils';
import { computeCodonCells, fillCodonCells, type CodonMode } from './codon-rendering';
import { repeatedTextPainter } from './rendering/repeated-text';
import {
  arrowRectForEnd,
  type CdsExtensionArrowBounds,
  drawCdsExtensionArrow,
  cdsExtensionOriginalBounds,
  cdsExtensionHoveredEnds,
  cdsExtensionPreviewEnds,
  cdsExtensionPreviewDirection,
  isPredictedCodonCell,
  cdsExtensionKeyFor as cdsExtensionKey,
  incompleteCdsEnds,
} from './cds-extension-affordance';
import { paintSplicedCdsIntronConnectors } from './translation-drawing-introns';
import { paintCdsResidueNumbers } from './translation-drawing-residue-numbers';

import type { CodonInfo, DraftCodonInfo, AlignmentCodonInfo } from './translation';

export {
  isPositionDeleted,
  countDeletedBefore,
  effectiveToVisual,
  rangeOverlapsInsertions,
} from './utils';

export {
  getCodonsForSingleCDS,
  getCodonsForLine,
  getDraftCodonsForCDS,
  getDeletedCodons,
  getFrameshiftRanges,
  getAlignmentCodonsForCDS,
  computeAllAlignmentCodons,
  filterAlignmentCodonsForLine,
};
export type { CodonInfo, DraftCodonInfo, AlignmentCodonInfo };

type SelectedCodonOutlineDiagnostic = {
  renderedAt: number;
  viewer: '1d' | '2d';
  start: number;
  end: number;
  strand: 1 | -1;
  lineStartPos: number;
  lineEndPos: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

type HoveredCodonOutlineDiagnostic = SelectedCodonOutlineDiagnostic & {
  source?: 'sequence' | 'structure';
};

const CDS_CODON_CELL_BORDER_LIGHT = 'rgba(156, 163, 175, 0.38)';
const CDS_CODON_CELL_BORDER_DARK = 'rgba(156, 163, 175, 0.3)';

function cdsCodonCellBorderColor(isDark: boolean): string {
  return isDark ? CDS_CODON_CELL_BORDER_DARK : CDS_CODON_CELL_BORDER_LIGHT;
}

function recordHoveredCodonOutlineDraw(event: HoveredCodonOutlineDiagnostic): void {
  if (typeof window === 'undefined') return;
  const env = (import.meta as ImportMeta & { env?: { DEV?: boolean; MODE?: string } }).env;
  if (env?.DEV !== true && env?.MODE !== 'test') return;
  const target = window as typeof window & {
    __WAYPOINT_HOVERED_CODON_OUTLINE_DRAWS__?: {
      last: HoveredCodonOutlineDiagnostic | null;
      events: HoveredCodonOutlineDiagnostic[];
    };
  };
  const current = target.__WAYPOINT_HOVERED_CODON_OUTLINE_DRAWS__ ?? {
    last: null,
    events: [],
  };
  target.__WAYPOINT_HOVERED_CODON_OUTLINE_DRAWS__ = {
    last: event,
    events: [...current.events, event].slice(-200),
  };
}

function recordSelectedCodonOutlineDraw(event: SelectedCodonOutlineDiagnostic): void {
  if (typeof window === 'undefined') return;
  const env = (import.meta as ImportMeta & { env?: { DEV?: boolean; MODE?: string } }).env;
  if (env?.DEV !== true && env?.MODE !== 'test') return;
  const target = window as typeof window & {
    __WAYPOINT_SELECTED_CODON_OUTLINE_DRAWS__?: {
      last: SelectedCodonOutlineDiagnostic | null;
      events: SelectedCodonOutlineDiagnostic[];
    };
  };
  const current = target.__WAYPOINT_SELECTED_CODON_OUTLINE_DRAWS__ ?? {
    last: null,
    events: [],
  };
  target.__WAYPOINT_SELECTED_CODON_OUTLINE_DRAWS__ = {
    last: event,
    events: [...current.events, event].slice(-200),
  };
}

import type {
  InsertedRange,
  DeletedRange,
  WorkspaceEditorConfig,
  ClassifiedCDS,
  ExonPillBound,
} from './types';

import {
  getCanvasTheme,
  molstarHoverColorRgb,
  molstarSelectionColorRgb,
  PLANNOTATE_DRAFT_OUTLINE_ALPHA,
  PLANNOTATE_DRAFT_FAINT_ALPHA,
} from './canvas-theme';
import { tintedTextColor, adaptColorForDark, isLightColor } from './canvas-colors';
import { getAAScheme } from '@waypoint/sequence-utils';
import { DEFAULT_MUTED_COLUMN_COLOR, rangeOverlapsMutedColumns } from './muted-columns';
import {
  TRANSLATION_AA_HEIGHT_RATIO,
  TRANSLATION_LABEL_HEIGHT,
  TRANSLATION_LABEL_FONT_SIZE,
  TRANSLATION_LETTER_SCALE,
} from './layout-constants';

function adaptAAColorForDark(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  const r = parseInt(m[1], 16) / 255;
  const g = parseInt(m[2], 16) / 255;
  const b = parseInt(m[3], 16) / 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0,
    s = 0;
  if (d > 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  const lAdj = 30 + l * 18;
  const sAdj = s * 100 * 0.7;
  const hDeg = Math.round(h * 360);
  return `hsl(${hDeg}, ${Math.round(sAdj)}%, ${Math.round(lAdj)}%)`;
}

function desaturateColorForMutedChevron(color: string, isDark: boolean): string | null {
  const rgb = parseAnyColorToRgb(color);
  if (!rgb) return null;

  const gray = Math.round(rgb.r * 0.299 + rgb.g * 0.587 + rgb.b * 0.114);
  const saturationKeep = isDark ? 0.28 : 0.22;
  const r = Math.round(gray + (rgb.r - gray) * saturationKeep);
  const g = Math.round(gray + (rgb.g - gray) * saturationKeep);
  const b = Math.round(gray + (rgb.b - gray) * saturationKeep);
  return `rgb(${r}, ${g}, ${b})`;
}

function fadeColor(color: string, alpha: number, fallback: string): string {
  const rgb = parseAnyColorToRgb(color);
  if (!rgb) return fallback;
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

const LABEL_VISUAL_GAP = 1;

const SEPARATOR_LINE_PADDING_RATIO = 0.15;

const AA_FONT_SIZE_RATIO = 1.27;

export interface AlignmentModeOptions {
  alignedRef: string;
  alignedQuery: string;
}

function paintUncheckedDraftChevrons(args: {
  ctx: SequenceDrawingContext;
  renderData: Parameters<typeof buildChevronStripOuterPath>[1];
  aaY: number;
  aaTrackHeight: number;
  chevronDepth: number;
  direction: 1 | -1;
  borderColor: string;
}): void {
  args.ctx.save();
  args.ctx.strokeStyle = args.borderColor;
  args.ctx.lineWidth = 1.25;
  args.ctx.globalAlpha = PLANNOTATE_DRAFT_FAINT_ALPHA;
  buildChevronStripInteriorDividersPath(
    args.ctx,
    args.renderData,
    args.aaY,
    args.aaTrackHeight,
    args.chevronDepth,
    args.direction
  );
  args.ctx.stroke();
  args.ctx.restore();
  args.ctx.save();
  args.ctx.strokeStyle = args.borderColor;
  args.ctx.lineWidth = 1.5;
  args.ctx.globalAlpha = PLANNOTATE_DRAFT_OUTLINE_ALPHA;
  buildChevronStripOuterPath(
    args.ctx,
    args.renderData,
    args.aaY,
    args.aaTrackHeight,
    args.chevronDepth,
    args.direction
  );
  args.ctx.stroke();
  args.ctx.restore();
}

function isCdsPreviewTarget(
  alignmentMode: AlignmentModeOptions | undefined,
  previewCDS: Annotation | null | undefined,
  cds: { start: number; end: number }
): boolean {
  return (
    !alignmentMode &&
    Boolean(previewCDS) &&
    cds.start === previewCDS!.start &&
    cds.end === previewCDS!.end
  );
}

function paintCdsPreviewHighlight(args: {
  ctx: SequenceDrawingContext;
  cds: Annotation;
  renderData: Parameters<typeof buildChevronStripOuterPath>[1];
  aaY: number;
  aaTrackHeight: number;
  chevronDepth: number;
  direction: 1 | -1;
}): void {
  const isSpliced = isSplicedCDS(args.cds);
  const intronRanges = isSpliced
    ? args.cds.segments!.slice(0, -1).map((seg, i) => ({
        start: seg.end,
        end: args.cds.segments![i + 1]!.start - 2,
      }))
    : [];
  for (const rd of args.renderData) {
    if (rd.genomicStart === undefined) continue;
    let inIntron = false;
    for (const ir of intronRanges) {
      if (rd.genomicStart >= ir.start && rd.genomicStart <= ir.end) {
        inIntron = true;
        break;
      }
    }
    if (inIntron) continue;
    buildCodonCellPath(
      args.ctx,
      rd.codonX,
      args.aaY,
      rd.visibleWidth,
      args.aaTrackHeight,
      args.chevronDepth,
      args.direction,
      rd.leftEdge,
      rd.rightEdge
    );
    args.ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
    args.ctx.globalAlpha = 1.0;
    args.ctx.fill();
    args.ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
    args.ctx.lineWidth = 2;
    args.ctx.globalAlpha = 1.0;
    args.ctx.stroke();
    args.ctx.globalAlpha = 1.0;
  }
}

function paintHoveredCodonCellOutlines(args: {
  ctx: SequenceDrawingContext;
  renderData: Parameters<typeof buildChevronStripOuterPath>[1];
  hoveredCodon: {
    start: number;
    end: number;
    strand: 1 | -1;
    source?: 'sequence' | 'structure';
  };
  direction: 1 | -1;
  isDark: boolean;
  aaY: number;
  aaTrackHeight: number;
  chevronDepth: number;
  lineStartPos: number;
  lineEndPos: number;
  skipLabels?: boolean;
}): void {
  if (args.hoveredCodon.strand !== args.direction) return;
  const [pr, pg, pb] = molstarHoverColorRgb(args.isDark);
  const hoverPink = `rgba(${pr}, ${pg}, ${pb}, 0.95)`;
  for (const rd of args.renderData) {
    if (rd.genomicStart === undefined || rd.genomicEnd === undefined) continue;
    if (rd.genomicStart !== args.hoveredCodon.start || rd.genomicEnd !== args.hoveredCodon.end) {
      continue;
    }
    recordHoveredCodonOutlineDraw({
      renderedAt: performance.now(),
      viewer: args.skipLabels ? '1d' : '2d',
      start: rd.genomicStart,
      end: rd.genomicEnd,
      strand: args.direction,
      source: args.hoveredCodon.source,
      lineStartPos: args.lineStartPos,
      lineEndPos: args.lineEndPos,
      x: rd.codonX,
      y: args.aaY,
      width: rd.visibleWidth,
      height: args.aaTrackHeight,
    });
    args.ctx.save();
    args.ctx.setLineDash([]);
    args.ctx.strokeStyle = hoverPink;
    args.ctx.lineWidth = 2.5;
    args.ctx.beginPath();
    buildCodonCellPath(
      args.ctx,
      rd.codonX,
      args.aaY,
      rd.visibleWidth,
      args.aaTrackHeight,
      args.chevronDepth,
      args.direction,
      rd.leftEdge,
      rd.rightEdge
    );
    args.ctx.stroke();
    args.ctx.restore();
  }
}

function paintSelectedCodonCellOutlines(args: {
  ctx: SequenceDrawingContext;
  renderData: Parameters<typeof buildChevronStripOuterPath>[1];
  selectedCodons: ReadonlyArray<{ start: number; end: number; strand: 1 | -1 }>;
  direction: 1 | -1;
  isDark: boolean;
  aaY: number;
  aaTrackHeight: number;
  chevronDepth: number;
  lineStartPos: number;
  lineEndPos: number;
  skipLabels?: boolean;
}): void {
  const onThisStrand = args.selectedCodons.filter((s) => s.strand === args.direction);
  if (onThisStrand.length === 0) return;
  const [sr, sg, sb] = molstarSelectionColorRgb(args.isDark);
  const molstarSelectStroke = `rgba(${sr}, ${sg}, ${sb}, 0.95)`;
  const selectedKeys = new Set(onThisStrand.map((s) => `${s.start}:${s.end}`));
  for (const rd of args.renderData) {
    if (rd.genomicStart === undefined || rd.genomicEnd === undefined) continue;
    if (!selectedKeys.has(`${rd.genomicStart}:${rd.genomicEnd}`)) continue;
    recordSelectedCodonOutlineDraw({
      renderedAt: performance.now(),
      viewer: args.skipLabels ? '1d' : '2d',
      start: rd.genomicStart,
      end: rd.genomicEnd,
      strand: args.direction,
      lineStartPos: args.lineStartPos,
      lineEndPos: args.lineEndPos,
      x: rd.codonX,
      y: args.aaY,
      width: rd.visibleWidth,
      height: args.aaTrackHeight,
    });
    paintAnnotationOutline(args.ctx, 'selected', molstarSelectStroke, (c) => {
      c.beginPath();
      buildCodonCellPath(
        c,
        rd.codonX,
        args.aaY,
        rd.visibleWidth,
        args.aaTrackHeight,
        args.chevronDepth,
        args.direction,
        rd.leftEdge,
        rd.rightEdge
      );
      c.stroke();
    });
  }
}

function paintCdsChevronInteractionOutline(args: {
  ctx: SequenceDrawingContext;
  cds: Annotation;
  renderData: Parameters<typeof buildChevronStripOuterPath>[1];
  direction: 1 | -1;
  aaY: number;
  aaTrackHeight: number;
  chevronDepth: number;
  isDark: boolean;
  annotationRenderStateInput?: import('./annotation-render-state').AnnotationRenderStateInput;
}): void {
  const chevState = annotationRenderState(args.cds, args.annotationRenderStateInput);
  const chevAlpha = annotationOutlineStrokeSpec(chevState)?.alpha ?? 0.95;
  const chevColor = args.isDark
    ? `rgba(160, 160, 160, ${chevAlpha})`
    : `rgba(90, 90, 90, ${chevAlpha})`;
  const cellsByX =
    args.direction === -1
      ? [...args.renderData].sort((a, b) => a.codonX - b.codonX)
      : args.renderData;
  paintAnnotationOutline(args.ctx, chevState, chevColor, (c) => {
    buildChevronStripOuterPath(
      c,
      cellsByX,
      args.aaY,
      args.aaTrackHeight,
      args.chevronDepth,
      args.direction
    );
    c.stroke();
  });
}

function paintCdsDraftOutline(args: {
  ctx: SequenceDrawingContext;
  renderData: Parameters<typeof buildChevronStripOuterPath>[1];
  direction: 1 | -1;
  aaY: number;
  aaTrackHeight: number;
  chevronDepth: number;
  cdsColor: string;
}): void {
  const cellsByX =
    args.direction === -1
      ? [...args.renderData].sort((a, b) => a.codonX - b.codonX)
      : args.renderData;
  args.ctx.save();
  args.ctx.setLineDash([...ANNOTATION_DRAFT_OUTLINE_DASH]);
  args.ctx.strokeStyle = args.cdsColor;
  args.ctx.lineWidth = ANNOTATION_DRAFT_OUTLINE_WIDTH;
  args.ctx.globalAlpha = ANNOTATION_DRAFT_OUTLINE_ALPHA;
  buildChevronStripOuterPath(
    args.ctx,
    cellsByX,
    args.aaY,
    args.aaTrackHeight,
    args.chevronDepth,
    args.direction
  );
  args.ctx.stroke();
  args.ctx.restore();
}

const CDS_EXTENSION_PREDICTED_FILL = '#9ca3af';

function stripPreviewCodonStart(
  qualifiers: Record<string, string[]> | undefined
): Record<string, string[]> | undefined {
  if (!qualifiers) return qualifiers;
  const { codon_start: _dropped, ...rest } = qualifiers;
  return rest;
}

function parseCodonStartQualifier(
  qualifiers: Record<string, string[]> | undefined
): 1 | 2 | 3 | undefined {
  const raw = qualifiers?.codon_start?.[0];
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return parsed === 2 ? 2 : parsed === 3 ? 3 : 1;
}

function parseGeneticCodeQualifier(
  qualifiers: Record<string, string[]> | undefined
): number | undefined {
  const raw = qualifiers?.transl_table?.[0];
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}

export interface CdsExtensionRenderOptions {
  isCircularSequence?: boolean;
  contentRightX?: number;
  arrowRightX?: number;
  emitArrows?: boolean;
}

export const singleRowChevronOutlines = new WeakMap<ClassifiedCDS, OutlinePoint[][]>();

type CdsForeground = { glyph: CdsGlyphPaintPlan; cds: ClassifiedCDS; color: string };

function paintCdsForegrounds(
  ctx: SequenceDrawingContext,
  foregrounds: readonly CdsForeground[],
  fontFamily: string
): void {
  for (const { glyph, cds, color } of foregrounds)
    paintCdsGlyphLabels(ctx, glyph, cds, color, fontFamily);
  for (const { glyph, cds } of foregrounds) paintCdsGlyphOutline(ctx, glyph, cds);
}

export function drawTranslation(
  ctx: SequenceDrawingContext,
  sequence: string,
  classifiedCDSs: ClassifiedCDS[],
  lineStartPos: number,
  lineEndPos: number,
  x: number,
  y: number,
  config: WorkspaceEditorConfig,
  fullSequence: string,
  insertedRanges: InsertedRange[] = [],
  deletedRanges: DeletedRange[] = [],
  _overlayLaneCount: number = 0,
  _overlaySegments: unknown[] = [],
  alignmentMode?: AlignmentModeOptions,
  precomputedAlignmentCodons?: Map<string, AlignmentCodonInfo[]>,
  previewCDS?: Annotation | null,
  annotationRenderStateInput?: import('./annotation-render-state').AnnotationRenderStateInput,
  translationOptions?: {
    skipLabels?: boolean;
    annotationY?: number;
    geneticCode?: GeneticCodeSpec;
    geneticCodeBasis?: import('@waypoint/sequence-utils').RecordGeneticCodeBasis;
    mutedColumns?: ReadonlySet<number> | undefined;
    mutedColumnColor?: string | undefined;
    viewportLeftX?: number;
    viewportRightX?: number;
    onIntronConnector?: (
      stroke: IntronConnectorStroke & { source: 'cds-bar' | 'amino-acid' }
    ) => void;
  },
  hoveredCodon?: {
    start: number;
    end: number;
    strand: 1 | -1;
    source?: 'sequence' | 'structure';
  } | null,
  selectedCodons?: ReadonlyArray<{ start: number; end: number; strand: 1 | -1 }>,
  extensionOptions?: CdsExtensionRenderOptions
): { codons: CodonInfo[]; trackHeight: number; extensionArrows?: CdsExtensionArrowBounds[] } {
  const {
    isCircularSequence,
    contentRightX,
    arrowRightX = contentRightX,
    emitArrows = false,
  } = extensionOptions ?? {};
  const { charWidth, rowHeight, fontFamily, labelFontFamily, fontSize } = config;
  const detailProgress = alignmentMode ? 1 : cdsDetailProgress(config);
  const cohesiveGlyph =
    !alignmentMode && !translationOptions?.skipLabels && config.cdsDetailProgress !== undefined;
  const phases = cdsPresentationPhases(config);
  const aaTrackHeight =
    config.cdsZoomPresentation?.aaHeight ??
    (cohesiveGlyph
      ? CDS_GLYPH_STYLE.thinBandHeight +
        (rowHeight * TRANSLATION_AA_HEIGHT_RATIO - CDS_GLYPH_STYLE.thinBandHeight) *
          phases.bandProgress
      : rowHeight * TRANSLATION_AA_HEIGHT_RATIO * detailProgress);
  const trackHeight = aaTrackHeight;
  const aaFontSize =
    config.cdsZoomPresentation?.aaFontSize ??
    fontSize * AA_FONT_SIZE_RATIO * TRANSLATION_LETTER_SCALE;
  const labelFontSize = TRANSLATION_LABEL_FONT_SIZE;

  if (classifiedCDSs.length === 0) {
    return { codons: [], trackHeight: 0 };
  }

  const isDark = getCanvasTheme().isDark;
  const getCdsColor = (cds: ClassifiedCDS): string =>
    adaptColorForDark(
      getAnnotationDisplayColor(cds, { annotationColorMode: config.annotationColorMode }),
      isDark
    );
  const mutedColumns = translationOptions?.mutedColumns;
  const mutedColumnColor = adaptColorForDark(
    translationOptions?.mutedColumnColor ?? DEFAULT_MUTED_COLUMN_COLOR,
    isDark
  );

  const aaSchemeId = config.aaColorScheme;
  const precomputedAAColors: Record<string, string> | null =
    aaSchemeId && aaSchemeId !== 'none'
      ? Object.fromEntries(
          Object.entries(getAAScheme(aaSchemeId).colors).map(([aa, color]) => [
            aa,
            isDark ? adaptAAColorForDark(color) : color,
          ])
        )
      : null;

  const cellColorFor = (rd: { aa: string; display?: CodonDisplay }): string => {
    if (rd.display?.kind === 'unassigned') return '#9CA3AF';
    const residue = rd.display?.kind === 'residue' ? rd.display.full : null;
    const base = residue
      ? nonStandardResidueColor(residue)
      : (precomputedAAColors?.[rd.aa] ?? null);
    if (!base) return '#9CA3AF';
    return residue && isDark ? adaptAAColorForDark(base) : base;
  };

  const legacyCDSs = classifiedCDSs.filter((cds) => cds.translationLane >= 0);
  for (const cds of legacyCDSs) {
    cds._cdsPillBounds = [];
    cds._cdsLineBounds = [];
    cds._exonPillBounds = [];
    cds._intronPillBounds = [];
    cds._paintedPresentation = undefined;
    cds._interactionOutlineContours = undefined;
  }

  const chevronDepth =
    (config.cdsZoomPresentation
      ? Math.round(aaTrackHeight * CHEVRON_WIDTH_RATIO)
      : aaTrackHeight * CHEVRON_WIDTH_RATIO) * (cohesiveGlyph ? phases.chevronProgress : 1);
  const sequenceLength = fullSequence.length;

  const hasDeletions = deletedRanges.length > 0;
  const hasInsertions = insertedRanges.length > 0;
  const hasDraftEdits = hasDeletions || hasInsertions;

  const labelHeight = TRANSLATION_PILL_HEIGHT;
  const presentationFor = (cds: ClassifiedCDS) =>
    cdsPresentationGeometry(
      cds,
      y,
      translationOptions?.annotationY ?? y,
      alignmentMode ? { ...config, cdsDetailProgress: 1 } : config
    );

  if (!cohesiveGlyph && !alignmentMode && !translationOptions?.skipLabels) {
    const legacyGap = LABEL_VISUAL_GAP;
    legacyCDSs.forEach((cds) => {
      const segments = getCDSVisibleSegments(cds, lineStartPos, lineEndPos, sequenceLength);
      const presentation = presentationFor(cds);
      const laneY = presentation.labelY;
      cds._intronPillBounds = [];
      const cdsColor = getCdsColor(cds);

      const draftStyle = resolveAnnotationDraftStyle(cds);
      const isCdsUncheckedDraft = draftStyle.isHollow;
      const filledDraftAlpha = draftStyle.fillAlpha;
      cds._paintedPresentation = { ...presentation, color: cdsColor, barAlpha: filledDraftAlpha };

      const labelPad = 6;

      paintTranscriptGlyph({
        ctx,
        annotation: cds,
        lineStart: lineStartPos,
        lineEnd: lineEndPos,
        sequenceLength,
        x,
        y: presentation.barY,
        charWidth,
        height: presentation.barHeight,
        color: cdsColor,
        alpha: filledDraftAlpha,
        outlineOnly: isCdsUncheckedDraft,
        showIntronConnectors: false,
        onIntronConnector:
          translationOptions?.onIntronConnector &&
          ((stroke) => translationOptions.onIntronConnector!({ ...stroke, source: 'cds-bar' })),
      });

      const isSpliced = isSplicedCDS(cds, sequenceLength);

      if (isSpliced) {
        ctx.font = `500 ${labelFontSize}px ${labelFontFamily}`;
        const isReverseCDS = (cds.direction ?? 1) === -1;
        const totalExons = cds.segments!.length;
        const lineSpansOrigin = lineStartPos > lineEndPos;
        const firstSegBarX =
          segments.length > 0 ? x + segments[0].charIndexStart * charWidth + legacyGap : x;
        const nameBlockW = ctx.measureText(cds._compactName ?? cds.name).width + labelPad * 2;

        const visibleExons: Array<{ exonNum: number; charIdx: number; segIdx: number }> = [];
        const seenExonNums = new Set<number>();
        for (let si = 0; si < totalExons; si++) {
          const seg = cds.segments![si];
          const segStart0 = seg.start - 1;
          const segEnd0 = seg.end;

          let visible = false;
          let visStart = 0;
          if (lineSpansOrigin) {
            const inPreOrigin = segEnd0 > lineStartPos && segStart0 < sequenceLength;
            const inPostOrigin = segStart0 < lineEndPos && segEnd0 > 0;
            if (inPreOrigin) {
              visible = true;
              visStart = Math.max(segStart0, lineStartPos);
            } else if (inPostOrigin) {
              visible = true;
              visStart = Math.max(segStart0, 0);
            }
          } else {
            if (segEnd0 > lineStartPos && segStart0 < lineEndPos) {
              visible = true;
              visStart = Math.max(segStart0, lineStartPos);
            }
          }
          if (!visible) continue;

          const exonNum = isReverseCDS ? totalExons - si : si + 1;
          if (seenExonNums.has(exonNum)) continue;
          seenExonNums.add(exonNum);
          const charIdx =
            lineSpansOrigin && visStart < lineStartPos
              ? sequenceLength - lineStartPos + visStart
              : visStart - lineStartPos;
          visibleExons.push({ exonNum, charIdx, segIdx: si });
        }

        const rowRight = contentRightX ?? x + config.charsPerLine * charWidth;
        const featureRight = segments.length
          ? x +
            Math.max(
              ...segments.map((segment) => segment.charIndexStart + segment.end - segment.start)
            ) *
              charWidth
          : x;
        const right = featureRight + (rowRight - featureRight) * detailProgress;
        const items = [
          ...(visibleExons.length
            ? [
                {
                  text: cds._compactName ?? cds.name,
                  segIdx: -1,
                  x: firstSegBarX,
                  width: nameBlockW,
                },
              ]
            : []),
          ...(detailProgress > 0 ? visibleExons : [])
            .sort((a, b) => a.charIdx - b.charIdx)
            .map((ve) => {
              const seg = cds.segments![ve.segIdx];
              const text = `exon ${ve.exonNum} (${seg.end - seg.start + 1} bp)`;
              return {
                text,
                segIdx: ve.segIdx,
                x: x + ve.charIdx * charWidth,
                width: (ctx.measureText(text).width + labelPad * 2) * detailProgress,
              };
            }),
        ];
        const pills = placeCompoundLabels(
          items,
          Math.max(x, firstSegBarX),
          right - legacyGap,
          4 * detailProgress
        );
        const exonPillBounds: ExonPillBound[] = [];
        cds._cdsPillBounds = [];
        for (let i = 0; i < pills.length; ) {
          const first = i;
          while (i + 1 < pills.length && pills[i + 1].x <= pills[i].x + pills[i].width + 5) i++;
          paintCdsCompoundChip(
            ctx,
            pills.slice(first, i + 1),
            laneY,
            cds,
            cdsColor,
            labelFontFamily,
            annotationRenderStateInput
          );
          for (let j = first; j <= i; j++) {
            const pill = pills[j];
            if (pill.segIdx >= 0) {
              const seg = cds.segments![pill.segIdx];
              exonPillBounds.push({
                x: pill.x,
                w: pill.width,
                y: laneY,
                h: labelHeight,
                rangeStart: seg.start - 1,
                rangeEnd: seg.end - 1,
              });
            } else cds._cdsPillBounds.push({ x: pill.x, w: pill.width, y: laneY, h: labelHeight });
          }
          i++;
        }
        cds._exonPillBounds = exonPillBounds;
      } else {
        if (segments.length > 0) {
          const firstBarX = x + segments[0].charIndexStart * charWidth + legacyGap;
          ctx.font = `500 ${labelFontSize}px ${labelFontFamily}`;
          const mnw = ctx.measureText(cds._compactName ?? cds.name).width;
          const nbw = Math.max(
            0,
            Math.min(
              mnw + labelPad * 2,
              (segments[0].end - segments[0].start) * charWidth -
                legacyGap +
                ((contentRightX ?? x + config.charsPerLine * charWidth) -
                  (x +
                    (segments[0].charIndexStart + segments[0].end - segments[0].start) *
                      charWidth)) *
                  detailProgress
            )
          );
          cds._cdsPillBounds = nbw > 0 ? [{ x: firstBarX, w: nbw, y: laneY, h: labelHeight }] : [];
          paintCdsCompoundChip(
            ctx,
            [{ text: cds._compactName ?? cds.name, x: firstBarX, width: nbw }],
            laneY,
            cds,
            cdsColor,
            labelFontFamily,
            annotationRenderStateInput
          );
        }
      }
    });
  }

  const paintIntrons = (cds: ClassifiedCDS, glyph?: CdsGlyphPaintPlan) => {
    if (alignmentMode || !isSplicedCDS(cds, sequenceLength)) return;
    const presentation = presentationFor(cds);
    paintSplicedCdsIntronConnectors({
      ctx,
      cds,
      fullSequence,
      lineStartPos,
      lineEndPos,
      sequenceLength,
      x,
      charWidth,
      aaY: presentation.aaY,
      aaTrackHeight,
      lineY: presentation.intronY,
      cohesiveGlyph,
      chevronDepth,
      cdsColor: getCdsColor(cds),
      fontFamily: labelFontFamily,
      translationOptions,
      annotationRenderStateInput,
      onIntronConnector: (stroke) => {
        glyph?.outline?.shapes.push(
          rectangleContour(stroke.x1, stroke.y - 0.5, stroke.x2 - stroke.x1, 1)
        );
        translationOptions?.onIntronConnector?.({ ...stroke, source: 'amino-acid' });
      },
    });
  };
  const foregrounds: CdsForeground[] = [];
  if (detailProgress === 0 || (config.cdsZoomPresentation && phases.colorAlpha === 0)) {
    legacyCDSs.forEach((cds) => {
      const cdsColor = cohesiveGlyph ? getCdsColor(cds) : '';
      const glyph = cohesiveGlyph
        ? paintCdsGlyph({
            ctx,
            cds,
            config,
            fullSequence,
            lineStart: lineStartPos,
            lineEnd: lineEndPos,
            x,
            translationY: y,
            annotationY: translationOptions?.annotationY ?? y,
            color: cdsColor,
            chevronDepth,
            viewportLeft: translationOptions?.viewportLeftX,
            viewportRight: translationOptions?.viewportRightX ?? contentRightX,
            geneticCode: translationOptions?.geneticCode,
            annotationRenderStateInput,
          })
        : undefined;
      paintIntrons(cds, glyph);
      if (glyph) foregrounds.push({ glyph, cds, color: cdsColor });
    });
    paintCdsForegrounds(ctx, foregrounds, labelFontFamily);
    return { codons: [], trackHeight: 0, extensionArrows: [] };
  }

  if (!alignmentMode && hasDraftEdits) {
    legacyCDSs.forEach((cds) => {
      const segments = getCDSVisibleSegments(cds, lineStartPos, lineEndPos, sequenceLength);
      const aaY = presentationFor(cds).aaY;
      const direction = cds.direction ?? 1;

      segments.forEach((segment, _segIdx) => {
        const barX = x + segment.charIndexStart * charWidth;
        const barWidth = (segment.end - segment.start) * charWidth;

        const leftChevron = direction === -1 && segment.isStartOfCds;
        const rightChevron = direction === 1 && segment.isEndOfCds;

        ctx.fillStyle = getCdsColor(cds);
        ctx.globalAlpha = 0.3;
        drawChevronRect(
          ctx,
          barX,
          aaY,
          barWidth,
          aaTrackHeight,
          chevronDepth,
          direction,
          leftChevron,
          rightChevron
        );
        ctx.globalAlpha = 1.0;
      });
    });
  }

  const cdsAnnotations = legacyCDSs;

  const linePadding = Math.round(aaTrackHeight * SEPARATOR_LINE_PADDING_RATIO);

  const greenSeparatorColor = sequenceEditMarkupCss(CDS_MUTATION_MARKUP.inserted.outline);
  const orangeSeparatorColor = sequenceEditMarkupCss(CDS_MUTATION_MARKUP.frameshifted.outline);
  const redSeparatorColor = sequenceEditMarkupCss(CDS_MUTATION_MARKUP.deleted.outline);

  const firstCdsColor = cdsAnnotations[0] ? getCdsColor(cdsAnnotations[0]) : '#88CCFF';
  const cdsDirection = cdsAnnotations[0]?.direction ?? 1;
  const defaultSeparatorColor = firstCdsColor.startsWith('#')
    ? `${firstCdsColor}99`
    : firstCdsColor;

  const firstCds = cdsAnnotations[0];
  const firstCdsStart = firstCds ? firstCds.start - 1 : 0;
  const firstCdsEnd = firstCds ? firstCds.end : 0;
  const firstVisibleStart = Math.max(firstCdsStart, lineStartPos);
  const firstVisibleEnd = Math.min(firstCdsEnd, lineEndPos);
  const cdsLeftX = x + (firstVisibleStart - lineStartPos) * charWidth;
  const cdsRightX = x + (firstVisibleEnd - lineStartPos) * charWidth;
  const firstAATrackY = legacyCDSs.length
    ? presentationFor(legacyCDSs[0]).aaY
    : y + TRANSLATION_LABEL_HEIGHT;

  const drawChevronSeparator = (
    sepX: number,
    sepColor: string,
    direction: number,
    atY: number = firstAATrackY
  ): void => {
    drawChevronSeparatorLine(ctx, sepX, atY, sepColor, direction, aaTrackHeight, linePadding);
  };

  if (hasDraftEdits) {
    ctx.font = `500 ${aaFontSize}px ${fontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const allDraftCodons: DraftCodonInfo[] = [];
    const allDeletedCodons: CodonInfo[] = [];

    cdsAnnotations.forEach((cds) => {
      const { draftCodons, originalCodons } = getDraftCodonsForCDS(
        cds,
        fullSequence,
        insertedRanges,
        deletedRanges,
        lineStartPos,
        lineEndPos,
        translationOptions?.geneticCode,
        translationOptions?.geneticCodeBasis
      );

      allDraftCodons.push(...draftCodons);

      const deletedCodons = getDeletedCodons(originalCodons, draftCodons, deletedRanges);
      allDeletedCodons.push(...deletedCodons);
    });

    allDraftCodons.sort((a, b) => a.visualStartPos - b.visualStartPos);

    type DraftHighlight = 'inserted' | 'frameshifted' | 'deleted' | 'none';
    const getDraftSeparatorColor = (
      leftHighlight: DraftHighlight | null,
      rightHighlight: DraftHighlight | null
    ): string => {
      if (leftHighlight === 'deleted' || rightHighlight === 'deleted') {
        return redSeparatorColor;
      }
      if (leftHighlight === 'inserted' || rightHighlight === 'inserted') {
        return greenSeparatorColor;
      }
      if (leftHighlight === 'frameshifted' && rightHighlight === 'frameshifted') {
        return orangeSeparatorColor;
      }
      if (
        (leftHighlight === 'frameshifted' && rightHighlight === null) ||
        (leftHighlight === null && rightHighlight === 'frameshifted')
      ) {
        return orangeSeparatorColor;
      }
      return defaultSeparatorColor;
    };

    allDeletedCodons.forEach((deletedCodon) => {
      for (const delRange of deletedRanges) {
        const overlapStart = Math.max(deletedCodon.startPos, delRange.start);
        const overlapEnd = Math.min(deletedCodon.endPos + 1, delRange.end);

        if (overlapStart < overlapEnd) {
          const overlapsWithSpanningCodon = allDraftCodons.some(
            (draft) =>
              draft.visualStartPos <= overlapStart &&
              draft.visualEndPos >= overlapEnd - 1 &&
              draft.status === 'frameshifted'
          );

          if (overlapsWithSpanningCodon) continue;

          const localStart = overlapStart - lineStartPos;
          const highlightX = x + localStart * charWidth;
          const highlightWidth = (overlapEnd - overlapStart) * charWidth;

          ctx.fillStyle = sequenceEditMarkupCss(CDS_MUTATION_MARKUP.deleted.background);
          ctx.fillRect(highlightX, firstAATrackY, highlightWidth, aaTrackHeight);

          ctx.strokeStyle = redSeparatorColor;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(highlightX, firstAATrackY + linePadding);
          ctx.lineTo(highlightX, firstAATrackY + aaTrackHeight - linePadding);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(highlightX + highlightWidth, firstAATrackY + linePadding);
          ctx.lineTo(highlightX + highlightWidth, firstAATrackY + aaTrackHeight - linePadding);
          ctx.stroke();
        }
      }
    });

    const toHighlight = (status: DraftCodonInfo['status']): DraftHighlight =>
      status === 'normal' ? 'none' : status;

    const draftRenderData = allDraftCodons.map((draftCodon, idx) => {
      const localStart = draftCodon.visualStartPos - lineStartPos;
      const localEnd = draftCodon.visualEndPos - lineStartPos;
      const codonX = x + localStart * charWidth;
      const visualWidth = (localEnd - localStart + 1) * charWidth;
      const codonCenterX = codonX + visualWidth / 2;
      const highlight: DraftHighlight = draftCodon.status === 'normal' ? 'none' : draftCodon.status;
      const prevHighlight: DraftHighlight | null =
        idx > 0 ? toHighlight(allDraftCodons[idx - 1].status) : null;
      const isFirstCodon = idx === 0 && draftCodon.visualStartPos === firstCdsStart;

      return {
        draftCodon,
        codonX,
        visualWidth,
        codonCenterX,
        highlight,
        prevHighlight,
        isFirstCodon,
      };
    });

    draftRenderData.forEach(({ codonX, visualWidth, draftCodon }) => {
      if (draftCodon.status === 'inserted') {
        ctx.fillStyle = sequenceEditMarkupCss(CDS_MUTATION_MARKUP.inserted.background);
        ctx.fillRect(codonX, firstAATrackY, visualWidth, aaTrackHeight);
      } else if (draftCodon.status === 'frameshifted') {
        if (precomputedAAColors && draftCodon.aa) {
          ctx.fillStyle = precomputedAAColors[draftCodon.aa] || '#9CA3AF';
          ctx.globalAlpha = 0.6;
          ctx.fillRect(codonX, firstAATrackY, visualWidth, aaTrackHeight);
          ctx.globalAlpha = 1.0;
        } else {
          ctx.fillStyle = sequenceEditMarkupCss(CDS_MUTATION_MARKUP.frameshifted.background);
          ctx.fillRect(codonX, firstAATrackY, visualWidth, aaTrackHeight);
        }

        ctx.strokeStyle = sequenceEditMarkupCss(CDS_MUTATION_MARKUP.frameshifted.outline);

        ctx.lineWidth = 2;
        ctx.strokeRect(codonX, firstAATrackY, visualWidth, aaTrackHeight);
      } else if (precomputedAAColors && draftCodon.aa) {
        ctx.fillStyle =
          draftCodon.aa === '*' ? '#9CA3AF' : precomputedAAColors[draftCodon.aa] || '#9CA3AF';
        ctx.globalAlpha = 0.6;
        ctx.fillRect(codonX, firstAATrackY, visualWidth, aaTrackHeight);
        ctx.globalAlpha = 1.0;
      }
    });

    const draftChevronWidth = Math.round(aaTrackHeight * CHEVRON_WIDTH_RATIO);
    const draftAtActualCdsEnd = firstVisibleEnd === firstCdsEnd;
    const draftAtActualCdsStart = firstVisibleStart === firstCdsStart;
    let draftClipLeft = cdsLeftX;
    let draftClipRight = cdsRightX;
    if (cdsDirection === 1 && draftAtActualCdsEnd) {
      draftClipRight -= draftChevronWidth;
    }
    if (cdsDirection === -1 && draftAtActualCdsStart) {
      draftClipLeft += draftChevronWidth;
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(draftClipLeft, firstAATrackY, draftClipRight - draftClipLeft, aaTrackHeight);
    ctx.clip();

    const chevronOffset = -cdsDirection * (charWidth / 4);
    draftRenderData.forEach(({ codonX, highlight, prevHighlight, isFirstCodon }) => {
      if (isFirstCodon) return;
      const sepColor = getDraftSeparatorColor(prevHighlight, highlight);
      drawChevronSeparator(codonX + chevronOffset, sepColor, cdsDirection, firstAATrackY);
    });

    ctx.restore();

    ctx.font = `500 ${aaFontSize}px ${fontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const draftCdsColor = firstCdsColor;
    const draftAaTextColor = tintedTextColor(draftCdsColor, getCanvasTheme().isDark);
    draftRenderData.forEach(({ draftCodon, codonX, visualWidth }) => {
      const pos = getCodonLetterPosition(
        codonX,
        visualWidth,
        firstAATrackY,
        aaTrackHeight,
        chevronDepth,
        cdsDirection as 1 | -1,
        aaFontSize
      );
      const isStop = draftCodon.aa === '*';
      let textColor: string;
      if (isStop) {
        textColor = '#cc0000';
      } else if (precomputedAAColors && draftCodon.aa && draftCodon.status !== 'inserted') {
        const aaColor = precomputedAAColors[draftCodon.aa] || '#9CA3AF';
        textColor = isLightColor(aaColor)
          ? 'rgba(0,0,0,0.85)'
          : isDark
            ? 'rgba(230,230,230,0.85)'
            : 'rgba(255,255,255,0.95)';
      } else if (draftCodon.status === 'inserted') {
        textColor = isDark ? '#a8c8a8' : '#4a6a4a';
      } else {
        textColor = draftAaTextColor;
      }
      ctx.fillStyle = textColor;
      ctx.fillText(draftCodon.aa, pos.x, pos.y);
    });

    const codons = getCodonsForLine(
      sequence,
      cdsAnnotations,
      lineStartPos,
      lineEndPos,
      fullSequence,
      translationOptions?.geneticCode,
      translationOptions?.geneticCodeBasis
    );
    return { codons, trackHeight };
  }

  const frameshiftRanges = alignmentMode ? [] : getFrameshiftRanges(cdsAnnotations, insertedRanges);

  type CodonHighlight = 'inserted' | 'frameshifted' | 'none';

  const allCodons: CodonInfo[] = [];
  const arrowPaints: Array<() => void> = [];
  const extensionArrows: CdsExtensionArrowBounds[] = [];

  cdsAnnotations.forEach((cds) => {
    const aaY = presentationFor(cds).aaY;

    const cdsStart = cds.start - 1;
    const cdsEnd = cds.end - 1;
    const thisCdsDirection: 1 | -1 = cds.direction === -1 ? -1 : 1;
    const cdsColor = getCdsColor(cds);

    const isReviewGrayed = cds.color === '#e5e7eb';
    const reviewOpacity = isReviewGrayed ? (alignmentMode && isDark ? 0.08 : 0.2) : 1;
    const reviewAlpha = reviewOpacity * (cohesiveGlyph ? phases.colorAlpha : detailProgress);

    const draftStyle = resolveAnnotationDraftStyle(cds);
    const isUncheckedDraft = draftStyle.isHollow;
    const hasDraftOutline = draftStyle.hasDottedOutline;
    const codonCellBorderColor = cdsCodonCellBorderColor(isDark);
    const codonCellFillAlpha = 0.3;

    const codons = alignmentMode
      ? undefined
      : getCodonsForSingleCDS(
          cds,
          lineStartPos,
          lineEndPos,
          fullSequence,
          translationOptions?.geneticCode,
          translationOptions?.geneticCodeBasis
        );
    const codonMode: CodonMode = alignmentMode
      ? {
          type: 'alignment',
          alignedRef: alignmentMode.alignedRef,
          alignedQuery: alignmentMode.alignedQuery,
          precomputed: precomputedAlignmentCodons,
        }
      : { type: 'normal', codons };

    const renderData = computeCodonCells(
      {
        start: cdsStart,
        end: cdsEnd,
        direction: thisCdsDirection,
        name: cds.name,
        segments: cds.segments,
        qualifiers: cds.qualifiers,
      },
      lineStartPos,
      lineEndPos,
      x,
      charWidth,
      fullSequence,
      sequenceLength,
      codonMode,
      translationOptions?.geneticCode,
      translationOptions?.geneticCodeBasis
    );

    if (renderData.length === 0 && (alignmentMode || !isSplicedCDS(cds, sequenceLength))) return;

    const glyph = cohesiveGlyph
      ? paintCdsGlyph({
          ctx,
          cds,
          config,
          fullSequence,
          lineStart: lineStartPos,
          lineEnd: lineEndPos,
          x,
          translationY: y,
          annotationY: translationOptions?.annotationY ?? y,
          color: cdsColor,
          chevronDepth,
          renderData,
          viewportLeft: translationOptions?.viewportLeftX,
          viewportRight: translationOptions?.viewportRightX ?? contentRightX,
          geneticCode: translationOptions?.geneticCode,
          annotationRenderStateInput,
          codonFillAlpha: (precomputedAAColors ? 0.6 : codonCellFillAlpha) * reviewOpacity,
        })
      : undefined;

    if (codons) {
      allCodons.push(...codons);
    }

    const getHighlight = (rd: { genomicStart?: number; genomicEnd?: number }): CodonHighlight => {
      if (alignmentMode) return 'none';
      if (rd.genomicStart === undefined || rd.genomicEnd === undefined) return 'none';
      if (rangeOverlapsInsertions(rd.genomicStart, rd.genomicEnd + 1, insertedRanges)) {
        return 'inserted';
      }
      if (rangeOverlapsInsertions(rd.genomicStart, rd.genomicEnd + 1, frameshiftRanges)) {
        return 'frameshifted';
      }
      return 'none';
    };
    const isMutedCodon = (rd: { genomicStart?: number; genomicEnd?: number }): boolean =>
      !alignmentMode &&
      rd.genomicStart !== undefined &&
      rd.genomicEnd !== undefined &&
      rangeOverlapsMutedColumns(rd.genomicStart, rd.genomicEnd + 1, mutedColumns, sequenceLength);
    const previewOriginalBounds = cdsExtensionOriginalBounds(cds);
    const getCodonFillOverride = (
      rd: (typeof renderData)[number]
    ): { fill: string; alpha: number } | null => {
      if (previewOriginalBounds && isPredictedCodonCell(previewOriginalBounds, rd)) {
        return { fill: CDS_EXTENSION_PREDICTED_FILL, alpha: 0.45 };
      }
      const highlight = getHighlight(rd);
      if (highlight === 'inserted') {
        return { fill: sequenceEditMarkupCss(CDS_MUTATION_MARKUP.inserted.background), alpha: 1.0 };
      }
      if (highlight === 'frameshifted') {
        if (precomputedAAColors && rd.aa) {
          return { fill: cellColorFor(rd), alpha: 0.6 };
        }
        return {
          fill: sequenceEditMarkupCss(CDS_MUTATION_MARKUP.frameshifted.background),
          alpha: 1.0,
        };
      }
      if (precomputedAAColors && rd.aa) {
        if (rd.aa === '*') return { fill: '#9CA3AF', alpha: 0.6 };
        return { fill: cellColorFor(rd), alpha: 0.6 };
      }
      return null;
    };

    if (isUncheckedDraft) {
      paintUncheckedDraftChevrons({
        ctx,
        renderData,
        aaY,
        aaTrackHeight,
        chevronDepth,
        direction: thisCdsDirection,
        borderColor: codonCellBorderColor,
      });
    } else if (glyph && phases.chevronProgress === 0) {
      paintCdsBarColors({
        ctx,
        renderData,
        y: aaY,
        height: aaTrackHeight,
        plan: glyph,
        color: cdsColor,
        alpha: codonCellFillAlpha,
        overallAlpha: reviewAlpha,
        colorFor: getCodonFillOverride,
      });
    } else {
      fillCodonCells(
        ctx,
        renderData,
        aaY,
        aaTrackHeight,
        chevronDepth,
        thisCdsDirection,
        cdsColor,
        codonCellBorderColor,
        codonCellFillAlpha,
        cohesiveGlyph ? phases.chevronProgress : 1,
        (_idx, rd) => {
          const codonFill = getCodonFillOverride(rd);
          if (isMutedCodon(rd)) {
            const baseFill = codonFill?.fill ?? cdsColor;
            const mutedFill = desaturateColorForMutedChevron(baseFill, isDark) ?? mutedColumnColor;
            const mutedAlpha = Math.min(0.34, (codonFill?.alpha ?? codonCellFillAlpha) * 0.58);
            return {
              fill: mutedFill,
              alpha: mutedAlpha,
              border: mutedFill,
              borderAlpha: Math.min(0.24, mutedAlpha),
            };
          }
          return codonFill;
        },
        reviewAlpha,
        false,
        Boolean(config.cdsZoomPresentation)
      );
    }

    if (hasDraftOutline && renderData.length > 0) {
      paintCdsDraftOutline({
        ctx,
        renderData,
        direction: thisCdsDirection,
        aaY,
        aaTrackHeight,
        chevronDepth,
        cdsColor,
      });
    }

    if (
      translationOptions?.skipLabels &&
      !glyph &&
      !draftStyle.suppressInteractionOutline &&
      renderData.length > 0 &&
      annotationRenderState(cds, annotationRenderStateInput) !== 'default'
    ) {
      const cellsByX =
        thisCdsDirection === -1 ? [...renderData].sort((a, b) => a.codonX - b.codonX) : renderData;
      const pending = singleRowChevronOutlines.get(cds) ?? [];
      singleRowChevronOutlines.set(cds, pending);
      pending.push(
        pathContour((c) =>
          buildChevronStripOuterPath(
            c,
            cellsByX,
            aaY,
            aaTrackHeight,
            chevronDepth,
            thisCdsDirection
          )
        )
      );
    } else if (!glyph && !draftStyle.suppressInteractionOutline && renderData.length > 0) {
      paintCdsChevronInteractionOutline({
        ctx,
        cds,
        renderData,
        direction: thisCdsDirection,
        aaY,
        aaTrackHeight,
        chevronDepth,
        isDark,
        annotationRenderStateInput,
      });
    }

    const pendingArrowPaints: Array<() => void> = [];
    if (emitArrows && !alignmentMode && renderData.length > 0) {
      const originalBounds = cdsExtensionOriginalBounds(cds);
      const previewDirection = cdsExtensionPreviewDirection(cds);
      const anchorStart = (originalBounds?.start ?? cds.start) - 1;
      const anchorEnd = (originalBounds?.end ?? cds.end) - 1;
      const geometry = {
        start: anchorStart,
        end: anchorEnd,
        direction: thisCdsDirection,
        codonStart: parseCodonStartQualifier(
          originalBounds ? stripPreviewCodonStart(cds.qualifiers) : cds.qualifiers
        ),
        geneticCode: parseGeneticCodeQualifier(cds.qualifiers),
      };
      const incompleteEnds = incompleteCdsEnds(geometry, fullSequence, isCircularSequence === true);
      const extendedEnds = cdsExtensionPreviewEnds(cds);
      const hoveredEnds = cdsExtensionHoveredEnds(cds);
      const ends: Array<{ end: CdsExtensionDirection; kind: 'extend' | 'undo' }> = [];
      for (const end of ['five-prime', 'three-prime'] as const) {
        if (extendedEnds.includes(end)) ends.push({ end, kind: 'undo' });
        else if (incompleteEnds.includes(end)) ends.push({ end, kind: 'extend' });
      }
      const anchorCells = originalBounds
        ? renderData.filter((cell) => !isPredictedCodonCell(originalBounds, cell))
        : renderData;
      if (anchorCells.length > 0) {
        for (const { end, kind } of ends) {
          const atExtendedEnd = kind === 'undo';
          const boundsStart = atExtendedEnd ? cds.start - 1 : anchorStart;
          const boundsEnd = atExtendedEnd ? cds.end - 1 : anchorEnd;
          const endPosition =
            end === 'three-prime'
              ? thisCdsDirection === 1
                ? boundsEnd
                : boundsStart
              : thisCdsDirection === 1
                ? boundsStart
                : boundsEnd;
          const rect = arrowRectForEnd(
            atExtendedEnd ? renderData : anchorCells,
            thisCdsDirection,
            end,
            aaY,
            aaTrackHeight,
            endPosition,
            lineStartPos,
            lineEndPos,
            arrowRightX
          );
          if (!rect) continue;

          const cdsKey = cdsExtensionKey({
            name: cds.name,
            type: cds.type,
            start: anchorStart + 1,
            end: anchorEnd + 1,
          });
          const isHovered = hoveredEnds.includes(end) || previewDirection === end;
          const pointsOutward =
            end === 'three-prime' ? thisCdsDirection === 1 : thisCdsDirection === -1;
          const pointsRight = kind === 'undo' ? !pointsOutward : pointsOutward;
          pendingArrowPaints.push(() =>
            drawCdsExtensionArrow(ctx, rect, pointsRight, isDark, isHovered)
          );
          extensionArrows.push({
            cdsKey,
            direction: end,
            kind,
            anchorBp: endPosition,
            pointsRight,
            ...rect,
          });
        }
      }
    }

    if (isCdsPreviewTarget(alignmentMode, previewCDS, cds)) {
      paintCdsPreviewHighlight({
        ctx,
        cds,
        renderData,
        aaY,
        aaTrackHeight,
        chevronDepth,
        direction: thisCdsDirection,
      });
    }

    {
      ctx.save();
      ctx.globalAlpha = cohesiveGlyph
        ? (isUncheckedDraft ? PLANNOTATE_DRAFT_FAINT_ALPHA : reviewOpacity) *
          phases.residueAlpha *
          (config.cdsZoomPresentation ? 0.85 : 1)
        : (isUncheckedDraft ? PLANNOTATE_DRAFT_FAINT_ALPHA : reviewAlpha) * detailProgress;

      renderData.forEach((rd) => {
        const highlight = getHighlight(rd);
        if (highlight !== 'frameshifted') return;
        ctx.beginPath();
        buildCodonCellPath(
          ctx,
          rd.codonX,
          aaY,
          rd.visibleWidth,
          aaTrackHeight,
          chevronDepth,
          thisCdsDirection,
          rd.leftEdge,
          rd.rightEdge
        );
        ctx.strokeStyle = sequenceEditMarkupCss(CDS_MUTATION_MARKUP.frameshifted.outline);
        ctx.lineWidth = 2;
        ctx.stroke();
      });

      if (hoveredCodon) {
        paintHoveredCodonCellOutlines({
          ctx,
          renderData,
          hoveredCodon,
          direction: thisCdsDirection,
          isDark,
          aaY,
          aaTrackHeight,
          chevronDepth,
          lineStartPos,
          lineEndPos,
          skipLabels: translationOptions?.skipLabels,
        });
      }
      if (selectedCodons && selectedCodons.length > 0) {
        paintSelectedCodonCellOutlines({
          ctx,
          renderData,
          selectedCodons,
          direction: thisCdsDirection,
          isDark,
          aaY,
          aaTrackHeight,
          chevronDepth,
          lineStartPos,
          lineEndPos,
          skipLabels: translationOptions?.skipLabels,
        });
      }

      if (!cohesiveGlyph || phases.residueAlpha !== 0) {
        ctx.font = `500 ${aaFontSize}px ${fontFamily}`;

        const measuredAaLabels = new Map<string, number>();
        const measureAaLabel = (text: string): number => {
          const cached = measuredAaLabels.get(text);
          if (cached !== undefined) return cached;
          const width = ctx.measureText(text).width;
          measuredAaLabels.set(text, width);
          return width;
        };
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        const cdsTextColor = tintedTextColor(cdsColor, getCanvasTheme().isDark);
        const draftLetterColor = cdsColor;
        const paintAaLabel = repeatedTextPainter(
          ctx,
          getCodonLetterPosition(
            0,
            0,
            aaY,
            aaTrackHeight,
            chevronDepth,
            thisCdsDirection,
            aaFontSize
          ).y
        );
        renderData.forEach((rd) => {
          if (!rd.renderLetter) return;
          if (config.cdsZoomPresentation && !indexedCodonLettersVisible(rd.visibleWidth)) return;

          const pos = getCodonLetterPosition(
            rd.codonX,
            rd.visibleWidth,
            aaY,
            aaTrackHeight,
            chevronDepth,
            thisCdsDirection,
            aaFontSize
          );

          const highlight = getHighlight(rd);
          const muted = isMutedCodon(rd);
          const isStop = rd.aa === '*';
          let textColor: string;
          if (isStop) {
            textColor = '#cc0000';
          } else if (isUncheckedDraft) {
            textColor = draftLetterColor;
          } else if (highlight === 'inserted') {
            textColor = isDark ? '#a8c8a8' : '#4a6a4a';
          } else if (precomputedAAColors && rd.aa) {
            const aaColor = cellColorFor(rd);
            textColor = config.cdsZoomPresentation
              ? isLightColor(aaColor)
                ? '#000000'
                : isDark
                  ? '#e6e6e6'
                  : '#ffffff'
              : isLightColor(aaColor)
                ? 'rgba(0,0,0,0.85)'
                : isDark
                  ? 'rgba(230,230,230,0.85)'
                  : 'rgba(255,255,255,0.95)';
          } else if (highlight === 'frameshifted') {
            textColor = isDark ? '#c4a882' : '#7a6545';
          } else {
            textColor = cdsTextColor;
          }
          if (muted) {
            const fallback = isDark ? 'rgba(230,230,230,0.38)' : 'rgba(15,23,42,0.42)';
            textColor = fadeColor(textColor, isDark ? 0.38 : 0.42, fallback);
          }
          ctx.fillStyle = textColor;

          const fit = rd.display
            ? codonLabelThatFits(rd.display, rd.visibleWidth, aaFontSize, measureAaLabel)
            : { text: rd.aa, scale: 1 };
          if (fit.scale !== 1) {
            ctx.font = `500 ${Math.max(1, Math.round(aaFontSize * fit.scale))}px ${fontFamily}`;
            ctx.fillText(fit.text, pos.x, pos.y);
            ctx.font = `500 ${aaFontSize}px ${fontFamily}`;
          } else {
            paintAaLabel(fit.text, pos.x);
          }
        });
      }

      ctx.restore();
    }

    paintIntrons(cds, glyph);
    if (glyph) foregrounds.push({ glyph, cds, color: cdsColor });

    if (!alignmentMode && config.showResidueNumbers && renderData.length > 0) {
      paintCdsResidueNumbers({
        ctx,
        renderData,
        aaY,
        aaTrackHeight,
        charWidth,
        labelFontFamily,
        isDark,
      });
    }

    arrowPaints.push(...pendingArrowPaints);
  });
  paintCdsForegrounds(ctx, foregrounds, labelFontFamily);
  for (const paint of arrowPaints) paint();

  const codons = allCodons;

  return { codons, trackHeight, extensionArrows };
}
