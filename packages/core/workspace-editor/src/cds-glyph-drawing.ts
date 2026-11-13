import {
  planCdsCompoundLabels,
  crossfadeUnderlayAlpha,
  retainedTopEdge,
  morphBodyContour,
  CDS_GLYPH_STYLE,
  type CdsLabelRegion,
  type CdsCompoundLabel,
  unionOuterContours,
  rectangleContour,
  roundedRectangleContour,
  type OutlinePoint,
} from '@waypoint/platform';
import type { GeneticCodeSpec } from '@waypoint/sequence-utils';
import type { ClassifiedCDS, WorkspaceEditorConfig } from './types';
import type { SequenceDrawingContext } from './rendering/drawing-context';
import {
  computeCodonCells,
  computeCodonEnvelopeCells,
  type CodonCellGeometry,
  type CodonCellRenderData,
} from './codon-rendering';
import type { AnnotationRenderStateInput, AnnotationRenderState } from './annotation-render-state';
import { annotationRenderState, paintAnnotationOutline } from './annotation-render-state';
import { cdsPresentationGeometry } from './cds-presentation';
import { getVisibleRangeSegments } from './utils/range-utils';
import { isSplicedCDS } from './translation';
import { paintCdsCompoundChip } from './cds-chip-drawing';
import { getCanvasTheme } from './canvas-theme';
import { buildChevronStripOuterPath, CHEVRON_WIDTH_RATIO } from './rendering/canvas-primitives';
import {
  resolveAnnotationDraftStyle,
  ANNOTATION_DRAFT_OUTLINE_DASH,
  ANNOTATION_DRAFT_THIN_OUTLINE_WIDTH,
  ANNOTATION_DRAFT_OUTLINE_ALPHA,
} from './annotation-draft-style';
import { TRANSLATION_LABEL_FONT_SIZE } from './layout-constants';
import {
  annotationSegmentArrowFlags,
  annotationSegmentLabelBounds,
  drawAnnotationSegment,
  buildAnnotationSegmentPath,
} from './canvas-drawing';

export type CdsLabelCornerRadii = [number, number, number, number];

export interface CdsGlyphPaintPlan {
  labels: (CdsCompoundLabel & { y: number; radii: CdsLabelCornerRadii })[];
  annotationRenderStateInput?: AnnotationRenderStateInput;
  outline?: { state: AnnotationRenderState; shapes: OutlinePoint[][] };
}

interface CdsBandGeometry {
  body: OutlinePoint[];
  codons: OutlinePoint[];
  topEdge: OutlinePoint[];
}

function planCdsBand(args: {
  compact: OutlinePoint[];
  cells: readonly CodonCellGeometry[];
  left: number;
  right: number;
  y: number;
  height: number;
  depth: number;
  direction: 1 | -1;
  progress: number;
  topEdgeHeight: number;
  shoulders: boolean;
}): CdsBandGeometry {
  const cells = args.cells;
  const codons = cells.length
    ? pathContour((ctx) =>
        buildChevronStripOuterPath(
          ctx,
          cells,
          args.y,
          args.height,
          args.depth,
          args.direction,
          args.shoulders ? { left: args.left, right: args.right } : undefined
        )
      )
    : args.compact;
  const body = morphBodyContour(args.compact, codons, args.progress);
  return {
    body,
    codons,
    topEdge: args.topEdgeHeight > 0 ? retainedTopEdge(body, args.topEdgeHeight) : [],
  };
}

function contourTopEdge(contour: OutlinePoint[]): { left: number; right: number; top: number } {
  let top = Infinity;
  for (const point of contour) top = Math.min(top, point.y);
  let left = Infinity;
  let right = -Infinity;
  for (const point of contour)
    if (point.y <= top + 1e-7) {
      left = Math.min(left, point.x);
      right = Math.max(right, point.x);
    }
  return { left, right, top };
}

class ContourRecorder {
  readonly points: OutlinePoint[] = [];
  beginPath() {
    this.points.length = 0;
  }
  moveTo(x: number, y: number) {
    this.points.push({ x, y });
  }
  lineTo(x: number, y: number) {
    this.points.push({ x, y });
  }
  closePath() {}
}

export function pathContour(
  draw: (ctx: Parameters<typeof buildChevronStripOuterPath>[0]) => void
): OutlinePoint[] {
  const recorder = new ContourRecorder();
  draw(recorder);
  return recorder.points;
}

