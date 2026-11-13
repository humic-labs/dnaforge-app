import type { Graphics } from 'pixi.js';
import type { RenderState } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import { ARROW_HEIGHT_RATIO, ARROW_MAX_WIDTH } from '../shared/theme';
import { annotationPolicyLaneCenterOffsetPxV1 } from '../overview/annotation-policy-gpu-instances-v1';
import { unpackBpCoordinate } from '../overview/bp-coordinate-packing';
import { RETAINED_SUBPIXEL_MIN_WIDTH_PX } from '../overview/retained-subpixel-aa';
import { TRANSCRIPT_GLYPH_INSTANCE_LAYOUT } from '../overview/transcript-glyph-instances';
import {
  findPrepackedAnnotationFeatureByRendererIdV2,
  findPrepackedAnnotationFeaturePrimitiveCsrOrdinalV2,
} from '../overview/prepacked-annotation-interaction-index-v2';
import type { PrepackedAnnotationSceneLoadInput } from '../overview/prepacked-annotation-scene';
import { interactionOutlineStyle } from '../shared/interaction-outline';

export type PrepackedInteractionGeometryHost = {
  prepackedPolicyTrackLaneForPrimitive(
    primitiveIndex: number,
    input: PrepackedAnnotationSceneLoadInput | null
  ): number | null | undefined;
  prepackedAnnotationCenterScreenY(path: PathMapper, offsetPx: number): number | null;
};

export function prepackedAnnotationPrimitiveScreenGeometry(
  host: PrepackedInteractionGeometryHost,
  path: PathMapper,
  state: RenderState,
  input: PrepackedAnnotationSceneLoadInput,
  primitiveIndex: number,
  trackOffsetPx: number,
  temporaryAdditionalLane: number | null = null
): { points: number[]; actualWidthPx: number } | null {
  const scene = input.gpuReadyScene;
  if (!scene || !Number.isSafeInteger(primitiveIndex) || primitiveIndex < 0) return null;
  const stride = TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideFloats;
  const base = primitiveIndex * stride;
  if (base + stride > scene.packedInstanceData.length) return null;
  const projectedTrackLane = host.prepackedPolicyTrackLaneForPrimitive(primitiveIndex, input);

  const packed = scene.packedInstanceData;
  const startBp = unpackBpCoordinate(
    packed[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpStartChunk],
    packed[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpStartDelta]
  );
  const endBp = unpackBpCoordinate(
    packed[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpEndChunk],
    packed[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpEndDelta]
  );
  let xMin = path.bpLeftX(startBp);
  let xMax = path.bpLeftX(endBp);
  if (xMax < xMin) {
    const swap = xMin;
    xMin = xMax;
    xMax = swap;
  }
  const actualWidthPx = Math.max(0, xMax - xMin);
  if (actualWidthPx < RETAINED_SUBPIXEL_MIN_WIDTH_PX) {
    const midpoint = (xMin + xMax) / 2;
    xMin = midpoint - RETAINED_SUBPIXEL_MIN_WIDTH_PX / 2;
    xMax = midpoint + RETAINED_SUBPIXEL_MIN_WIDTH_PX / 2;
  }
  if (xMax < 0 || xMin > state.width) return null;

  const focusOffsetCenterPx =
    temporaryAdditionalLane !== null
      ? annotationPolicyLaneCenterOffsetPxV1(temporaryAdditionalLane) - trackOffsetPx
      : typeof projectedTrackLane === 'number'
        ? annotationPolicyLaneCenterOffsetPxV1(projectedTrackLane)
        : projectedTrackLane === null
          ? annotationPolicyLaneCenterOffsetPxV1(0)
          : packed[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.offsetCenter];
  const centerY = host.prepackedAnnotationCenterScreenY(path, focusOffsetCenterPx + trackOffsetPx);
  if (centerY === null) return null;
  const halfHeight = packed[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.halfH];
  const direction = packed[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.dirSign];
  let arrowWidth = 0;
  if (direction !== 0) {
    const candidate = Math.min(
      2 * halfHeight * ARROW_HEIGHT_RATIO,
      actualWidthPx * 0.3,
      ARROW_MAX_WIDTH
    );
    if (actualWidthPx > candidate * 2) arrowWidth = candidate;
  }
  const points =
    direction < 0
      ? [
          xMin + arrowWidth,
          centerY - halfHeight,
          xMax,
          centerY - halfHeight,
          xMax,
          centerY + halfHeight,
          xMin + arrowWidth,
          centerY + halfHeight,
          xMin,
          centerY,
        ]
      : [
          xMin,
          centerY - halfHeight,
          xMax - arrowWidth,
          centerY - halfHeight,
          xMax,
          centerY,
          xMax - arrowWidth,
          centerY + halfHeight,
          xMin,
          centerY + halfHeight,
        ];
  return { points, actualWidthPx };
}

