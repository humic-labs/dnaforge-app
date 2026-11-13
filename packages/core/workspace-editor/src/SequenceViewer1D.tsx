import { reportOrfPaint, type OrfPresentation } from './orfs/orf-observation';
import {
  WheelMotion,
  registerWheelZoomTarget,
  shouldAnimateWheel,
} from '@waypoint/platform/wheel-motion';

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { flushSync } from 'react-dom';
import type {
  Annotation,
  AnnotatedSequence,
  ColoredCutSite,
  GeneticCodeSpec,
  ORF,
  SearchMatch,
  SequenceStrandOverride,
} from '@waypoint/sequence-utils';
import {
  complement,
  cutSiteRecognitionSelection,
  geneticCodeKey,
  nucleicAcidOf,
  resolveSequenceGeneticCode,
  sequenceStrandOverrideAt,
  type AnnotationColorMode,
  type NucleicAcid,
} from '@waypoint/sequence-utils';
import type {
  AnnotationWithLane,
  ClassifiedCDS,
  CoordinateSpace,
  MutationMarker,
  PrimerDisplay,
  RenderedPrimerSegment,
  RulerDecoration,
  Selection,
  SequenceScrollPresentation,
  ViewportChangeSource,
  ViewportRange,
  WorkspaceEditorConfig,
} from './types';
import { isGappedMode, validateCoordinateSpace } from './coordinate-space';
import {
  sequenceViewer1DBoolAttr,
  sequenceViewer1DCanvasBackground,
  sequenceViewer1DCursor,
  sequenceViewer1DExtraLaneHeight,
  sequenceViewer1DGappedSequenceForLayout,
  sequenceViewer1DHasCutSites,
  sequenceViewer1DHasMutationTrack,
  sequenceViewer1DIsCircular,
  sequenceViewer1DOptionalCount,
  sequenceViewer1DShouldTrackScroll,
} from './sequence-viewer-1d-layout-flags';
import { useCoordinateSpaceRemap } from './hooks/useCoordinateSpaceRemap';
import { DEFAULT_EDITOR_CONFIG } from './types';
import {
  compute1DLayout,
  create1DLayoutAdapter,
  HORIZONTAL_PADDING_1D,
  LANE_HEIGHT_1D,
  LANE_GAP_1D,
  MIN_PX_PER_BASE_1D,
  MAX_PX_PER_BASE_1D,
  RULER_HEIGHT_1D,
} from './layout-1d';
import type { Layout1D } from './layout-1d';
import { ANNOTATION_LABEL_FONT_SIZE, TRANSLATION_LABEL_HEIGHT } from './layout-constants';
import { SequenceViewer1DPrimerTooltip, SequenceViewer1DScrollbar } from './SequenceViewer1DChrome';
import { FeatureHoverTooltip } from './FeatureHoverTooltip';
import { codonNameLine, featureSummaryLine, cdsRegionHoverLine } from './codon-hover-tooltip-lines';
import {
  drawSelectionFillRect,
  drawSelectionHandleBar,
  drawViewCursorLine,
  getHoverCursorChrome,
  SELECTION_HANDLE_HIT_TOLERANCE_BASES,
} from './selection-primitives';

type TranslationSlice = {
  lineStart: number;
  lineEnd: number;
  originX: number;
};

function buildTranslationSlices(args: {
  isCircular: boolean;
  columnCount: number;
  visibleStart: number;
  visibleEnd: number;
  codonBuffer: number;
  pxPerBase: number;
}): TranslationSlice[] {
  const { isCircular, columnCount, visibleStart, visibleEnd, codonBuffer, pxPerBase } = args;
  const slices: TranslationSlice[] = [];
  const naturalStart = Math.max(0, visibleStart - codonBuffer);
  const naturalEnd = Math.min(columnCount, visibleEnd + codonBuffer);
  if (naturalEnd > naturalStart) {
    slices.push({
      lineStart: naturalStart,
      lineEnd: naturalEnd,
      originX: HORIZONTAL_PADDING_1D + naturalStart * pxPerBase,
    });
  }
  if (isCircular && visibleEnd > columnCount) {
    const wrapEnd = Math.min(columnCount, visibleEnd - columnCount + codonBuffer);
    if (wrapEnd > 0) {
      slices.push({
        lineStart: 0,
        lineEnd: wrapEnd,
        originX: HORIZONTAL_PADDING_1D + columnCount * pxPerBase,
      });
    }
  }
  return slices;
}

function paint1DAnnotationLanes(args: {
  ctx: CanvasRenderingContext2D;
  annotations: AnnotationWithLane[];
  isCircular: boolean;
  columnCount: number;
  visibleStart: number;
  visibleEnd: number;
  renderColumnCount: number;
  laneBandTop: number;
  laneSpacing: number;
  pxPerBase: number;
  viewportLeftX: number;
  viewportRightX: number;
  labelPadding: number;
  mutedColumnSet: Set<number>;
  mutedColumnColor: string | undefined;
  themeFg: string;
  themeFgMuted: string;
  sharedConfig: WorkspaceEditorConfig;
  annotationRenderStateInput: AnnotationRenderStateInput;
  labelFont: string;
}): void {
  const {
    ctx,
    annotations,
    isCircular,
    columnCount,
    visibleStart,
    visibleEnd,
    renderColumnCount,
    laneBandTop,
    laneSpacing,
    pxPerBase,
    viewportLeftX,
    viewportRightX,
    labelPadding,
    mutedColumnSet,
    mutedColumnColor,
    themeFg,
    themeFgMuted,
    sharedConfig,
    annotationRenderStateInput,
    labelFont,
  } = args;
  const annOffsets: number[] = isCircular ? [-columnCount, 0, columnCount] : [0];
  for (const ann of annotations) {
    const annEffEnd = effectiveEnd(ann.start, ann.end, columnCount, isCircular);
    const annSpansOrigin = isCircular && ann.end < ann.start;
    for (const offset of annOffsets) {
      const segStart = ann.start - 1 + offset;
      const segEnd = annEffEnd + offset;
      const cycleBoundary = columnCount + offset;
      const pieces = annSpansOrigin
        ? [
            { start: segStart, end: cycleBoundary, ownsStart: true, ownsEnd: false },
            { start: cycleBoundary, end: segEnd, ownsStart: false, ownsEnd: true },
          ]
        : [{ start: segStart, end: segEnd, ownsStart: true, ownsEnd: true }];
      for (const piece of pieces) {
        if (piece.end <= visibleStart - 2 || piece.start >= visibleEnd + 2) continue;
        const a = Math.max(piece.start, isCircular ? visibleStart - 2 : 0, visibleStart - 2);
        const b = Math.min(
          piece.end,
          isCircular ? visibleEnd + 2 : renderColumnCount,
          visibleEnd + 2
        );
        if (b <= a) continue;
        drawAnnotationSegment(
          ctx,
          ann,
          a,
          b,
          0,
          HORIZONTAL_PADDING_1D,
          laneBandTop,
          sharedConfig,
          LANE_HEIGHT_1D,
          laneSpacing,
          false,
          piece.ownsStart && a === piece.start,
          piece.ownsEnd && b === piece.end,
          a,
          undefined,
          annotationRenderState(ann, annotationRenderStateInput),
          undefined,
          {
            mutedColumns: mutedColumnSet,
            mutedColumnColor,
            sequenceLength: columnCount,
            clipStart: visibleStart - 2,
            clipEnd: visibleEnd + 2,
          }
        );
        const annX = HORIZONTAL_PADDING_1D + a * pxPerBase;
        const annEndX = HORIZONTAL_PADDING_1D + b * pxPerBase;
        const visLeftX = Math.max(annX, viewportLeftX);
        const visRightX = Math.min(annEndX, viewportRightX);
        const visW = visRightX - visLeftX;
        if (visW < 28) continue;
        const y = laneBandTop + ann.lane * laneSpacing;
        const centerX = (visLeftX + visRightX) / 2;
        const centerVirtualCol = Math.floor((centerX - HORIZONTAL_PADDING_1D) / pxPerBase);
        const centerActualCol = isCircular
          ? biologicalColumn(centerVirtualCol, columnCount)
          : centerVirtualCol;
        ctx.font = labelFont;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'center';
        ctx.fillStyle = mutedColumnSet.has(centerActualCol)
          ? (mutedColumnColor ?? themeFgMuted)
          : themeFg;
        const avail = Math.max(0, visW - labelPadding * 2);
        const approxCharW = 6;
        const maxChars = Math.max(1, Math.floor(avail / approxCharW));
        const label =
          ann.name.length <= maxChars
            ? ann.name
            : `${ann.name.slice(0, Math.max(1, maxChars - 1))}…`;
        ctx.fillText(label, centerX, y + LANE_HEIGHT_1D / 2);
      }
    }
  }
}

function visitWrappedRangeColumns(
  range: { start: number; end: number; wraps?: boolean },
  isCircular: boolean,
  columnCount: number,
  visit: (startCol: number, endColExclusive: number) => void
): void {
  const wraps = isCircular && !!range.wraps;
  const segStart = wraps ? range.start : Math.min(range.start, range.end);
  const segEnd = wraps ? range.end + 1 + columnCount : Math.max(range.start, range.end) + 1;
  const offsets = isCircular ? [-columnCount, 0, columnCount] : [0];
  for (const offset of offsets) {
    const a = segStart + offset;
    const b = segEnd + offset;
    const aClamp = isCircular ? a : Math.max(0, a);
    const bClamp = isCircular ? b : Math.min(columnCount, b);
    if (bClamp <= aClamp) continue;
    visit(aClamp, bClamp);
  }
}
import { drawAnnotationSegment, drawMutationTrack1D } from './canvas-drawing';
import { render1DPrimers } from './primer-1d-render';
import {
  annotationRenderState,
  type AnnotationStateIdentity,
  type AnnotationRenderStateInput,
} from './annotation-render-state';
import { resolveAnnotationTarget } from './resolve-annotation-target';
import {
  resolvePointerSelection,
  annotationIdentityEqual,
  orfIdentityEqual,
  type PointerSelectionResult,
} from './pointer-selection';
import { resolveCanvasTheme } from './canvas-theme';
import { TEXT_VISIBILITY_THRESHOLD_PX } from './canvas-constants';
import { drawTranslation } from './translation-drawing';
import type { CodonInfo } from './translation/codon-calculator';
import {
  useHoveredCodon,
  useHoveredCodonStore,
  type HoveredCodonStore,
} from './hovered-codon-store';
import { useSelectedCodons } from './selected-codons-store';
import { drawTranslationLabels1D } from './translation-labels-1d';
import { drawORFTracks, makeOrfRenderStateFn } from './orf-drawing';
import { findOrfAtPointInBand } from './orf-hit-test';
import { drawCutSites1D, hitTestCutSiteLabel1D } from './restriction-enzymes/drawCutSites1D';
import type { RenderedCutSite } from './restriction-enzymes/cut-site-styling';
import { biologicalColumn, effectiveEnd, isCrossCycleDrag } from './utils/circular-cols';
import type { ReferenceColumnOverlay } from './lanes/overlay-types';
export type { ReferenceColumnOverlay } from './lanes/overlay-types';
import { isSplicedCDS } from './translation';
import { findSplicedCodonWithIndexAtPosition } from './hit-detection/spliced-cds';
import { useKeyboardNavigation1D } from './hooks/useKeyboardNavigation1D';
import { handleShiftClickNucleotide, handleOptionShiftClickNucleotide } from './selection-model';
import {
  findResidueSelectionForMolecule,
  replaceResidueSelectionForMolecule,
  useResidueSelectionsStore,
  type ResidueSelection,
  type ResidueSelectionsStore,
} from './residue-selection-store';
import {
  buildResidueSelectionForCdsCodon,
  buildResidueSelectionForCdsCodonRange,
  type CdsCodonSelectionHit,
} from './residue-selection-from-cds';
import { hasPlatformCommandModifier } from './platform-modifiers';

type PaintCodonKey = {
  start: number;
  end: number;
  strand: 1 | -1;
  source?: 'sequence' | 'structure';
};

type PaintOrfIdentity = {
  start: number;
  end: number;
  strand: '+' | '-';
};

type PaintCutSiteHoverInfo = {
  enzymeName: string;
  position: number;
  recognitionStart: number;
  recognitionEnd: number;
};

function paint1DOverflowBand(args: {
  ctx: CanvasRenderingContext2D;
  layout: Layout1D;
  isCircular: boolean;
  columnCount: number;
  visibleStart: number;
  visibleEnd: number;
  pxPerBase: number;
  bgMuted: string;
}): void {
  const { ctx, layout, isCircular, columnCount, visibleStart, visibleEnd, pxPerBase, bgMuted } =
    args;
  if (!layout.hasOverflow) return;
  const y = layout.overflowBandY;
  ctx.fillStyle = bgMuted;
  for (let col = visibleStart; col < visibleEnd; col++) {
    const actualCol = isCircular ? biologicalColumn(col, columnCount) : col;
    if (layout.overflowCounts[actualCol] > 0) {
      ctx.fillRect(HORIZONTAL_PADDING_1D + col * pxPerBase, y, pxPerBase, 6);
    }
  }
}

function paint1DCdsTranslationAndOrfBands(args: {
  ctx: CanvasRenderingContext2D;
  layout: Layout1D;
  isCircular: boolean;
  columnCount: number;
  visibleStart: number;
  visibleEnd: number;
  pxPerBase: number;
  scrollLeft: number;
  cssWidth: number;
  sharedConfig: WorkspaceEditorConfig;
  sequence: string;
  geneticCode: GeneticCodeSpec | undefined;
  geneticCodeBasis: import('@waypoint/sequence-utils').RecordGeneticCodeBasis;
  coordinateSpace: CoordinateSpace | undefined;
  hoveredAnnotation: AnnotationStateIdentity | null;
  selectedAnnotation: AnnotationStateIdentity | null;
  hoveredCodon: PaintCodonKey | null;
  selectedCodons: ReadonlyArray<PaintCodonKey>;
  paintedCodonsSink?: { current: CodonInfo[] };
  hoveredOrf: PaintOrfIdentity | null;
  selectedOrf: PaintOrfIdentity | null;
  candidateOrf: PaintOrfIdentity | null | undefined;
  mutedColumnSet: Set<number>;
  mutedColumnColor: string | undefined;
}): boolean {
  const {
    ctx,
    layout,
    isCircular,
    columnCount,
    visibleStart,
    visibleEnd,
    pxPerBase,
    scrollLeft,
    cssWidth,
    sharedConfig,
    sequence,
    geneticCode,
    geneticCodeBasis,
    coordinateSpace,
    hoveredAnnotation,
    selectedAnnotation,
    hoveredCodon,
    selectedCodons,
    hoveredOrf,
    selectedOrf,
    candidateOrf,
    mutedColumnSet,
    mutedColumnColor,
  } = args;
  const codonBuffer = 30;
  const translationSlices = buildTranslationSlices({
    isCircular,
    columnCount,
    visibleStart,
    visibleEnd,
    codonBuffer,
    pxPerBase,
  });

  const hasCDSs = layout.translationLaneCount > 0 && layout.classifiedCDSs.length > 0;

  const alignmentModeOptions =
    coordinateSpace?.mode === 'gapped' &&
    coordinateSpace?.gappedSequence &&
    coordinateSpace?.alignedQuery
      ? {
          alignedRef: coordinateSpace.gappedSequence,
          alignedQuery: coordinateSpace.alignedQuery,
        }
      : undefined;

  if (hasCDSs && pxPerBase >= CODON_LOD_MIN_PX_PER_BASE) {
    if (args.paintedCodonsSink) args.paintedCodonsSink.current = [];
    for (const slice of translationSlices) {
      const painted = drawTranslation(
        ctx,
        sequence,
        layout.classifiedCDSs,
        slice.lineStart,
        slice.lineEnd,
        slice.originX,
        layout.translationBandTop,
        sharedConfig,
        sequence,
        undefined,
        undefined,
        undefined,
        undefined,
        alignmentModeOptions,
        undefined,
        undefined,
        {
          hovered: hoveredAnnotation,
          selected: selectedAnnotation,
        },
        {
          skipLabels: true,
          viewportLeftX: scrollLeft,
          viewportRightX: scrollLeft + cssWidth,
          mutedColumns: mutedColumnSet,
          mutedColumnColor,
          geneticCode,
          geneticCodeBasis,
        },
        hoveredCodon,
        selectedCodons
      );
      if (args.paintedCodonsSink && painted?.codons) {
        args.paintedCodonsSink.current.push(...painted.codons);
      }
    }
  }

  if (hasCDSs) {
    drawTranslationLabels1D(ctx, {
      cdss: layout.classifiedCDSs,
      pxPerBase,
      columnCount,
      sequenceLength: sequence.length,
      viewportLeftX: scrollLeft,
      viewportRightX: scrollLeft + cssWidth,
      originX: HORIZONTAL_PADDING_1D,
      bandTopY: layout.translationBandTop,
      laneHeight: layout.translationLaneHeight,
      labelFontSize: ANNOTATION_LABEL_FONT_SIZE,
      labelFontFamily: sharedConfig.labelFontFamily,
      annotationColorMode: sharedConfig.annotationColorMode,
      annotationRenderStateInput: {
        hovered: hoveredAnnotation,
        selected: selectedAnnotation,
      },
      mutedColumns: mutedColumnSet,
      mutedColumnColor,
    });
  }

  let orfsDrawn = false;
  if (layout.orfLaneCount > 0 && layout.orfsWithLanes.length > 0) {
    const orfCodonMode = alignmentModeOptions
      ? {
          type: 'alignment' as const,
          alignedRef: alignmentModeOptions.alignedRef,
          alignedQuery: alignmentModeOptions.alignedQuery,
        }
      : { type: 'normal' as const };
    const getOrfRenderState = makeOrfRenderStateFn({
      hovered: hoveredOrf,
      selected: selectedOrf,
      candidate: candidateOrf ?? null,
    });
    for (const slice of translationSlices) {
      orfsDrawn =
        drawORFTracks(
          ctx,
          layout.orfsWithLanes,
          slice.lineStart,
          slice.lineEnd,
          slice.originX,
          layout.orfBandTop,
          sharedConfig,
          sequence,
          columnCount,
          orfCodonMode,
          getOrfRenderState,
          geneticCode
        ) || orfsDrawn;
    }
  }
  return orfsDrawn;
}