export function paintCdsGlyph(args: {
  ctx: SequenceDrawingContext;
  cds: ClassifiedCDS;
  config: WorkspaceEditorConfig;
  fullSequence: string;
  lineStart: number;
  lineEnd: number;
  x: number;
  translationY: number;
  annotationY: number;
  color: string;
  chevronDepth: number;
  renderData?: readonly CodonCellRenderData[];
  viewportLeft?: number;
  viewportRight?: number;
  geneticCode?: GeneticCodeSpec;
  annotationRenderStateInput?: AnnotationRenderStateInput;
  codonFillAlpha?: number;
}): CdsGlyphPaintPlan {
  const { ctx, cds, config, fullSequence, lineStart, lineEnd, x, color } = args;
  const n = fullSequence.length;
  const pose = cdsPresentationGeometry(cds, args.translationY, args.annotationY, config);
  let codonCells: readonly CodonCellGeometry[] | undefined = args.renderData;
  const getCodonCells = () => {
    if (codonCells) return codonCells;
    const region = {
      start: cds.start - 1,
      end: cds.end - 1,
      direction: cds.direction === -1 ? (-1 as const) : (1 as const),
      name: cds.name,
      segments: cds.segments,
      qualifiers: cds.qualifiers,
    };
    codonCells =
      computeCodonEnvelopeCells(region, lineStart, lineEnd, x, config.charWidth, n) ??
      computeCodonCells(
        region,
        lineStart,
        lineEnd,
        x,
        config.charWidth,
        fullSequence,
        n,
        { type: 'normal' },
        args.geneticCode
      );
    return codonCells;
  };
  const regions: CdsLabelRegion[] = [];
  const project = (start: number, end: number) => {
    if (lineStart >= 0 && lineEnd <= n && start >= lineStart && end <= lineEnd && end > start) {
      const charIndexStart = start - lineStart;
      return [
        {
          left: x + charIndexStart * config.charWidth,
          right: x + (charIndexStart + end - start) * config.charWidth,
        },
      ];
    }
    const spans: { left: number; right: number }[] = [];
    const append = (start: number, end: number) => {
      for (const part of getVisibleRangeSegments(start, end, lineStart, lineEnd, n))
        spans.push({
          left: x + part.charIndexStart * config.charWidth,
          right: x + (part.charIndexStart + part.end - part.start) * config.charWidth,
        });
    };
    if (end < start) {
      append(start, n);
      append(0, end);
    } else append(start, end);
    if (spans.length < 2) return spans;
    spans.sort((a, b) => a.left - b.left);
    let length = 0;
    for (const span of spans) {
      const previous = spans[length - 1];
      if (previous && span.left <= previous.right + 1e-7)
        previous.right = Math.max(previous.right, span.right);
      else spans[length++] = span;
    }
    spans.length = length;
    return spans;
  };
  const spliced = isSplicedCDS(cds, n);
  if (spliced) {
    const exons = [...cds.segments!].sort(
      (a, b) => ((a.start - cds.start + n) % n) - ((b.start - cds.start + n) % n)
    );
    exons.forEach((exon) => {
      for (const span of project(exon.start - 1, exon.end))
        regions.push({
          left: span.left,
          right: span.right,
          kind: 'exon',
          rangeStart: exon.start - 1,
          rangeEnd: exon.end - 1,
        });
    });
  } else {
    for (const span of project(cds.start - 1, cds.end))
      regions.push({
        left: span.left,
        right: span.right,
        kind: 'cds',
        rangeStart: cds.start - 1,
        rangeEnd: cds.end - 1,
      });
  }

  ctx.save();
  ctx.font = `500 ${TRANSLATION_LABEL_FONT_SIZE}px ${config.labelFontFamily}`;
  const projectLabel = (start: number, end: number) => {
    if (!config.linearWrapPhase) return project(start, end);
    const spans: { left: number; right: number }[] = [];
    const rowEnd = lineEnd < lineStart ? lineEnd + n : lineEnd;
    for (let copy = -1; copy <= 1; copy++) {
      const cycle = copy * n;
      const unwrappedStart = start + cycle;
      const unwrappedEnd = end + (end < start ? n : 0) + cycle;
      if (unwrappedEnd <= lineStart || unwrappedStart >= rowEnd) continue;
      spans.push({
        left: x + (unwrappedStart - lineStart) * config.charWidth,
        right: x + (unwrappedEnd - lineStart) * config.charWidth,
      });
    }
    return spans;
  };
  const completeSpanOnLine =
    !spliced &&
    cds.start <= cds.end &&
    lineStart >= 0 &&
    lineStart <= lineEnd &&
    lineEnd <= n &&
    cds.start - 1 >= lineStart &&
    cds.end <= lineEnd;
  const labelSpans = completeSpanOnLine ? regions : projectLabel(cds.start - 1, cds.end);
  const liftedLabel = !config.cdsZoomPresentation || pose.bandProgress > 0;
  const nameRegions: CdsLabelRegion[] = liftedLabel
    ? labelSpans.map((span) => ({
        left: span.left,
        right: span.right,
        kind: 'cds',
        rangeStart: cds.start - 1,
        rangeEnd: cds.end - 1,
      }))
    : [];
  const viewportLeft = args.viewportLeft ?? x;
  const viewportRight = args.viewportRight ?? x + config.charsPerLine * config.charWidth;
  const compactLabelRegion =
    regions.length === 1
      ? regions[0]
      : regions.reduce<CdsLabelRegion | undefined>(
          (best, region) =>
            !best || region.right - region.left > best.right - best.left ? region : best,
          undefined
        );
  let compactLabelBounds: ReturnType<typeof annotationSegmentLabelBounds> | undefined;
  if (config.cdsZoomPresentation && pose.bandProgress < 1 && compactLabelRegion) {
    const region = compactLabelRegion;
    const width = region.right - region.left;
    const visibleStart = Math.round((lineStart + (region.left - x) / config.charWidth) % n);
    const visibleEnd = visibleStart + Math.round(width / config.charWidth);
    const flags = annotationSegmentArrowFlags({
      isStartOfAnnotation: visibleStart === cds.start - 1,
      isEndOfAnnotation: visibleEnd % n === cds.end % n,
      direction: cds.direction,
      barWidth: width,
      annotationHeight: pose.barHeight,
      suppressStartTear: visibleStart === region.rangeStart,
      suppressEndTear: visibleEnd % n === (region.rangeEnd + 1) % n,
    });
    const span = config.linearWrapPhase
      ? ((spliced ? projectLabel(region.rangeStart, region.rangeEnd + 1) : labelSpans).find(
          (span) => span.left < region.right && span.right > region.left
        ) ?? region)
      : region;
    const left = Math.max(viewportLeft, span.left);
    const right = Math.min(viewportRight, span.right);
    compactLabelBounds = annotationSegmentLabelBounds(left, right - left, flags);
  }
  const groups = liftedLabel
    ? planCdsCompoundLabels(
        nameRegions,
        cds._compactName ?? cds.name,
        (text) => ctx.measureText(text).width,
        viewportLeft,
        viewportRight
      )
    : [];
  if (compactLabelBounds && compactLabelBounds.availableWidth > 0) {
    for (const group of groups) {
      const shift =
        (compactLabelBounds.centerX - (group.left + group.right) / 2) * (1 - pose.bandProgress);
      group.left += shift;
      group.right += shift;
      for (const part of group.parts) part.x += shift;
    }
  }
  const labels = groups.map((group) => ({
    ...group,
    y: pose.labelY,
    radii: [
      CDS_GLYPH_STYLE.radius,
      CDS_GLYPH_STYLE.radius,
      CDS_GLYPH_STYLE.radius,
      CDS_GLYPH_STYLE.radius,
    ] as CdsLabelCornerRadii,
  }));
  const bandTops: { left: number; right: number; top: number }[] = [];
  const draft = resolveAnnotationDraftStyle(cds);
  const state = draft.suppressInteractionOutline
    ? 'default'
    : annotationRenderState(cds, args.annotationRenderStateInput);
  const outlineShapes: OutlinePoint[][] | undefined = state === 'default' ? undefined : [];
  const bodyOpacity = config.cdsZoomPresentation
    ? crossfadeUnderlayAlpha(pose.colorAlpha, args.codonFillAlpha ?? 0)
    : 1;
  const topEdgeHeight = config.cdsZoomPresentation?.topLineHeight ?? 0;
  const compactPathOnly =
    !!config.cdsZoomPresentation &&
    pose.bandProgress === 0 &&
    topEdgeHeight === 0 &&
    !outlineShapes;
  for (const region of regions) {
    if (region.kind === 'intron') continue;
    const left = region.left;
    const width = region.right - region.left;
    const charIndexStart = (left - x) / config.charWidth;
    const visibleStart = Math.round((lineStart + charIndexStart) % n);
    const visibleEnd = visibleStart + Math.round(width / config.charWidth);
    const startIsFeature = visibleStart === cds.start - 1;
    const endIsFeature = visibleEnd % n === cds.end % n;
    const suppressStartTear = visibleStart === region.rangeStart;
    const suppressEndTear = visibleEnd % n === (region.rangeEnd + 1) % n;
    const flags = annotationSegmentArrowFlags({
      isStartOfAnnotation: startIsFeature,
      isEndOfAnnotation: endIsFeature,
      direction: cds.direction,
      barWidth: width,
      annotationHeight: pose.barHeight,
      suppressStartTear,
      suppressEndTear,
    });

    let band: CdsBandGeometry | undefined;
    if (!compactPathOnly) {
      const compact = config.cdsZoomPresentation
        ? pathContour((c) =>
            buildAnnotationSegmentPath(c, left, pose.barY, width, pose.barHeight, flags)
          )
        : rectangleContour(left, pose.barY, width, pose.barHeight);
      const cells =
        pose.bandProgress > 0 || (outlineShapes && !config.cdsZoomPresentation)
          ? regions.length === 1
            ? getCodonCells()
            : getCodonCells().filter(
                (cell) =>
                  cell.codonX < region.right - 1e-7 && cell.codonX + cell.visibleWidth > left + 1e-7
              )
          : [];
      band = planCdsBand({
        compact,
        cells,
        left,
        right: region.right,
        y: pose.aaY,
        height: pose.aaHeight,
        depth: config.cdsZoomPresentation
          ? Math.round(pose.aaHeight * CHEVRON_WIDTH_RATIO)
          : args.chevronDepth,
        direction: cds.direction === -1 ? -1 : 1,
        progress: config.cdsZoomPresentation ? pose.bandProgress : 0,
        topEdgeHeight,
        shoulders: bodyOpacity > 0,
      });
    }
    if (band) bandTops.push(contourTopEdge(topEdgeHeight > 0 ? band.topEdge : band.body));
    if (band && topEdgeHeight > 0) {
      const edge = band.topEdge;
      let edgeLeft = Infinity;
      let edgeRight = -Infinity;
      for (const point of edge) {
        edgeLeft = Math.min(edgeLeft, point.x);
        edgeRight = Math.max(edgeRight, point.x);
      }
      outlineShapes?.push(edge);
      ctx.fillStyle = color;
      ctx.globalAlpha = draft.fillAlpha * draft.connectorAlphaMultiplier;
      ctx.beginPath();
      edge.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.closePath();
      ctx.fill();
      cds._cdsLineBounds!.push({
        x: edgeLeft,
        w: edgeRight - edgeLeft,
        y: pose.aaY - topEdgeHeight,
        h: topEdgeHeight,
      });
      ctx.globalAlpha = 1;
    }
    if (band) {
      outlineShapes?.push(band.body);
      if (!config.cdsZoomPresentation) outlineShapes?.push(band.codons);
    }
    if (bodyOpacity === 0) continue;
    if (config.cdsZoomPresentation && pose.progress < 1) {
      drawAnnotationSegment(
        ctx,
        cds,
        visibleStart,
        visibleEnd,
        lineStart,
        x,
        pose.barY,
        config,
        pose.barHeight,
        0,
        !liftedLabel && region === compactLabelRegion,
        startIsFeature,
        endIsFeature,
        charIndexStart,
        false,
        'default',
        true,
        {
          lane: 0,
          labelText: cds._compactName ?? cds.name,
          colorOverride: color,
          surfaceOpacity: bodyOpacity,
          contour: band?.body,
          traceContour: band
            ? undefined
            : (context) =>
                buildAnnotationSegmentPath(context, left, pose.barY, width, pose.barHeight, flags),
          colorIsAdapted: true,
          suppressStartTear,
          suppressEndTear,
          labelBounds: region === compactLabelRegion ? compactLabelBounds : undefined,
        }
      );
      continue;
    }
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    if (draft.isHollow) {
      ctx.lineWidth = 1.5;
      ctx.strokeRect(left, pose.barY, width, pose.barHeight);
    } else {
      ctx.globalAlpha = draft.fillAlpha;
      ctx.fillRect(left, pose.barY, width, pose.barHeight);
      ctx.globalAlpha = 1;
    }
    if (draft.hasDottedOutline) {
      ctx.save();
      ctx.setLineDash([...ANNOTATION_DRAFT_OUTLINE_DASH]);
      ctx.strokeStyle = color;
      ctx.lineWidth = ANNOTATION_DRAFT_THIN_OUTLINE_WIDTH;
      ctx.globalAlpha = ANNOTATION_DRAFT_OUTLINE_ALPHA;
      ctx.strokeRect(left, pose.barY, width, pose.barHeight);
      ctx.restore();
    }
  }
  for (const label of labels) {
    const bottom = label.y + CDS_GLYPH_STYLE.labelHeight;
    const seated = (x: number) =>
      bandTops.some((top) => top.top <= bottom + 0.5 && top.left <= x && top.right >= x);
    if (seated(label.left + CDS_GLYPH_STYLE.radius)) label.radii[3] = 0;
    if (seated(label.right - CDS_GLYPH_STYLE.radius)) label.radii[2] = 0;
  }
  if (outlineShapes) {
    for (const label of labels)
      outlineShapes.push(
        roundedRectangleContour(
          label.left,
          label.y,
          label.right - label.left,
          CDS_GLYPH_STYLE.labelHeight,
          label.radii
        )
      );
  }
  cds._paintedPresentation = Object.assign(pose, {
    color,
    barAlpha: draft.fillAlpha * bodyOpacity,
    detailStyle: config.cdsZoomPresentation
      ? ('replacement-band' as const)
      : ('indexed-bands' as const),
  });
  for (const label of labels) {
    for (const part of label.parts) {
      if (part.width <= 0) continue;
      const bounds = { x: part.x, w: part.width, y: label.y, h: CDS_GLYPH_STYLE.labelHeight };
      cds._cdsPillBounds!.push(bounds);
    }
  }
  ctx.restore();
  return {
    labels,
    annotationRenderStateInput: args.annotationRenderStateInput,
    outline: outlineShapes ? { state, shapes: outlineShapes } : undefined,
  };
}

