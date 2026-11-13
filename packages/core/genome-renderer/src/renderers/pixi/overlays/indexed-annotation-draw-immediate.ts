import type { ImmediateDrawHost } from './indexed-annotation-draw-host';
import { annotationMutationBodyColor } from './annotation-mutation-paint';
import type { Feature, RenderState } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import { screenWidthToBp } from '../shared/lane-path';
import { computeBBox, featureHitPayload } from './hit-testing';
import {
  getThemedColor,
  hasDraftOutline,
  isOutlineOnlyFeature,
  isSplicedFeature,
  isTranscript,
} from './annotation-feature-semantics';
import { fullShapeOverviewAlphaScale, MIN_NARROW_FEATURE_PX } from './annotation-lod-policy';
import type { FeaturePrimitiveSink } from '../overview/feature-primitive-sink';
import type { OutlineCommand } from './annotation-feature-geometry';
import type { AnnotationDrawAuditDecision } from './annotation-draw-audit';
import { drawIndexedCdsZoomGlyph } from './indexed-cds-zoom-drawing';

export function shouldSplitLinearWrappedFeature(
  host: ImmediateDrawHost,
  feature: Feature,
  path: PathMapper
): boolean {
  return (
    host.genomeCircular && !path.isArcMode && host.genomeLength > 0 && feature.start > feature.end
  );
}

export function linearWrappedSplicedFeatureSegments(
  host: ImmediateDrawHost,
  feature: Feature
): Feature[] | null {
  if (!isSplicedFeature(feature)) return null;

  const sourceSegments = feature.segments ?? [];
  const pieces: Feature[] = [];
  const splitInclusiveSegment = (segment: { start: number; end: number }) =>
    segment.start <= segment.end
      ? [segment]
      : [
          { start: segment.start, end: host.genomeLength },
          { start: 1, end: segment.end },
        ];

  const pushPiece = (rangeStart0: number, rangeEnd0: number, direction: Feature['direction']) => {
    const rangeStart1 = rangeStart0 + 1;
    const rangeEnd1 = rangeEnd0;
    const clippedSegments = sourceSegments.flatMap((segment) =>
      splitInclusiveSegment(segment)
        .map((part) => ({
          start: Math.max(part.start, rangeStart1),
          end: Math.min(part.end, rangeEnd1),
        }))
        .filter((part) => part.start <= part.end)
    );
    if (clippedSegments.length === 0) return;

    const start = Math.min(...clippedSegments.map((segment) => segment.start)) - 1;
    const end = Math.max(...clippedSegments.map((segment) => segment.end));
    const qualifiers = { ...(feature.qualifiers ?? {}) };
    qualifiers._locationString =
      clippedSegments.length > 1
        ? `join(${clippedSegments.map((segment) => `${segment.start}..${segment.end}`).join(',')})`
        : `${clippedSegments[0].start}..${clippedSegments[0].end}`;

    pieces.push({
      ...feature,
      start,
      end,
      direction,
      segments: clippedSegments,
      qualifiers,
    });
  };

  if (feature.start < host.genomeLength) {
    pushPiece(
      feature.start,
      host.genomeLength,
      feature.direction === 'reverse' ? 'reverse' : 'none'
    );
  }
  if (feature.end > 0) {
    pushPiece(0, feature.end, feature.direction === 'forward' ? 'forward' : 'none');
  }

  return pieces.length > 0 ? pieces : null;
}

export function linearWrappedFeatureSegments(host: ImmediateDrawHost, feature: Feature): Feature[] {
  const splicedSegments = linearWrappedSplicedFeatureSegments(host, feature);
  if (splicedSegments) return splicedSegments;

  const qualifiers = feature.qualifiers ? { ...feature.qualifiers } : undefined;
  if (qualifiers) delete qualifiers._locationString;
  const baseSegment = {
    ...feature,
    segments: undefined,
    qualifiers,
  };
  const segments: Feature[] = [];
  if (feature.start < host.genomeLength) {
    segments.push({
      ...baseSegment,
      end: host.genomeLength,
      direction: feature.direction === 'reverse' ? 'reverse' : 'none',
    });
  }
  if (feature.end > 0) {
    segments.push({
      ...baseSegment,
      start: 0,
      direction: feature.direction === 'forward' ? 'forward' : 'none',
    });
  }
  return segments;
}