function paint1DCutSites(args: {
  ctx: CanvasRenderingContext2D;
  layout: Layout1D;
  scrollLeft: number;
  cssWidth: number;
  showCutSites: boolean;
  cutSites: ColoredCutSite[] | undefined;
  scannedCutSites: ColoredCutSite[] | undefined;
  showReverseComplement: boolean;
  hoveredEnzymeName: string | null;
  hoveredPositionInfo: PaintCutSiteHoverInfo | null;
  hoveredCutSite: ColoredCutSite | null;
}): RenderedCutSite[] {
  const {
    ctx,
    layout,
    scrollLeft,
    cssWidth,
    showCutSites,
    cutSites,
    scannedCutSites,
    showReverseComplement,
    hoveredEnzymeName,
    hoveredPositionInfo,
    hoveredCutSite,
  } = args;
  if (showCutSites && (cutSites?.length || scannedCutSites?.length)) {
    return drawCutSites1D({
      ctx,
      layout,
      originX: HORIZONTAL_PADDING_1D,
      viewportLeftX: scrollLeft,
      viewportRightX: scrollLeft + cssWidth,
      cutSites: cutSites ?? [],
      scannedCutSites: scannedCutSites ?? [],
      baseFontSize: BASE_FONT_SIZE,
      fontFamily: BASE_FONT_FAMILY,
      showReverseComplement,
      hoveredEnzymeName,
      hoveredPositionInfo,
      hoveredCutSite,
    });
  }
  return [];
}

function paint1DHoveredCodonHighlight(args: {
  ctx: CanvasRenderingContext2D;
  layout: Layout1D;
  isCircular: boolean;
  columnCount: number;
  pxPerBase: number;
  scrollLeft: number;
  cssWidth: number;
  showReverseComplement: boolean;
  hoveredCodon: PaintCodonKey | null;
}): void {
  const {
    ctx,
    layout,
    isCircular,
    columnCount,
    pxPerBase,
    scrollLeft,
    cssWidth,
    showReverseComplement,
    hoveredCodon,
  } = args;
  if (!hoveredCodon) return;
  const strandY =
    hoveredCodon.strand === -1 && showReverseComplement
      ? layout.complementRowY
      : layout.sequenceRowY;
  const strandH = layout.sequenceRowHeight;
  const codonSegStart = hoveredCodon.start;
  const codonSegEnd =
    effectiveEnd(hoveredCodon.start, hoveredCodon.end, columnCount, isCircular) + 1;
  const codonOffsets = isCircular ? [-columnCount, 0, columnCount] : [0];
  ctx.save();
  ctx.fillStyle = 'rgba(140, 140, 140, 0.25)';
  for (const offset of codonOffsets) {
    const a = codonSegStart + offset;
    const b = codonSegEnd + offset;
    const xL = HORIZONTAL_PADDING_1D + a * pxPerBase;
    const xR = HORIZONTAL_PADDING_1D + b * pxPerBase;
    if (xR < scrollLeft - 2 || xL > scrollLeft + cssWidth + 2) continue;
    ctx.fillRect(xL, strandY, xR - xL, strandH);
  }
  ctx.restore();
}

function paint1DReferenceColumnOverlays(args: {
  ctx: CanvasRenderingContext2D;
  extraLanes: readonly SequenceExtraLane[] | undefined;
  layout: Layout1D;
  isCircular: boolean;
  columnCount: number;
  visibleStart: number;
  visibleEnd: number;
  pxPerBase: number;
  showReverseComplement: boolean;
  showRuler: boolean;
}): void {
  const {
    ctx,
    extraLanes,
    layout,
    isCircular,
    columnCount,
    visibleStart,
    visibleEnd,
    pxPerBase,
    showReverseComplement,
    showRuler,
  } = args;
  if (!extraLanes || extraLanes.length === 0) return;
  const sequenceBandY = layout.sequenceRowY;
  const sequenceBandH = layout.sequenceRowHeight * (showReverseComplement ? 2 : 1);
  const laneRanges = new Map<string, { y: number; h: number }>();
  let laneWalkY = layout.totalHeight;
  for (const l of extraLanes) {
    const h = Math.max(0, l.height);
    laneRanges.set(l.id, { y: laneWalkY, h });
    laneWalkY += h;
  }
  const resolveTarget = (target: string): { y: number; h: number } | null => {
    if (target === 'sequenceBand') return { y: sequenceBandY, h: sequenceBandH };
    if (target === 'ruler') {
      return showRuler ? { y: layout.rulerY, h: RULER_HEIGHT_1D } : null;
    }
    return laneRanges.get(target) ?? null;
  };

  const seenOverlayKeys = new Set<string>();
  ctx.save();
  for (const lane of extraLanes) {
    const overlays = lane.referenceColumnOverlays;
    if (!overlays || overlays.length === 0) continue;
    for (const overlay of overlays) {
      const dedupKey = `${lane.id}/${overlay.id}`;
      if (seenOverlayKeys.has(dedupKey)) continue;
      seenOverlayKeys.add(dedupKey);
      const range = resolveTarget(overlay.target);
      if (!range) continue;
      const { y: targetY, h: targetH } = range;
      const isWash = overlay.kind === 'columnWash';
      const isTopMarker = overlay.kind === 'topMarker';
      const thickness = overlay.thickness ?? 2;
      const alpha = overlay.alpha ?? 0.28;
      ctx.fillStyle = overlay.color;
      ctx.globalAlpha = isWash ? alpha : 1;
      for (const col of overlay.columns) {
        if (col < 0 || col >= columnCount) continue;
        const offsets = isCircular ? [-columnCount, 0, columnCount] : [0];
        for (const offset of offsets) {
          const virtualCol = col + offset;
          if (virtualCol + 1 < visibleStart || virtualCol > visibleEnd) continue;
          const x = HORIZONTAL_PADDING_1D + virtualCol * pxPerBase;
          if (isWash) {
            ctx.fillRect(x, targetY, pxPerBase, targetH);
          } else if (isTopMarker) {
            ctx.fillRect(x, targetY, pxPerBase, thickness);
          } else {
            ctx.fillRect(x, targetY + targetH - thickness, pxPerBase, thickness);
          }
        }
      }
    }
  }
  ctx.restore();
}