export function paintCdsGlyphLabels(
  ctx: SequenceDrawingContext,
  plan: CdsGlyphPaintPlan,
  cds: ClassifiedCDS,
  color: string,
  fontFamily: string
): void {
  for (const label of plan.labels)
    paintCdsCompoundChip(
      ctx,
      label.parts,
      label.y,
      cds,
      color,
      fontFamily,
      plan.annotationRenderStateInput,
      1,
      true,
      label.radii
    );
}

export function strokeCdsOutline(
  ctx: SequenceDrawingContext,
  state: AnnotationRenderState,
  shapes: readonly OutlinePoint[][]
): OutlinePoint[][] {
  const color = getCanvasTheme().isDark ? 'rgba(160, 160, 160, 0.95)' : 'rgba(90, 90, 90, 0.95)';
  const contours = unionOuterContours(shapes);
  for (const contour of contours)
    paintAnnotationOutline(ctx, state, color, (c) => {
      c.beginPath();
      contour.forEach((point, i) =>
        i === 0 ? c.moveTo(point.x, point.y) : c.lineTo(point.x, point.y)
      );
      c.closePath();
      c.stroke();
    });
  return contours;
}

export function paintCdsGlyphOutline(
  ctx: SequenceDrawingContext,
  plan: CdsGlyphPaintPlan,
  cds: ClassifiedCDS
): void {
  if (!plan.outline) return;
  cds._interactionOutlineContours = strokeCdsOutline(ctx, plan.outline.state, plan.outline.shapes);
}