export function renderLinearWrappedFeatureSegments(
  host: ImmediateDrawHost,
  sink: FeaturePrimitiveSink,
  feature: Feature,
  path: PathMapper,
  state: RenderState,
  useOverviewAggregation: boolean,
  forceTinyFeatureShapes: boolean,
  alphaScale: number
): AnnotationDrawAuditDecision {
  const outlineCommands: OutlineCommand[] = [];
  let aggregateDecision: AnnotationDrawAuditDecision = 'skipped-empty-visual-range';
  for (const segment of linearWrappedFeatureSegments(host, feature)) {
    const hitStartIndex = host.hitCache.length;
    const segmentDecision = renderImmediateFeature(
      host,
      sink,
      segment,
      path,
      state,
      useOverviewAggregation,
      forceTinyFeatureShapes,
      alphaScale
    );
    if (segmentDecision === 'drawn' || aggregateDecision === 'skipped-empty-visual-range') {
      aggregateDecision = segmentDecision;
    }
    for (let i = hitStartIndex; i < host.hitCache.length; i++) {
      const record = host.hitCache[i];
      if (record.id !== feature.id) continue;
      record.start = feature.start;
      record.end = feature.end;
    }
    const segmentOutline = host.outlineCache.get(feature.id);
    if (segmentOutline) outlineCommands.push(...segmentOutline);
  }
  if (outlineCommands.length > 0) host.outlineCache.set(feature.id, outlineCommands);
  return aggregateDecision;
}

