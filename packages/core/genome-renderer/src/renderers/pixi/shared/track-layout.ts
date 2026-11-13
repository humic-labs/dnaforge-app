import {
  canvasCdsMetrics,
  cdsReplacementZoomPresentation,
  cdsZoomBandCenterOffset,
  type CdsZoomPresentation,
  indexedSequenceRevealMetrics as computeSequenceRevealMetrics,
} from '@waypoint/platform';

import type { OverlayLayoutBands, OverlayTrack } from '../overlays/overlay-track';
import type { Genome, RenderState } from '../../../types';
import {
  DEFAULT_TRACK_STACK_END_RESERVE_PX,
  TRACK_MANAGEMENT_REFERENCE_MIN_HEIGHT_PX,
} from '../../../track-stack-layout-contract';
import {
  ANNOTATION_BAR_HEIGHT as CANVAS_ANNOTATION_BAR_HEIGHT,
  ANNOTATION_LANE_SPACING as CANVAS_ANNOTATION_LANE_SPACING,
} from './theme';
import { MAX_SEQUENCE_FONT_SIZE, sequenceRowHeightForFontSize } from './sequence-sizing';
export {
  MAX_SEQUENCE_FONT_SIZE,
  MAX_INDEXED_LINEAR_SEQUENCE_PIXELS_PER_BP,
  MAX_SEQUENCE_PIXELS_PER_BP,
  MIN_SEQUENCE_FONT_SIZE,
  SEQUENCE_CHAR_WIDTH,
  SEQUENCE_FONT_SIZE,
  STABILITY_SEQUENCE_DETAIL_FRACTION,
  capMaxZoomForStabilityMode,
  maxZoomForSequencePixelsPerBp,
  sequenceFullViewportPixelsPerBp,
} from './sequence-sizing';
export {
  DEFAULT_TRACK_STACK_END_RESERVE_PX,
  TRACK_STACK_END_CONTROL_HEIGHT_PX,
} from '../../../track-stack-layout-contract';

export const LANE_HEIGHT = CANVAS_ANNOTATION_BAR_HEIGHT;
export const LANE_GAP = CANVAS_ANNOTATION_LANE_SPACING;

export const TRANSLATION_LABEL_HEIGHT = CANVAS_ANNOTATION_BAR_HEIGHT;
export const TRANSLATION_AA_RATIO = 0.9;

export const RESIDUE_NUMBER_ROW_HEIGHT = 11;
export const ORF_LANE_GAP = 4;
export const RULER_HEIGHT = 18;
export const SECTION_GAP = 4;
export const PRIMER_FEATURE_LANE_MIN_PIXELS_PER_BP = 0.02;
const PRIMER_FEATURE_LANE_FULL_PIXELS_PER_BP = 0.16;
const PRIMER_FEATURE_LANE_MIN_SCALE = 0.62;
const MIN_RULER_REVEAL_DROP_PX = 6;
const MAX_RULER_REVEAL_DROP_PX = 18;
const RULER_REVEAL_ROW_HEIGHT_RATIO = 0.4;
const MIN_HIDDEN_SEQUENCE_SLOT_PX = 0;

export interface OverlaySlot {
  overlay: OverlayTrack;
  yOffset: number;
  height: number;
}

export interface UnifiedLayoutInputs {
  overlays: readonly OverlayTrack[];
  genome: Genome;
  state: RenderState;
  pixelsPerBp: number;
  viewportHeight: number;

  topOffsetMin?: number;

  bottomReserve?: number;

  trackScrollTop?: number;

  trackStackEndReservePx?: number;
  hasSequence: boolean;

  showReverseComplement?: boolean;

  sequenceAvailable?: boolean;

  reserveSequenceLayoutEnvelope?: boolean;

  sequenceViewportSpanPx?: number;

  overviewLaneScale?: number;

  cdsSizing?: 'canvas' | 'indexed' | 'cohesive';
  translationLanes: number;
  annotationLanes: number;
  cdsLanes: number;
  orfForwardLanes?: number;
  orfReverseLanes?: number;
}

export interface UnifiedLayout {
  above: OverlaySlot[];
  on: OverlaySlot[];
  below: OverlaySlot[];

  primerLayoutMode: 'none' | 'collapsed' | 'split';
  primerForwardTop: number;
  primerForwardHeight: number;
  primerReverseTop: number;
  primerReverseHeight: number;
  primerOverviewTop: number;
  primerOverviewHeight: number;
  orfForwardTop: number;
  orfForwardHeight: number;
  orfReverseTop: number;
  orfReverseHeight: number;

  trackScrollTop: number;

  maxTrackScrollTop: number;

  trackContentHeight: number;
  annotationTop: number;
  annotationHeight: number;
  translationTop: number;
  translationLaneHeight: number;
  translationHeight: number;

  strandEnvelopeTop: number;

  strandEnvelopeBottom: number;

  fwdStrandTop: number;
  fwdStrandCenter: number;
  fwdStrandBottom: number;
  revStrandTop: number;
  revStrandCenter: number;
  revStrandBottom: number;
  rulerY: number;
  cutLineTop: number;
  cutLineBottom: number;
  cutLineConnectorY: number;
  cutLabelY: number;

  annotationOffset: number;
  annotationStep: number;
  cdsLaneOffset: number;
  cdsLaneStep: number;
  cdsBarOffset: number;
  cdsChevronOffset: number;

  cdsChevronHeight?: number;
  cdsZoomPresentation?: CdsZoomPresentation;

