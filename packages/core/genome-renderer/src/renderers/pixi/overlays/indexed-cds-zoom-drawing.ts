import type { ImmediateDrawHost } from './indexed-annotation-draw-host';
import {
  buildChevronStripOuterPath,
  crossfadeUnderlayAlpha,
  morphBodyContour,
  retainedTopEdge,
  CODON_CHEVRON_DEPTH_RATIO,
  cdsZoomBandCenterOffset,
  type OutlinePoint,
} from '@waypoint/platform';
import type { Feature, RenderState } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import type { FeaturePrimitiveSink } from '../overview/feature-primitive-sink';
import { hasDraftOutline, isOutlineOnlyFeature } from './annotation-feature-semantics';
import type { OutlineCommand } from './annotation-feature-geometry';

export function drawIndexedCdsZoomGlyph(
  host: ImmediateDrawHost,
  sink: FeaturePrimitiveSink,
  feature: Feature,
  path: PathMapper,
  state: RenderState,
  color: number,
  alpha: number,
  hitPts: number[],
  featureLen: number
): boolean {
  const pose = path.cdsZoomPresentation;
  if (!pose || path.isArcMode || pose.bandProgress <= 0) return false;
  const labelCenter = host.featureOffset(feature);
  const center = labelCenter + cdsZoomBandCenterOffset(pose);
  const endBp = feature.start + featureLen;
  const segments = feature.type === 'CDS' ? feature.segments : feature.cds;
  const ranges = segments?.length
    ? segments
        .map((segment) => ({ start: segment.start - 1, end: segment.end }))
        .sort((a, b) => a.start - b.start)
    : [{ start: feature.start, end: endBp }];
  const outlines: OutlineCommand[] = [];
  const outlineOnly = isOutlineOnlyFeature(feature);
  const underlayAlpha = crossfadeUnderlayAlpha(pose.colorAlpha, 0.6);
  const direction = feature.direction === 'reverse' ? -1 : 1;
  const flatten = (points: OutlinePoint[]) => points.flatMap((point) => [point.x, point.y]);
  for (let index = 1; feature.type === 'CDS' && index < ranges.length; index++) {
    const start = ranges[index - 1].end;
    const end = ranges[index].start;
    if (end <= start || pose.colorAlpha >= 1) continue;
    const connector = path.featurePolygonAt(start, end, center, 0.5);
    sink.fillPoly(connector, color, alpha * 0.5 * (1 - pose.colorAlpha));
    outlines.push({ kind: 'poly', pts: connector });
  }
  for (const range of ranges) {
    if (!path.isFeatureVisible(range.start, range.end - range.start, center, pose.aaHeight / 2))
      continue;
    const left = path.featureLabelPosAt(range.start - 0.5, center);
    const right = path.featureLabelPosAt(range.end - 0.5, center);
    const width = right.x - left.x;
    if (width <= 0) continue;
    const top = left.y - pose.aaHeight / 2;
    const bottom = top + pose.aaHeight;
    const arrow = Math.min(pose.aaHeight * 0.6, width * 0.3, 8);
    const startArrow = feature.direction === 'reverse' && range.start === feature.start;
    const endArrow = feature.direction === 'forward' && range.end === endBp;
    const compact: OutlinePoint[] = [
      { x: left.x + (startArrow ? arrow : 0), y: top },
      { x: right.x - (endArrow ? arrow : 0), y: top },
      { x: right.x, y: left.y },
      { x: right.x - (endArrow ? arrow : 0), y: bottom },
      { x: left.x + (startArrow ? arrow : 0), y: bottom },
      { x: left.x, y: left.y },
    ];
    const target: OutlinePoint[] = [];
    buildChevronStripOuterPath(
      {
        beginPath: () => {
          target.length = 0;
        },
        moveTo: (x, y) => {
          target.push({ x, y });
        },
        lineTo: (x, y) => {
          target.push({ x, y });
        },
        closePath: () => undefined,
      },
      [
        {
          codonX: left.x,
          visibleWidth: width,
          leftEdge: direction === 1 && range.start === ranges[0].start ? 'flat' : 'chevron',
          rightEdge:
            direction === -1 && range.end === ranges[ranges.length - 1].end ? 'flat' : 'chevron',
        },
      ],
      top,
      pose.aaHeight,
      Math.round(pose.aaHeight * CODON_CHEVRON_DEPTH_RATIO),
      direction,
      { left: left.x, right: right.x }
    );
    const body = morphBodyContour(compact, target, pose.bandProgress);
    const bodyPoints = flatten(body);
    outlines.push({ kind: 'poly', pts: bodyPoints });
    if (outlineOnly) sink.strokePoly(bodyPoints, color, alpha);
    else if (underlayAlpha > 0) sink.fillPoly(bodyPoints, color, alpha * underlayAlpha);
    if (pose.topLineHeight > 0) {
      const edge = flatten(retainedTopEdge(body, pose.topLineHeight));
      outlines.push({ kind: 'poly', pts: edge });
      sink.fillPoly(edge, color, alpha);
    }
  }
  host.setFeatureOutline(feature.id, outlines);
  host.drawCDSLabelStrip(
    host.graphics,
    { ...feature, exons: undefined, segments: undefined },
    endBp,
    featureLen,
    color,
    alpha,
    path,
    state,
    pose.bandProgress,
    host.featureLevelLabelCenterBp(feature, featureLen, hitPts, state),
    false,
    null
  );
  if (hasDraftOutline(feature)) {
    host.strokeDraftOutlineCommands(
      host.graphics,
      path,
      host.outlineCache.get(feature.id) ?? [],
      color,
      alpha
    );
  }
  return true;
}
