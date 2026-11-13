import type { Graphics, Text } from 'pixi.js';
import type { Feature, RenderState } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import {
  measurePillLabelTextWidth,
  pillLabelTextStyle,
  targetPillLabelTextResolution,
} from '../shared/label-pill';
import { buildDirectionalPolygon, type OutlineCommand } from './annotation-feature-geometry';
import { isOutlineOnlyFeature, isSplicedFeature } from './annotation-feature-semantics';
import {
  bestVisiblePolygonLabelCandidate,
  truncateForWidth,
  visibleCenterFromPolygon,
} from './annotation-label-geometry';
import type { FeaturePrimitiveSink } from '../overview/feature-primitive-sink';

const MIN_BAR_FOR_LABEL = 30;

export type StandardFeatureDrawHost = {
  featureOffset(feature: Feature): number;
  scaledBarHeight(): number;
  directionalArrowWidth(pixelWidth: number, barHeight: number): number;
  setFeatureOutline(featureId: number, commands: OutlineCommand[]): void;
  overviewLabelAlpha(): number;
  labelCache: Map<number, { text: string; width: number }>;
  acquireLabel(): Text;
  standardFeatureDrawPoints(
    feature: Feature,
    endBp: number,
    pixelWidth: number,
    path: PathMapper,
    hitPts: number[]
  ): number[];
  shouldRenderFeatureText(path: PathMapper): boolean;
  renderCurvedLabel(
    labelText: string,
    centerBp: number,
    textWidth: number,
    feature: Feature,
    endBp: number,
    color: number,
    offset: number,
    path: PathMapper,
    alpha: number,
    rangeStartBp: number,
    rangeEndBp: number,
    textColor?: number
  ): void;
};

