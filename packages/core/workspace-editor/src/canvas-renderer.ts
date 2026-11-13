import { rowPaintBounds, withRowMorph } from './predictive-wrap-layout';
import { rowPresentationBounds } from './row-presentation-bounds';
import type { SequenceDrawingContext } from './rendering/drawing-context';

import { resolveAnnotationDisplayColor, primersForSequenceDisplay } from '@waypoint/sequence-utils';
import type { GeneticCodeSpec } from '@waypoint/sequence-utils';
import type { Annotation, ColoredCutSite, ORF, SearchMatch } from '@waypoint/sequence-utils';
import type {
  LayoutSnapshot2D,
  WorkspaceEditorConfig,
  PrimerDisplay,
  RulerSegment,
  JunctionIndicator,
  RenderedGGProductLabel,
  CoordinateSpace,
  MutationMarker,
  InsertedRange,
  DeletedRange,
  SubstitutedRange,
  Selection,
  RulerDecoration,
} from './types';
import type { RenderedCutSite } from './restriction-enzymes/drawCutSites';
import {
  drawAnnotations,
  drawPrimers,
  type LinePositions,
  drawRowBackgrounds,
  drawHighlightedRangeColumns,
  drawSearchHighlights,
  drawHoveredCodonHighlight,
  drawViewCursor,
  drawRecognitionHighlights,
  drawSequenceText,
  drawComplementText,
  drawRuler,
  drawJunctionIndicators,
  drawHoveredRecognitionBorder,
  drawHighlightHandles,
  drawOriginIndicator,
  getVisibleRangeSegments,
  drawGGScarHighlights,
  drawAllGGScarBackgrounds,
  drawMutationTrack,
  drawDiffSequenceHighlights,
} from './canvas-drawing';
import { drawTranslation, type CodonInfo, type AlignmentCodonInfo } from './translation-drawing';
import type { CdsExtensionArrowBounds } from './cds-extension-affordance';
import {
  drawORFTracks,
  drawORFOverviewBars,
  makeOrfRenderStateFn,
  type OrfRenderStateInput,
} from './orf-drawing';
import type { AnnotationRenderStateInput } from './annotation-render-state';
import type { CodonMode } from './codon-rendering';
import { PRIMER_CANVAS_CONSTANTS } from './canvas-constants';
import { getCanvasTheme } from './canvas-theme';
import { paintedRowBackgroundBounds } from './row-background-geometry';
import { ROW_BOTTOM_PADDING } from './layout-constants';
import { getCachedSplicedSequence, isSplicedCDS } from './translation';
import type { IntronConnectorStroke } from './transcript-drawing';
import {
  buildLiveRulerDecorations,
  collectRenderedPrimerHits,
  goldenGateScarLabels,
  paintSequenceCutSites,
  sequenceAlignmentModeOptions,
  sequenceCodonMode,
  sequenceLodKind,
  type SequenceLodKind,
} from './sequence-render-batches';

export interface RenderSequenceParams {
  geneticCode?: GeneticCodeSpec;
  geneticCodeBasis?: import('@waypoint/sequence-utils').RecordGeneticCodeBasis;
  linePositions: LinePositions[];
  config: WorkspaceEditorConfig;
  layout: LayoutSnapshot2D;
  canvasWidth: number;
  canvasHeight: number;
  sequenceLength: number;
  fullSequence: string;
  cutSites: ColoredCutSite[];
  scannedCutSites: ColoredCutSite[];
  primers: PrimerDisplay[];
  mutations: MutationMarker[];
  rulerSegments: RulerSegment[];
  insertedRanges: InsertedRange[];
  deletedRanges: DeletedRange[];
  substitutedRanges?: SubstitutedRange[];
  showCutSites: boolean;
  highlightedRange: Selection | null;
  hoveredCodon: {
    start: number;
    end: number;
    strand: 1 | -1;
    source?: 'sequence' | 'structure';
  } | null;

  selectedCodons?: ReadonlyArray<{ start: number; end: number; strand: 1 | -1 }>;
  viewCursor: number | null;
  hoveredCutSite: ColoredCutSite | null;
  hoveredGGProductLabel: RenderedGGProductLabel | null;
  hoveredEnzymeName: string | null;
  hoveredPositionInfo: {
    enzymeName: string;
    position: number;
    recognitionStart: number;
    recognitionEnd: number;
  } | null;
  coordinateSpace?: CoordinateSpace;
  junctionIndicators?: JunctionIndicator[];
  viewport?: { scrollTop: number; height: number };

  precomputedAlignmentCodons?: Map<string, AlignmentCodonInfo[]>;

  mutationMap?: Map<number, MutationMarker>;

  orfs?: ORF[];

  orfRenderStateInput?: OrfRenderStateInput;

  annotationRenderStateInput?: AnnotationRenderStateInput;

  rulerDecorations?: RulerDecoration[];

  changedAnnotationNames?: Set<string>;

  searchHighlights?: SearchMatch[];