export function renderImmediateFeature(
  host: ImmediateDrawHost,
  sink: FeaturePrimitiveSink,
  feature: Feature,
  path: PathMapper,
  state: RenderState,
  useOverviewAggregation: boolean,
  forceTinyFeatureShapes = false,
  alphaScale = 1
): AnnotationDrawAuditDecision {
  if (shouldSplitLinearWrappedFeature(host, feature, path)) {
    return renderLinearWrappedFeatureSegments(
      host,
      sink,
      feature,
      path,
      state,
      useOverviewAggregation,
      forceTinyFeatureShapes,
      alphaScale
    );
  }

  const featureLen =
    feature.end > feature.start
      ? feature.end - feature.start
      : host.genomeLength - feature.start + feature.end;
  const pixelWidth = featureLen * path.pixelsPerBp;

  if (!forceTinyFeatureShapes && pixelWidth < 0.3) return 'skipped-subpixel';

  const offset = host.featureOffset(feature);
  const halfHeight = host.scaledBarHeight() / 2;

  if (!path.isFeatureVisible(feature.start, featureLen, offset, halfHeight)) {
    return 'skipped-viewport';
  }

  const color =
    annotationMutationBodyColor(feature, state.sequencePresentation) ??
    getThemedColor(feature, state.themeMode);

  const overviewAlphaScale = forceTinyFeatureShapes ? fullShapeOverviewAlphaScale(pixelWidth) : 1;
  const effectiveAlphaScale = Math.max(0, Math.min(1, alphaScale)) * overviewAlphaScale;
  const alpha = 0.85 * effectiveAlphaScale;

  const endBp = feature.end > feature.start ? feature.end : feature.end + host.genomeLength;
  const isSpliced = isSplicedFeature(feature);

  if (
    !isOutlineOnlyFeature(feature) &&
    !isSpliced &&
    useOverviewAggregation &&
    pixelWidth < MIN_NARROW_FEATURE_PX
  ) {
    return 'skipped-overview-aggregated-tiny';
  }
  host.lastDrawnFeatureCount += 1;
  host.lastImmediateDrawnLayerTypes.add(feature.type);
  if (isTranscript(feature)) host.lastImmediateTranscriptDrawnCount += 1;

  if (!isSpliced && pixelWidth < MIN_NARROW_FEATURE_PX) {
    const centerBp = feature.start + featureLen / 2;
    const minLenBp = path.isArcMode
      ? screenWidthToBp(path, centerBp, MIN_NARROW_FEATURE_PX, offset)
      : MIN_NARROW_FEATURE_PX / Math.max(path.pixelsPerBp, 1e-4);
    const visualLenBp = Math.max(featureLen, minLenBp);
    let visualStart = centerBp - visualLenBp / 2;
    let visualEnd = centerBp + visualLenBp / 2;

    if (!host.genomeCircular) {
      if (visualStart < 0) {
        visualEnd -= visualStart;
        visualStart = 0;
      }
      if (visualEnd > host.genomeLength) {
        visualStart -= visualEnd - host.genomeLength;
        visualEnd = host.genomeLength;
      }
      visualStart = Math.max(0, visualStart);
      visualEnd = Math.min(host.genomeLength, visualEnd);
    }
    if (visualEnd <= visualStart) return 'skipped-empty-visual-range';

    const pts = path.featurePolygonAt(visualStart, visualEnd, offset, halfHeight);
    if (isOutlineOnlyFeature(feature)) {
      sink.strokePoly(pts, color, 0.9 * effectiveAlphaScale);
    } else {
      sink.fillPoly(pts, color, alpha);
    }
    const outlineCommands = [{ kind: 'poly' as const, pts }];
    host.setFeatureOutline(feature.id, outlineCommands);
    if (hasDraftOutline(feature)) {
      host.strokeDraftOutlineCommands(
        host.graphics,
        path,
        outlineCommands,
        color,
        0.95 * effectiveAlphaScale
      );
    }
    const bbox = computeBBox(pts);

    host.hitCache.push({
      ...featureHitPayload(feature),
      pts: [],
      xMin: bbox.xMin - 4,
      xMax: bbox.xMax + 4,
      yMin: bbox.yMin - 2,
      yMax: bbox.yMax + 2,
    });
    return 'drawn';
  }

  const hitPts = path.featurePolygonAt(feature.start, endBp, offset, halfHeight);
  const bbox = computeBBox(hitPts);
  host.hitCache.push({
    ...featureHitPayload(feature),
    pts: hitPts,
    ...bbox,
  });

  if (isTranscript(feature)) {
    host.drawTranscriptGlyph(
      sink,
      feature,
      endBp,
      featureLen,
      pixelWidth,
      color,
      alpha,
      path,
      state,
      hitPts,
      effectiveAlphaScale
    );
    if (feature.cds?.length && path.cdsZoomPresentation?.bandProgress) {
      const transcriptOutline = host.outlineCache.get(feature.id) ?? [];
      if (
        drawIndexedCdsZoomGlyph(host, sink, feature, path, state, color, alpha, hitPts, featureLen)
      ) {
        host.setFeatureOutline(feature.id, [
          ...transcriptOutline,
          ...(host.outlineCache.get(feature.id) ?? []),
        ]);
      }
    }
    return 'drawn';
  }

  const isCDS = feature.type === 'CDS';

  if (
    isCDS &&
    drawIndexedCdsZoomGlyph(host, sink, feature, path, state, color, alpha, hitPts, featureLen)
  )
    return 'drawn';

  if (isCDS) {
    const outlineOnly = isOutlineOnlyFeature(feature);
    const detailProgress = host.cdsDetailProgress();
    const featureLabelCenterBp = host.featureLevelLabelCenterBp(feature, featureLen, hitPts, state);
    if (detailProgress <= 0) {
      host.drawStandard(
        sink,
        feature,
        endBp,
        featureLen,
        pixelWidth,
        color,
        alpha * (1 - detailProgress),
        path,
        state,
        hitPts,
        true,
        effectiveAlphaScale
      );
    } else if (detailProgress < 1 && !outlineOnly) {
      host.drawFeatureLevelTransitionShape(
        host.graphics,
        feature,
        endBp,
        pixelWidth,
        color,
        alpha,
        path,
        hitPts,
        detailProgress
      );
    }
    if (detailProgress > 0) {
      host.drawCDSLabelStrip(
        host.graphics,
        feature,
        endBp,
        featureLen,
        color,
        alpha,
        path,
        state,
        detailProgress,
        detailProgress < 1 ? featureLabelCenterBp : null,
        detailProgress >= 1,
        detailProgress < 1 ? host.cdsTransitionHalfHeight(detailProgress) : null
      );
    }
  } else {
    host.drawStandard(
      sink,
      feature,
      endBp,
      featureLen,
      pixelWidth,
      color,
      alpha,
      path,
      state,
      hitPts,
      true,
      effectiveAlphaScale
    );
  }

  if (hasDraftOutline(feature)) {
    const outlineCommands = host.outlineCache.get(feature.id);
    if (outlineCommands) {
      host.strokeDraftOutlineCommands(
        host.graphics,
        path,
        outlineCommands,
        color,
        0.95 * effectiveAlphaScale
      );
    }
  }

  return 'drawn';
}