export function strokePrepackedInteractionFeature(
  host: PrepackedInteractionGeometryHost,
  graphics: Graphics,
  path: PathMapper,
  state: RenderState,
  input: PrepackedAnnotationSceneLoadInput | null | undefined,
  rendererId: number,
  forceSelected = false,
  trackOffsetPx = 0
): number {
  const index = input?.interactionIndex;
  const scene = input?.gpuReadyScene;
  const style = forceSelected
    ? {
        width: 2,
        color: state.themeMode === 'dark' ? 0xf8fafc : 0x111827,
        alpha: 0.85,
      }
    : interactionOutlineStyle(state, rendererId);
  if (!index || !scene || !style || !input) return 0;
  const featureIndex = findPrepackedAnnotationFeatureByRendererIdV2(index, rendererId);
  if (featureIndex === null) return 0;

  graphics.setStrokeStyle({
    width: style.width,
    color: style.color,
    alpha: style.alpha,
  });
  const packed = scene.packedInstanceData;
  const stride = TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideFloats;
  let commandCount = 0;
  const csrOrdinal = findPrepackedAnnotationFeaturePrimitiveCsrOrdinalV2(index, featureIndex);
  if (csrOrdinal < 0) return 0;
  const csrStart = index.featurePrimitiveOffsets[csrOrdinal];
  const csrEnd = index.featurePrimitiveOffsets[csrOrdinal + 1];
  for (let cursor = csrStart; cursor < csrEnd; cursor += 1) {
    const primitiveIndex = index.featurePrimitiveIndices[cursor];
    const base = primitiveIndex * stride;
    const projectedTrackLane = host.prepackedPolicyTrackLaneForPrimitive(primitiveIndex, input);
    if (projectedTrackLane === null) continue;
    const startBp = unpackBpCoordinate(
      packed[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpStartChunk],
      packed[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpStartDelta]
    );
    const endBp = unpackBpCoordinate(
      packed[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpEndChunk],
      packed[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpEndDelta]
    );
    let xMin = path.bpLeftX(startBp);
    let xMax = path.bpLeftX(endBp);
    if (xMax < xMin) {
      const swap = xMin;
      xMin = xMax;
      xMax = swap;
    }
    const actualWidth = Math.max(0, xMax - xMin);
    if (actualWidth < RETAINED_SUBPIXEL_MIN_WIDTH_PX) {
      const midpoint = (xMin + xMax) / 2;
      xMin = midpoint - RETAINED_SUBPIXEL_MIN_WIDTH_PX / 2;
      xMax = midpoint + RETAINED_SUBPIXEL_MIN_WIDTH_PX / 2;
    }
    if (xMax < -style.width || xMin > state.width + style.width) continue;

    const centerY = host.prepackedAnnotationCenterScreenY(
      path,
      (typeof projectedTrackLane === 'number'
        ? annotationPolicyLaneCenterOffsetPxV1(projectedTrackLane)
        : packed[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.offsetCenter]) + trackOffsetPx
    );
    if (centerY === null) continue;
    const halfHeight = packed[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.halfH];
    const direction = packed[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.dirSign];
    let arrowWidth = 0;
    if (direction !== 0) {
      const candidate = Math.min(
        2 * halfHeight * ARROW_HEIGHT_RATIO,
        actualWidth * 0.3,
        ARROW_MAX_WIDTH
      );
      if (actualWidth > candidate * 2) arrowWidth = candidate;
    }

    if (direction < 0) {
      graphics.moveTo(xMin + arrowWidth, centerY - halfHeight);
      graphics.lineTo(xMax, centerY - halfHeight);
      graphics.lineTo(xMax, centerY + halfHeight);
      graphics.lineTo(xMin + arrowWidth, centerY + halfHeight);
      graphics.lineTo(xMin, centerY);
      graphics.lineTo(xMin + arrowWidth, centerY - halfHeight);
    } else {
      graphics.moveTo(xMin, centerY - halfHeight);
      graphics.lineTo(xMax - arrowWidth, centerY - halfHeight);
      graphics.lineTo(xMax, centerY);
      graphics.lineTo(xMax - arrowWidth, centerY + halfHeight);
      graphics.lineTo(xMin, centerY + halfHeight);
      graphics.lineTo(xMin, centerY - halfHeight);
    }
    graphics.stroke();
    commandCount += 1;
  }
  return commandCount;
}