  activeSearchIndex?: number;

  hoveredPrimerId?: string | null;

  selectedPrimerId?: string | null;

  previewCDS?: Annotation | null;

  collectProfile?: boolean;

  capturePresentationBackground?: boolean;

  captureIntronConnectors?: boolean;
}

export interface PaintedIntronConnector extends IntronConnectorStroke {
  source: 'annotation' | 'cds-bar' | 'amino-acid';
  lineIndex: number;
}

export interface RenderSequenceProfile {
  totalMs: number;
  otherMs: number;
  backgroundMs?: number;
  translationMs?: number;
  rulerMs?: number;
  annotationsMs: number;
  sequenceMs: number;
  complementMs: number;
  visibleLineCount: number;
  visibleAnnotationCount: number;
}

export interface RenderSequenceResult {
  orfsDrawn?: boolean;
  renderedPrimers: Array<{
    primer: PrimerDisplay;
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
  renderedGGLabels: RenderedGGProductLabel[];
  renderedCutSites: RenderedCutSite[];

  renderedCdsExtensionArrows: CdsExtensionArrowBounds[];
  lineCodonUpdates: Map<number, CodonInfo[]>;
  profile?: RenderSequenceProfile;
  intronConnectors?: PaintedIntronConnector[];
}

function drawDensityLodRows(
  ctx: SequenceDrawingContext,
  linePositions: LinePositions[],
  x: number,
  config: WorkspaceEditorConfig,
  sequenceLength: number,
  canvasWidth: number,
  paintBackground = true,
  paintFeatures = true
): void {
  ctx.save();

  for (const lp of linePositions) {
    const rowTop = Math.floor(lp.sequenceY);
    const rowHeight = Math.max(1, Math.ceil(lp.lineEndY - lp.annotationY));
    ctx.fillStyle =
      (lp.line.lineIndex + (config.rowBackgroundOffset ?? 0)) % 2 === 0
        ? 'rgba(148, 163, 184, 0.08)'
        : 'rgba(148, 163, 184, 0.14)';
    if (paintBackground) ctx.fillRect(0, rowTop, canvasWidth, rowHeight);
    if (!paintFeatures) continue;

    const densityFeatures = [...lp.line.annotations, ...(lp.line.classifiedCDSs ?? [])];
    if (densityFeatures.length === 0) continue;
    for (const ann of densityFeatures) {
      const annStart = Math.max(0, ann.start - 1);
      const annEnd = Math.max(0, ann.end);
      const ranges =
        ann.start > ann.end && sequenceLength > 0
          ? [
              ...getVisibleRangeSegments(
                annStart,
                sequenceLength,
                lp.line.startPos,
                lp.line.endPos,
                sequenceLength
              ),
              ...getVisibleRangeSegments(
                0,
                annEnd,
                lp.line.startPos,
                lp.line.endPos,
                sequenceLength
              ),
            ]
          : getVisibleRangeSegments(
              annStart,
              annEnd,
              lp.line.startPos,
              lp.line.endPos,
              sequenceLength
            );

      ctx.fillStyle = resolveAnnotationDisplayColor(ann, {
        profile: { colorMode: config.annotationColorMode },
      });
      for (const range of ranges) {
        const width = Math.max(0.75, (range.end - range.start) * config.charWidth);
        const startX = x + range.charIndexStart * config.charWidth;
        ctx.fillRect(startX, rowTop, width, rowHeight);
      }
    }
  }

  ctx.restore();
}

function paintSequenceHighlightChrome(args: {
  ctx: SequenceDrawingContext;
  linePositions: LinePositions[];
  originX: number;
  config: WorkspaceEditorConfig;
  sequenceLength: number;
  isCircular: boolean;
  detailLod: boolean;
  highlightedRange: Selection | null | undefined;
  searchHighlights: SearchMatch[] | undefined;
  activeSearchIndex: number | undefined;
  hoveredCodon: RenderSequenceParams['hoveredCodon'];
  viewCursor: number | null | undefined;
  hoveredCutSite: ColoredCutSite | null | undefined;
}): void {
  if (args.highlightedRange) {
    drawHighlightedRangeColumns(
      args.ctx,
      args.linePositions,
      args.highlightedRange,
      args.originX,
      args.config,
      args.sequenceLength
    );
  }
  if (args.searchHighlights && args.searchHighlights.length > 0) {
    drawSearchHighlights(
      args.ctx,
      args.linePositions,
      args.searchHighlights,
      args.activeSearchIndex ?? -1,
      args.originX,
      args.config,
      args.sequenceLength
    );
  }
  if (args.detailLod && args.hoveredCodon) {
    drawHoveredCodonHighlight(
      args.ctx,
      args.linePositions,
      args.hoveredCodon,
      args.originX,
      args.config,
      args.sequenceLength,
      args.isCircular
    );
  }
  if (
    args.detailLod &&
    args.viewCursor !== null &&
    args.viewCursor !== undefined &&
    !args.hoveredCutSite
  ) {
    drawViewCursor(args.ctx, args.linePositions, args.viewCursor, args.originX, args.config);
  }
}

function paintSequenceAnnotationBatch(args: {
  ctx: SequenceDrawingContext;
  showAnnotations: boolean | undefined;
  lodLevel: SequenceLodKind;
  linePositions: LinePositions[];
  originX: number;
  config: WorkspaceEditorConfig;
  sequenceLength: number;
  changedAnnotationNames: RenderSequenceParams['changedAnnotationNames'];
  annotationRenderStateInput: AnnotationRenderStateInput | undefined;
  aminoAcidTracksVisible: boolean;
  fullSequence: string;
  intronConnectors: PaintedIntronConnector[] | undefined;
}): void {
  if (!args.showAnnotations) return;
  const renderCdsAsBar = args.lodLevel === 'feature';
  for (const { line, annotationY } of args.linePositions) {
    if (renderCdsAsBar)
      for (const cds of line.classifiedCDSs ?? []) {
        cds._paintedPresentation = undefined;
        cds._interactionOutlineContours = undefined;
        cds._cdsPillBounds = [];
        cds._cdsLineBounds = [];
        cds._exonPillBounds = [];
        cds._intronPillBounds = [];
      }
    if (line.annotations.length === 0) continue;
    const aminoAcidIntronOwners = args.aminoAcidTracksVisible
      ? (line.classifiedCDSs ?? [])
          .filter((cds) => cds.translationLane >= 0 && isSplicedCDS(cds, args.sequenceLength))
          .map((cds) => ({
            codingSegments: cds.segments!,
            direction: cds.direction ?? 1,
            introns: getCachedSplicedSequence(cds, args.fullSequence).introns.map((gap) => ({
              start: gap.genomicStart,
              end: gap.genomicEnd + 1,
            })),
          }))
      : undefined;
    drawAnnotations(
      args.ctx,
      args.config.cdsDetailProgress !== undefined && !renderCdsAsBar
        ? line.annotations.filter((ann) => ann.type !== 'CDS')
        : line.annotations,
      line.startPos,
      line.endPos,
      args.originX,
      annotationY,
      line.annotationLaneCount,
      args.config,
      args.sequenceLength,
      args.changedAnnotationNames,
      args.annotationRenderStateInput,
      renderCdsAsBar,
      undefined,
      undefined,
      {
        aminoAcidIntronOwners,
        onIntronConnector:
          args.intronConnectors &&
          ((stroke) =>
            args.intronConnectors!.push({
              ...stroke,
              source: 'annotation',
              lineIndex: line.lineIndex,
            })),
      }
    );
  }
}

function paintSequenceTranslationBatch(args: {
  ctx: SequenceDrawingContext;
  detailLod: boolean;
  showTranslation: boolean;
  linePositions: LinePositions[];
  originX: number;
  config: WorkspaceEditorConfig;
  fullSequence: string;
  insertedRanges: InsertedRange[];
  deletedRanges: DeletedRange[];
  coordinateSpace: CoordinateSpace | undefined;
  precomputedAlignmentCodons: Map<string, AlignmentCodonInfo[]> | undefined;
  previewCDS: RenderSequenceParams['previewCDS'];
  annotationRenderStateInput: AnnotationRenderStateInput | undefined;
  hoveredCodon: RenderSequenceParams['hoveredCodon'];
  selectedCodons: RenderSequenceParams['selectedCodons'];
  geneticCode: RenderSequenceParams['geneticCode'];
  geneticCodeBasis: RenderSequenceParams['geneticCodeBasis'];
  isCircularSequence: boolean;
  contentRightX: number;
  intronConnectors: PaintedIntronConnector[] | undefined;
}): { lineCodonUpdates: Map<number, CodonInfo[]>; extensionArrows: CdsExtensionArrowBounds[] } {
  const lineCodonUpdates = new Map<number, CodonInfo[]>();
  const extensionArrows: CdsExtensionArrowBounds[] = [];

  if (!args.detailLod || !args.showTranslation) return { lineCodonUpdates, extensionArrows };
  const alignmentModeOptions = sequenceAlignmentModeOptions(args.coordinateSpace);

  const labelViewportRightX = Math.min(
    args.contentRightX,
    args.config.cdsZoomPresentation?.viewportSpanPx ??
      (args.config.wrapCapacity === undefined
        ? args.contentRightX
        : args.config.marginLeft + args.config.wrapCapacity * args.config.charWidth)
  );
  for (const { line, annotationY, translationY, translationLaneCount } of args.linePositions) {
    if (translationLaneCount > 0 && line.classifiedCDSs && line.classifiedCDSs.length > 0) {
      const { codons, extensionArrows: arrows } = drawTranslation(
        args.ctx,
        line.sequence,
        line.classifiedCDSs,
        line.startPos,
        line.endPos,
        args.originX,
        translationY,
        args.config,
        args.fullSequence,
        args.insertedRanges,
        args.deletedRanges,
        0,
        [],
        alignmentModeOptions,
        args.precomputedAlignmentCodons,
        args.previewCDS,
        args.annotationRenderStateInput,
        {
          geneticCode: args.geneticCode,
          geneticCodeBasis: args.geneticCodeBasis,
          annotationY,
          ...(args.config.linearWrapPhase
            ? {
                viewportLeftX: args.config.marginLeft - (line.xOffset ?? 0),
                viewportRightX: labelViewportRightX - (line.xOffset ?? 0),
              }
            : {}),
          onIntronConnector:
            args.intronConnectors &&
            ((stroke) => args.intronConnectors!.push({ ...stroke, lineIndex: line.lineIndex })),
        },
        args.hoveredCodon,
        args.selectedCodons,
        {
          isCircularSequence: args.isCircularSequence,
          contentRightX: args.contentRightX,

          arrowRightX: labelViewportRightX - (line.xOffset ?? 0),

          emitArrows: true,
        }
      );

      const boundsYOffset = line.y - annotationY;
      for (const cds of line.classifiedCDSs) {
        for (const pills of [
          cds._cdsPillBounds,
          cds._cdsLineBounds,
          cds._exonPillBounds,
          cds._intronPillBounds,
        ])
          for (const pill of pills ?? []) if (pill.y !== undefined) pill.y += boundsYOffset;
        const pose = cds._paintedPresentation;
        if (pose)
          for (const key of ['labelY', 'barY', 'barCenterY', 'aaY', 'intronY'] as const)
            pose[key] += boundsYOffset;
        for (const contour of cds._interactionOutlineContours ?? [])
          for (const point of contour) point.y += boundsYOffset;
      }
      lineCodonUpdates.set(line.lineIndex, codons);
      if (arrows && arrows.length > 0) extensionArrows.push(...arrows);
    }
  }
  return { lineCodonUpdates, extensionArrows };
}

function paintSequencePrimerBatch(args: {
  ctx: SequenceDrawingContext;
  primers: PrimerDisplay[];
  linePositions: LinePositions[];
  originX: number;
  config: WorkspaceEditorConfig;
  sequenceLength: number;
  hoveredGGProductLabel: RenderedGGProductLabel | null | undefined;
  hoveredPrimerId: string | null | undefined;
  selectedPrimerId: string | null | undefined;
}): {
  renderedPrimers: RenderSequenceResult['renderedPrimers'];
  collectedGGLabels: RenderedGGProductLabel[];
  sharedLabelPositions: Map<number, Array<{ x: number; width: number }>>;
} {
  const allRenderedPrimers: RenderSequenceResult['renderedPrimers'] = [];
  const sharedLabelPositions = new Map<number, Array<{ x: number; width: number }>>();
  const collectedGGLabels: RenderedGGProductLabel[] = [];
  if (args.primers.length === 0) {
    return { renderedPrimers: allRenderedPrimers, collectedGGLabels, sharedLabelPositions };
  }
  const trackHeight = args.config.rowHeight * PRIMER_CANVAS_CONSTANTS.TRACK_HEIGHT_RATIO;
  const hitLaneHeight =
    args.config.rowHeight *
    (PRIMER_CANVAS_CONSTANTS.TRACK_HEIGHT_RATIO + PRIMER_CANVAS_CONSTANTS.ARROW_PADDING_RATIO);
  for (const lp of args.linePositions) {
    const { line, forwardPrimerY, reversePrimerY, hasForwardPrimers, hasReversePrimers } = lp;
    const fwdLaneMap = hasForwardPrimers
      ? drawPrimers(
          args.ctx,
          args.primers,
          line.startPos,
          line.endPos,
          args.originX,
          forwardPrimerY,
          args.config,
          'forward',
          'above',
          args.sequenceLength,
          sharedLabelPositions,
          line.lineIndex,
          collectedGGLabels,
          args.hoveredGGProductLabel,
          args.hoveredPrimerId,
          args.selectedPrimerId
        )
      : new Map<string, number>();
    const revLaneMap = hasReversePrimers
      ? drawPrimers(
          args.ctx,
          args.primers,
          line.startPos,
          line.endPos,
          args.originX,
          reversePrimerY,
          args.config,
          'reverse',
          'below',
          args.sequenceLength,
          sharedLabelPositions,
          line.lineIndex,
          collectedGGLabels,
          args.hoveredGGProductLabel,
          args.hoveredPrimerId,
          args.selectedPrimerId
        )
      : new Map<string, number>();
    allRenderedPrimers.push(
      ...collectRenderedPrimerHits({
        primers: args.primers,
        lineStartPos: line.startPos,
        lineEndPos: line.endPos,
        sequenceLength: args.sequenceLength,
        forwardPrimerY,
        reversePrimerY,
        fwdLaneMap,
        revLaneMap,
        hitLaneHeight,
        trackHeight,
        originX: args.originX,
        charWidth: args.config.charWidth,
      })
    );
  }
  return { renderedPrimers: allRenderedPrimers, collectedGGLabels, sharedLabelPositions };
}

function paintSequenceOrfBatch(args: {
  ctx: SequenceDrawingContext;
  detailLod: boolean;
  featureLod: boolean;
  orfs: ORF[] | undefined;
  linePositions: LinePositions[];
  originX: number;
  config: WorkspaceEditorConfig;
  fullSequence: string;
  sequenceLength: number;
  coordinateSpace: CoordinateSpace | undefined;
  precomputedAlignmentCodons: Map<string, AlignmentCodonInfo[]> | undefined;
  insertedRanges: InsertedRange[];
  deletedRanges: DeletedRange[];
  orfRenderStateInput: OrfRenderStateInput | undefined;
}): boolean {
  if (!(args.detailLod || args.featureLod) || !args.orfs || args.orfs.length === 0) return false;
  let drawn = false;
  const codonMode: CodonMode = sequenceCodonMode(
    sequenceAlignmentModeOptions(args.coordinateSpace),
    args.precomputedAlignmentCodons,
    args.insertedRanges,
    args.deletedRanges
  );
  const getRenderState = args.orfRenderStateInput
    ? makeOrfRenderStateFn(args.orfRenderStateInput)
    : undefined;
  const drawOrfLane = args.detailLod ? drawORFTracks : drawORFOverviewBars;
  for (const lp of args.linePositions) {
    if (lp.forwardOrfLaneCount > 0 && lp.line.forwardOrfs) {
      drawn =
        drawOrfLane(
          args.ctx,
          lp.line.forwardOrfs,
          lp.line.startPos,
          lp.line.endPos,
          args.originX,
          lp.forwardOrfY,
          args.config,
          args.fullSequence,
          args.sequenceLength,
          codonMode,
          getRenderState
        ) || drawn;
    }
    if (lp.reverseOrfLaneCount > 0 && lp.line.reverseOrfs) {
      drawn =
        drawOrfLane(
          args.ctx,
          lp.line.reverseOrfs,
          lp.line.startPos,
          lp.line.endPos,
          args.originX,
          lp.reverseOrfY,
          args.config,
          args.fullSequence,
          args.sequenceLength,
          codonMode,
          getRenderState
        ) || drawn;
    }
  }
  return drawn;
}

function renderSequenceRow(
  ctx: SequenceDrawingContext | null,
  params: RenderSequenceParams,
  clearBackground = true,
  paintRowBackground = true
): RenderSequenceResult {
  const emptyResult: RenderSequenceResult = {
    orfsDrawn: false,
    renderedPrimers: [],
    renderedGGLabels: [],
    renderedCutSites: [],
    renderedCdsExtensionArrows: [],
    lineCodonUpdates: new Map(),
  };

  if (!ctx) return emptyResult;
  ctx.setGeometryLayer?.('paper');

  const {
    linePositions,
    config,
    layout,
    sequenceLength,
    fullSequence,
    cutSites,
    scannedCutSites,
    primers: sourcePrimers,
    mutations,
    rulerSegments,
    insertedRanges,
    deletedRanges,
    showCutSites,
    highlightedRange,
    hoveredCodon,
    selectedCodons,
    geneticCode,
    geneticCodeBasis,
    viewCursor,
    hoveredCutSite,
    hoveredGGProductLabel,
    hoveredEnzymeName,
    hoveredPositionInfo,
    coordinateSpace,
    junctionIndicators,
    viewport,
    precomputedAlignmentCodons,
    mutationMap,
    orfs,
    orfRenderStateInput,
    annotationRenderStateInput,
    rulerDecorations,
    changedAnnotationNames,
    hoveredPrimerId,
    selectedPrimerId,
    previewCDS,
  } = params;
  const primers = primersForSequenceDisplay(sourcePrimers, config.showPrimers ?? false);

  const x = config.marginLeft;
  const vp = viewport ?? { scrollTop: 0, height: 0 };
  const lineCodonUpdates = new Map<number, CodonInfo[]>();
  const collectProfile = params.collectProfile === true;
  const intronConnectors = params.captureIntronConnectors
    ? ([] as PaintedIntronConnector[])
    : undefined;
  const totalStart = collectProfile ? performance.now() : 0;
  const overviewLod = config.overviewLod === true;
  const visibleAnnotationCount = linePositions.reduce(
    (sum, { line }) => sum + line.annotations.length,
    0
  );
  const measure = (fn: () => void): number => {
    if (!collectProfile) {
      fn();
      return 0;
    }
    const start = performance.now();
    fn();
    return performance.now() - start;
  };
  let annotationsMs = 0;
  let sequenceMs = 0;
  let complementMs = 0;
  const lodLevel = sequenceLodKind(overviewLod, config.lodLevel);
  const densityLod = lodLevel === 'density';
  const detailLod = lodLevel === 'detail';
  const featureLod = lodLevel === 'feature';

  const backgroundStart = collectProfile ? performance.now() : 0;

  if (clearBackground) {
    ctx.fillStyle = getCanvasTheme().bg;
    ctx.fillRect(0, 0, params.canvasWidth, params.canvasHeight);
  }

  if (densityLod) {
    drawDensityLodRows(
      ctx,
      linePositions,
      x,
      config,
      sequenceLength,
      params.canvasWidth,
      paintRowBackground,
      !params.capturePresentationBackground
    );
    if (params.capturePresentationBackground) {
      ctx.capturePresentationBackground?.();
      drawDensityLodRows(ctx, linePositions, x, config, sequenceLength, params.canvasWidth, false);
    }
  } else if (paintRowBackground) {
    drawRowBackgrounds(ctx, linePositions, params.canvasWidth, config.rowBackgroundOffset);
  }

  if (!densityLod && params.capturePresentationBackground) ctx.capturePresentationBackground?.();

  const backgroundMs = collectProfile ? performance.now() - backgroundStart : 0;

  if (densityLod) {
    const totalMs = collectProfile ? performance.now() - totalStart : 0;
    return {
      ...emptyResult,
      profile: collectProfile
        ? {
            totalMs,
            otherMs: totalMs,
            backgroundMs,
            annotationsMs: 0,
            sequenceMs: 0,
            complementMs: 0,
            visibleLineCount: linePositions.length,
            visibleAnnotationCount,
          }
        : undefined,
    };
  }

  ctx.setGeometryLayer?.(null);
  paintSequenceHighlightChrome({
    ctx,
    linePositions,
    originX: x,
    config,
    sequenceLength,
    isCircular: layout.isCircular ?? false,
    detailLod,
    highlightedRange,
    searchHighlights: params.searchHighlights,
    activeSearchIndex: params.activeSearchIndex,
    hoveredCodon,
    viewCursor,
    hoveredCutSite,
  });

  ctx.setGeometryLayer?.('scientific');
  annotationsMs = measure(() => {
    paintSequenceAnnotationBatch({
      ctx,
      showAnnotations: config.showAnnotations,
      lodLevel,
      linePositions,
      originX: x,
      config,
      sequenceLength,
      changedAnnotationNames,
      annotationRenderStateInput,
      aminoAcidTracksVisible:
        (detailLod || Boolean(config.cdsZoomPresentation)) &&
        config.showTranslation &&
        coordinateSpace?.mode !== 'gapped',
      fullSequence,
      intronConnectors,
    });
  });

  const translationStart = collectProfile ? performance.now() : 0;
  const translationBatch = paintSequenceTranslationBatch({
    ctx,
    detailLod: detailLod || (featureLod && Boolean(config.cdsZoomPresentation)),
    showTranslation: config.showTranslation,
    linePositions,
    originX: x,
    config,
    fullSequence,
    insertedRanges,
    deletedRanges,
    coordinateSpace,
    precomputedAlignmentCodons,
    previewCDS,
    annotationRenderStateInput,
    hoveredCodon,
    selectedCodons,
    geneticCode,
    geneticCodeBasis,

    isCircularSequence: layout.summary?.isCircular ?? layout.isCircular === true,
    contentRightX: params.canvasWidth,
    intronConnectors,
  });
  const translationMs = collectProfile ? performance.now() - translationStart : 0;
  for (const [lineIndex, codons] of translationBatch.lineCodonUpdates) {
    lineCodonUpdates.set(lineIndex, codons);
  }

  const orfsDrawn = paintSequenceOrfBatch({
    ctx,
    detailLod,
    featureLod,
    orfs,
    linePositions,
    originX: x,
    config,
    fullSequence,
    sequenceLength,
    coordinateSpace,
    precomputedAlignmentCodons,
    insertedRanges,
    deletedRanges,
    orfRenderStateInput,
  });

  const allCutSitesToHighlight = [...cutSites, ...scannedCutSites];
  if (detailLod) {
    drawRecognitionHighlights(ctx, linePositions, allCutSitesToHighlight, x, config);
  }

  if (primers.length > 0) {
    const scarLabels = goldenGateScarLabels(primers, sequenceLength);
    if (scarLabels.length > 0) {
      drawAllGGScarBackgrounds(ctx, linePositions, scarLabels, x, config, sequenceLength);
    }
  }

  if (detailLod && mutations.length > 0 && coordinateSpace?.alignedQuery) {
    drawDiffSequenceHighlights(ctx, linePositions, mutations, x, config, mutationMap);
  }

  sequenceMs = measure(() => {
    if (detailLod && config.showNucleotideLetters !== false) {
      drawSequenceText(
        ctx,
        linePositions,
        x,
        config,
        deletedRanges,
        insertedRanges,
        params.substitutedRanges
      );
    }
  });

  complementMs = measure(() => {
    if (detailLod && config.showNucleotideLetters !== false) {
      drawComplementText(
        ctx,
        linePositions,
        x,
        config,
        deletedRanges,
        insertedRanges,
        params.substitutedRanges
      );
    }
  });

  if (mutations.length > 0 || coordinateSpace?.alignedQuery) {
    drawMutationTrack(
      ctx,
      linePositions,
      mutations,
      coordinateSpace?.alignedQuery,
      x,
      config,
      mutationMap
    );
  }

  const allDecorations = buildLiveRulerDecorations(rulerDecorations, insertedRanges, deletedRanges);

  const rulerStart = collectProfile ? performance.now() : 0;
  drawRuler(
    ctx,
    linePositions,
    x,
    config,
    sequenceLength,
    rulerSegments,
    coordinateSpace,
    allDecorations.length > 0 ? allDecorations : undefined
  );

  const rulerMs = collectProfile ? performance.now() - rulerStart : 0;

  if (junctionIndicators && junctionIndicators.length > 0) {
    drawJunctionIndicators(ctx, linePositions, x, config, junctionIndicators);
  }

  const {
    renderedPrimers: allRenderedPrimers,
    collectedGGLabels,
    sharedLabelPositions,
  } = paintSequencePrimerBatch({
    ctx,
    primers,
    linePositions,
    originX: x,
    config,
    sequenceLength,
    hoveredGGProductLabel,
    hoveredPrimerId,
    selectedPrimerId,
  });

  if (hoveredGGProductLabel && sequenceLength > 0) {
    drawGGScarHighlights(ctx, linePositions, hoveredGGProductLabel, x, config, sequenceLength);
  }

  ctx.setGeometryLayer?.(null);
  if (highlightedRange) {
    const canvasHeight = params.canvasHeight;
    drawHighlightHandles(
      ctx,
      linePositions,
      highlightedRange,
      x,
      config,
      sequenceLength,
      canvasHeight
    );
  }

  ctx.setGeometryLayer?.('cut-sites');

  const allRenderedSites = paintSequenceCutSites({
    ctx,
    showCutSites,
    lodLevel,
    scannedCutSites,
    cutSites,
    layout,
    config,
    viewport: vp,
    hoveredCutSite,
    linePositions,
    hoveredEnzymeName,
    hoveredPositionInfo,
    primers,
    sharedLabelPositions,
  });

  const hoveredRecognition = hoveredCutSite ?? hoveredPositionInfo;
  if (hoveredRecognition) {
    drawHoveredRecognitionBorder(ctx, linePositions, hoveredRecognition, x, config);
  }

  for (const lp of linePositions) {
    drawOriginIndicator(ctx, lp, x, config);
  }
  ctx.setGeometryLayer?.(null);

  const totalMs = collectProfile ? performance.now() - totalStart : 0;
  const otherMs = collectProfile
    ? Math.max(0, totalMs - annotationsMs - sequenceMs - complementMs)
    : 0;

  return {
    orfsDrawn,
    renderedPrimers: allRenderedPrimers,
    renderedGGLabels: collectedGGLabels,
    renderedCutSites: allRenderedSites,
    renderedCdsExtensionArrows: translationBatch.extensionArrows,
    lineCodonUpdates,
    intronConnectors,
    profile: collectProfile
      ? {
          totalMs,
          otherMs,
          backgroundMs,
          translationMs,
          rulerMs,
          annotationsMs,
          sequenceMs,
          complementMs,
          visibleLineCount: linePositions.length,
          visibleAnnotationCount,
        }
      : undefined,
  };
}

export function renderSequence(
  ctx: SequenceDrawingContext | null,
  params: RenderSequenceParams
): RenderSequenceResult {
  if (
    !ctx ||
    !params.linePositions.some(
      (lp) =>
        lp.line.xOffset ||
        lp.line.trackMorph ||
        lp.line.stripeInsetPx ||
        lp.line.stripeTopOffsetPx ||
        (lp.line.heightScale && lp.line.heightScale !== 1)
    )
  ) {
    return renderSequenceRow(ctx, params);
  }
  ctx.setGeometryLayer?.('paper');
  ctx.fillStyle = getCanvasTheme().bg;
  ctx.fillRect(0, 0, params.canvasWidth, params.canvasHeight);
  const combined: RenderSequenceResult = {
    orfsDrawn: false,
    renderedPrimers: [],
    renderedGGLabels: [],
    renderedCutSites: [],
    renderedCdsExtensionArrows: [],
    lineCodonUpdates: new Map(),
    intronConnectors: params.captureIntronConnectors ? [] : undefined,
  };
  const scrollTop = params.viewport?.scrollTop ?? 0;

  for (const lp of params.linePositions) {
    if (lp.line.stripeInsetPx || lp.line.stripeTopOffsetPx) {
      const theme = getCanvasTheme();
      const isOddRow =
        Math.abs((lp.line.lineIndex + (params.config.rowBackgroundOffset ?? 0)) % 2) === 1;
      const { y: stripeY, height: stripeHeight } = paintedRowBackgroundBounds(lp, scrollTop);
      ctx.fillStyle = isOddRow && !theme.isDark ? theme.bgSubtle : theme.bg;
      ctx.fillRect(0, stripeY, params.canvasWidth, stripeHeight);
      if (isOddRow && theme.isDark) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.035)';
        ctx.fillRect(0, stripeY, params.canvasWidth, stripeHeight);
      }
    } else if (lp.line.xOffset) {
      withRowMorph(ctx, { ...lp.line, xOffset: 0 }, scrollTop, () => {
        if (params.config.overviewLod === true || params.config.lodLevel === 'density') {
          ctx.fillStyle =
            (lp.line.lineIndex + (params.config.rowBackgroundOffset ?? 0)) % 2 === 0
              ? 'rgba(148, 163, 184, 0.08)'
              : 'rgba(148, 163, 184, 0.14)';
          ctx.fillRect(
            0,
            Math.floor(lp.sequenceY),
            params.canvasWidth,
            Math.max(1, Math.ceil(lp.lineEndY - lp.annotationY))
          );
        } else drawRowBackgrounds(ctx, [lp], params.canvasWidth, params.config.rowBackgroundOffset);
      });
    } else {
      withRowMorph(ctx, lp.line, scrollTop, () => {
        if (params.config.overviewLod === true || params.config.lodLevel === 'density')
          drawDensityLodRows(
            ctx,
            [lp],
            params.config.marginLeft,
            params.config,
            params.sequenceLength,
            params.canvasWidth,
            true,
            false
          );
        else drawRowBackgrounds(ctx, [lp], params.canvasWidth, params.config.rowBackgroundOffset);
      });
    }
  }
  if (params.capturePresentationBackground) ctx.capturePresentationBackground?.();
  for (const lp of params.linePositions) {
    let result!: RenderSequenceResult;
    const { top, bottom } = rowPresentationBounds(
      lp.line,
      params.layout.summary,
      scrollTop,
      params.canvasHeight,
      rowPaintBounds(lp.line, lp.lineEndY + scrollTop, ROW_BOTTOM_PADDING).y -
        scrollTop +
        ROW_BOTTOM_PADDING
    );

    const inkSpan =
      params.canvasWidth +
      params.config.charsPerLine * params.config.charWidth +
      Math.abs(lp.line.xOffset ?? 0);
    ctx.save();
    ctx.beginPath();
    ctx.rect(-inkSpan, top, inkSpan * 3, Math.max(0, bottom - top));
    ctx.clip();
    try {
      withRowMorph(ctx, lp.line, scrollTop, () => {
        result = renderSequenceRow(
          ctx,
          { ...params, linePositions: [lp], capturePresentationBackground: false },
          false,
          false
        );
      });
    } finally {
      ctx.restore();
    }
    combined.orfsDrawn = combined.orfsDrawn || result.orfsDrawn === true;
    const paintBounds = <T extends { x?: number; y: number; height: number }>(bounds: T): T => {
      const painted = rowPaintBounds(lp.line, bounds.y + scrollTop, bounds.height);
      return {
        ...bounds,
        ...(typeof bounds.x === 'number' ? { x: bounds.x + (lp.line.xOffset ?? 0) } : {}),
        y: painted.y - scrollTop,
        height: painted.height,
      };
    };
    combined.renderedPrimers.push(
      ...result.renderedPrimers.map(paintBounds).filter((bounds) => bounds.height > 0)
    );
    combined.renderedGGLabels.push(
      ...result.renderedGGLabels
        .map((label) => ({
          ...label,
          labelBounds: paintBounds(label.labelBounds),
        }))
        .filter((label) => label.labelBounds.height > 0)
    );
    combined.renderedCutSites.push(
      ...result.renderedCutSites
        .map((label) => ({
          ...label,
          labelBounds: paintBounds(label.labelBounds),
        }))
        .filter((label) => label.labelBounds.height > 0)
    );
    combined.renderedCdsExtensionArrows.push(
      ...result.renderedCdsExtensionArrows.map(paintBounds).filter((bounds) => bounds.height > 0)
    );
    for (const [index, codons] of result.lineCodonUpdates)
      combined.lineCodonUpdates.set(index, codons);
    for (const stroke of result.intronConnectors ?? []) {
      const y = rowPaintBounds(lp.line, stroke.y + scrollTop, 0).y - scrollTop;
      if (y < top || y > bottom) continue;
      combined.intronConnectors!.push({
        ...stroke,
        x1: stroke.x1 + (lp.line.xOffset ?? 0),
        x2: stroke.x2 + (lp.line.xOffset ?? 0),
        y,
      });
    }
    if (result.profile) {
      if (!combined.profile) combined.profile = { ...result.profile };
      else
        for (const key of Object.keys(result.profile) as (keyof RenderSequenceProfile)[]) {
          const amount = result.profile[key];
          if (amount !== undefined) combined.profile[key] = (combined.profile[key] ?? 0) + amount;
        }
    }
  }
  return combined;
}
