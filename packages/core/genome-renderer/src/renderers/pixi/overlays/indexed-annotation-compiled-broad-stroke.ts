import type { Graphics } from 'pixi.js';
import type { RenderState } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import { ARROW_HEIGHT_RATIO, ARROW_MAX_WIDTH } from '../shared/theme';
import { interactionOutlineStyle } from '../shared/interaction-outline';
import { RETAINED_SUBPIXEL_MIN_WIDTH_PX } from '../overview/retained-subpixel-aa';
import {
  decodePrepackedAnnotationInteractionFeatureV2,
  findPrepackedAnnotationFeatureByRendererIdV2,
  type PrepackedAnnotationFeatureLookupIndexV2,
} from '../overview/prepacked-annotation-interaction-index-v2';
import { annotationPolicyLaneCenterOffsetPxV1 } from '../overview/annotation-policy-gpu-instances-v1';
import {
  decodeAnnotationPolicyProjectionFeatureV1,
  type AnnotationPolicyProjectionTableV1,
} from '../overview/annotation-policy-projection-v1';

export type CompiledBroadStrokeResident = {
  featureLookup: PrepackedAnnotationFeatureLookupIndexV2;
  policyProjection?: AnnotationPolicyProjectionTableV1;
  metadata: { annotationBarHeightPx?: number; trackType?: string };
};

export type CompiledBroadStrokeHost = {
  maxAnnotationLane: number;
  prepackedAnnotationRuntimePolicy: {
    isoformMode: 'canonical' | 'expanded';
    laneLimit: number | null;
  } | null;
  prepackedAnnotationCenterScreenY(path: PathMapper, offsetPx: number): number | null;
};

export function strokeCompiledBroadInteractionFeature(
  host: CompiledBroadStrokeHost,
  graphics: Graphics,
  path: PathMapper,
  state: RenderState,
  resident: CompiledBroadStrokeResident,
  rendererId: number,
  forceSelected = false,
  trackOffsetPx = 0
): number {
  const style = forceSelected
    ? {
        width: 2,
        color: state.themeMode === 'dark' ? 0xf8fafc : 0x111827,
        alpha: 0.85,
      }
    : interactionOutlineStyle(state, rendererId);
  if (!style) return 0;
  const featureIndex = findPrepackedAnnotationFeatureByRendererIdV2(
    resident.featureLookup,
    rendererId
  );
  if (
    featureIndex === null ||
    !resident.policyProjection ||
    featureIndex >= resident.policyProjection.featureCount
  ) {
    return 0;
  }
  const feature = decodePrepackedAnnotationInteractionFeatureV2(
    resident.featureLookup,
    featureIndex
  );
  const projected = decodeAnnotationPolicyProjectionFeatureV1(
    resident.policyProjection,
    featureIndex
  );
  const policy = host.prepackedAnnotationRuntimePolicy ?? {
    isoformMode: 'canonical' as const,
    laneLimit: Math.max(1, host.maxAnnotationLane + 1),
  };
  const trackLane =
    policy.isoformMode === 'canonical' ? projected.canonicalTrackLane : projected.expandedTrackLane;
  if (trackLane === null || (policy.laneLimit !== null && trackLane >= policy.laneLimit)) return 0;

  let xMin = path.bpLeftX(feature.startBp);
  let xMax = path.bpLeftX(feature.endBp);
  if (xMax < xMin) [xMin, xMax] = [xMax, xMin];
  const actualWidth = Math.max(0, xMax - xMin);
  if (actualWidth < RETAINED_SUBPIXEL_MIN_WIDTH_PX) {
    const midpoint = (xMin + xMax) / 2;
    xMin = midpoint - RETAINED_SUBPIXEL_MIN_WIDTH_PX / 2;
    xMax = midpoint + RETAINED_SUBPIXEL_MIN_WIDTH_PX / 2;
  }
  if (xMax < -style.width || xMin > state.width + style.width) return 0;
  const centerY = host.prepackedAnnotationCenterScreenY(
    path,
    annotationPolicyLaneCenterOffsetPxV1(trackLane) + trackOffsetPx
  );
  if (centerY === null) return 0;
  const halfHeight = (resident.metadata.annotationBarHeightPx ?? 0) / 2;
  const direction = feature.direction === 'reverse' ? -1 : feature.direction === 'forward' ? 1 : 0;
  let arrowWidth = 0;
  if (direction !== 0) {
    const candidate = Math.min(
      2 * halfHeight * ARROW_HEIGHT_RATIO,
      actualWidth * 0.3,
      ARROW_MAX_WIDTH
    );
    if (actualWidth > candidate * 2) arrowWidth = candidate;
  }
  graphics.setStrokeStyle({ width: style.width, color: style.color, alpha: style.alpha });
  if (direction < 0) {
    graphics.moveTo(xMin + arrowWidth, centerY - halfHeight);
    graphics.lineTo(xMax, centerY - halfHeight);
    graphics.lineTo(xMax, centerY + halfHeight);
    graphics.lineTo(xMin + arrowWidth, centerY + halfHeight);
    graphics.lineTo(xMin, centerY);
    graphics.lineTo(xMin + arrowWidth, centerY - halfHeight);
  } else if (direction > 0) {
    graphics.moveTo(xMin, centerY - halfHeight);
    graphics.lineTo(xMax - arrowWidth, centerY - halfHeight);
    graphics.lineTo(xMax, centerY);
    graphics.lineTo(xMax - arrowWidth, centerY + halfHeight);
    graphics.lineTo(xMin, centerY + halfHeight);
    graphics.lineTo(xMin, centerY - halfHeight);
  } else {
    graphics.roundRect(
      xMin,
      centerY - halfHeight,
      xMax - xMin,
      halfHeight * 2,
      Math.min(3, halfHeight, (xMax - xMin) / 2)
    );
  }
  graphics.stroke();
  return 1;
}