  cdsResidueRowOffset: number;
  cdsResidueRowHeight: number;
  orfForwardOffset: number;
  orfReverseOffset: number;
  orfLaneStep: number;
  orfLaneHeight: number;
  translationOffset: number;
  translationStep: number;
  fwdStrandOffset: number;
  revStrandOffset: number;
  rulerOffset: number;
  cutLineTopOffset: number;
  cutLineBottomOffset: number;
  cutLineConnectorOffset: number;
  cutLabelOffset: number;

  sequenceFontSize: number;
  rowHeight: number;
  sequenceVisible: boolean;

  sequenceOpacity: number;

  sequenceRevealProgress: number;

  primerFeatureLaneScale: number;
  totalHeight: number;
  offset: number;

  compactScale: number;

  overviewLaneScale: number;

  laneGeometryScale: number;
}

export interface SequenceRevealMetrics {
  sequenceVisible: boolean;
  sequenceOpacity: number;
  sequenceRevealProgress: number;
  sequenceRevealStartPixelsPerBp: number;
  sequenceFullViewportPixelsPerBp: number;
  sequenceFontSize: number;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function rulerRevealDropForRowHeight(rowHeight: number): number {
  return Math.max(
    MIN_RULER_REVEAL_DROP_PX,
    Math.min(MAX_RULER_REVEAL_DROP_PX, rowHeight * RULER_REVEAL_ROW_HEIGHT_RATIO)
  );
}

export { computeSequenceRevealMetrics };

export function primerFeatureLaneScaleForPixelsPerBp(
  pixelsPerBp: number,
  fullScalePixelsPerBp = PRIMER_FEATURE_LANE_FULL_PIXELS_PER_BP
): number {
  if (!Number.isFinite(pixelsPerBp) || pixelsPerBp <= 0) return PRIMER_FEATURE_LANE_MIN_SCALE;
  const fullScaleAt = Math.max(PRIMER_FEATURE_LANE_MIN_PIXELS_PER_BP + 0.001, fullScalePixelsPerBp);
  const t = smoothstep(PRIMER_FEATURE_LANE_MIN_PIXELS_PER_BP, fullScaleAt, pixelsPerBp);
  return lerp(PRIMER_FEATURE_LANE_MIN_SCALE, 1, t);
}

export function unifiedLayoutCoreCameraKey(pixelsPerBp: number): number {
  return pixelsPerBp <= PRIMER_FEATURE_LANE_MIN_PIXELS_PER_BP ? 0 : pixelsPerBp;
}

function collectOverlayLayoutBandEntries(
  overlays: readonly OverlayTrack[],
  genome: Genome,
  state: RenderState,
  pixelsPerBp: number
): Array<{ overlay: OverlayTrack; bands: OverlayLayoutBands }> {
  return overlays
    .filter((overlay) => overlay.enabled && overlay.computeLayoutBands)
    .map((overlay) => ({
      overlay,
      bands: overlay.computeLayoutBands?.(genome, state, pixelsPerBp) ?? null,
    }))
    .filter((entry): entry is { overlay: OverlayTrack; bands: OverlayLayoutBands } => {
      const bands = entry.bands;
      return (
        !!bands &&
        ((bands.aboveSequenceHeight ?? 0) > 0 ||
          (bands.belowSequenceHeight ?? 0) > 0 ||
          (bands.sequenceBandHeight ?? 0) > 0 ||
          bands.occupiesSequenceBand === true)
      );
    });
}

function partitionEnabledOverlays(
  overlays: readonly OverlayTrack[],
  overlaysWithLayoutBands: ReadonlySet<OverlayTrack>
): { above: OverlayTrack[]; on: OverlayTrack[]; below: OverlayTrack[] } {
  return {
    above: overlays
      .filter((o) => o.enabled && o.position === 'above' && !overlaysWithLayoutBands.has(o))
      .sort((a, b) => a.sortOrder - b.sortOrder),
    on: overlays.filter((o) => o.enabled && o.position === 'on' && !overlaysWithLayoutBands.has(o)),
    below: overlays
      .filter((o) => o.enabled && o.position === 'below' && !overlaysWithLayoutBands.has(o))
      .sort((a, b) => a.sortOrder - b.sortOrder),
  };
}

function residueLabelsWillRender(args: {
  showResidueNumbers: boolean | undefined;
  reserveSequenceLayoutEnvelope: boolean;
  sequenceVisible: boolean;
  pixelsPerBp: number;
}): boolean {
  return (
    args.showResidueNumbers === true &&
    (args.reserveSequenceLayoutEnvelope || (args.sequenceVisible && args.pixelsPerBp * 3 >= 1))
  );
}

function computeTrackStackOffset(args: {
  topOffsetMin: number | undefined;
  bottomReserve: number | undefined;
  trackStackEndReservePx: number | undefined;
  trackScrollTop: number | undefined;
  viewportHeight: number;
  totalHeight: number;
}): {
  offset: number;
  trackScrollTop: number;
  maxTrackScrollTop: number;
  trackContentHeight: number;
  hasExplicitTrackStackEndReserve: boolean;
  trackStackEndReservePx: number;
} {
  const topMin = Math.max(0, args.topOffsetMin ?? 0);
  const bottomReserve = Math.max(0, args.bottomReserve ?? 0);
  const hasExplicitTrackStackEndReserve = args.trackStackEndReservePx !== undefined;
  const trackStackEndReservePx = hasExplicitTrackStackEndReserve
    ? Math.max(0, Number.isFinite(args.trackStackEndReservePx) ? args.trackStackEndReservePx! : 0)
    : DEFAULT_TRACK_STACK_END_RESERVE_PX;
  const trackContentHeight = topMin + args.totalHeight + bottomReserve;
  const maxTrackScrollTop = hasExplicitTrackStackEndReserve
    ? Math.max(0, trackContentHeight + trackStackEndReservePx - args.viewportHeight)
    : trackContentHeight > args.viewportHeight
      ? trackContentHeight - args.viewportHeight + DEFAULT_TRACK_STACK_END_RESERVE_PX
      : 0;

  let offset: number;

  if (topMin > 0 || bottomReserve > 0 || hasExplicitTrackStackEndReserve) {
    offset = topMin;
  } else {
    const idealOffset = (args.viewportHeight - args.totalHeight) / 2;
    const maxOffset = args.viewportHeight - args.totalHeight - trackStackEndReservePx;
    offset =
      args.totalHeight > args.viewportHeight
        ? Math.min(0, maxOffset)
        : Math.max(0, Math.min(idealOffset, maxOffset));
  }

  let trackScrollTop = Math.max(0, Math.min(maxTrackScrollTop, topMin - offset));
  if (args.trackScrollTop !== undefined) {
    const requested = Number.isFinite(args.trackScrollTop) ? args.trackScrollTop : 0;
    trackScrollTop = Math.max(0, Math.min(maxTrackScrollTop, requested));
    offset = topMin - trackScrollTop;
  }

  return {
    offset,
    trackScrollTop,
    maxTrackScrollTop,
    trackContentHeight,
    hasExplicitTrackStackEndReserve,
    trackStackEndReservePx,
  };
}

function applyPrimerForwardLayout(args: {
  y: number;
  overlayBandEntries: Array<{ overlay: OverlayTrack; bands: OverlayLayoutBands }>;
  genome: Genome;
  state: RenderState;
  pixelsPerBp: number;
  compactScale: number;
}): {
  primerLayoutMode: UnifiedLayout['primerLayoutMode'];
  primerForwardTop: number;
  primerForwardHeight: number;
  collapsedPrimerSequenceBandHeight: number;
  nextY: number;
} {
  let primerLayoutMode: UnifiedLayout['primerLayoutMode'] = 'none';
  let primerForwardTop = args.y;
  let primerForwardHeight = 0;
  let collapsedPrimerSequenceBandHeight = 0;
  let y = args.y;
  for (const { overlay, bands } of args.overlayBandEntries) {
    if (overlay.id !== 'primers') continue;
    const primerSequenceBandHeight = bands.sequenceBandHeight ?? 0;
    if (primerSequenceBandHeight > 0) {
      collapsedPrimerSequenceBandHeight = Math.max(
        collapsedPrimerSequenceBandHeight,
        primerSequenceBandHeight
      );
    }
    primerForwardHeight = bands.aboveSequenceHeight ?? 0;
    if (primerForwardHeight > 0) {
      primerLayoutMode = 'split';
      primerForwardTop = y;
      y += primerForwardHeight;
    } else if (bands.occupiesSequenceBand) {
      primerLayoutMode = 'collapsed';
      collapsedPrimerSequenceBandHeight = Math.max(
        collapsedPrimerSequenceBandHeight,
        primerSequenceBandHeight > 0
          ? primerSequenceBandHeight
          : overlay.computeHeight(args.genome, args.state, args.pixelsPerBp) * args.compactScale
      );
    }
  }
  return {
    primerLayoutMode,
    primerForwardTop,
    primerForwardHeight,
    collapsedPrimerSequenceBandHeight,
    nextY: y,
  };
}

function applyPrimerReverseLayout(args: {
  y: number;
  sectionGap: number;
  overlayBandEntries: Array<{ overlay: OverlayTrack; bands: OverlayLayoutBands }>;
  primerLayoutMode: UnifiedLayout['primerLayoutMode'];
}): {
  primerLayoutMode: UnifiedLayout['primerLayoutMode'];
  primerReverseTop: number;
  primerReverseHeight: number;
  nextY: number;
} {
  let primerLayoutMode = args.primerLayoutMode;
  let primerReverseTop = 0;
  let primerReverseHeight = 0;
  let y = args.y;
  for (const { overlay, bands } of args.overlayBandEntries) {
    if (overlay.id !== 'primers') continue;
    primerReverseHeight = bands.belowSequenceHeight ?? 0;
    if (primerReverseHeight > 0) {
      primerLayoutMode = 'split';
      y += args.sectionGap;
      primerReverseTop = y;
      y += primerReverseHeight;
    }
  }
  return { primerLayoutMode, primerReverseTop, primerReverseHeight, nextY: y };
}

function computeStrandSlotGeometry(args: {
  y: number;
  strandRowHeight: number;
  rowHeight: number;
  layoutRowHeight: number;
  collapsedPrimerSequenceBandHeight: number;
  sequenceRevealProgress: number;
  reserveSequenceLayoutEnvelope: boolean;
  showReverseComplement: boolean;
}): {
  visibleStrandSlot: number;
  allocatedStrandSlot: number;
  strandEnvelopeTop: number;
  fwdStrandTop: number;
  fwdStrandCenter: number;
  fwdStrandBottom: number;
  revStrandTop: number;
  revStrandCenter: number;
  revStrandBottom: number;
  spineY: number;
  nextY: number;
} {
  const visibleDetailStrandSlot = Math.max(args.strandRowHeight, args.rowHeight);
  const allocatedDetailStrandSlot = Math.max(args.strandRowHeight, args.layoutRowHeight);
  const primerCollapsedStrandSlot = args.collapsedPrimerSequenceBandHeight / 2;
  const reservedStrandSlot = Math.max(primerCollapsedStrandSlot, allocatedDetailStrandSlot);
  const sequenceRevealStrandSlot = lerp(
    MIN_HIDDEN_SEQUENCE_SLOT_PX,
    visibleDetailStrandSlot,
    args.sequenceRevealProgress
  );
  const visibleStrandSlot =
    primerCollapsedStrandSlot > 0
      ? lerp(primerCollapsedStrandSlot, visibleDetailStrandSlot, args.sequenceRevealProgress)
      : sequenceRevealStrandSlot;
  const allocatedStrandSlot = args.reserveSequenceLayoutEnvelope
    ? reservedStrandSlot
    : visibleStrandSlot;
  const rowCount = args.showReverseComplement ? 2 : 1;
  const visiblePairInset = (Math.max(0, allocatedStrandSlot - visibleStrandSlot) * rowCount) / 2;
  const strandEnvelopeTop = args.y;
  const fwdStrandTop = strandEnvelopeTop + visiblePairInset;
  const fwdStrandBottom = fwdStrandTop + visibleStrandSlot;
  const revStrandTop = fwdStrandBottom;
  const revStrandBottom = revStrandTop + (args.showReverseComplement ? visibleStrandSlot : 0);
  return {
    visibleStrandSlot,
    allocatedStrandSlot,
    strandEnvelopeTop,
    fwdStrandTop,
    fwdStrandCenter: fwdStrandTop + visibleStrandSlot / 2,
    fwdStrandBottom,
    revStrandTop,
    revStrandCenter: revStrandTop + (args.showReverseComplement ? visibleStrandSlot / 2 : 0),
    revStrandBottom,
    spineY: fwdStrandTop,
    nextY: strandEnvelopeTop + allocatedStrandSlot * rowCount,
  };
}

function computeRulerPlacement(args: {
  y: number;
  sectionGap: number;
  rulerH: number;
  layoutRowHeight: number;
  layoutSequenceRevealProgress: number;
  belowSlotCount: number;
  annotationHeight: number;
  cdsRegionHeight: number;
  orfForwardHeight: number;
  orfReverseHeight: number;
  primerForwardHeight: number;
  collapsedPrimerSequenceBandHeight: number;
}): { rulerY: number; nextY: number } {
  const hasCollapsedOverviewTrackAboveSequence =
    args.annotationHeight > 0 ||
    args.cdsRegionHeight > 0 ||
    args.orfForwardHeight > 0 ||
    args.orfReverseHeight > 0 ||
    args.primerForwardHeight > 0 ||
    args.collapsedPrimerSequenceBandHeight > 0;
  const overviewRulerGap =
    args.belowSlotCount > 0
      ? 0
      : hasCollapsedOverviewTrackAboveSequence
        ? Math.min(1, args.sectionGap)
        : args.sectionGap;
  const detailRulerGap =
    (args.belowSlotCount > 0 ? 0 : args.sectionGap) +
    rulerRevealDropForRowHeight(args.layoutRowHeight);
  const collapsedRulerY = args.y + overviewRulerGap;
  const expandedRulerY = args.y + detailRulerGap;
  const rulerY = lerp(collapsedRulerY, expandedRulerY, args.layoutSequenceRevealProgress);
  return {
    rulerY,
    nextY: Math.max(args.y, Math.max(expandedRulerY + args.rulerH, rulerY + args.rulerH)),
  };
}

function unifiedLayoutCompactMetrics(args: {
  viewportHeight: number;
  pixelsPerBp: number;
  sequenceRevealStartPixelsPerBp: number;
  overviewLaneScale: number | undefined;
}): {
  compactScale: number;
  overviewLaneScale: number;
  primerFeatureLaneScale: number;
  laneHeight: number;
  laneGap: number;
  sectionGap: number;
  rulerH: number;
  translationLabelH: number;
  strandRowHeight: number;
  aaTrackHeightMin: number;
} {
  const REFERENCE_VIEWPORT_HEIGHT = 600;
  const compactScale = Math.max(0.5, Math.min(1, args.viewportHeight / REFERENCE_VIEWPORT_HEIGHT));
  return {
    compactScale,
    overviewLaneScale: Math.max(0, Math.min(1, args.overviewLaneScale ?? 1)),
    primerFeatureLaneScale: primerFeatureLaneScaleForPixelsPerBp(
      args.pixelsPerBp,
      args.sequenceRevealStartPixelsPerBp
    ),
    laneHeight: LANE_HEIGHT,
    laneGap: LANE_GAP,
    sectionGap: SECTION_GAP * compactScale,
    rulerH: RULER_HEIGHT,
    translationLabelH: TRANSLATION_LABEL_HEIGHT,
    strandRowHeight: 6 * compactScale,
    aaTrackHeightMin: 10 * compactScale,
  };
}

function unifiedLayoutTranslationEnvelope(args: {
  compactScale: number;
  translationLabelH: number;
  aaTrackHeight: number;
  orfTrackHeight: number;
  showResidueNumbers: boolean | undefined;
  reserveSequenceLayoutEnvelope: boolean;
  sequenceVisible: boolean;
  pixelsPerBp: number;
  cdsLanes: number | undefined;
  orfForwardLanes: number | undefined;
  orfReverseLanes: number | undefined;
}): {
  residueLabelsVisible: boolean;
  residueRowHeight: number;
  translationLaneHeight: number;
  cdsLanes: number;
  orfForwardLanes: number;
  orfReverseLanes: number;
  orfLaneHeight: number;
  orfLaneGap: number;
  orfLaneStep: number;
} {
  const residueLabelsVisible = residueLabelsWillRender({
    showResidueNumbers: args.showResidueNumbers,
    reserveSequenceLayoutEnvelope: args.reserveSequenceLayoutEnvelope,
    sequenceVisible: args.sequenceVisible,
    pixelsPerBp: args.pixelsPerBp,
  });
  const residueRowHeight = residueLabelsVisible ? RESIDUE_NUMBER_ROW_HEIGHT * args.compactScale : 0;
  const orfLaneHeight = args.orfTrackHeight;
  const orfLaneGap = ORF_LANE_GAP * args.compactScale;
  return {
    residueLabelsVisible,
    residueRowHeight,
    translationLaneHeight: args.translationLabelH + args.aaTrackHeight + residueRowHeight,
    cdsLanes: Math.max(0, args.cdsLanes ?? 0),
    orfForwardLanes: Math.max(0, args.orfForwardLanes ?? 0),
    orfReverseLanes: Math.max(0, args.orfReverseLanes ?? 0),
    orfLaneHeight,
    orfLaneGap,
    orfLaneStep: orfLaneHeight + orfLaneGap,
  };
}

function placeUnifiedLayoutAboveSlots(args: {
  y: number;
  above: OverlayTrack[];
  aboveHeights: number[];
  cdsLanes: number;
  sectionGap: number;
}): {
  y: number;
  aboveSlots: OverlaySlot[];
  annotationTop: number;
  annotationHeight: number;
} {
  const aboveSlots: OverlaySlot[] = [];
  const annotationTop = args.y;
  let annotationHeight = 0;
  let y = args.y;
  for (let i = 0; i < args.above.length; i++) {
    const h = args.aboveHeights[i];
    const renderZeroHeightAnnotationSlot = args.above[i].id === 'annotations' && args.cdsLanes > 0;
    if (h > 0 || renderZeroHeightAnnotationSlot) {
      aboveSlots.push({ overlay: args.above[i], yOffset: y, height: h });
      if (h > 0) {
        annotationHeight += h;
        y += h;
        if (i < args.above.length - 1) y += args.sectionGap;
      }
    }
  }
  return { y, aboveSlots, annotationTop, annotationHeight };
}

function placeUnifiedLayoutCdsRegion(args: {
  y: number;
  annotationHeight: number;
  cdsLanes: number;
  translationLaneHeight: number;
  sectionGap: number;
}): {
  y: number;
  cdsLaneStep: number;
  cdsRegionTop: number;
  cdsRegionHeight: number;
} {
  let y = args.y;
  if (args.annotationHeight > 0 && args.cdsLanes > 0) {
    y += args.sectionGap;
  }
  const cdsLaneStep = args.translationLaneHeight;
  const cdsRegionTop = y;
  let cdsRegionHeight = 0;
  if (args.cdsLanes > 0) {
    cdsRegionHeight = args.cdsLanes * cdsLaneStep;
    y += cdsRegionHeight + args.sectionGap;
  }
  return { y, cdsLaneStep, cdsRegionTop, cdsRegionHeight };
}

function placeUnifiedLayoutOrfStack(args: {
  y: number;
  orfForwardLanes: number;
  orfReverseLanes: number;
  orfLaneHeight: number;
  orfLaneGap: number;
  sectionGap: number;
  layoutSequenceRevealProgress: number;
  cdsRegionHeight: number;
}): {
  y: number;
  orfForwardTop: number;
  orfForwardHeight: number;
  orfReverseTop: number;
  orfReverseHeight: number;
} {
  let y = args.y;
  const orfForwardTop = y;
  const orfForwardHeight =
    args.orfForwardLanes > 0
      ? args.orfForwardLanes * args.orfLaneHeight + (args.orfForwardLanes - 1) * args.orfLaneGap
      : 0;
  if (orfForwardHeight > 0) {
    y += orfForwardHeight;
  }

  let orfReverseTop = y;
  const orfReverseHeight =
    args.orfReverseLanes > 0
      ? args.orfReverseLanes * args.orfLaneHeight + (args.orfReverseLanes - 1) * args.orfLaneGap
      : 0;
  const sequenceRevealGap = args.sectionGap * args.layoutSequenceRevealProgress;
  if (orfReverseHeight > 0) {
    if (orfForwardHeight > 0 || args.cdsRegionHeight > 0) {
      y += args.sectionGap;
      orfReverseTop = y;
    }
    y += orfReverseHeight + sequenceRevealGap;
  } else if (orfForwardHeight > 0) {
    y += sequenceRevealGap;
  }
  return { y, orfForwardTop, orfForwardHeight, orfReverseTop, orfReverseHeight };
}

function placeUnifiedLayoutBelowSlots(args: {
  y: number;
  below: OverlayTrack[];
  belowHeights: number[];
  sectionGap: number;
}): { y: number; belowSlots: OverlaySlot[] } {
  let y = args.y;
  const belowSlots: OverlaySlot[] = [];
  if (args.belowHeights.some((h) => h > 0)) y += args.sectionGap;
  for (let i = 0; i < args.below.length; i++) {
    const h = args.belowHeights[i];
    if (h > 0) {
      belowSlots.push({ overlay: args.below[i], yOffset: y, height: h });
      y += h + args.sectionGap;
    }
  }
  return { y, belowSlots };
}

function unifiedLayoutSpineOffsets(args: {
  annotationHeight: number;
  annotationTop: number;
  spineY: number;
  annotationBottomInset: number;
  cdsLanes: number;
  cdsRegionTop: number;
  cdsRegionHeight: number;
  cdsLaneStep: number;
  residueRowHeight: number;
  aaTrackHeight: number;
  cdsChevronHeight?: number;
  translationLabelH: number;
  orfForwardHeight: number;
  orfForwardTop: number;
  orfLaneHeight: number;
  orfReverseHeight: number;
  orfReverseTop: number;
  translationLaneHeight: number;
  inwardPrimerStackExtent: number;
}): {
  annotationOffset: number;
  cdsLaneOffset: number;
  cdsBarOffset: number;
  cdsChevronOffset: number;
  cdsResidueRowOffset: number;
  orfForwardOffset: number;
  orfReverseOffset: number;
  translationOffset: number;
} {
  const annotationOffset =
    args.annotationHeight > 0
      ? args.annotationTop + args.annotationHeight - args.spineY - args.annotationBottomInset
      : 0;
  const cdsLaneOffset =
    args.cdsLanes > 0
      ? args.cdsRegionTop + args.cdsRegionHeight - args.spineY - args.cdsLaneStep / 2
      : -(args.cdsLaneStep / 2 + 2);
  const cdsBarOffset = cdsLaneOffset - args.aaTrackHeight / 2 - args.residueRowHeight / 2;
  const cdsChevronOffset =
    args.cdsChevronHeight === undefined
      ? cdsLaneOffset + args.translationLabelH / 2 - args.residueRowHeight / 2
      : cdsBarOffset + args.translationLabelH / 2 + args.cdsChevronHeight / 2;
  const cdsResidueRowOffset =
    args.residueRowHeight > 0
      ? cdsLaneOffset + args.cdsLaneStep / 2 - args.residueRowHeight / 2
      : 0;
  const orfForwardOffset =
    args.orfForwardHeight > 0 ? args.orfForwardTop - args.spineY + args.orfLaneHeight / 2 : 0;
  const orfReverseOffset =
    args.orfReverseHeight > 0 ? args.orfReverseTop - args.spineY + args.orfLaneHeight / 2 : 0;
  const translationOffset =
    args.cdsLanes > 0
      ? cdsLaneOffset
      : -(args.inwardPrimerStackExtent + args.translationLaneHeight / 2 + 2);
  return {
    annotationOffset,
    cdsLaneOffset,
    cdsBarOffset,
    cdsChevronOffset,
    cdsResidueRowOffset,
    orfForwardOffset,
    orfReverseOffset,
    translationOffset,
  };
}

export function computeUnifiedLayout(inputs: UnifiedLayoutInputs): UnifiedLayout {
  const {
    overlays,
    genome,
    state,
    pixelsPerBp,
    viewportHeight,
    hasSequence,
    translationLanes: _translationLanes,
  } = inputs;

  const sequenceViewportSpanPx = inputs.sequenceViewportSpanPx ?? state.width;
  const sequenceAvailable = inputs.sequenceAvailable ?? hasSequence;
  const reveal = computeSequenceRevealMetrics(
    sequenceAvailable,
    pixelsPerBp,
    sequenceViewportSpanPx
  );
  const sequenceVisible = hasSequence && reveal.sequenceVisible;
  const sequenceOpacity = sequenceVisible ? reveal.sequenceOpacity : 0;
  const sequenceRevealProgress = reveal.sequenceRevealProgress;
  const sequenceFontSize = reveal.sequenceFontSize;
  const reserveSequenceLayoutEnvelope =
    inputs.reserveSequenceLayoutEnvelope === true && sequenceAvailable;

  const rowHeight = sequenceRowHeightForFontSize(sequenceFontSize);
  const layoutRowHeight = reserveSequenceLayoutEnvelope
    ? sequenceRowHeightForFontSize(MAX_SEQUENCE_FONT_SIZE)
    : rowHeight;
  const layoutSequenceRevealProgress = reserveSequenceLayoutEnvelope ? 1 : sequenceRevealProgress;

  const {
    compactScale,
    overviewLaneScale,
    primerFeatureLaneScale,
    laneHeight,
    laneGap,
    sectionGap,
    rulerH,
    translationLabelH,
    strandRowHeight: STRAND_ROW_HEIGHT,
    aaTrackHeightMin: AA_TRACK_HEIGHT_MIN,
  } = unifiedLayoutCompactMetrics({
    viewportHeight,
    pixelsPerBp,
    sequenceRevealStartPixelsPerBp: reveal.sequenceRevealStartPixelsPerBp,
    overviewLaneScale: inputs.overviewLaneScale,
  });

  const indexedAaTrackHeight = Math.max(
    AA_TRACK_HEIGHT_MIN,
    layoutRowHeight * TRANSLATION_AA_RATIO
  );
  const canvasCdsSizing = inputs.cdsSizing === 'canvas';
  const cdsZoomPresentation =
    inputs.cdsSizing === 'cohesive'
      ? cdsReplacementZoomPresentation(pixelsPerBp, sequenceViewportSpanPx)
      : undefined;
  if (cdsZoomPresentation && !hasSequence) cdsZoomPresentation.colorAlpha = 0;
  const cdsChevronHeight = canvasCdsSizing
    ? Math.max(5.4, canvasCdsMetrics(pixelsPerBp).aaHeight)
    : (cdsZoomPresentation?.aaHeight ?? rowHeight * TRANSLATION_AA_RATIO);
  const aaTrackHeight = canvasCdsSizing
    ? Math.max(AA_TRACK_HEIGHT_MIN, cdsChevronHeight)
    : cdsZoomPresentation
      ? Math.max(indexedAaTrackHeight, cdsZoomPresentation.bandHeight)
      : indexedAaTrackHeight;
  const {
    residueRowHeight,
    translationLaneHeight,
    cdsLanes,
    orfForwardLanes,
    orfReverseLanes,
    orfLaneHeight,
    orfLaneGap,
    orfLaneStep,
  } = unifiedLayoutTranslationEnvelope({
    compactScale,
    translationLabelH,
    aaTrackHeight,
    orfTrackHeight: indexedAaTrackHeight,
    showResidueNumbers: inputs.state.showResidueNumbers,
    reserveSequenceLayoutEnvelope,
    sequenceVisible: reveal.sequenceVisible,
    pixelsPerBp,
    cdsLanes: inputs.cdsLanes,
    orfForwardLanes: inputs.orfForwardLanes,
    orfReverseLanes: inputs.orfReverseLanes,
  });

  const overlayBandEntries = collectOverlayLayoutBandEntries(overlays, genome, state, pixelsPerBp);
  const overlaysWithLayoutBands = new Set(overlayBandEntries.map((entry) => entry.overlay));
  const { above, on, below } = partitionEnabledOverlays(overlays, overlaysWithLayoutBands);

  const annotationLabelHalfHeight = laneHeight / 2;
  const annotationBottomInset = cdsZoomPresentation
    ? Math.max(
        annotationLabelHalfHeight,
        cdsZoomBandCenterOffset(cdsZoomPresentation) + cdsZoomPresentation.aaHeight / 2
      )
    : annotationLabelHalfHeight;
  const annotationStep = annotationLabelHalfHeight + annotationBottomInset + laneGap;
  const annotationHeightForLod = Math.max(0, inputs.annotationLanes) * annotationStep;
  const aboveHeights = above.map((o) => {
    if (o.id === 'annotations') return annotationHeightForLod;
    return o.computeHeight(genome, state, pixelsPerBp) * compactScale;
  });
  const belowHeights = below.map((o) => o.computeHeight(genome, state, pixelsPerBp) * compactScale);

  let y = 0;

  const abovePlaced = placeUnifiedLayoutAboveSlots({
    y,
    above,
    aboveHeights,
    cdsLanes,
    sectionGap,
  });
  const { aboveSlots, annotationTop, annotationHeight } = abovePlaced;
  y = abovePlaced.y;

  const cdsPlaced = placeUnifiedLayoutCdsRegion({
    y,
    annotationHeight,
    cdsLanes,
    translationLaneHeight,
    sectionGap,
  });
  const { cdsLaneStep, cdsRegionTop, cdsRegionHeight } = cdsPlaced;
  y = cdsPlaced.y;

  const orfPlaced = placeUnifiedLayoutOrfStack({
    y,
    orfForwardLanes,
    orfReverseLanes,
    orfLaneHeight,
    orfLaneGap,
    sectionGap,
    layoutSequenceRevealProgress,
    cdsRegionHeight,
  });
  const { orfForwardTop, orfForwardHeight, orfReverseTop, orfReverseHeight } = orfPlaced;
  y = orfPlaced.y;

  const translationTop = y;
  const translationHeight = 0;

  let primerOverviewTop = 0;
  let primerOverviewHeight = 0;
  const primerForward = applyPrimerForwardLayout({
    y,
    overlayBandEntries,
    genome,
    state,
    pixelsPerBp,
    compactScale,
  });
  let primerLayoutMode = primerForward.primerLayoutMode;
  let primerForwardTop = primerForward.primerForwardTop;
  const primerForwardHeight = primerForward.primerForwardHeight;
  const collapsedPrimerSequenceBandHeight = primerForward.collapsedPrimerSequenceBandHeight;
  y = primerForward.nextY;

  const strandSlots = computeStrandSlotGeometry({
    y,
    strandRowHeight: STRAND_ROW_HEIGHT,
    rowHeight,
    layoutRowHeight,
    collapsedPrimerSequenceBandHeight,
    sequenceRevealProgress,
    reserveSequenceLayoutEnvelope,
    showReverseComplement: inputs.showReverseComplement !== false,
  });
  const {
    visibleStrandSlot,
    allocatedStrandSlot,
    strandEnvelopeTop,
    fwdStrandTop,
    fwdStrandCenter,
    fwdStrandBottom,
    revStrandTop,
    revStrandCenter,
    revStrandBottom,
    spineY,
  } = strandSlots;
  y = strandSlots.nextY;

  primerOverviewTop = fwdStrandTop;
  primerOverviewHeight = revStrandBottom - fwdStrandTop;

  const primerReverse = applyPrimerReverseLayout({
    y,
    sectionGap,
    overlayBandEntries,
    primerLayoutMode,
  });
  primerLayoutMode = primerReverse.primerLayoutMode;
  let primerReverseTop = primerReverse.primerReverseTop;
  const primerReverseHeight = primerReverse.primerReverseHeight;
  y = primerReverse.nextY;

  const onSlots: OverlaySlot[] = on.map((o) => ({
    overlay: o,
    yOffset: fwdStrandTop,
    height: 0,
  }));
  for (const { overlay } of overlayBandEntries) {
    onSlots.push({
      overlay,
      yOffset: fwdStrandTop,
      height: revStrandBottom - fwdStrandTop,
    });
  }

  const belowPlaced = placeUnifiedLayoutBelowSlots({
    y,
    below,
    belowHeights,
    sectionGap,
  });
  const { belowSlots } = belowPlaced;
  y = belowPlaced.y;

  const rulerPlacement = computeRulerPlacement({
    y,
    sectionGap,
    rulerH,
    layoutRowHeight,
    layoutSequenceRevealProgress,
    belowSlotCount: belowSlots.length,
    annotationHeight,
    cdsRegionHeight,
    orfForwardHeight,
    orfReverseHeight,
    primerForwardHeight,
    collapsedPrimerSequenceBandHeight,
  });
  let rulerY = rulerPlacement.rulerY;
  y = rulerPlacement.nextY;
  if (reserveSequenceLayoutEnvelope && belowSlots.length === 0) {
    const drawnBottom =
      primerReverseHeight > 0
        ? primerReverseTop + primerReverseHeight
        : sequenceRevealProgress > 0
          ? revStrandBottom
          : spineY;
    rulerY = Math.min(rulerY, drawnBottom + sectionGap);
  }

  const totalHeight =
    inputs.trackStackEndReservePx === undefined
      ? y
      : Math.max(y, TRACK_MANAGEMENT_REFERENCE_MIN_HEIGHT_PX);

  const { offset, trackScrollTop, maxTrackScrollTop, trackContentHeight } = computeTrackStackOffset(
    {
      topOffsetMin: inputs.topOffsetMin,
      bottomReserve: inputs.bottomReserve,
      trackStackEndReservePx: inputs.trackStackEndReservePx,
      trackScrollTop: inputs.trackScrollTop,
      viewportHeight,
      totalHeight,
    }
  );

  for (const s of aboveSlots) s.yOffset += offset;
  for (const s of onSlots) s.yOffset += offset;
  for (const s of belowSlots) s.yOffset += offset;
  primerForwardTop += offset;
  primerReverseTop += offset;
  primerOverviewTop += offset;

  const fwdStrandOffset = 0;

  const fwdAllocated = visibleStrandSlot;
  const revAllocated = inputs.showReverseComplement === false ? 0 : visibleStrandSlot;
  const revStrandOffset = fwdAllocated;
  const rulerOffset = rulerY - spineY;

  const inwardPrimerStackExtent = primerForwardHeight > 0 ? primerForwardHeight : 0;

  const {
    annotationOffset,
    cdsLaneOffset,
    cdsBarOffset,
    cdsChevronOffset,
    cdsResidueRowOffset,
    orfForwardOffset,
    orfReverseOffset,
    translationOffset,
  } = unifiedLayoutSpineOffsets({
    annotationHeight,
    annotationTop,
    spineY,
    annotationBottomInset,
    cdsLanes,
    cdsRegionTop,
    cdsRegionHeight,
    cdsLaneStep,
    residueRowHeight,
    aaTrackHeight,
    cdsChevronHeight: canvasCdsSizing || cdsZoomPresentation ? cdsChevronHeight : undefined,
    translationLabelH,
    orfForwardHeight,
    orfForwardTop,
    orfLaneHeight,
    orfReverseHeight,
    orfReverseTop,
    translationLaneHeight,
    inwardPrimerStackExtent,
  });
  const cdsResidueRowHeight = residueRowHeight;
  const translationStep = translationLaneHeight;

  const cutLineTopOffset = fwdStrandOffset;
  const cutLineBottomOffset = revStrandOffset + revAllocated;
  const cutLineConnectorOffset = fwdAllocated;
  const belowStackBottomOffset = y - spineY;

  const cutLabelOffset = Math.max(
    rulerOffset + rulerH + sectionGap,
    belowStackBottomOffset,
    cutLineBottomOffset + sectionGap
  );

  const cutLineTop = fwdStrandTop + offset;
  const cutLineBottom = revStrandBottom + offset;
  const cutLineConnectorY = fwdStrandBottom + offset;
  const cutLabelY = spineY + cutLabelOffset + offset;

  return {
    above: aboveSlots,
    on: onSlots,
    below: belowSlots,

    primerLayoutMode,
    primerForwardTop,
    primerForwardHeight,
    primerReverseTop,
    primerReverseHeight,
    primerOverviewTop,
    primerOverviewHeight,
    orfForwardTop: orfForwardTop + offset,
    orfForwardHeight,
    orfReverseTop: orfReverseTop + offset,
    orfReverseHeight,

    trackScrollTop,
    maxTrackScrollTop,
    trackContentHeight,
    annotationTop: annotationTop + offset,
    annotationHeight,
    translationTop: translationTop + offset,
    translationLaneHeight,
    translationHeight,
    strandEnvelopeTop: strandEnvelopeTop + offset,
    strandEnvelopeBottom: strandEnvelopeTop + allocatedStrandSlot * 2 + offset,
    fwdStrandTop: fwdStrandTop + offset,
    fwdStrandCenter: fwdStrandCenter + offset,
    fwdStrandBottom: fwdStrandBottom + offset,
    revStrandTop: revStrandTop + offset,
    revStrandCenter: revStrandCenter + offset,
    revStrandBottom: revStrandBottom + offset,
    rulerY: rulerY + offset,
    cutLineTop,
    cutLineBottom,
    cutLineConnectorY,
    cutLabelY,

    annotationOffset,
    annotationStep,
    cdsLaneOffset,
    cdsLaneStep: cdsLaneStep,
    cdsBarOffset,
    cdsChevronOffset,
    cdsChevronHeight,
    cdsZoomPresentation,
    cdsResidueRowOffset,
    cdsResidueRowHeight,
    orfForwardOffset,
    orfReverseOffset,
    orfLaneStep,
    orfLaneHeight,
    translationOffset,
    translationStep,
    fwdStrandOffset,
    revStrandOffset,
    rulerOffset,
    cutLineTopOffset,
    cutLineBottomOffset,
    cutLineConnectorOffset,
    cutLabelOffset,

    sequenceFontSize,
    rowHeight,
    sequenceVisible,
    sequenceOpacity,
    sequenceRevealProgress,
    primerFeatureLaneScale,
    totalHeight,
    offset,
    compactScale,
    overviewLaneScale,
    laneGeometryScale: overviewLaneScale,
  };
}