export function drawStandard(
  host: StandardFeatureDrawHost,
  sink: FeaturePrimitiveSink,
  feature: Feature,
  endBp: number,
  featureLen: number,
  pixelWidth: number,
  color: number,
  alpha: number,
  path: PathMapper,
  state: RenderState,
  hitPts: number[],
  renderLabel = true,
  labelAlphaScale = 1
): void {
  const offset = host.featureOffset(feature);
  const outlineOnly = isOutlineOnlyFeature(feature);
  const halfHeight = host.scaledBarHeight() / 2;

  if (isSplicedFeature(feature) && feature.segments && feature.segments.length > 1) {
    const segments = feature.segments;
    const dir = feature.direction;
    const drawArrow = dir === 'forward' || dir === 'reverse';
    const arrowExonIdx = dir === 'reverse' ? 0 : segments.length - 1;

    const exonOutlinePolys: number[][] = [];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];

      const segStart = seg.start - 1;
      const segEnd = seg.end;
      const segWidthPx = (segEnd - segStart) * path.pixelsPerBp;

      let exonPts: number[];
      if (drawArrow && i === arrowExonIdx) {
        const aw = host.directionalArrowWidth(segWidthPx, halfHeight * 2);
        if (segWidthPx > aw * 2) {
          const subFeature = { ...feature, start: segStart };
          exonPts = buildDirectionalPolygon(path, subFeature, segEnd, offset, aw, halfHeight);
        } else {
          exonPts = path.featurePolygonAt(segStart, segEnd, offset, halfHeight);
        }
      } else {
        exonPts = path.featurePolygonAt(segStart, segEnd, offset, halfHeight);
      }
      if (outlineOnly) {
        sink.strokePoly(exonPts, color, 0.9 * labelAlphaScale);
      } else {
        sink.fillPoly(exonPts, color, alpha);
      }
      exonOutlinePolys.push(exonPts);

      if (i < segments.length - 1) {
        const nextSeg = segments[i + 1];
        const intronStart = segEnd;
        const intronEnd = nextSeg.start - 1;
        if (intronEnd > intronStart) {
          const connectorHalfHeight = Math.max(0.5, halfHeight * 0.08);
          const linePts = path.featurePolygonAt(
            intronStart,
            intronEnd,
            offset,
            connectorHalfHeight
          );
          sink.fillPoly(linePts, color, alpha * 0.55);
        }
      }
    }
    host.setFeatureOutline(
      feature.id,
      exonOutlinePolys.map((pts) => ({ kind: 'poly' as const, pts }))
    );

    const splicedLabelAlpha = host.overviewLabelAlpha() * labelAlphaScale;
    if (renderLabel && splicedLabelAlpha > 0.01 && feature.displayName) {
      const labelPlacement = bestVisiblePolygonLabelCandidate(
        exonOutlinePolys,
        state.width,
        state.height
      );
      if (labelPlacement && labelPlacement.visibleWidth > MIN_BAR_FOR_LABEL) {
        const labelSegment = segments[labelPlacement.candidateIndex];
        const availW = labelPlacement.visibleWidth - 8;
        const labelText = truncateForWidth(
          feature.displayName,
          availW,
          host.labelCache,
          feature.id
        );
        if (labelText && path.isArcMode) {
          const rangeStartBp = labelSegment.start - 1;
          const rangeEndBp = labelSegment.end;
          const centerBp = rangeStartBp + (rangeEndBp - rangeStartBp) * labelPlacement.fraction;
          host.renderCurvedLabel(
            labelText,
            centerBp,
            measurePillLabelTextWidth(labelText),
            feature,
            rangeEndBp,
            color,
            offset,
            path,
            splicedLabelAlpha,
            rangeStartBp,
            rangeEndBp,
            state.sequencePresentation?.annotationColors?.get(feature.id) ??
              (outlineOnly ? color : undefined)
          );
        } else if (labelText) {
          const textObj = host.acquireLabel();
          textObj.text = labelText;
          const targetStyle = pillLabelTextStyle(
            color,
            undefined,
            state.sequencePresentation?.annotationColors?.get(feature.id) ??
              (outlineOnly ? color : undefined)
          );
          if (textObj.style !== targetStyle) textObj.style = targetStyle;
          textObj.alpha = splicedLabelAlpha;
          const resolution = targetPillLabelTextResolution();
          if (textObj.resolution !== resolution) textObj.resolution = resolution;
          textObj.roundPixels = true;
          textObj.anchor.set(0.5, 0.5);
          textObj.x = labelPlacement.cx;
          textObj.y = labelPlacement.cy;
          textObj.rotation = 0;
          textObj.scale.set(1);
        }
      }
    }
    return;
  }

  const drawPts = host.standardFeatureDrawPoints(feature, endBp, pixelWidth, path, hitPts);
  host.setFeatureOutline(feature.id, [{ kind: 'poly', pts: drawPts }]);
  if (outlineOnly) {
    sink.strokePoly(drawPts, color, 0.9 * labelAlphaScale);
  } else {
    sink.fillPoly(drawPts, color, alpha);
  }

  const labelAlpha = host.overviewLabelAlpha() * labelAlphaScale;
  if (
    renderLabel &&
    host.shouldRenderFeatureText(path) &&
    labelAlpha > 0.01 &&
    pixelWidth > MIN_BAR_FOR_LABEL &&
    feature.displayName
  ) {
    const {
      cx: labelPosX,
      cy: labelPosY,
      visibleWidth: visW,
      fraction,
    } = visibleCenterFromPolygon(hitPts, state.width, state.height);
    const availW = visW - 8;

    const labelText = truncateForWidth(feature.displayName, availW, host.labelCache, feature.id);
    if (labelText) {
      if (path.isArcMode) {
        const centerBp = feature.start + featureLen * fraction;
        const textWidth = measurePillLabelTextWidth(labelText);
        host.renderCurvedLabel(
          labelText,
          centerBp,
          textWidth,
          feature,
          endBp,
          color,
          offset,
          path,
          labelAlpha,
          feature.start,
          endBp,
          state.sequencePresentation?.annotationColors?.get(feature.id) ??
            (outlineOnly ? color : undefined)
        );
        return;
      }

      const textObj = host.acquireLabel();
      textObj.text = labelText;
      const targetStyle = pillLabelTextStyle(
        color,
        undefined,
        state.sequencePresentation?.annotationColors?.get(feature.id) ??
          (outlineOnly ? color : undefined)
      );
      if (textObj.style !== targetStyle) textObj.style = targetStyle;
      textObj.alpha = labelAlpha;
      const resolution = targetPillLabelTextResolution();
      if (textObj.resolution !== resolution) textObj.resolution = resolution;
      textObj.roundPixels = true;
      textObj.anchor.set(0.5, 0.5);
      textObj.x = labelPosX;
      textObj.y = labelPosY;

      const outerCount = hitPts.length / 4;
      const midIdx = Math.floor(outerCount / 2);
      let labelAngle = 0;
      if (midIdx > 0 && midIdx < outerCount) {
        const dx = hitPts[midIdx * 2] - hitPts[(midIdx - 1) * 2];
        const dy = hitPts[midIdx * 2 + 1] - hitPts[(midIdx - 1) * 2 + 1];
        labelAngle = Math.atan2(dy, dx);
      }
      textObj.rotation = labelAngle;
      textObj.scale.set(1);
    }
  }
}

export type FeatureTransitionDrawHost = {
  cdsTransitionHalfHeight(detailProgress: number): number;
  standardFeatureDrawPoints(
    feature: Feature,
    endBp: number,
    pixelWidth: number,
    path: PathMapper,
    hitPts: number[],
    halfHeight: number
  ): number[];
  setFeatureOutline(featureId: number, commands: OutlineCommand[]): void;
  strokeCurrentPath(g: Graphics, path: PathMapper, color: number, alpha: number): void;
};

export function drawFeatureLevelTransitionShape(
  host: FeatureTransitionDrawHost,
  g: Graphics,
  feature: Feature,
  endBp: number,
  pixelWidth: number,
  color: number,
  alpha: number,
  path: PathMapper,
  hitPts: number[],
  detailProgress: number
): void {
  const halfHeight = host.cdsTransitionHalfHeight(detailProgress);
  const drawPts = host.standardFeatureDrawPoints(
    feature,
    endBp,
    pixelWidth,
    path,
    hitPts,
    halfHeight
  );
  const outlineOnly = isOutlineOnlyFeature(feature);
  host.setFeatureOutline(feature.id, [{ kind: 'poly', pts: drawPts }]);
  if (alpha <= 0) return;

  g.poly(drawPts);
  if (outlineOnly) {
    host.strokeCurrentPath(g, path, color, 0.9);
  } else {
    g.fill({ color, alpha });
  }
}