export function paintCdsBarColors(args: {
  ctx: SequenceDrawingContext;
  renderData: readonly CodonCellRenderData[];
  y: number;
  height: number;
  plan: CdsGlyphPaintPlan;
  color: string;
  alpha: number;
  overallAlpha: number;
  colorFor: (rd: CodonCellRenderData) => { fill: string; alpha: number } | null;
}): void {
  const { ctx } = args;
  ctx.save();
  for (const rd of args.renderData) {
    let rects = [
      {
        left: rd.codonX,
        right: rd.codonX + rd.visibleWidth,
        top: args.y,
        bottom: args.y + args.height,
      },
    ];
    for (const label of args.plan.labels) {
      const cut = {
        left: label.left,
        right: label.right,
        top: label.y,
        bottom: label.y + CDS_GLYPH_STYLE.labelHeight,
      };
      rects = rects.flatMap((rect) => {
        const left = Math.max(rect.left, cut.left),
          right = Math.min(rect.right, cut.right);
        const top = Math.max(rect.top, cut.top),
          bottom = Math.min(rect.bottom, cut.bottom);
        if (left >= right || top >= bottom) return [rect];
        return [
          { ...rect, bottom: top },
          { ...rect, top: bottom },
          { left: rect.left, right: left, top, bottom },
          { left: right, right: rect.right, top, bottom },
        ].filter((r) => r.right - r.left > 1e-7 && r.bottom - r.top > 1e-7);
      });
    }
    const color = args.colorFor(rd);
    ctx.fillStyle = color?.fill ?? args.color;
    ctx.globalAlpha = (color?.alpha ?? args.alpha) * args.overallAlpha;
    for (const rect of rects)
      ctx.fillRect(rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top);
  }
  ctx.restore();
}