function paint1DSequenceTextRow(args: {
  ctx: CanvasRenderingContext2D;
  layout: Layout1D;
  sequence: string;
  strandOverrides?: readonly SequenceStrandOverride[];
  nucleicAcid: NucleicAcid;
  isCircular: boolean;
  columnCount: number;
  visibleStart: number;
  visibleEnd: number;
  pxPerBase: number;
  showReverseComplement: boolean;
  mutedColumnSet: Set<number>;
  mutedColumnColor: string | undefined;
  fg: string;
  fgMuted: string;
  isDark: boolean;
}): void {
  const {
    ctx,
    layout,
    sequence,
    strandOverrides,
    nucleicAcid,
    isCircular,
    columnCount,
    visibleStart,
    visibleEnd,
    pxPerBase,
    showReverseComplement,
    mutedColumnSet,
    mutedColumnColor,
    fg,
    fgMuted,
    isDark,
  } = args;
  const seqCenterY = layout.sequenceRowY + layout.sequenceRowHeight / 2;
  if (pxPerBase >= TEXT_VISIBILITY_THRESHOLD_PX) {
    const fontSize = Math.max(5, Math.round((BASE_FONT_SIZE * pxPerBase) / DEFAULT_PX_PER_BASE));
    ctx.font = `${fontSize}px ${BASE_FONT_FAMILY}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    for (let col = visibleStart; col < visibleEnd; col++) {
      const actualCol = isCircular ? biologicalColumn(col, columnCount) : col;
      const ch =
        sequenceStrandOverrideAt(strandOverrides, actualCol, columnCount, 'forward') ??
        sequence[actualCol];
      if (!ch) continue;
      ctx.fillStyle = mutedColumnSet.has(actualCol) ? (mutedColumnColor ?? fgMuted) : fg;
      const x = HORIZONTAL_PADDING_1D + col * pxPerBase + pxPerBase / 2;
      ctx.fillText(ch, x, seqCenterY);
    }

    if (showReverseComplement) {
      const compCenterY = layout.complementRowY + layout.sequenceRowHeight / 2;
      for (let col = visibleStart; col < visibleEnd; col++) {
        const actualCol = isCircular ? biologicalColumn(col, columnCount) : col;
        const ch =
          sequenceStrandOverrideAt(strandOverrides, actualCol, columnCount, 'reverse') ??
          complement(sequence[actualCol] ?? '', nucleicAcid);
        if (!ch) continue;
        ctx.fillStyle = mutedColumnSet.has(actualCol) ? (mutedColumnColor ?? fgMuted) : fgMuted;
        const x = HORIZONTAL_PADDING_1D + col * pxPerBase + pxPerBase / 2;
        ctx.fillText(ch, x, compCenterY);
      }
    }
  } else {
    ctx.fillStyle = isDark ? OVERVIEW_STRIP_COLOR_DARK : OVERVIEW_STRIP_COLOR_LIGHT;
    ctx.fillRect(
      HORIZONTAL_PADDING_1D + visibleStart * pxPerBase,
      seqCenterY - 3,
      (visibleEnd - visibleStart) * pxPerBase,
      6
    );
  }
}

function paint1DRulerDecorations(args: {
  ctx: CanvasRenderingContext2D;
  layout: Layout1D;
  showRuler: boolean;
  decorations: readonly RulerDecoration[] | undefined;
  isCircular: boolean;
  columnCount: number;
  pxPerBase: number;
  scrollLeft: number;
  cssWidth: number;
}): void {
  const {
    ctx,
    layout,
    showRuler,
    decorations,
    isCircular,
    columnCount,
    pxPerBase,
    scrollLeft,
    cssWidth,
  } = args;
  if (!showRuler || !decorations || decorations.length === 0) return;
  const decoHeight = 4;
  const rulerY = layout.rulerY;
  const decoOffsets = isCircular ? [-columnCount, 0, columnCount] : [0];
  ctx.save();
  for (const deco of decorations) {
    for (const offset of decoOffsets) {
      const startX = HORIZONTAL_PADDING_1D + (deco.start + offset) * pxPerBase;
      const widthCols = Math.max(1, deco.end - deco.start + 1);
      const decoWidth = widthCols * pxPerBase;
      if (startX + decoWidth < scrollLeft - 4 || startX > scrollLeft + cssWidth + 4) {
        continue;
      }
      if (deco.style === 'caret') {
        ctx.fillStyle = deco.color;
        ctx.beginPath();
        ctx.moveTo(startX, rulerY - decoHeight - 1);
        ctx.lineTo(startX - 3, rulerY + 1);
        ctx.lineTo(startX + 3, rulerY + 1);
        ctx.closePath();
        ctx.fill();
      } else if (deco.style === 'strikethrough') {
        ctx.fillStyle = deco.color;
        ctx.globalAlpha = 0.3;
        ctx.fillRect(startX, rulerY - decoHeight, decoWidth, decoHeight);
        ctx.globalAlpha = 1.0;
        ctx.strokeStyle = deco.color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(startX, rulerY - decoHeight / 2);
        ctx.lineTo(startX + decoWidth, rulerY - decoHeight / 2);
        ctx.stroke();
      } else {
        ctx.fillStyle = deco.color;
        ctx.globalAlpha = 0.7;
        ctx.fillRect(startX, rulerY - decoHeight, decoWidth, decoHeight);
        ctx.globalAlpha = 1.0;
      }
    }
  }
  ctx.restore();
}

function paint1DSelectionHandles(args: {
  ctx: CanvasRenderingContext2D;
  layout: Layout1D;
  selection: Selection | null | undefined;
  isCircular: boolean;
  columnCount: number;
  pxPerBase: number;
  scrollLeft: number;
  cssWidth: number;
}): void {
  const { ctx, layout, selection, isCircular, columnCount, pxPerBase, scrollLeft, cssWidth } = args;
  if (!selection) return;
  const wraps = isCircular && !!selection.wraps;
  const handleLeftCol = wraps ? selection.start : Math.min(selection.start, selection.end);
  const handleRightCol = wraps ? selection.end + 1 : Math.max(selection.start, selection.end) + 1;
  const handleOffsets = isCircular ? [-columnCount, 0, columnCount] : [0];
  for (const offset of handleOffsets) {
    const lx = HORIZONTAL_PADDING_1D + (handleLeftCol + offset) * pxPerBase;
    const rx = HORIZONTAL_PADDING_1D + (handleRightCol + offset) * pxPerBase;
    if (lx >= scrollLeft - 20 && lx <= scrollLeft + cssWidth + 20) {
      drawSelectionHandleBar(ctx, lx, 0, layout.totalHeight);
    }
    if (rx >= scrollLeft - 20 && rx <= scrollLeft + cssWidth + 20) {
      drawSelectionHandleBar(ctx, rx, 0, layout.totalHeight);
    }
  }
}

function paint1DViewCursor(args: {
  ctx: CanvasRenderingContext2D;
  layout: Layout1D;
  selection: Selection | null | undefined;
  viewCursor: number | null | undefined;
  isCircular: boolean;
  columnCount: number;
  pxPerBase: number;
  scrollLeft: number;
  cssWidth: number;
}): void {
  const {
    ctx,
    layout,
    selection,
    viewCursor,
    isCircular,
    columnCount,
    pxPerBase,
    scrollLeft,
    cssWidth,
  } = args;
  const hasMultiColSelection = !!selection && selection.start !== selection.end;
  if (hasMultiColSelection || viewCursor === null || viewCursor === undefined) return;
  const cursorOffsets = isCircular ? [-columnCount, 0, columnCount] : [0];
  for (const offset of cursorOffsets) {
    const vc = viewCursor + offset;
    if (!isCircular && (vc < 0 || vc > columnCount)) continue;
    const cursorX = HORIZONTAL_PADDING_1D + vc * pxPerBase;
    if (cursorX < scrollLeft - 2 || cursorX > scrollLeft + cssWidth + 2) continue;
    drawViewCursorLine(ctx, cursorX, 0, layout.totalHeight);
  }
}

function paint1DHoverCursor(args: {
  ctx: CanvasRenderingContext2D;
  layout: Layout1D;
  selection: Selection | null | undefined;
  hoverCol: number | null;
  pointerInteractionsEnabled: boolean;
  isCircular: boolean;
  columnCount: number;
  pxPerBase: number;
  scrollLeft: number;
  cssWidth: number;
  isDark: boolean;
}): void {
  const {
    ctx,
    layout,
    selection,
    hoverCol,
    pointerInteractionsEnabled,
    isCircular,
    columnCount,
    pxPerBase,
    scrollLeft,
    cssWidth,
    isDark,
  } = args;
  const hasMultiColSelection = !!selection && selection.start !== selection.end;
  if (
    !pointerInteractionsEnabled ||
    hasMultiColSelection ||
    hoverCol === null ||
    hoverCol < 0 ||
    hoverCol > columnCount
  ) {
    return;
  }
  const hoverOffsets = isCircular ? [-columnCount, 0, columnCount] : [0];
  const hTop = 0;
  const hBot = layout.totalHeight;
  ctx.save();
  for (const offset of hoverOffsets) {
    const hoverX = HORIZONTAL_PADDING_1D + (hoverCol + offset) * pxPerBase;
    if (hoverX < scrollLeft - 2 || hoverX > scrollLeft + cssWidth + 2) continue;
    const hoverChrome = getHoverCursorChrome(isDark);
    ctx.strokeStyle = hoverChrome.glow;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(hoverX - 1, hTop);
    ctx.lineTo(hoverX - 1, hBot);
    ctx.moveTo(hoverX + 1, hTop);
    ctx.lineTo(hoverX + 1, hBot);
    ctx.stroke();
    ctx.strokeStyle = hoverChrome.line;
    ctx.beginPath();
    ctx.moveTo(hoverX, hTop);
    ctx.lineTo(hoverX, hBot);
    ctx.stroke();
  }
  ctx.restore();
}

function copySelectionRange(range: Selection | null | undefined): Selection | null {
  return range
    ? { start: range.start, end: range.end, ...(range.wraps ? { wraps: true } : {}) }
    : null;
}

const DEFAULT_PX_PER_BASE = DEFAULT_EDITOR_CONFIG.charWidth;
const BASE_FONT_FAMILY = DEFAULT_EDITOR_CONFIG.fontFamily;
const BASE_FONT_SIZE = DEFAULT_EDITOR_CONFIG.fontSize;

const CODON_LOD_MIN_PX_PER_BASE = 1.5;

const RULER_FONT = '10px "Inter", system-ui, sans-serif';

const RULER_TICK_COLOR = '#6b7280';
const OVERVIEW_STRIP_COLOR_LIGHT = '#e5e7eb';
const OVERVIEW_STRIP_COLOR_DARK = '#3a3a3a';

export interface SequenceViewer1DHandle {
  scrollToPosition: (baseIndex: number) => void;
}

export interface SequenceViewer1DProps {
  sequence: AnnotatedSequence;
  layoutAnchorSequence?: AnnotatedSequence;
  selection?: Selection | null;
  onSelectionChange?: (selection: Selection | null) => void;
  viewCursor?: number | null;
  onViewCursorChange?: (position: number | null) => void;
  initialPxPerBase?: number;
  zoomPercent?: number;
  onZoomChange?: (zoomPercent: number) => void;
  scrollLeft?: number;
  onScrollLeftChange?: (scrollLeft: number) => void;
  wheelScrollEnabled?: boolean;
  showScrollbar?: boolean;
  showRuler?: boolean;
  mutedColumns?: readonly number[];
  mutedColumnColor?: string;
  scrollToPosition?: number | null;
  scrollCommandId?: number | null;
  scrollAnimate?: boolean;
  onScrollToPositionComplete?: () => void;
  scrollPresentation?: SequenceScrollPresentation | null;
  selectedAnnotationIds?: ReadonlySet<string>;
  selectedAnnotation?: AnnotationStateIdentity | null;
  onSelectedAnnotationChange?: (annotation: AnnotationStateIdentity | null) => void;
  residueSelectionReferenceId?: string | null;
  orfs?: readonly ORF[];
  onOrfsPresented?: OrfPresentation['presented'];
  candidateOrf?: { start: number; end: number; strand: '+' | '-' } | null;
  aaColorScheme?: string;
  annotationColorMode?: AnnotationColorMode;
  showReverseComplement?: boolean;
  className?: string;
  style?: React.CSSProperties;
  pointerInteractionsEnabled?: boolean;
  primerHoverEnabled?: boolean;
  passiveCursor?: React.CSSProperties['cursor'];
  onViewportChange?: (range: ViewportRange, source?: ViewportChangeSource) => void;

  cutSites?: ColoredCutSite[];
  scannedCutSites?: ColoredCutSite[];
  showCutSites?: boolean;
  onCutSiteClick?: (cutSite: ColoredCutSite) => void;
  onCutSiteDoubleClick?: (cutSite: ColoredCutSite) => void;
  hoveredEnzymeName?: string | null;
  hoveredPositionInfo?: {
    enzymeName: string;
    position: number;
    recognitionStart: number;
    recognitionEnd: number;
  } | null;

  primers?: PrimerDisplay[];
  showPrimers?: boolean;
  suppressPrimerDrawing?: boolean;
  transparentBackground?: boolean;
  onPrimerLayoutChange?: (segments: RenderedPrimerSegment[]) => void;

  coordinateSpace?: CoordinateSpace;
  mutations?: MutationMarker[];
  rulerDecorations?: readonly RulerDecoration[];

  searchMatches?: SearchMatch[];
  activeSearchIndex?: number;

  onContextMenu?: (
    event: React.MouseEvent,
    selection: Selection | null,
    contextInfo: {
      isOnNucleotideRow: boolean;
      position: number | null;
      annotation: Annotation | null;
      orf?: ORF | null;
      primer?: PrimerDisplay | null;
    }
  ) => void;
  extraLanes?: readonly SequenceExtraLane[];
}

export interface SequenceExtraLane {
  id: string;
  height: number;
  draw: (ctx: CanvasRenderingContext2D, info: SequenceExtraLanePaintInfo) => void;
  referenceColumnOverlays?: ReadonlyArray<ReferenceColumnOverlay>;
}

export interface SequenceExtraLanePaintInfo {
  laneY: number;
  laneHeight: number;
  pxPerBase: number;
  columnCount: number;
  visibleStart: number;
  visibleEnd: number;
  isCircular: boolean;
  scrollLeft: number;
  horizontalPadding: number;
  viewportWidth: number;
}

function isPrimaryButton(e: React.PointerEvent): boolean {
  return e.button == null || e.button === -1 || e.button === 0 || e.buttons === 1;
}

function isResidueSelectionPointerIntent(e: React.PointerEvent): boolean {
  return hasPlatformCommandModifier(e);
}

function publishResidueSelectionPointerDebug(payload: Record<string, unknown>): void {
  const w = window as Window & {
    __test?: { residueSelectionPointerDebug?: Record<string, unknown> };
  };
  if (!w.__test) return;
  w.__test.residueSelectionPointerDebug = {
    viewer: '1d',
    ...payload,
  };
}

interface CdsResidueSelectionAnchor {
  referenceId: string;
  codon: CdsCodonSelectionHit;
  selection: ResidueSelection;
}

type CdsCodonPointerHit = CdsCodonSelectionHit & { cds: ClassifiedCDS };

function residueSelectionClickFailureReason(args: {
  coordinateMode: CoordinateSpace['mode'] | undefined;
  residueSelectionReferenceId: string | null | undefined;
  codonClickHit: CdsCodonPointerHit | null;
  orfClickHit: ORF | null;
  residueSelectionsStore: ResidueSelectionsStore | null;
}): string | null {
  if (args.coordinateMode === 'gapped') return 'gapped-coordinate-space';
  if (!args.residueSelectionReferenceId) return 'missing-reference-id';
  if (!args.codonClickHit) return 'missing-codon';
  if (args.orfClickHit) return 'orf-click';
  if (!args.residueSelectionsStore) return 'missing-store';
  return null;
}

function codonPointerDebugFields(codon: CdsCodonPointerHit | null): {
  start: number;
  end: number;
  strand: 1 | -1;
  residueIndex: number | undefined;
} | null {
  if (!codon) return null;
  return {
    start: codon.start,
    end: codon.end,
    strand: codon.strand,
    residueIndex: codon.residueIndex,
  };
}

function tryHandleResidueSelectionClick1D(args: {
  event: React.PointerEvent;
  coordinateMode: CoordinateSpace['mode'] | undefined;
  residueSelectionReferenceId: string | null | undefined;
  codonClickHit: CdsCodonPointerHit | null;
  orfClickHit: ORF | null;
  residueSelectionsStore: ResidueSelectionsStore | null;
  fullSequence: string;
  anchorRef: { current: CdsResidueSelectionAnchor | null };
}): boolean {
  const {
    event,
    coordinateMode,
    residueSelectionReferenceId,
    codonClickHit,
    orfClickHit,
    residueSelectionsStore,
    fullSequence,
    anchorRef,
  } = args;
  if (!isResidueSelectionPointerIntent(event)) return false;

  const failureReason = residueSelectionClickFailureReason({
    coordinateMode,
    residueSelectionReferenceId,
    codonClickHit,
    orfClickHit,
    residueSelectionsStore,
  });

  if (!failureReason && residueSelectionReferenceId && codonClickHit && residueSelectionsStore) {
    const residueSelection = buildResidueSelectionForCdsCodon({
      referenceId: residueSelectionReferenceId,
      cds: codonClickHit.cds,
      codon: codonClickHit,
      fullSequence,
    });
    if (residueSelection) {
      const anchor = anchorRef.current;
      const currentResidueSelections = residueSelectionsStore.getSnapshot();
      const existingSelection = anchor
        ? findResidueSelectionForMolecule(currentResidueSelections, anchor.selection.target)
        : undefined;
      if (
        event.shiftKey &&
        anchor &&
        existingSelection &&
        anchor.referenceId === residueSelectionReferenceId &&
        anchor.selection.target.moleculeId === residueSelection.target.moleculeId &&
        anchor.selection.target.moleculeKind === residueSelection.target.moleculeKind
      ) {
        const rangeSelection = buildResidueSelectionForCdsCodonRange({
          referenceId: residueSelectionReferenceId,
          cds: codonClickHit.cds,
          anchorCodon: anchor.codon,
          codon: codonClickHit,
          existingSelection,
          fullSequence,
        });
        if (rangeSelection) {
          residueSelectionsStore.set(
            replaceResidueSelectionForMolecule(currentResidueSelections, rangeSelection)
          );
          publishResidueSelectionPointerDebug({
            stage: 'range',
            result: true,
            referenceId: residueSelectionReferenceId,
            coordinateMode: coordinateMode ?? null,
            hasStore: true,
            clientX: event.clientX,
            clientY: event.clientY,
            codon: {
              start: codonClickHit.start,
              end: codonClickHit.end,
              strand: codonClickHit.strand,
              residueIndex: codonClickHit.residueIndex,
            },
            anchorCodon: anchor.codon,
            selectionId: rangeSelection.selectionId ?? null,
            snapshotLength: residueSelectionsStore.getSnapshot().length,
          });
          event.preventDefault();
          event.stopPropagation();
          return true;
        }
        publishResidueSelectionPointerDebug({
          stage: 'range',
          result: false,
          reason: 'build-range-selection-null',
          referenceId: residueSelectionReferenceId,
          coordinateMode: coordinateMode ?? null,
          hasStore: true,
          clientX: event.clientX,
          clientY: event.clientY,
          codon: codonClickHit,
          anchorCodon: anchor.codon,
        });
        return false;
      }
      residueSelectionsStore.dispatch({
        type: 'toggle',
        selection: residueSelection,
      });
      anchorRef.current =
        residueSelectionsStore.getSnapshot().length === 0
          ? null
          : {
              referenceId: residueSelectionReferenceId,
              codon: codonClickHit,
              selection: residueSelection,
            };
      publishResidueSelectionPointerDebug({
        stage: 'toggle',
        result: true,
        referenceId: residueSelectionReferenceId,
        coordinateMode: coordinateMode ?? null,
        hasStore: true,
        extendRange: event.shiftKey,
        hasRangeAnchor: !!anchorRef.current,
        clientX: event.clientX,
        clientY: event.clientY,
        codon: {
          start: codonClickHit.start,
          end: codonClickHit.end,
          strand: codonClickHit.strand,
          residueIndex: codonClickHit.residueIndex,
        },
        selectionId: residueSelection.selectionId ?? null,
        snapshotLength: residueSelectionsStore.getSnapshot().length,
      });
      event.preventDefault();
      event.stopPropagation();
      return true;
    }
    publishResidueSelectionPointerDebug({
      stage: 'toggle',
      result: false,
      reason: 'build-selection-null',
      referenceId: residueSelectionReferenceId,
      coordinateMode: coordinateMode ?? null,
      hasStore: true,
      clientX: event.clientX,
      clientY: event.clientY,
      codon: codonClickHit,
    });
    return false;
  }

  publishResidueSelectionPointerDebug({
    stage: 'toggle',
    result: false,
    reason: failureReason,
    referenceId: residueSelectionReferenceId ?? null,
    coordinateMode: coordinateMode ?? null,
    hasStore: !!residueSelectionsStore,
    clientX: event.clientX,
    clientY: event.clientY,
    codon: codonPointerDebugFields(codonClickHit),
  });
  return false;
}

function columnToBiological1D(col: number, columnCount: number, isCircular: boolean): number {
  if (isCircular) return biologicalColumn(col, columnCount);
  return Math.max(0, Math.min(columnCount - 1, col));
}

function pointerMovedBeyondClickTolerance(
  downPos: { x: number; y: number } | null,
  clientX: number,
  clientY: number
): boolean {
  const dx = downPos ? clientX - downPos.x : 0;
  const dy = downPos ? clientY - downPos.y : 0;
  return dx * dx + dy * dy > 25;
}

function findRenderedPrimerAtPoint1D(
  segments: readonly RenderedPrimerSegment[],
  layoutMouseX: number,
  layoutY: number
): PrimerDisplay | null {
  for (const rp of segments) {
    if (
      layoutMouseX >= rp.x &&
      layoutMouseX <= rp.x + rp.width &&
      layoutY >= rp.y &&
      layoutY <= rp.y + rp.height
    ) {
      return rp.primer;
    }
  }
  return null;
}

function findOrfAtViewerPoint1D(
  orfs: readonly ORF[] | undefined,
  layout: Layout1D,
  layoutY: number,
  bioCol: number
): ORF | null {
  if (!orfs || orfs.length === 0 || layout.orfLaneCount <= 0) return null;
  return findOrfAtPointInBand(
    {
      bandY: layout.orfBandTop,
      bandHeight: layout.orfBandHeight,
      laneCount: layout.orfLaneCount,
      laneHeight: layout.orfLaneHeight,
      orfs: layout.orfsWithLanes,
    },
    layoutY,
    bioCol
  );
}

function tryHandleCutSiteClick1D(args: {
  rendered: RenderedCutSite[];
  layoutMouseX: number;
  layoutY: number;
  columnCount: number;
  onCutSiteClick?: (cutSite: ColoredCutSite) => void;
  onSelectionChange?: (selection: Selection | null) => void;
}): boolean {
  const cutClick = hitTestCutSiteLabel1D(args.rendered, args.layoutMouseX, args.layoutY);
  if (!cutClick) return false;
  args.onCutSiteClick?.(cutClick.cutSite);
  args.onSelectionChange?.(cutSiteRecognitionSelection(cutClick.cutSite, args.columnCount));
  return true;
}

function tryHandlePrimerClick1D(args: {
  segments: readonly RenderedPrimerSegment[];
  layoutMouseX: number;
  layoutY: number;
  onSelectionChange?: (selection: Selection | null) => void;
}): boolean {
  const primerClick = findRenderedPrimerAtPoint1D(args.segments, args.layoutMouseX, args.layoutY);
  if (!primerClick || primerClick.isCandidate || primerClick.isDraft) return false;
  args.onSelectionChange?.({
    start: primerClick.start,
    end: primerClick.end - 1,
    wraps: primerClick.start > primerClick.end,
  });
  return true;
}

function parentCdsForPointerHits(
  codonHit: CdsCodonPointerHit | null,
  cdsLaneHit: { cds: ClassifiedCDS } | null
): ClassifiedCDS | null {
  return codonHit?.cds ?? cdsLaneHit?.cds ?? null;
}

function tryApplyFeaturePointerClick1D(args: {
  annClickHit: AnnotationWithLane | null;
  parentCdsForClick: ClassifiedCDS | null;
  classifiedCDSs: ClassifiedCDS[];
  bioCol: number;
  orfClickHit: ORF | null;
  applyPointerSelection1D: (result: PointerSelectionResult) => void;
  onSelectionChange?: (selection: Selection | null) => void;
}): boolean {
  const pointerSel = resolvePointerSelection({
    annotationHit: args.annClickHit,
    parentCdsForCodon: args.parentCdsForClick,
    classifiedCDSs: args.classifiedCDSs,
    position: args.bioCol,
    showAnnotations: true,
    showTranslation: true,
    orfHit: args.orfClickHit,
  });
  args.applyPointerSelection1D(pointerSel);
  if (!pointerSel.annotation && !pointerSel.orf) return false;
  args.onSelectionChange?.(null);
  return true;
}

function clearBareCanvasClick1D(args: {
  bioCol: number;
  onSelectionChange?: (selection: Selection | null) => void;
  onViewCursorChange?: (position: number | null) => void;
  selectedAnnotationRef: { current: AnnotationStateIdentity | null };
  onSelectedAnnotationChange?: (annotation: AnnotationStateIdentity | null) => void;
  redraw: () => void;
}): void {
  args.onSelectionChange?.(null);
  args.onViewCursorChange?.(args.bioCol);
  if (args.selectedAnnotationRef.current === null) return;
  args.selectedAnnotationRef.current = null;
  args.onSelectedAnnotationChange?.(null);
  args.redraw();
}

function applyPassivePointerSurface1D(args: {
  target: HTMLDivElement;
  passiveCursor: React.CSSProperties['cursor'];
  hoverColRef: { current: number | null };
  hoveredCodonRef: { current: PaintCodonKey | null };
  hoveredOrfRef: { current: PaintOrfIdentity | null };
  hoveredAnnotationRef: { current: AnnotationStateIdentity | null };
  redraw: () => void;
}): void {
  args.target.style.cursor = args.passiveCursor ?? 'inherit';
  if (
    args.hoverColRef.current === null &&
    args.hoveredCodonRef.current === null &&
    args.hoveredOrfRef.current === null &&
    args.hoveredAnnotationRef.current === null
  ) {
    return;
  }
  args.hoverColRef.current = null;
  args.hoveredCodonRef.current = null;
  args.hoveredOrfRef.current = null;
  args.hoveredAnnotationRef.current = null;
  args.redraw();
}

function snapHoverColumnFromLayoutX(
  layoutMouseX: number,
  pxPerBase: number,
  columnCount: number,
  isCircular: boolean
): { raw: number; snapped: number } {
  const raw = Math.floor((layoutMouseX - HORIZONTAL_PADDING_1D) / pxPerBase);
  return { raw, snapped: columnToBiological1D(raw, columnCount, isCircular) };
}

function cutSiteHoverChanged(cutHit: RenderedCutSite | null, prev: ColoredCutSite | null): boolean {
  if ((cutHit === null) !== (prev === null)) return true;
  if (!cutHit || !prev) return false;
  return (
    cutHit.cutSite.enzyme.name !== prev.enzyme.name ||
    cutHit.cutSite.cutPositionTop !== prev.cutPositionTop
  );
}

function applyCutSiteHoverPointer1D(
  cutHit: RenderedCutSite | null,
  hoveredCutSiteRef: { current: ColoredCutSite | null },
  redraw: () => void
): void {
  if (!cutSiteHoverChanged(cutHit, hoveredCutSiteRef.current)) return;
  hoveredCutSiteRef.current = cutHit ? cutHit.cutSite : null;
  redraw();
}

function applyPrimerHoverPointer1D(args: {
  primerHit: PrimerDisplay | null;
  hoveredPrimer: PrimerDisplay | null;
  primerTooltipPos: { x: number; y: number } | null;
  clientX: number;
  clientY: number;
  setHoveredPrimer: (primer: PrimerDisplay | null) => void;
  setPrimerTooltipPos: (pos: { x: number; y: number } | null) => void;
}): void {
  if ((args.hoveredPrimer?.id ?? null) !== (args.primerHit?.id ?? null)) {
    args.setHoveredPrimer(args.primerHit);
  }
  if (args.primerHit) {
    args.setPrimerTooltipPos({ x: args.clientX, y: args.clientY });
  } else if (args.primerTooltipPos) {
    args.setPrimerTooltipPos(null);
  }
}

function isOverClickableFeature1D(
  annotationHit: boolean,
  cdsLaneHit: boolean,
  orfHit: boolean,
  cutHit: boolean,
  primerHit: boolean
): boolean {
  if (annotationHit) return true;
  if (cdsLaneHit) return true;
  if (orfHit) return true;
  if (cutHit) return true;
  if (primerHit) return true;
  return false;
}

function pointerSurfaceCursor1D(
  draggingHandle: boolean,
  hoverHandle: 'start' | 'end' | null,
  overFeature: boolean
): 'ew-resize' | 'pointer' | 'text' {
  if (draggingHandle || hoverHandle) return 'ew-resize';
  return overFeature ? 'pointer' : 'text';
}

function codonPointerIdentityChanged(
  next: { start: number; end: number; strand: 1 | -1 } | null,
  prev: PaintCodonKey | null
): boolean {
  if ((next === null) !== (prev === null)) return true;
  if (!next || !prev) return false;
  return next.start !== prev.start || next.end !== prev.end || next.strand !== prev.strand;
}

function clearOwnedSequenceHoveredCodon(
  store: HoveredCodonStore | null | undefined,
  lastLocal: PaintCodonKey | null
): void {
  const prev = store?.getSnapshot() ?? null;
  if (
    prev?.source === 'sequence' &&
    lastLocal &&
    prev.start === lastLocal.start &&
    prev.end === lastLocal.end &&
    prev.strand === lastLocal.strand
  ) {
    store?.set(null);
  }
}

function applyHoveredCodonPointerChange(args: {
  codonHit: CdsCodonPointerHit | null;
  hoveredCodonRef: { current: PaintCodonKey | null };
  lastLocalHoveredCodonRef: { current: PaintCodonKey | null };
  store: HoveredCodonStore | null | undefined;
}): boolean {
  if (!codonPointerIdentityChanged(args.codonHit, args.hoveredCodonRef.current)) return false;
  args.hoveredCodonRef.current = args.codonHit
    ? { start: args.codonHit.start, end: args.codonHit.end, strand: args.codonHit.strand }
    : null;
  if (args.hoveredCodonRef.current) {
    args.lastLocalHoveredCodonRef.current = args.hoveredCodonRef.current;
    args.store?.set({ ...args.hoveredCodonRef.current, source: 'sequence' });
    return true;
  }
  const lastLocal = args.lastLocalHoveredCodonRef.current;
  args.lastLocalHoveredCodonRef.current = null;
  clearOwnedSequenceHoveredCodon(args.store, lastLocal);
  return true;
}

function orfPointerIdentityChanged(
  next: PaintOrfIdentity | null,
  prev: PaintOrfIdentity | null
): boolean {
  if ((next === null) !== (prev === null)) return true;
  if (!next || !prev) return false;
  return next.start !== prev.start || next.end !== prev.end || next.strand !== prev.strand;
}

function applyHoveredOrfPointerChange(
  orfHover: ORF | null,
  hoveredOrfRef: { current: PaintOrfIdentity | null }
): boolean {
  const orfHoverIdent = orfHover
    ? { start: orfHover.start, end: orfHover.end, strand: orfHover.strand }
    : null;
  const changed = orfPointerIdentityChanged(orfHoverIdent, hoveredOrfRef.current);
  if (changed) hoveredOrfRef.current = orfHoverIdent;
  return changed;
}

function annotationPointerIdentityChanged(
  next: AnnotationStateIdentity | null,
  prev: AnnotationStateIdentity | null
): boolean {
  if ((next === null) !== (prev === null)) return true;
  if (!next || !prev) return false;
  return (
    next.type !== prev.type ||
    next.name !== prev.name ||
    next.start !== prev.start ||
    next.end !== prev.end ||
    next.direction !== prev.direction
  );
}

function resolveHoveredAnnotation1D(args: {
  orfHover: ORF | null;
  annHoverHit: AnnotationWithLane | null;
  codonHoverHit: CdsCodonPointerHit | null;
  cdsLaneHoverHit: { cds: ClassifiedCDS } | null;
  classifiedCDSs: ClassifiedCDS[];
  bioCol: number;
}): AnnotationStateIdentity | null {
  if (args.orfHover) return null;
  return resolveAnnotationTarget({
    annotationHit: args.annHoverHit,
    parentCdsForCodon: parentCdsForPointerHits(args.codonHoverHit, args.cdsLaneHoverHit),
    classifiedCDSs: args.classifiedCDSs,
    position: args.bioCol,
    showAnnotations: true,
    showTranslation: true,
  });
}

function pointerHoverNeedsRedraw(
  hoverCol: number | null,
  snapped: number,
  hoverChanged: boolean,
  orfHoverChanged: boolean,
  hoveredAnnChanged: boolean
): boolean {
  return hoverCol !== snapped || hoverChanged || orfHoverChanged || hoveredAnnChanged;
}

function featureLaneKey(feature: Annotation): string {
  const maybeId = (feature as { id?: string }).id;
  if (maybeId) return `id:${maybeId}`;
  const name = feature.name || '';
  const type = feature.type || '';
  const direction = feature.direction ?? 1;
  if (name || type) return `named:${name}|${type}|${direction}`;
  return `pos:${feature.start}|${feature.end}|${direction}`;
}

function anchorAnnotationLanes(
  content: AnnotationWithLane[],
  anchor: AnnotationWithLane[],
  anchorLaneCount: number
): AnnotationWithLane[] {
  if (anchorLaneCount <= 0) return [];
  const maxLane = anchorLaneCount - 1;
  const anchorLanes = new Map<string, number>();
  for (const annotation of anchor) {
    if (annotation.lane < 0) continue;
    anchorLanes.set(featureLaneKey(annotation), Math.min(maxLane, annotation.lane));
  }
  return content.map((annotation) => {
    const anchoredLane = anchorLanes.get(featureLaneKey(annotation));
    const lane =
      anchoredLane ??
      Math.max(0, Math.min(maxLane, Number.isFinite(annotation.lane) ? annotation.lane : 0));
    return { ...annotation, lane };
  });
}

function anchorCdsLanes(
  content: ClassifiedCDS[],
  anchor: ClassifiedCDS[],
  anchorLaneCount: number
): ClassifiedCDS[] {
  if (anchorLaneCount <= 0) return [];
  const maxLane = anchorLaneCount - 1;
  const anchorLanes = new Map<string, number>();
  for (const cds of anchor) {
    if (cds.translationLane < 0) continue;
    anchorLanes.set(featureLaneKey(cds), Math.min(maxLane, cds.translationLane));
  }
  return content.map((cds) => {
    const anchoredLane = anchorLanes.get(featureLaneKey(cds));
    const translationLane =
      anchoredLane ??
      Math.max(
        0,
        Math.min(maxLane, Number.isFinite(cds.translationLane) ? cds.translationLane : 0)
      );
    return { ...cds, translationLane };
  });
}

function anchor1DGeometry(content: Layout1D, anchor: Layout1D): Layout1D {
  return {
    ...content,
    totalWidth: anchor.totalWidth,
    totalHeight: anchor.totalHeight,
    renderColumnCount: anchor.renderColumnCount,
    showReverseComplement: anchor.showReverseComplement,
    complementRowY: anchor.complementRowY,
    annotations: anchorAnnotationLanes(content.annotations, anchor.annotations, anchor.laneCount),
    laneCount: anchor.laneCount,
    hasOverflow: anchor.hasOverflow,
    overflowCounts: anchor.overflowCounts,
    classifiedCDSs: anchorCdsLanes(
      content.classifiedCDSs,
      anchor.classifiedCDSs,
      anchor.translationLaneCount
    ),
    translationLaneCount: anchor.translationLaneCount,
    orfLaneCount: anchor.orfLaneCount,
    overflowBandY: anchor.overflowBandY,
    laneBandTop: anchor.laneBandTop,
    laneBandHeight: anchor.laneBandHeight,
    cutSiteLabelRowY: anchor.cutSiteLabelRowY,
    cutSiteLabelRowHeight: anchor.cutSiteLabelRowHeight,
    forwardPrimerBandTop: anchor.forwardPrimerBandTop,
    forwardPrimerBandHeight: anchor.forwardPrimerBandHeight,
    forwardPrimerLaneCount: anchor.forwardPrimerLaneCount,
    reversePrimerBandTop: anchor.reversePrimerBandTop,
    reversePrimerBandHeight: anchor.reversePrimerBandHeight,
    reversePrimerLaneCount: anchor.reversePrimerLaneCount,
    translationBandTop: anchor.translationBandTop,
    translationLaneHeight: anchor.translationLaneHeight,
    translationBandHeight: anchor.translationBandHeight,
    orfBandTop: anchor.orfBandTop,
    orfLaneHeight: anchor.orfLaneHeight,
    orfBandHeight: anchor.orfBandHeight,
    sequenceRowY: anchor.sequenceRowY,
    sequenceRowHeight: anchor.sequenceRowHeight,
    rulerY: anchor.rulerY,
    mutationTrackY: anchor.mutationTrackY,
    mutationTrackHeight: anchor.mutationTrackHeight,
    hasMutationTrack: anchor.hasMutationTrack,
  };
}

function roundLayoutValue(value: number): string {
  return String(Math.round(value * 100) / 100);
}

export const SequenceViewer1D = forwardRef<SequenceViewer1DHandle, SequenceViewer1DProps>(
  function SequenceViewer1D(
    {
      sequence,
      layoutAnchorSequence,
      extraLanes,
      selection,
      onSelectionChange,
      viewCursor,
      onViewCursorChange,
      initialPxPerBase = DEFAULT_PX_PER_BASE,
      zoomPercent,
      onZoomChange,
      scrollLeft: controlledScrollLeft,
      onScrollLeftChange,
      wheelScrollEnabled = true,
      showScrollbar = true,
      showRuler = true,
      mutedColumns,
      mutedColumnColor,
      scrollToPosition,
      scrollCommandId,
      scrollAnimate,
      onScrollToPositionComplete,
      scrollPresentation,
      selectedAnnotationIds,
      selectedAnnotation,
      onSelectedAnnotationChange,
      residueSelectionReferenceId,
      orfs,
      onOrfsPresented,
      candidateOrf,
      aaColorScheme = 'rasmol',
      annotationColorMode = DEFAULT_EDITOR_CONFIG.annotationColorMode,
      showReverseComplement = true,
      className,
      style,
      pointerInteractionsEnabled = true,
      primerHoverEnabled = pointerInteractionsEnabled,
      passiveCursor = 'inherit',
      onViewportChange,
      cutSites,
      scannedCutSites,
      showCutSites = true,
      onCutSiteClick,
      onCutSiteDoubleClick,
      hoveredEnzymeName = null,
      hoveredPositionInfo = null,
      primers,
      showPrimers = true,
      suppressPrimerDrawing = false,
      transparentBackground = false,
      onPrimerLayoutChange,
      searchMatches,
      activeSearchIndex,
      coordinateSpace,
      mutations,
      rulerDecorations,
      onContextMenu,
    }: SequenceViewer1DProps,
    ref
  ) {
    const scrollContainerRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);

    const [pxPerBase, setPxPerBaseState] = useState<number>(() => {
      const seed =
        typeof zoomPercent === 'number' && isFinite(zoomPercent) && zoomPercent > 0
          ? (DEFAULT_PX_PER_BASE * zoomPercent) / 100
          : initialPxPerBase;
      return Math.max(MIN_PX_PER_BASE_1D, Math.min(MAX_PX_PER_BASE_1D, seed));
    });
    const scrollLeftRef = useRef<number>(0);
    const [scrollLeftForUI, setScrollLeftForUI] = useState<number>(0);
    const [viewportWidth, setViewportWidth] = useState<number>(0);
    const shouldTrackScrollForReact = sequenceViewer1DShouldTrackScroll(
      showScrollbar,
      onViewportChange
    );

    const hoverColRef = useRef<number | null>(null);
    const hoveredCodonRef = useRef<{
      start: number;
      end: number;
      strand: 1 | -1;
    } | null>(null);
    const lastLocalHoveredCodonRef = useRef<{
      start: number;
      end: number;
      strand: 1 | -1;
    } | null>(null);
    const hoveredCodonStore = useHoveredCodonStore();
    const selectedCodons = useSelectedCodons();
    const residueSelectionsStore = useResidueSelectionsStore();
    const residueSelectionAnchorRef = useRef<CdsResidueSelectionAnchor | null>(null);
    useEffect(() => {
      if (!hoveredCodonStore) return;
      const sync = () => {
        const next = hoveredCodonStore.getSnapshot();
        const prev = hoveredCodonRef.current;
        const changed =
          (next === null) !== (prev === null) ||
          (next &&
            prev &&
            (next.start !== prev.start || next.end !== prev.end || next.strand !== prev.strand));
        if (changed) {
          hoveredCodonRef.current = next;
          drawRef.current?.();
        }
      };
      sync();
      return hoveredCodonStore.subscribe(sync);
    }, [hoveredCodonStore]);

    const hoveredOrfRef = useRef<{ start: number; end: number; strand: '+' | '-' } | null>(null);
    const selectedOrfRef = useRef<{ start: number; end: number; strand: '+' | '-' } | null>(null);

    const hoveredAnnotationRef = useRef<AnnotationStateIdentity | null>(null);
    const selectedAnnotationRef = useRef<AnnotationStateIdentity | null>(null);

    const layoutTotalWidthRef = useRef(0);
    const viewportWidthRef = useRef(0);
    const columnCountRef = useRef(0);
    const pxPerBaseRef = useRef(0);
    const scrollToBaseRef = useRef<
      | ((
          baseIndex: number,
          options?: { animate?: boolean; onComplete?: () => void }
        ) => (() => void) | undefined)
      | null
    >(null);
    const bioToColMapRef = useRef<ReadonlyMap<number, number> | null>(null);
    useEffect(() => {
      // global singleton, so a preview mounting would OVERWRITE the genome viewer's
      if (!pointerInteractionsEnabled) return;
      const w = window as Window & {
        __test?: {
          sequenceViewer1D?: {
            getHoveredAnnotation: () => AnnotationStateIdentity | null;
            getSelectedAnnotation: () => AnnotationStateIdentity | null;
            getScrollState: () => {
              scrollLeft: number;
              clientWidth: number;
              layoutTotalWidth: number;
              columnCount: number;
              pxPerBase: number;
              hpad: number;
            };
            scrollToBpImmediate: (bp: number) => void;
          };
        };
      };
      if (!w.__test) return;
      w.__test.sequenceViewer1D = {
        getHoveredAnnotation: () => hoveredAnnotationRef.current,
        getSelectedAnnotation: () => selectedAnnotationRef.current,
        getScrollState: () => ({
          scrollLeft: scrollLeftRef.current,
          clientWidth: scrollContainerRef.current?.clientWidth ?? viewportWidthRef.current,
          layoutTotalWidth: layoutTotalWidthRef.current,
          columnCount: columnCountRef.current,
          pxPerBase: pxPerBaseRef.current,
          hpad: HORIZONTAL_PADDING_1D,
        }),
        scrollToBpImmediate: (bp: number) => {
          const map = bioToColMapRef.current;
          let col: number;
          if (map != null) {
            const lookup = map.get(bp);
            if (lookup === undefined) return;
            col = lookup;
          } else {
            col = bp - 1;
          }
          scrollToBaseRef.current?.(col, { animate: false });
        },
      };
      return () => {
        if (w.__test) delete w.__test.sequenceViewer1D;
      };
    }, [pointerInteractionsEnabled]);

    const hoveredCutSiteRef = useRef<ColoredCutSite | null>(null);
    const renderedCutSitesRef = useRef<RenderedCutSite[]>([]);

    const [hoveredPrimer, setHoveredPrimer] = useState<PrimerDisplay | null>(null);
    const [primerTooltipPos, setPrimerTooltipPos] = useState<{ x: number; y: number } | null>(null);
    const [annotationTooltipPos, setAnnotationTooltipPos] = useState<{
      x: number;
      y: number;
      position: number;
    } | null>(null);
    const paintedCodonsRef = useRef<CodonInfo[]>([]);
    const hoveredCodonForTooltip = useHoveredCodon();
    const hoveredCodonNameLine = useMemo(() => {
      if (!hoveredCodonForTooltip) return null;
      const cell = paintedCodonsRef.current.find(
        (codon) =>
          codon.startPos === hoveredCodonForTooltip.start &&
          codon.endPos === hoveredCodonForTooltip.end
      );
      return cell ? codonNameLine(cell.display) : null;
    }, [hoveredCodonForTooltip]);
    const [hoveredFeatureFacts, setHoveredFeatureFacts] = useState<{
      type: string;
      name: string;
      start: number;
      end: number;
      direction?: number;
      segments?: { start: number; end: number }[];
    } | null>(null);
    const renderedPrimersRef = useRef<RenderedPrimerSegment[]>([]);
    const dragStateRef = useRef<{ anchorCol: number; currentCol: number } | null>(null);
    const pointerDownPosRef = useRef<{ x: number; y: number } | null>(null);
    const handleDragRef = useRef<{ anchorCol: number; edge: 'start' | 'end' } | null>(null);

    const selectionAnchorRef = useRef<number | null>(null);
    const autoscrollDirRef = useRef<-1 | 0 | 1>(0);
    const autoscrollRafRef = useRef<number | null>(null);

    useEffect(() => {
      if (sequence?.sequence && !validateCoordinateSpace(coordinateSpace, sequence.sequence)) {
        // eslint-disable-next-line no-console
        console.warn(
          '[SequenceViewer1D] coordinateSpace failed validation — non-gap count of gappedSequence does not match biological sequence length. Overlays may render at incorrect positions.'
        );
      }
    }, [coordinateSpace, sequence?.sequence]);

    const remap = useCoordinateSpaceRemap({
      sequence,
      coordinateSpace,
      orfs,
      cutSites,
      scannedCutSites,
      rulerDecorations,
    });
    const {
      effectiveOrfs,
      effectiveCutSites,
      effectiveScannedCutSites,
      effectiveRulerDecorations,
    } = remap;
    const effectiveSequence: AnnotatedSequence = remap.effectiveSequence ?? sequence;

    const recordCode = useMemo(
      () => resolveSequenceGeneticCode(effectiveSequence),
      [
        effectiveSequence.annotations,
        effectiveSequence.chosenGeneticCode,
        effectiveSequence.unreadableGeneticCode,
      ]
    );

    const columnCount = effectiveSequence.sequence.length;
    const mutedColumnSet = useMemo(() => new Set(mutedColumns ?? []), [mutedColumns]);
    const isCircular = sequenceViewer1DIsCircular(
      isGappedMode(coordinateSpace),
      effectiveSequence.circular
    );
    const hasCutSites = sequenceViewer1DHasCutSites(
      showCutSites,
      effectiveCutSites?.length,
      effectiveScannedCutSites?.length
    );
    const gappedSequenceForLayout = sequenceViewer1DGappedSequenceForLayout(
      isGappedMode(coordinateSpace),
      coordinateSpace?.gappedSequence
    );
    const hasMutationTrackInput = sequenceViewer1DHasMutationTrack(
      mutations?.length,
      coordinateSpace?.alignedQuery
    );
    const layoutSnapshot = useMemo(() => {
      const contentLayout = compute1DLayout({
        columnCount,
        annotations: effectiveSequence.annotations ?? [],
        selectedIds: selectedAnnotationIds,
        pxPerBase,
        fullSequence: effectiveSequence.sequence,
        orfs: effectiveOrfs,
        isCircular,
        showReverseComplement,
        showCutSites: hasCutSites,
        showRuler,
        primers,
        showPrimers,
        gappedSequence: gappedSequenceForLayout,
        hasMutationTrack: hasMutationTrackInput,
      });

      if (!layoutAnchorSequence || layoutAnchorSequence.sequence.length !== columnCount) {
        return {
          layout: contentLayout,
          contentLayout,
          anchorLayout: null,
        };
      }

      const anchorLayout = compute1DLayout({
        columnCount,
        annotations: layoutAnchorSequence.annotations ?? [],
        selectedIds: selectedAnnotationIds,
        pxPerBase,
        fullSequence: layoutAnchorSequence.sequence,
        orfs: effectiveOrfs,
        isCircular: isGappedMode(coordinateSpace)
          ? false
          : (layoutAnchorSequence.circular ?? isCircular),
        showReverseComplement,
        showCutSites: hasCutSites,
        showRuler,
        primers,
        showPrimers,
        gappedSequence: gappedSequenceForLayout,
        hasMutationTrack: hasMutationTrackInput,
      });

      return {
        layout: anchor1DGeometry(contentLayout, anchorLayout),
        contentLayout,
        anchorLayout,
      };
    }, [
      columnCount,
      effectiveSequence.annotations,
      selectedAnnotationIds,
      pxPerBase,
      effectiveSequence.sequence,
      effectiveOrfs,
      isCircular,
      coordinateSpace,
      layoutAnchorSequence,
      showReverseComplement,
      gappedSequenceForLayout,
      hasMutationTrackInput,
      hasCutSites,
      showRuler,
      primers,
      showPrimers,
    ]);
    const { layout, contentLayout, anchorLayout } = layoutSnapshot;

    const adapter = useMemo(() => create1DLayoutAdapter(layout), [layout]);

    layoutTotalWidthRef.current = layout.totalWidth;
    viewportWidthRef.current = viewportWidth;
    columnCountRef.current = columnCount;
    pxPerBaseRef.current = pxPerBase;
    bioToColMapRef.current = remap.bioToColMap ?? null;

    const effectiveMinPxPerBase = useMemo(() => {
      if (viewportWidth <= 0 || columnCount <= 0) return MIN_PX_PER_BASE_1D;
      const innerW = Math.max(1, viewportWidth - HORIZONTAL_PADDING_1D * 2);
      const fitFloor = innerW / columnCount;
      return Math.max(MIN_PX_PER_BASE_1D, Math.min(MAX_PX_PER_BASE_1D, fitFloor));
    }, [viewportWidth, columnCount]);

    const setPxPerBase = useCallback(
      (next: number) => {
        const clamped = Math.max(effectiveMinPxPerBase, Math.min(MAX_PX_PER_BASE_1D, next));
        setPxPerBaseState(clamped);
        if (onZoomChange) onZoomChange((clamped / DEFAULT_PX_PER_BASE) * 100);
      },
      [onZoomChange, effectiveMinPxPerBase]
    );

    useEffect(() => {
      if (typeof zoomPercent !== 'number' || !isFinite(zoomPercent) || zoomPercent <= 0) return;
      const scaled = (DEFAULT_PX_PER_BASE * zoomPercent) / 100;
      const clamped = Math.max(effectiveMinPxPerBase, Math.min(MAX_PX_PER_BASE_1D, scaled));
      if (Math.abs(pxPerBaseRef.current - clamped) > 1e-6) cancelWheelMotion();
      setPxPerBaseState((prev) => (Math.abs(prev - clamped) < 1e-6 ? prev : clamped));
      // eslint-disable-next-line react-hooks/exhaustive-deps -- floor is a
    }, [zoomPercent]);

    useLayoutEffect(() => {
      const el = scrollContainerRef.current;
      if (!el || typeof ResizeObserver === 'undefined') return;
      const update = () => setViewportWidth(el.clientWidth);
      update();
      const ro = new ResizeObserver(update);
      ro.observe(el);
      return () => ro.disconnect();
    }, []);

    const drawRef = useRef<(() => void) | null>(null);

    useEffect(() => {
      if (selectedAnnotation === undefined) return;
      if (annotationIdentityEqual(selectedAnnotationRef.current, selectedAnnotation ?? null)) {
        return;
      }
      selectedAnnotationRef.current = selectedAnnotation ?? null;
      if (selectedAnnotation) {
        selectedOrfRef.current = null;
      }
      drawRef.current?.();
    }, [
      selectedAnnotation?.type,
      selectedAnnotation?.name,
      selectedAnnotation?.start,
      selectedAnnotation?.end,
      selectedAnnotation?.direction,
    ]);

    const applyPointerSelection1D = useCallback(
      (result: PointerSelectionResult) => {
        let needsRedraw = false;
        if (!orfIdentityEqual(selectedOrfRef.current, result.orf)) {
          selectedOrfRef.current = result.orf;
          needsRedraw = true;
        }
        if (!annotationIdentityEqual(selectedAnnotationRef.current, result.annotation)) {
          selectedAnnotationRef.current = result.annotation;
          onSelectedAnnotationChange?.(result.annotation);
          needsRedraw = true;
        }
        if (needsRedraw) drawRef.current?.();
      },
      [onSelectedAnnotationChange]
    );

    const clampScroll = useCallback(
      (next: number): number => {
        if (isCircular) {
          const cycle = columnCount * pxPerBase;
          if (cycle <= 0) return 0;
          const wrapped = ((next % cycle) + cycle) % cycle;
          return wrapped;
        }
        const liveWidth = scrollContainerRef.current?.clientWidth ?? viewportWidth;
        const maxScroll = Math.max(0, layout.totalWidth - liveWidth / 2);
        return Math.max(0, Math.min(maxScroll, next));
      },
      [layout.totalWidth, viewportWidth, isCircular, columnCount, pxPerBase]
    );
    const applyScroll = useCallback(
      (next: number) => {
        const clamped = clampScroll(next);
        if (clamped === scrollLeftRef.current) return;
        scrollLeftRef.current = clamped;
        if (shouldTrackScrollForReact) {
          setScrollLeftForUI(clamped);
        }
        drawRef.current?.();
        onScrollLeftChange?.(clamped);
      },
      [clampScroll, onScrollLeftChange, shouldTrackScrollForReact]
    );

    const wheelMotionRef = useRef(new WheelMotion());
    const wheelZoomMotionRef = useRef(new WheelMotion(1e-6));
    const wheelZoomCursorRef = useRef(0);
    const wheelZoomWrittenRef = useRef<number | null>(null);
    const wheelRafRef = useRef<number | null>(null);
    const scrollAnimationRafRef = useRef<number | null>(null);
    const cancelScrollAnimation = useCallback(() => {
      if (scrollAnimationRafRef.current !== null) {
        cancelAnimationFrame(scrollAnimationRafRef.current);
        scrollAnimationRafRef.current = null;
      }
    }, []);
    const wheelHandlersRef = useRef({
      applyScroll,
      clampScroll,
      isCircular,
      setPxPerBase,
      effectiveMinPxPerBase,
    });
    wheelHandlersRef.current = {
      applyScroll,
      clampScroll,
      isCircular,
      setPxPerBase,
      effectiveMinPxPerBase,
    };
    const cancelWheelMotion = useCallback(() => {
      cancelScrollAnimation();
      if (wheelRafRef.current !== null) cancelAnimationFrame(wheelRafRef.current);
      wheelRafRef.current = null;
      wheelMotionRef.current.cancel();
      wheelZoomMotionRef.current.cancel();
    }, [cancelScrollAnimation]);
    const scheduleWheelFrame = useCallback(() => {
      const clampMotion = (value: number) =>
        wheelHandlersRef.current.isCircular ? value : wheelHandlersRef.current.clampScroll(value);
      const clampZoom = (value: number) =>
        Math.max(
          Math.log(wheelHandlersRef.current.effectiveMinPxPerBase),
          Math.min(Math.log(MAX_PX_PER_BASE_1D), value)
        );
      if (
        (!wheelMotionRef.current.pending && !wheelZoomMotionRef.current.pending) ||
        wheelRafRef.current !== null
      )
        return;
      const step = (now: number) => {
        wheelRafRef.current = null;
        const zoomMotion = wheelZoomMotionRef.current;
        const nextZoom = zoomMotion.advance(Math.log(pxPerBaseRef.current), now, clampZoom);
        if (nextZoom !== null) {
          const nextPxPerBase = Math.exp(nextZoom);
          nextZoomAnchorRef.current = { screenX: wheelZoomCursorRef.current };
          wheelZoomWrittenRef.current = nextPxPerBase;
          flushSync(() => wheelHandlersRef.current.setPxPerBase(nextPxPerBase));
          zoomMotion.commit(Math.log(pxPerBaseRef.current));
        }
        const motion = wheelMotionRef.current;
        const next = motion.advance(scrollLeftRef.current, now, clampMotion);
        if (next !== null) {
          wheelHandlersRef.current.applyScroll(next);
          motion.commit(scrollLeftRef.current);
        }
        if (motion.pending || zoomMotion.pending) wheelRafRef.current = requestAnimationFrame(step);
      };
      wheelRafRef.current = requestAnimationFrame(step);
    }, []);
    const animateWheel = useCallback(
      (delta: number) => {
        wheelZoomMotionRef.current.cancel();
        const clampMotion = (value: number) =>
          wheelHandlersRef.current.isCircular ? value : wheelHandlersRef.current.clampScroll(value);
        wheelMotionRef.current.add(delta, scrollLeftRef.current, performance.now(), clampMotion);
        scheduleWheelFrame();
      },
      [scheduleWheelFrame]
    );
    const animateWheelZoom = useCallback(
      (delta: number, screenX: number) => {
        wheelMotionRef.current.cancel();
        wheelZoomCursorRef.current = screenX;
        wheelZoomMotionRef.current.add(
          delta,
          Math.log(pxPerBaseRef.current),
          performance.now(),
          (value) =>
            Math.max(
              Math.log(wheelHandlersRef.current.effectiveMinPxPerBase),
              Math.min(Math.log(MAX_PX_PER_BASE_1D), value)
            )
        );
        scheduleWheelFrame();
      },
      [scheduleWheelFrame]
    );
    useEffect(() => {
      window.addEventListener('pointerdown', cancelWheelMotion, { capture: true, passive: true });
      window.addEventListener('keydown', cancelWheelMotion, { capture: true });
      window.addEventListener('resize', cancelWheelMotion, { passive: true });
      return () => {
        cancelWheelMotion();
        window.removeEventListener('pointerdown', cancelWheelMotion, { capture: true });
        window.removeEventListener('keydown', cancelWheelMotion, { capture: true });
        window.removeEventListener('resize', cancelWheelMotion);
      };
    }, [cancelWheelMotion]);

    useLayoutEffect(() => {
      if (typeof controlledScrollLeft !== 'number' || !Number.isFinite(controlledScrollLeft)) {
        return;
      }
      const clamped = clampScroll(controlledScrollLeft);
      if (Math.abs(clamped - scrollLeftRef.current) < 0.5) return;
      cancelWheelMotion();
      scrollLeftRef.current = clamped;
      if (shouldTrackScrollForReact) {
        setScrollLeftForUI(clamped);
      }
      drawRef.current?.();
    }, [controlledScrollLeft, clampScroll, shouldTrackScrollForReact, cancelWheelMotion]);

    useLayoutEffect(() => {
      if (shouldTrackScrollForReact) {
        setScrollLeftForUI(scrollLeftRef.current);
      }
    }, [shouldTrackScrollForReact]);

    const onCustomScrollChange = useCallback(
      (next: number) => {
        applyScroll(next);
      },
      [applyScroll]
    );

    const scrollToBase = useCallback(
      (baseIndex: number, options?: { animate?: boolean; onComplete?: () => void }) => {
        const clamped = Math.max(0, Math.min(columnCount - 1, baseIndex));
        const x = HORIZONTAL_PADDING_1D + (clamped + 0.5) * pxPerBase;
        const liveWidth = scrollContainerRef.current?.clientWidth ?? viewportWidth;
        const targetScroll = x - liveWidth / 2;
        cancelWheelMotion();
        if (!options?.animate) {
          applyScroll(targetScroll);
          options?.onComplete?.();
          return;
        }
        const startScroll = scrollLeftRef.current;
        const clampedTarget = clampScroll(targetScroll);
        const distance = clampedTarget - startScroll;
        if (Math.abs(distance) < 0.5) {
          applyScroll(targetScroll);
          options?.onComplete?.();
          return;
        }
        const duration = 350;
        let startTime: number | null = null;
        let frameId: number;
        const step = (now: number) => {
          if (startTime === null) startTime = now;
          const elapsed = now - startTime;
          const t = Math.min(1, elapsed / duration);
          const eased = 1 - Math.pow(1 - t, 3);
          const next = startScroll + distance * eased;
          if (Math.abs(next - scrollLeftRef.current) >= 0.5) {
            scrollLeftRef.current = next;
            drawRef.current?.();
          }
          if (t < 1) {
            frameId = requestAnimationFrame(step);
            scrollAnimationRafRef.current = frameId;
          } else {
            scrollLeftRef.current = clampedTarget;
            drawRef.current?.();
            setScrollLeftForUI(clampedTarget);
            scrollAnimationRafRef.current = null;
            options?.onComplete?.();
          }
        };
        frameId = requestAnimationFrame(step);
        scrollAnimationRafRef.current = frameId;
        return () => {
          if (scrollAnimationRafRef.current === frameId) cancelScrollAnimation();
        };
      },
      [
        columnCount,
        pxPerBase,
        viewportWidth,
        applyScroll,
        cancelWheelMotion,
        clampScroll,
        cancelScrollAnimation,
      ]
    );
    useEffect(() => () => cancelScrollAnimation(), [cancelScrollAnimation]);
    useImperativeHandle(ref, () => ({ scrollToPosition: (i: number) => scrollToBase(i) }), [
      scrollToBase,
    ]);
    scrollToBaseRef.current = scrollToBase;

    const controlledScrollCommandRef = useRef<{
      position: number | null;
      id: number | null;
      completed: boolean;
      cancel?: () => void;
    }>({ position: null, id: null, completed: false });
    const scrollCompletionCallbackRef = useRef(onScrollToPositionComplete);
    scrollCompletionCallbackRef.current = onScrollToPositionComplete;
    const controlledScrollEffectInitializedRef = useRef(false);
    const controlledScrollCompletionRafRef = useRef<number | null>(null);
    const controlledScrollCompletionEpochRef = useRef(0);
    useEffect(() => {
      if (viewportWidth <= 0) return;
      const isInitialEffect = !controlledScrollEffectInitializedRef.current;
      controlledScrollEffectInitializedRef.current = true;
      const command = controlledScrollCommandRef.current;
      const commandId = scrollCommandId ?? null;
      if (scrollToPosition == null) {
        command.cancel?.();
        command.cancel = undefined;
        command.position = null;
        command.id = null;
        command.completed = false;
        return;
      }
      if (
        command.position !== scrollToPosition ||
        (commandId !== null ? command.id !== commandId : command.id !== null)
      ) {
        command.position = scrollToPosition;
        command.id = commandId;
        command.completed = false;
      }
      if (command.completed) return;

      const onCommandComplete = scrollCompletionCallbackRef.current;
      const completionEpoch = ++controlledScrollCompletionEpochRef.current;
      if (controlledScrollCompletionRafRef.current !== null) {
        cancelAnimationFrame(controlledScrollCompletionRafRef.current);
        controlledScrollCompletionRafRef.current = null;
      }
      const completeCurrentCommand = () => {
        let stableFrames = 0;
        const acknowledgeAfterStableGeometry = () => {
          if (completionEpoch !== controlledScrollCompletionEpochRef.current) return;
          if (stableFrames < 1) {
            stableFrames += 1;
            controlledScrollCompletionRafRef.current = requestAnimationFrame(
              acknowledgeAfterStableGeometry
            );
            return;
          }
          controlledScrollCompletionRafRef.current = null;
          const current = controlledScrollCommandRef.current;
          if (
            current.position !== scrollToPosition ||
            current.id !== commandId ||
            current.completed
          )
            return;
          current.completed = true;
          onCommandComplete?.();
        };
        controlledScrollCompletionRafRef.current = requestAnimationFrame(
          acknowledgeAfterStableGeometry
        );
      };
      let col: number;
      if (remap.bioToColMap) {
        const lookup = remap.bioToColMap.get(scrollToPosition);
        if (lookup === undefined) {
          completeCurrentCommand();
          return;
        }
        col = lookup;
      } else {
        col = scrollToPosition - 1;
      }
      command.cancel = scrollToBaseRef.current?.(col, {
        animate: scrollAnimate !== false && !isInitialEffect,
        onComplete: completeCurrentCommand,
      });
      return () => {
        controlledScrollCompletionEpochRef.current += 1;
        if (controlledScrollCompletionRafRef.current !== null) {
          cancelAnimationFrame(controlledScrollCompletionRafRef.current);
          controlledScrollCompletionRafRef.current = null;
        }
      };
    }, [scrollToPosition, scrollCommandId, scrollAnimate, remap.bioToColMap, viewportWidth]);

    useKeyboardNavigation1D({
      containerRef: scrollContainerRef,
      columnCount,
      isCircular,
      viewCursor,
      onViewCursorChange,
      selection,
      onSelectionChange,
      scrollToBase,
      anchorRef: selectionAnchorRef,
    });

    const viewportEmitRef = useRef<{
      scrollLeft: number;
      viewportWidth: number;
      pxPerBase: number;
    } | null>(null);
    useEffect(() => {
      if (!onViewportChange || viewportWidth === 0) return;
      const previous = viewportEmitRef.current;
      const source: ViewportChangeSource =
        previous && Math.abs(previous.scrollLeft - scrollLeftForUI) > 0.5 ? 'scroll' : 'layout';
      viewportEmitRef.current = { scrollLeft: scrollLeftForUI, viewportWidth, pxPerBase };
      const sl = scrollLeftForUI;
      const vStart = Math.floor((sl - HORIZONTAL_PADDING_1D) / pxPerBase);
      const vEnd = Math.ceil((sl + viewportWidth - HORIZONTAL_PADDING_1D) / pxPerBase);

      if (!isCircular) {
        const start = Math.max(0, vStart);
        const end = Math.max(start, Math.min(columnCount - 1, vEnd));
        const centerColumn = Math.max(
          0,
          Math.min(columnCount - 1, Math.floor((vStart + vEnd) / 2))
        );
        onViewportChange({ start, end, centerColumn }, source);
        return;
      }

      const bioStart = biologicalColumn(vStart, columnCount);
      const bioEnd = biologicalColumn(vEnd, columnCount);
      const centerColumn = biologicalColumn(Math.floor((vStart + vEnd) / 2), columnCount);
      const straddles = isCrossCycleDrag(vStart, vEnd, columnCount);
      if (straddles && bioStart !== bioEnd) {
        onViewportChange({ start: bioStart, end: bioEnd, centerColumn, wraps: true }, source);
      } else {
        const start = Math.min(bioStart, bioEnd);
        const end = Math.max(bioStart, bioEnd);
        onViewportChange({ start, end, centerColumn }, source);
      }
    }, [scrollLeftForUI, viewportWidth, pxPerBase, columnCount, isCircular, onViewportChange]);

    const scrollPresentationContext = useMemo(
      () =>
        scrollPresentation
          ? {
              request: scrollPresentation,
              source: sequence,
              coordinateSpace,
              drawSequence: effectiveSequence.sequence,
              layout,
              pxPerBase,
            }
          : null,
      [scrollPresentation, sequence, coordinateSpace, effectiveSequence.sequence, layout, pxPerBase]
    );
    const currentScrollPresentationRef = useRef<typeof scrollPresentationContext>(null);
    const scrollPresentationOwnerRef = useRef<
      | (NonNullable<typeof scrollPresentationContext> & {
          status: 'pending' | 'retired' | 'presented';
        })
      | null
    >(null);
    useLayoutEffect(() => {
      currentScrollPresentationRef.current = scrollPresentationContext;
      const owner = scrollPresentationOwnerRef.current;
      if (!scrollPresentationContext) scrollPresentationOwnerRef.current = null;
      else if (owner?.request !== scrollPresentationContext.request) {
        scrollPresentationOwnerRef.current = { ...scrollPresentationContext, status: 'pending' };
      } else if (
        owner.source !== sequence ||
        owner.coordinateSpace !== coordinateSpace ||
        owner.drawSequence !== effectiveSequence.sequence
      )
        owner.status = 'retired';
      return () => {
        if (currentScrollPresentationRef.current === scrollPresentationContext)
          currentScrollPresentationRef.current = null;
      };
    }, [scrollPresentationContext, sequence, coordinateSpace, effectiveSequence.sequence]);

    const draw = useCallback(() => {
      const canvas = canvasRef.current;
      const container = scrollContainerRef.current;
      const liveWidth = container?.clientWidth ?? viewportWidth;
      if (!canvas || liveWidth <= 0) return;
      const dpr = window.devicePixelRatio || 1;
      const extrasHeight =
        extraLanes && extraLanes.length > 0
          ? extraLanes.reduce((sum, lane) => sum + Math.max(0, lane.height), 0)
          : 0;
      const cssHeight = layout.totalHeight + extrasHeight;
      const cssWidth = liveWidth;
      const scrollLeft = scrollLeftRef.current;
      if (container) {
        container.dataset.sequenceViewer1dEffectiveScrollLeft = String(
          roundLayoutValue(scrollLeft)
        );
        container.dataset.sequenceViewer1dRequestedScrollLeft =
          typeof controlledScrollLeft === 'number' && Number.isFinite(controlledScrollLeft)
            ? String(roundLayoutValue(controlledScrollLeft))
            : '';
      }

      const desiredW = Math.round(cssWidth * dpr);
      const desiredH = Math.round(cssHeight * dpr);
      if (canvas.width !== desiredW || canvas.height !== desiredH) {
        canvas.width = desiredW;
        canvas.height = desiredH;
        canvas.style.width = `${cssWidth}px`;
        canvas.style.height = `${cssHeight}px`;
      }

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const theme = resolveCanvasTheme();

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssWidth, cssHeight);
      if (!transparentBackground) {
        ctx.fillStyle = theme.bg;
        ctx.fillRect(0, 0, cssWidth, cssHeight);
      }

      const visibleStart = Math.max(
        0,
        Math.floor((scrollLeft - HORIZONTAL_PADDING_1D) / pxPerBase)
      );
      const rawEnd = Math.ceil((scrollLeft + cssWidth - HORIZONTAL_PADDING_1D) / pxPerBase) + 1;
      const visibleEnd = isCircular ? rawEnd : Math.min(columnCount, rawEnd);

      ctx.save();
      ctx.translate(-scrollLeft, 0);

      if (selection) {
        visitWrappedRangeColumns(selection, isCircular, columnCount, (aClamp, bClamp) => {
          const x = HORIZONTAL_PADDING_1D + aClamp * pxPerBase;
          const w = (bClamp - aClamp) * pxPerBase;
          drawSelectionFillRect(ctx, x, 0, w, layout.totalHeight);
        });
      }

      if (searchMatches && searchMatches.length > 0) {
        const inactiveColor = theme.isDark
          ? 'hsla(35, 85%, 52%, 0.10)'
          : 'hsla(35, 85%, 52%, 0.12)';
        ctx.save();
        ctx.fillStyle = inactiveColor;
        for (let mi = 0; mi < searchMatches.length; mi++) {
          if (mi === activeSearchIndex) continue;
          const match = searchMatches[mi];
          visitWrappedRangeColumns(match, isCircular, columnCount, (aClamp, bClamp) => {
            const x = HORIZONTAL_PADDING_1D + aClamp * pxPerBase;
            const w = (bClamp - aClamp) * pxPerBase;
            ctx.fillRect(x, 0, w, layout.totalHeight);
          });
        }
        ctx.restore();
      }

      const zoomScale = pxPerBase / DEFAULT_PX_PER_BASE;
      const sharedConfig = {
        ...DEFAULT_EDITOR_CONFIG,
        charWidth: pxPerBase,
        rowHeight: DEFAULT_EDITOR_CONFIG.rowHeight * zoomScale,
        fontSize: Math.max(1, (BASE_FONT_SIZE * pxPerBase) / DEFAULT_PX_PER_BASE),
        aaColorScheme,
        annotationColorMode,
      };
      const laneSpacing = LANE_HEIGHT_1D + LANE_GAP_1D;
      const viewportLeftX = scrollLeft;
      const viewportRightX = scrollLeft + cssWidth;
      const labelPadding = 6;

      const annotationRenderStateInput: AnnotationRenderStateInput = {
        hovered: hoveredAnnotationRef.current,
        selected: selectedAnnotationRef.current,
      };

      paint1DAnnotationLanes({
        ctx,
        annotations: layout.annotations,
        isCircular,
        columnCount,
        visibleStart,
        visibleEnd,
        renderColumnCount: layout.renderColumnCount,
        laneBandTop: layout.laneBandTop,
        laneSpacing,
        pxPerBase,
        viewportLeftX,
        viewportRightX,
        labelPadding,
        mutedColumnSet,
        mutedColumnColor,
        themeFg: theme.fg,
        themeFgMuted: theme.fgMuted,
        sharedConfig,
        annotationRenderStateInput,
        labelFont: RULER_FONT,
      });

      paint1DOverflowBand({
        ctx,
        layout,
        isCircular,
        columnCount,
        visibleStart,
        visibleEnd,
        pxPerBase,
        bgMuted: theme.bgMuted,
      });

      const orfsDrawn = paint1DCdsTranslationAndOrfBands({
        paintedCodonsSink: paintedCodonsRef,
        ctx,
        layout,
        isCircular,
        columnCount,
        visibleStart,
        visibleEnd,
        pxPerBase,
        scrollLeft,
        cssWidth,
        sharedConfig,
        sequence: effectiveSequence.sequence,
        geneticCode: recordCode.code,
        geneticCodeBasis: recordCode.basis,
        coordinateSpace,
        hoveredAnnotation: hoveredAnnotationRef.current,
        selectedAnnotation: selectedAnnotationRef.current,
        hoveredCodon: hoveredCodonRef.current,
        selectedCodons,
        hoveredOrf: hoveredOrfRef.current,
        selectedOrf: selectedOrfRef.current,
        candidateOrf,
        mutedColumnSet,
        mutedColumnColor,
      });

      renderedPrimersRef.current = render1DPrimers({
        ctx,
        primers: primers ?? [],
        showPrimers: showPrimers && (primers?.length ?? 0) > 0,
        columnCount,
        pxPerBase,
        isCircular,
        sharedConfig,
        forwardPrimerLaneCount: layout.forwardPrimerLaneCount,
        forwardPrimerBandTop: layout.forwardPrimerBandTop,
        reversePrimerLaneCount: layout.reversePrimerLaneCount,
        reversePrimerBandTop: layout.reversePrimerBandTop,
        scrollLeft,
        cssWidth,
        hoveredPrimerId: hoveredPrimer?.id ?? null,
        suppressDrawing: suppressPrimerDrawing,
      });
      onPrimerLayoutChange?.(renderedPrimersRef.current);

      renderedCutSitesRef.current = paint1DCutSites({
        ctx,
        layout,
        scrollLeft,
        cssWidth,
        showCutSites,
        cutSites: effectiveCutSites,
        scannedCutSites: effectiveScannedCutSites,
        showReverseComplement,
        hoveredEnzymeName,
        hoveredPositionInfo,
        hoveredCutSite: hoveredCutSiteRef.current,
      });

      paint1DHoveredCodonHighlight({
        ctx,
        layout,
        isCircular,
        columnCount,
        pxPerBase,
        scrollLeft,
        cssWidth,
        showReverseComplement,
        hoveredCodon: hoveredCodonRef.current,
      });

      paint1DReferenceColumnOverlays({
        ctx,
        extraLanes,
        layout,
        isCircular,
        columnCount,
        visibleStart,
        visibleEnd,
        pxPerBase,
        showReverseComplement,
        showRuler,
      });

      paint1DSequenceTextRow({
        ctx,
        layout,
        sequence: effectiveSequence.sequence,
        strandOverrides: effectiveSequence.strandOverrides,
        nucleicAcid: nucleicAcidOf(effectiveSequence),
        isCircular,
        columnCount,
        visibleStart,
        visibleEnd,
        pxPerBase,
        showReverseComplement,
        mutedColumnSet,
        mutedColumnColor,
        fg: theme.fg,
        fgMuted: theme.fgMuted,
        isDark: theme.isDark,
      });

      if (layout.hasMutationTrack) {
        drawMutationTrack1D(ctx, {
          bandY: layout.mutationTrackY,
          bandHeight: layout.mutationTrackHeight,
          visibleStart,
          visibleEnd: Math.min(visibleEnd, columnCount),
          referenceSequence: effectiveSequence.sequence,
          alignedQuery: coordinateSpace?.alignedQuery,
          mutations: mutations ?? [],
          originX: HORIZONTAL_PADDING_1D,
          pxPerBase,
          fontSize: Math.max(5, Math.round((BASE_FONT_SIZE * pxPerBase) / DEFAULT_PX_PER_BASE)),
          fontFamily: BASE_FONT_FAMILY,
          showText: pxPerBase >= TEXT_VISIBILITY_THRESHOLD_PX,
        });
      }

      if (showRuler) {
        const ticks = adapter.getRulerTicks(visibleStart, visibleEnd);
        ctx.strokeStyle = RULER_TICK_COLOR;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (const t of ticks) {
          ctx.moveTo(t.x + 0.5, t.y);
          ctx.lineTo(t.x + 0.5, t.y + 4);
        }
        ctx.stroke();
        ctx.font = RULER_FONT;
        ctx.fillStyle = theme.fgMuted;
        ctx.textBaseline = 'top';
        ctx.textAlign = 'center';
        for (const t of ticks) {
          if (t.label) ctx.fillText(t.label, t.x, t.y + 5);
        }
      }

      paint1DRulerDecorations({
        ctx,
        layout,
        showRuler,
        decorations: effectiveRulerDecorations,
        isCircular,
        columnCount,
        pxPerBase,
        scrollLeft,
        cssWidth,
      });

      paint1DSelectionHandles({
        ctx,
        layout,
        selection,
        isCircular,
        columnCount,
        pxPerBase,
        scrollLeft,
        cssWidth,
      });

      paint1DViewCursor({
        ctx,
        layout,
        selection,
        viewCursor,
        isCircular,
        columnCount,
        pxPerBase,
        scrollLeft,
        cssWidth,
      });

      paint1DHoverCursor({
        ctx,
        layout,
        selection,
        hoverCol: hoverColRef.current,
        pointerInteractionsEnabled,
        isCircular,
        columnCount,
        pxPerBase,
        scrollLeft,
        cssWidth,
        isDark: theme.isDark,
      });

      ctx.restore();

      if (extraLanes && extraLanes.length > 0) {
        let laneTop = layout.totalHeight;
        for (const lane of extraLanes) {
          const laneHeight = Math.max(0, lane.height);
          if (laneHeight > 0) {
            ctx.save();
            try {
              ctx.translate(-scrollLeft, 0);
              lane.draw(ctx, {
                laneY: laneTop,
                laneHeight,
                pxPerBase,
                columnCount,
                visibleStart,
                visibleEnd,
                isCircular,
                scrollLeft,
                horizontalPadding: HORIZONTAL_PADDING_1D,
                viewportWidth: cssWidth,
              });
            } finally {
              ctx.restore();
            }
          }
          laneTop += laneHeight;
        }
      }
      reportOrfPaint(onOrfsPresented, !orfs?.length, orfsDrawn, 'sequence_tracks');
      if (!scrollPresentationContext) return;
      const owner = scrollPresentationOwnerRef.current;
      if (
        !owner ||
        owner.status !== 'pending' ||
        owner.request !== scrollPresentationContext.request ||
        currentScrollPresentationRef.current !== scrollPresentationContext ||
        !container?.isConnected ||
        document.visibilityState !== 'visible' ||
        getComputedStyle(container).visibility === 'hidden' ||
        getComputedStyle(container).display === 'none' ||
        container.clientWidth !== cssWidth ||
        container.clientHeight <= 0 ||
        scrollLeftRef.current !== scrollLeft ||
        layout.sequenceRowY < 0 ||
        layout.sequenceRowY + layout.sequenceRowHeight > Math.min(cssHeight, container.clientHeight)
      )
        return;
      const position = remap.bioToColMap
        ? remap.bioToColMap.get(scrollPresentationContext.request.position)
        : scrollPresentationContext.request.position - 1;
      if (
        position === undefined ||
        !Number.isInteger(position) ||
        position < 0 ||
        position >= columnCount
      )
        return;
      const firstFullColumn = Math.ceil((scrollLeft - HORIZONTAL_PADDING_1D) / pxPerBase);
      const column = isCircular
        ? position + Math.ceil((firstFullColumn - position) / columnCount) * columnCount
        : position;
      const x = HORIZONTAL_PADDING_1D + column * pxPerBase - scrollLeft;
      if (x < 0 || x + pxPerBase > cssWidth) return;
      owner.status = 'presented';
      scrollPresentationContext.request.presented();
    }, [
      layout,
      scrollPresentationContext,
      remap.bioToColMap,
      onOrfsPresented,
      orfs,
      adapter,
      viewportWidth,
      effectiveSequence.sequence,
      effectiveSequence.molecule,
      selection,
      viewCursor,
      columnCount,
      pxPerBase,
      effectiveCutSites,
      effectiveScannedCutSites,
      showCutSites,
      hoveredEnzymeName,
      hoveredPositionInfo,
      primers,
      showPrimers,
      onPrimerLayoutChange,
      hoveredPrimer,
      isCircular,
      mutations,
      coordinateSpace,
      effectiveRulerDecorations,
      searchMatches,
      activeSearchIndex,
      showReverseComplement,
      aaColorScheme,
      annotationColorMode,
      showRuler,
      selectedCodons,
      extraLanes,
      mutedColumnColor,
      mutedColumnSet,
      transparentBackground,
      pointerInteractionsEnabled,
    ]);

    drawRef.current = draw;

    useLayoutEffect(() => {
      draw();
    }, [draw]);

    useEffect(() => {
      if (typeof document === 'undefined') return;
      const html = document.documentElement;
      const observer = new MutationObserver(() => {
        drawRef.current?.();
      });
      observer.observe(html, { attributes: true, attributeFilter: ['class'] });
      return () => observer.disconnect();
    }, []);

    useEffect(() => {
      drawRef.current?.();
    }, [candidateOrf?.start, candidateOrf?.end, candidateOrf?.strand]);

    const prevPxPerBaseRef = useRef<number>(pxPerBase);
    const nextZoomAnchorRef = useRef<{ screenX: number } | null>(null);
    useLayoutEffect(() => {
      const prev = prevPxPerBaseRef.current;
      const next = pxPerBase;
      const liveWidth = scrollContainerRef.current?.clientWidth ?? viewportWidth;
      if (prev !== next && liveWidth > 0 && prev > 0) {
        if (wheelZoomWrittenRef.current !== next) cancelWheelMotion();
        else wheelMotionRef.current.cancel();
        wheelZoomWrittenRef.current = null;
        const anchor = nextZoomAnchorRef.current;
        nextZoomAnchorRef.current = null;
        const anchorScreenX = anchor
          ? Math.max(0, Math.min(liveWidth, anchor.screenX))
          : liveWidth / 2;
        const anchorBase = (scrollLeftRef.current + anchorScreenX - HORIZONTAL_PADDING_1D) / prev;
        const nextScroll = anchorBase * next + HORIZONTAL_PADDING_1D - anchorScreenX;
        applyScroll(nextScroll);
      } else {
        applyScroll(scrollLeftRef.current);
      }
      prevPxPerBaseRef.current = next;
    }, [pxPerBase, layout.totalWidth, viewportWidth, applyScroll, cancelWheelMotion]);

    const onWheel = useCallback(
      (e: WheelEvent) => {
        if (!wheelScrollEnabled) return;
        const container = scrollContainerRef.current;
        if (!container) return;
        cancelScrollAnimation();

        if (e.metaKey || e.ctrlKey) {
          e.stopPropagation();
          if (e.deltaY === 0) return;
          const rect = scrollContainerRef.current?.getBoundingClientRect();
          if (!rect) return;
          const screenX = e.clientX - rect.left;
          if (shouldAnimateWheel(e, container.ownerDocument)) {
            animateWheelZoom(Math.log(e.deltaY > 0 ? 0.9 : 1.1), screenX);
          } else {
            cancelWheelMotion();
            nextZoomAnchorRef.current = { screenX };
            const delta =
              e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? viewportWidth : 1);
            setPxPerBase(pxPerBaseRef.current * 2 ** (-delta / 240));
          }
          return;
        }

        const delta = Math.abs(e.deltaX) >= Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        const dx = delta * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? viewportWidth : 1);
        if (dx !== 0) {
          if (shouldAnimateWheel(e, container.ownerDocument)) animateWheel(dx);
          else {
            cancelWheelMotion();
            applyScroll(scrollLeftRef.current + dx);
          }
        }
      },
      [
        viewportWidth,
        applyScroll,
        wheelScrollEnabled,
        animateWheel,
        animateWheelZoom,
        cancelWheelMotion,
        cancelScrollAnimation,
        setPxPerBase,
      ]
    );

    useEffect(() => {
      if (!wheelScrollEnabled) return;
      const el = scrollContainerRef.current;
      if (!el) return;
      const handler = (e: WheelEvent) => {
        e.preventDefault();
      };
      el.addEventListener('wheel', handler, { passive: false });
      const disposeZoomTarget = registerWheelZoomTarget(el, onWheel);
      return () => {
        disposeZoomTarget();
        el.removeEventListener('wheel', handler);
      };
    }, [wheelScrollEnabled, onWheel]);

    const colAtClientX = useCallback(
      (clientX: number): number => {
        const el = scrollContainerRef.current;
        if (!el) return 0;
        const rect = el.getBoundingClientRect();
        const localX = clientX - rect.left + scrollLeftRef.current;
        const col = Math.floor((localX - HORIZONTAL_PADDING_1D) / pxPerBase);
        if (isCircular) return col;
        return Math.max(0, Math.min(columnCount - 1, col));
      },
      [pxPerBase, columnCount, isCircular]
    );

    const emitSelectionFromDrag = useCallback(() => {
      const drag = dragStateRef.current;
      if (!drag) return;
      if (drag.anchorCol === drag.currentCol) return;
      const anchor = drag.anchorCol;
      const current = drag.currentCol;

      if (!isCircular) {
        const a = Math.min(anchor, current);
        const b = Math.max(anchor, current);
        onSelectionChange?.({ start: a, end: b });
        return;
      }

      const anchorBio = biologicalColumn(anchor, columnCount);
      const currentBio = biologicalColumn(current, columnCount);
      if (!isCrossCycleDrag(anchor, current, columnCount)) {
        const a = Math.min(anchorBio, currentBio);
        const b = Math.max(anchorBio, currentBio);
        onSelectionChange?.({ start: a, end: b });
        return;
      }
      if (current > anchor) {
        onSelectionChange?.({ start: anchorBio, end: currentBio, wraps: true });
      } else {
        onSelectionChange?.({ start: currentBio, end: anchorBio, wraps: true });
      }
    }, [onSelectionChange, isCircular, columnCount]);

    const stopAutoscroll = useCallback(() => {
      autoscrollDirRef.current = 0;
      if (autoscrollRafRef.current !== null) {
        cancelAnimationFrame(autoscrollRafRef.current);
        autoscrollRafRef.current = null;
      }
    }, []);

    const runAutoscroll = useCallback(() => {
      const dir = autoscrollDirRef.current;
      const el = scrollContainerRef.current;
      if (dir === 0 || !el) {
        autoscrollRafRef.current = null;
        return;
      }
      applyScroll(scrollLeftRef.current + dir * 12);
      const drag = dragStateRef.current;
      if (drag) {
        const rect = el.getBoundingClientRect();
        const edgeX = dir === -1 ? rect.left : rect.right;
        drag.currentCol = colAtClientX(edgeX);
        emitSelectionFromDrag();
      }
      autoscrollRafRef.current = requestAnimationFrame(runAutoscroll);
    }, [colAtClientX, emitSelectionFromDrag, applyScroll]);

    const featureContainsBioCol = useCallback(
      (feature: { start: number; end: number }, bioCol: number): boolean => {
        const startCol = feature.start - 1;
        const endCol = feature.end - 1;
        if (feature.end < feature.start) {
          return bioCol >= startCol || bioCol <= endCol;
        }
        return bioCol >= startCol && bioCol <= endCol;
      },
      []
    );

    const hitAnnotationAtBioColY = useCallback(
      (bioCol: number, y: number): AnnotationWithLane | null => {
        if (y < layout.laneBandTop) return null;
        if (y >= layout.laneBandTop + layout.laneBandHeight) return null;
        const laneSpacing = LANE_HEIGHT_1D + LANE_GAP_1D;
        const laneIdx = Math.floor((y - layout.laneBandTop) / laneSpacing);
        const yInLane = y - layout.laneBandTop - laneIdx * laneSpacing;
        if (yInLane > LANE_HEIGHT_1D) return null;
        for (const ann of layout.annotations) {
          if (ann.lane !== laneIdx) continue;
          if (featureContainsBioCol(ann, bioCol)) return ann;
        }
        return null;
      },
      [layout, featureContainsBioCol]
    );

    const hitCDSLaneAtBioColY = useCallback(
      (bioCol: number, y: number): { cds: ClassifiedCDS; yInLane: number } | null => {
        if (y < layout.translationBandTop) return null;
        if (y >= layout.translationBandTop + layout.translationBandHeight) return null;
        const laneIdx = Math.floor((y - layout.translationBandTop) / layout.translationLaneHeight);
        const yInLane = y - layout.translationBandTop - laneIdx * layout.translationLaneHeight;
        for (const cds of layout.classifiedCDSs) {
          if (cds.translationLane !== laneIdx) continue;
          if (featureContainsBioCol(cds, bioCol)) return { cds, yInLane };
        }
        return null;
      },
      [layout, featureContainsBioCol]
    );

    const hitCodonAtBioColY = useCallback(
      (
        bioCol: number,
        y: number
      ): {
        cds: ClassifiedCDS;
        start: number;
        end: number;
        strand: 1 | -1;
        residueIndex?: number;
      } | null => {
        const laneHit = hitCDSLaneAtBioColY(bioCol, y);
        if (!laneHit) return null;
        const { cds, yInLane } = laneHit;
        if (yInLane <= TRANSLATION_LABEL_HEIGHT) return null;

        const strand = (cds.direction ?? 1) as 1 | -1;

        if (isSplicedCDS(cds)) {
          const segments = cds.segments;
          if (!segments) return null;
          const codon = findSplicedCodonWithIndexAtPosition(bioCol, segments);
          if (!codon) return null;
          return {
            cds,
            start: codon.start,
            end: codon.end,
            strand,
            residueIndex: codon.codonIndex + 1,
          };
        }

        const cdsStart = cds.start - 1;
        const cdsEnd = cds.end - 1;
        const spansOrigin = cds.end < cds.start;

        let phaseOffset: number;
        if (strand === 1) {
          phaseOffset = bioCol - cdsStart;
          if (spansOrigin && bioCol < cdsStart) {
            phaseOffset = columnCount - cdsStart + bioCol;
          }
        } else {
          phaseOffset = cdsEnd - bioCol;
          if (spansOrigin && bioCol > cdsEnd) {
            phaseOffset = cdsEnd + (columnCount - bioCol);
          }
        }
        if (phaseOffset < 0) return null;

        const codonIdx = Math.floor(phaseOffset / 3);
        let codonLow: number;
        if (strand === 1) {
          codonLow = (cdsStart + codonIdx * 3) % columnCount;
        } else {
          codonLow = biologicalColumn(cdsEnd - codonIdx * 3 - 2, columnCount);
        }
        const codonHigh = (codonLow + 2) % columnCount;
        return { cds, start: codonLow, end: codonHigh, strand, residueIndex: codonIdx + 1 };
      },
      [hitCDSLaneAtBioColY, columnCount]
    );

    const handleHitAtCol = useCallback(
      (col: number): 'start' | 'end' | null => {
        if (!selection || selection.start === selection.end) return null;
        const wraps = isCircular && !!selection.wraps;
        const selStart = wraps ? selection.start : Math.min(selection.start, selection.end);
        const selEnd = wraps ? selection.end : Math.max(selection.start, selection.end);
        const tol = SELECTION_HANDLE_HIT_TOLERANCE_BASES;
        const cBio = isCircular ? biologicalColumn(col, columnCount) : col;
        if (Math.abs(cBio - selStart) <= tol) return 'start';
        if (Math.abs(cBio - (selEnd + 1)) <= tol) return 'end';
        return null;
      },
      [selection, isCircular, columnCount]
    );

    const emitSelectionFromHandleDrag = useCallback(
      (nextCol: number) => {
        const hd = handleDragRef.current;
        if (!hd) return;
        const anchor = hd.anchorCol;
        if (!isCircular) {
          const a = Math.min(anchor, nextCol);
          const b = Math.max(anchor, nextCol);
          onSelectionChange?.({ start: a, end: b });
          return;
        }
        const anchorBio = biologicalColumn(anchor, columnCount);
        const nextBio = biologicalColumn(nextCol, columnCount);
        if (!isCrossCycleDrag(anchor, nextCol, columnCount)) {
          const a = Math.min(anchorBio, nextBio);
          const b = Math.max(anchorBio, nextBio);
          onSelectionChange?.({ start: a, end: b });
        } else if (nextCol > anchor) {
          onSelectionChange?.({ start: anchorBio, end: nextBio, wraps: true });
        } else {
          onSelectionChange?.({ start: nextBio, end: anchorBio, wraps: true });
        }
      },
      [onSelectionChange, isCircular, columnCount]
    );

    const onPointerDown = useCallback(
      (e: React.PointerEvent) => {
        if (!isPrimaryButton(e)) return;
        const col = colAtClientX(e.clientX);
        const bioCol = isCircular ? biologicalColumn(col, columnCount) : col;

        if (e.shiftKey && !isResidueSelectionPointerIntent(e)) {
          const helper = e.altKey ? handleOptionShiftClickNucleotide : handleShiftClickNucleotide;
          const cursorPos =
            selectionAnchorRef.current ?? viewCursor ?? (selection ? selection.start : null);
          const newRange = helper(selection ?? null, bioCol, cursorPos, columnCount, isCircular);
          selectionAnchorRef.current = newRange.start === bioCol ? newRange.end : newRange.start;
          onSelectionChange?.({
            start: newRange.start,
            end: newRange.end,
            wraps: newRange.wraps,
          });
          return;
        }

        const handle = handleHitAtCol(col);
        if (handle && selection) {
          const anchorCol =
            handle === 'start'
              ? Math.max(selection.start, selection.end)
              : Math.min(selection.start, selection.end);
          handleDragRef.current = { anchorCol, edge: handle };
          (e.target as Element).setPointerCapture?.(e.pointerId);
          return;
        }

        selectionAnchorRef.current = null;
        dragStateRef.current = { anchorCol: col, currentCol: col };
        pointerDownPosRef.current = { x: e.clientX, y: e.clientY };
        (e.target as Element).setPointerCapture?.(e.pointerId);
      },
      [
        colAtClientX,
        handleHitAtCol,
        selection,
        viewCursor,
        onSelectionChange,
        onViewCursorChange,
        isCircular,
        columnCount,
      ]
    );

    const onPointerMove = useCallback(
      (e: React.PointerEvent) => {
        if (handleDragRef.current) {
          const col = colAtClientX(e.clientX);
          emitSelectionFromHandleDrag(col);

          const el = scrollContainerRef.current;
          if (el) {
            const rect = el.getBoundingClientRect();
            const localX = e.clientX - rect.left;
            let dir: -1 | 0 | 1 = 0;
            if (localX < 32) dir = -1;
            else if (localX > rect.width - 32) dir = 1;
            if (dir !== autoscrollDirRef.current) {
              autoscrollDirRef.current = dir;
              if (dir !== 0 && autoscrollRafRef.current === null) {
                autoscrollRafRef.current = requestAnimationFrame(runAutoscroll);
              }
            }
          }
          return;
        }

        const drag = dragStateRef.current;
        if (!drag) return;
        const col = colAtClientX(e.clientX);
        drag.currentCol = col;
        const downPos = pointerDownPosRef.current;
        const dx = downPos ? e.clientX - downPos.x : 0;
        const dy = downPos ? e.clientY - downPos.y : 0;
        const exceededClickThreshold = dx * dx + dy * dy > 25;
        if (exceededClickThreshold) {
          emitSelectionFromDrag();
        }

        const el = scrollContainerRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const localX = e.clientX - rect.left;
        let dir: -1 | 0 | 1 = 0;
        if (localX < 32) dir = -1;
        else if (localX > rect.width - 32) dir = 1;
        if (dir !== autoscrollDirRef.current) {
          autoscrollDirRef.current = dir;
          if (dir !== 0 && autoscrollRafRef.current === null) {
            autoscrollRafRef.current = requestAnimationFrame(runAutoscroll);
          }
        }
      },
      [colAtClientX, emitSelectionFromDrag, emitSelectionFromHandleDrag, runAutoscroll]
    );

    const onPointerUp = useCallback(
      (e: React.PointerEvent) => {
        stopAutoscroll();
        const drag = dragStateRef.current;
        const handleDrag = handleDragRef.current;
        dragStateRef.current = null;
        handleDragRef.current = null;

        if (drag) {
          const isClick = !pointerMovedBeyondClickTolerance(
            pointerDownPosRef.current,
            e.clientX,
            e.clientY
          );
          pointerDownPosRef.current = null;
          if (isClick) {
            const rect = scrollContainerRef.current?.getBoundingClientRect();
            const bioCol = columnToBiological1D(drag.anchorCol, columnCount, isCircular);
            const layoutY = rect ? e.clientY - rect.top : -1;

            let hitHandled = false;

            const orfClickHit = findOrfAtViewerPoint1D(orfs, layout, layoutY, bioCol);

            if (rect) {
              const layoutMouseX = e.clientX - rect.left + scrollLeftRef.current;
              if (
                tryHandleCutSiteClick1D({
                  rendered: renderedCutSitesRef.current,
                  layoutMouseX,
                  layoutY,
                  columnCount,
                  onCutSiteClick,
                  onSelectionChange,
                })
              ) {
                hitHandled = true;
              }

              if (
                !hitHandled &&
                tryHandlePrimerClick1D({
                  segments: renderedPrimersRef.current,
                  layoutMouseX,
                  layoutY,
                  onSelectionChange,
                })
              ) {
                hitHandled = true;
              }
            }

            if (rect && !hitHandled) {
              const annClickHit = hitAnnotationAtBioColY(bioCol, layoutY);
              const codonClickHit = orfClickHit ? null : hitCodonAtBioColY(bioCol, layoutY);
              const cdsLaneClickHit = orfClickHit ? null : hitCDSLaneAtBioColY(bioCol, layoutY);
              const parentCdsForClick = parentCdsForPointerHits(codonClickHit, cdsLaneClickHit);

              if (
                tryHandleResidueSelectionClick1D({
                  event: e,
                  coordinateMode: coordinateSpace?.mode,
                  residueSelectionReferenceId,
                  codonClickHit,
                  orfClickHit,
                  residueSelectionsStore,
                  fullSequence: sequence.sequence,
                  anchorRef: residueSelectionAnchorRef,
                })
              ) {
                hitHandled = true;
              }

              if (
                !hitHandled &&
                tryApplyFeaturePointerClick1D({
                  annClickHit,
                  parentCdsForClick,
                  classifiedCDSs: layout.classifiedCDSs,
                  bioCol,
                  orfClickHit,
                  applyPointerSelection1D,
                  onSelectionChange,
                })
              ) {
                hitHandled = true;
              }
            }

            if (!hitHandled) {
              clearBareCanvasClick1D({
                bioCol,
                onSelectionChange,
                onViewCursorChange,
                selectedAnnotationRef,
                onSelectedAnnotationChange,
                redraw: () => drawRef.current?.(),
              });
            }
          } else {
            emitSelectionFromDrag();
            selectionAnchorRef.current = columnToBiological1D(
              drag.anchorCol,
              columnCount,
              isCircular
            );
          }
        }
        if (handleDrag) {
          const col = colAtClientX(e.clientX);
          emitSelectionFromHandleDrag(col);
          selectionAnchorRef.current = columnToBiological1D(
            handleDrag.anchorCol,
            columnCount,
            isCircular
          );
        }
        try {
          (e.target as Element).releasePointerCapture?.(e.pointerId);
        } catch {}
      },
      [
        stopAutoscroll,
        emitSelectionFromDrag,
        colAtClientX,
        emitSelectionFromHandleDrag,
        onSelectionChange,
        onViewCursorChange,
        isCircular,
        columnCount,
        hitAnnotationAtBioColY,
        hitCDSLaneAtBioColY,
        hitCodonAtBioColY,
        coordinateSpace?.mode,
        residueSelectionReferenceId,
        residueSelectionsStore,
        sequence.sequence,
        applyPointerSelection1D,
      ]
    );

    const hoveredRegionLine =
      hoveredFeatureFacts && annotationTooltipPos
        ? cdsRegionHoverLine(hoveredFeatureFacts, annotationTooltipPos.position, columnCount)
        : null;
    return (
      <div
        className={className}
        style={{
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          width: '100%',
          background: sequenceViewer1DCanvasBackground(transparentBackground),
          userSelect: 'none',
          ...style,
        }}
        onWheel={(event) => {
          onWheel(event.nativeEvent);
          if (wheelScrollEnabled && (event.metaKey || event.ctrlKey)) event.stopPropagation();
        }}
        data-testid="sequence-viewer-1d"
        data-sequence-wheel-zoom-viewport={wheelScrollEnabled ? '' : undefined}
        data-layout-anchor-active={sequenceViewer1DBoolAttr(Boolean(anchorLayout))}
        data-genetic-code={geneticCodeKey(recordCode.code)}
        data-layout-sequence-row-y={roundLayoutValue(layout.sequenceRowY)}
        data-layout-sequence-row-height={roundLayoutValue(layout.sequenceRowHeight)}
        data-layout-total-height={roundLayoutValue(layout.totalHeight)}
        data-layout-translation-band-top={roundLayoutValue(layout.translationBandTop)}
        data-layout-translation-label-height={roundLayoutValue(TRANSLATION_LABEL_HEIGHT)}
        data-layout-translation-lane-height={roundLayoutValue(layout.translationLaneHeight)}
        data-layout-translation-lane-count={layout.translationLaneCount}
        data-layout-translation-band-height={roundLayoutValue(layout.translationBandHeight)}
        data-layout-content-translation-lane-count={contentLayout.translationLaneCount}
        data-layout-anchor-translation-lane-count={sequenceViewer1DOptionalCount(
          anchorLayout?.translationLaneCount
        )}
        data-layout-annotation-lane-count={layout.laneCount}
        data-layout-content-annotation-lane-count={contentLayout.laneCount}
        data-layout-anchor-annotation-lane-count={sequenceViewer1DOptionalCount(
          anchorLayout?.laneCount
        )}
        data-transparent-background={sequenceViewer1DBoolAttr(transparentBackground)}
      >
        {}
        <div
          ref={scrollContainerRef}
          tabIndex={0}
          data-testid="sequence-viewer-1d-pointer"
          onPointerDown={(e) => {
            if (!pointerInteractionsEnabled) return;
            const ae = document.activeElement;
            if (
              !ae ||
              (!(ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement) &&
                !(ae as HTMLElement | null)?.isContentEditable)
            ) {
              (e.currentTarget as HTMLDivElement).focus({ preventScroll: true });
            }
            onPointerDown(e);
          }}
          onPointerMove={(e) => {
            const target = e.currentTarget as HTMLDivElement;
            const rect = target.getBoundingClientRect();
            const layoutMouseX = e.clientX - rect.left + scrollLeftRef.current;
            const layoutY = e.clientY - rect.top;
            const primerHit = primerHoverEnabled
              ? findRenderedPrimerAtPoint1D(renderedPrimersRef.current, layoutMouseX, layoutY)
              : null;
            applyPrimerHoverPointer1D({
              primerHit,
              hoveredPrimer,
              primerTooltipPos,
              clientX: e.clientX,
              clientY: e.clientY,
              setHoveredPrimer,
              setPrimerTooltipPos,
            });
            if (!pointerInteractionsEnabled) {
              applyPassivePointerSurface1D({
                target,
                passiveCursor,
                hoverColRef,
                hoveredCodonRef,
                hoveredOrfRef,
                hoveredAnnotationRef,
                redraw: () => drawRef.current?.(),
              });
              return;
            }
            const hoverCol = colAtClientX(e.clientX);
            const hover = handleHitAtCol(hoverCol);

            const { snapped } = snapHoverColumnFromLayoutX(
              layoutMouseX,
              pxPerBase,
              columnCount,
              isCircular
            );
            const bioColForHit = snapped;
            const codonHit = hitCodonAtBioColY(bioColForHit, layoutY);

            const cutHit = hitTestCutSiteLabel1D(
              renderedCutSitesRef.current,
              layoutMouseX,
              layoutY
            );
            applyCutSiteHoverPointer1D(cutHit, hoveredCutSiteRef, () => drawRef.current?.());

            const annHover = primerHit
              ? null
              : (hitAnnotationAtBioColY(bioColForHit, layoutY) ??
                hitCDSLaneAtBioColY(bioColForHit, layoutY)?.cds ??
                null);
            setHoveredFeatureFacts((prev) => {
              if (!annHover) return prev === null ? prev : null;
              if (
                prev &&
                prev.type === annHover.type &&
                prev.name === annHover.name &&
                prev.start === annHover.start &&
                prev.end === annHover.end
              ) {
                return prev;
              }
              return {
                type: annHover.type,
                name: annHover.name,
                start: annHover.start,
                end: annHover.end,
                direction: annHover.direction,
                ...(annHover.segments ? { segments: annHover.segments } : {}),
              };
            });
            setAnnotationTooltipPos(
              annHover ? { x: e.clientX, y: e.clientY, position: bioColForHit } : null
            );

            const orfHoverForCursor = findOrfAtViewerPoint1D(orfs, layout, layoutY, bioColForHit);
            const overFeature =
              !handleDragRef.current && !hover
                ? isOverClickableFeature1D(
                    !!hitAnnotationAtBioColY(bioColForHit, layoutY),
                    !!hitCDSLaneAtBioColY(bioColForHit, layoutY),
                    !!orfHoverForCursor,
                    !!cutHit,
                    !!primerHit
                  )
                : false;
            target.style.cursor = pointerSurfaceCursor1D(
              !!handleDragRef.current,
              hover,
              overFeature
            );
            const hoverChanged = applyHoveredCodonPointerChange({
              codonHit,
              hoveredCodonRef,
              lastLocalHoveredCodonRef,
              store: hoveredCodonStore,
            });

            const orfHover = orfHoverForCursor;
            const orfHoverChanged = applyHoveredOrfPointerChange(orfHover, hoveredOrfRef);

            const annHoverHit = hitAnnotationAtBioColY(bioColForHit, layoutY);
            const codonHoverHit = orfHover ? null : hitCodonAtBioColY(bioColForHit, layoutY);
            const cdsLaneHoverHit = orfHover ? null : hitCDSLaneAtBioColY(bioColForHit, layoutY);
            const nextHoveredAnn = resolveHoveredAnnotation1D({
              orfHover,
              annHoverHit,
              codonHoverHit,
              cdsLaneHoverHit,
              classifiedCDSs: layout.classifiedCDSs,
              bioCol: bioColForHit,
            });
            const hoveredAnnChanged = annotationPointerIdentityChanged(
              nextHoveredAnn,
              hoveredAnnotationRef.current
            );
            if (hoveredAnnChanged) {
              hoveredAnnotationRef.current = nextHoveredAnn;
            }

            if (
              pointerHoverNeedsRedraw(
                hoverColRef.current,
                snapped,
                !!hoverChanged,
                orfHoverChanged,
                hoveredAnnChanged
              )
            ) {
              hoverColRef.current = snapped;
              drawRef.current?.();
            }

            onPointerMove(e);
          }}
          onPointerLeave={() => {
            setHoveredPrimer(null);
            setPrimerTooltipPos(null);
            if (hoveredCodonRef.current !== null) {
              hoveredCodonRef.current = null;
              const lastLocal = lastLocalHoveredCodonRef.current;
              lastLocalHoveredCodonRef.current = null;
              clearOwnedSequenceHoveredCodon(hoveredCodonStore, lastLocal);
              drawRef.current?.();
            }
            if (hoverColRef.current !== null) {
              hoverColRef.current = null;
              drawRef.current?.();
            }
            if (hoveredOrfRef.current !== null) {
              hoveredOrfRef.current = null;
              drawRef.current?.();
            }
            if (hoveredAnnotationRef.current !== null) {
              hoveredAnnotationRef.current = null;
              drawRef.current?.();
            }
          }}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onContextMenu={(e) => {
            if (!pointerInteractionsEnabled) return;
            if (!onContextMenu) return;
            e.preventDefault();
            const target = e.currentTarget as HTMLDivElement;
            const rect = target.getBoundingClientRect();
            const layoutMouseX = e.clientX - rect.left + scrollLeftRef.current;
            const layoutY = e.clientY - rect.top;
            const bioCol = snapHoverColumnFromLayoutX(
              layoutMouseX,
              pxPerBase,
              columnCount,
              isCircular
            ).snapped;

            const isOnNucleotideRow = showReverseComplement
              ? layoutY >= layout.sequenceRowY &&
                layoutY < layout.sequenceRowY + layout.sequenceRowHeight * 2
              : layoutY >= layout.sequenceRowY &&
                layoutY < layout.sequenceRowY + layout.sequenceRowHeight;

            const annotation = hitAnnotationAtBioColY(bioCol, layoutY) ?? null;

            const primer = findRenderedPrimerAtPoint1D(
              renderedPrimersRef.current,
              layoutMouseX,
              layoutY
            );

            const orf = findOrfAtViewerPoint1D(orfs, layout, layoutY, bioCol);

            const codonContextHit = orf ? null : hitCodonAtBioColY(bioCol, layoutY);
            const cdsLaneContextHit = orf ? null : hitCDSLaneAtBioColY(bioCol, layoutY);
            const parentCdsForContext = parentCdsForPointerHits(codonContextHit, cdsLaneContextHit);
            const contextPointerSel = resolvePointerSelection({
              annotationHit: annotation,
              parentCdsForCodon: parentCdsForContext,
              classifiedCDSs: layout.classifiedCDSs,
              position: bioCol,
              showAnnotations: true,
              showTranslation: true,
              orfHit: orf,
            });
            applyPointerSelection1D(contextPointerSel);

            onContextMenu(e, copySelectionRange(selection), {
              isOnNucleotideRow,
              position: bioCol,
              annotation: annotation as Annotation | null,
              orf,
              primer,
            });
          }}
          onDoubleClick={(e) => {
            if (!pointerInteractionsEnabled) return;
            const target = e.currentTarget as HTMLDivElement;
            const rect = target.getBoundingClientRect();
            const layoutMouseX = e.clientX - rect.left + scrollLeftRef.current;
            const layoutY = e.clientY - rect.top;
            const bioCol = columnToBiological1D(colAtClientX(e.clientX), columnCount, isCircular);

            if (onCutSiteDoubleClick) {
              const cutHit = hitTestCutSiteLabel1D(
                renderedCutSitesRef.current,
                layoutMouseX,
                layoutY
              );
              if (cutHit) {
                e.preventDefault();
                onCutSiteDoubleClick(cutHit.cutSite);
                return;
              }
            }

            const annHit = hitAnnotationAtBioColY(bioCol, layoutY);
            if (annHit) {
              e.preventDefault();
              onSelectionChange?.({
                start: annHit.start - 1,
                end: annHit.end - 1,
                wraps: annHit.end < annHit.start,
              });
              return;
            }

            const laneHit = hitCDSLaneAtBioColY(bioCol, layoutY);
            if (laneHit) {
              e.preventDefault();
              const cds = laneHit.cds;
              onSelectionChange?.({
                start: cds.start - 1,
                end: cds.end - 1,
                wraps: cds.end < cds.start,
              });
              return;
            }

            const orfHit = findOrfAtViewerPoint1D(orfs, layout, layoutY, bioCol);
            if (orfHit) {
              e.preventDefault();
              onSelectionChange?.({
                start: orfHit.start,
                end: orfHit.end,
                wraps: orfHit.end < orfHit.start,
              });
              return;
            }
          }}
          style={{
            position: 'relative',
            width: '100%',
            height: layout.totalHeight + sequenceViewer1DExtraLaneHeight(extraLanes),
            flex: '0 0 auto',
            overflow: 'hidden',
            cursor: sequenceViewer1DCursor(pointerInteractionsEnabled, passiveCursor),
            outline: 'none',
          }}
        >
          <canvas
            ref={canvasRef}
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              display: 'block',
              pointerEvents: 'none',
            }}
          />
        </div>
        <SequenceViewer1DScrollbar
          show={showScrollbar}
          totalWidth={layout.totalWidth}
          viewportWidth={viewportWidth}
          scrollLeft={scrollLeftForUI}
          onScrollChange={onCustomScrollChange}
          isCircular={isCircular}
          columnCount={columnCount}
          pxPerBase={pxPerBase}
        />
        <SequenceViewer1DPrimerTooltip primer={hoveredPrimer} position={primerTooltipPos} />
        {hoveredFeatureFacts && annotationTooltipPos ? (
          <FeatureHoverTooltip
            testId="annotation-hover-tooltip-1d"
            title={hoveredFeatureFacts.name || hoveredFeatureFacts.type}
            lines={[
              featureSummaryLine(hoveredFeatureFacts),
              ...(hoveredRegionLine ? [hoveredRegionLine] : []),
              ...(hoveredCodonNameLine ? [hoveredCodonNameLine] : []),
            ]}
            clientX={annotationTooltipPos.x}
            clientY={annotationTooltipPos.y}
          />
        ) : null}
      </div>
    );
  }
);
