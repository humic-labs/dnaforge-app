import type { Feature, RenderState } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import type { UnifiedLayout } from '../shared/track-layout';
import {
  ANNOTATION_BAR_HEIGHT,
  ANNOTATION_LANE_TOTAL,
  getAnnotationLaneEnvelope,
  resolveAnnotationTrackContract,
  type TrackContract,
} from '../shared/lane-contracts';
import { ARROW_HEIGHT_RATIO, ARROW_MAX_WIDTH } from '../shared/theme';
import { retainedOverviewAnnotationStyle } from '../overview/retained-overview-style';
import { smoothstep } from './annotation-lod-policy';
import { CDS_GLYPH_STYLE, indexedCdsBodyHeight } from '@waypoint/platform';

export const CDS_LINE_HEIGHT = CDS_GLYPH_STYLE.replacementTopEdgeHeight;
export const RETAINED_TRANSCRIPT_VERTICAL_CULL_MARGIN_PX = ANNOTATION_LANE_TOTAL;

export type AnnotationRenderKeyParts = Record<string, string>;

export type OverlayLayoutHost = {
  _layout: UnifiedLayout | null;
  _contract: TrackContract | null;
  maxAnnotationLane: number;
  maxCdsLane: number;
  lastRenderKeyParts: AnnotationRenderKeyParts | null;
  genomeLength: number;
  hashRetainedLinearTranscriptFeatureKey(featuresToRender: readonly Feature[]): string;
};

export function setOverlayLayout(
  host: OverlayLayoutHost,
  layout: UnifiedLayout,
  effectiveEnvelope: {
    maxAnnotationLane: number;
    maxCdsLane: number;
  }
): void {
  host._layout = layout;
  host._contract = resolveAnnotationTrackContract({
    layout,
    maxAnnotationLane: effectiveEnvelope.maxAnnotationLane,
    maxCdsLane: effectiveEnvelope.maxCdsLane,
  });
}

export function scaledBarHeight(): number {
  return ANNOTATION_BAR_HEIGHT;
}

export function scaledCdsLineHeight(): number {
  return CDS_LINE_HEIGHT;
}

export function scaledArrowMax(): number {
  return ARROW_MAX_WIDTH;
}

export function directionalArrowWidth(pixelWidth: number, barHeight: number): number {
  return Math.min(barHeight * ARROW_HEIGHT_RATIO, pixelWidth * 0.3, scaledArrowMax());
}

export function cdsTransitionHalfHeight(detailProgress: number): number {
  return indexedCdsBodyHeight(detailProgress) / 2;
}

export function featureEnvelope(host: OverlayLayoutHost, feature: Feature) {
  if (!host._contract) return null;
  const laneIndex = feature.type === 'CDS' ? (feature.cdsLane ?? feature.lane ?? 0) : feature.lane;
  return getAnnotationLaneEnvelope(host._contract, feature.type, laneIndex);
}

export function featureOffset(host: OverlayLayoutHost, feature: Feature): number {
  if (host._layout) {
    const contracted = featureEnvelope(host, feature);
    if (!contracted) {
      throw new Error(
        `Annotation lane contract missing ${feature.type} lane ${feature.type === 'CDS' ? (feature.cdsLane ?? feature.lane ?? 0) : feature.lane}`
      );
    }
    return contracted.centerOffset;
  }
  return -14;
}

export function getFeatureRenderOffset(host: OverlayLayoutHost, feature: Feature): number | null {
  if (!host._layout) return null;
  return featureEnvelope(host, feature)?.centerOffset ?? null;
}

export function featurePixelWidth(
  host: OverlayLayoutHost,
  feature: Feature,
  path: PathMapper
): number {
  const featureLen =
    feature.end > feature.start
      ? feature.end - feature.start
      : host.genomeLength - feature.start + feature.end;
  return featureLen * path.pixelsPerBp;
}

export function retainedLinearTranscriptLayoutKey(
  host: OverlayLayoutHost,
  state: RenderState
): string {
  const L = host._layout;
  if (!L) return `no-layout|h:${state.height}`;
  return [
    `h:${state.height}`,
    `ao:${L.annotationOffset}`,
    `as:${L.annotationStep}`,
    `co:${L.cdsBarOffset}`,
    `cs:${L.cdsLaneStep}`,
  ].join('|');
}

export function retainedLinearTranscriptFeatureKey(
  host: OverlayLayoutHost,
  featuresToRender: readonly Feature[]
): string {
  if (featuresToRender.length === 0) return 'empty';
  const g = globalThis as { __webglFeatureKeyMs?: number; __webglFeatureKeyCalls?: number };
  const t0 = performance.now();
  const result = host.hashRetainedLinearTranscriptFeatureKey(featuresToRender);
  g.__webglFeatureKeyMs = (g.__webglFeatureKeyMs ?? 0) + (performance.now() - t0);
  g.__webglFeatureKeyCalls = (g.__webglFeatureKeyCalls ?? 0) + 1;
  return result;
}

export function isRetainedTranscriptLaneVisible(
  host: OverlayLayoutHost,
  feature: Feature,
  path: PathMapper,
  state: RenderState
): boolean {
  if (path.isArcMode) return true;
  const env = featureEnvelope(host, feature);
  if (!env) return false;
  const y = path.featureLabelPosAt(path.viewStartBp, env.centerOffset).y;
  const margin = Math.max(RETAINED_TRANSCRIPT_VERTICAL_CULL_MARGIN_PX, env.halfHeight);
  return y + env.halfHeight + margin >= 0 && y - env.halfHeight - margin <= state.height;
}

export function cdsDetailProgress(host: OverlayLayoutHost): number {
  if (!host._layout) return 1;
  return Math.max(0, Math.min(1, host._layout.sequenceRevealProgress));
}

export function cdsExonLabelAlpha(host: OverlayLayoutHost): number {
  if (!host._layout) return 1;
  if (!host._layout.sequenceVisible) return 0;
  return Math.max(0, Math.min(1, host._layout.sequenceOpacity ?? 1));
}

export function overviewLaneScale(host: OverlayLayoutHost): number {
  return Math.max(
    0,
    Math.min(1, host._layout?.laneGeometryScale ?? host._layout?.overviewLaneScale ?? 1)
  );
}

export function overviewLabelAlpha(host: OverlayLayoutHost): number {
  return smoothstep(0.7, 0.95, overviewLaneScale(host));
}

export function renderKeyParts(
  host: OverlayLayoutHost,
  state: RenderState
): AnnotationRenderKeyParts {
  const revealProgress = host._layout?.sequenceRevealProgress ?? 0;
  const sequenceOpacity = host._layout?.sequenceOpacity ?? 0;
  const overviewLaneScaleValue = host._layout?.overviewLaneScale ?? 1;
  const laneGeometryScale = host._layout?.laneGeometryScale ?? overviewLaneScaleValue;
  return {
    zoom: `${state.zoom}`,
    viewOffset: `${state.viewOffset}`,
    morph: `${state.morph}`,
    width: `${state.width}`,
    height: `${state.height}`,
    geometryHeight: `${state.geometryHeight ?? state.height}`,
    themeMode: state.themeMode ?? 'light',
    sequenceVisible: host._layout?.sequenceVisible ? '1' : '0',
    sequenceRevealProgress: `${revealProgress}`,
    sequenceOpacity: `${sequenceOpacity}`,
    overviewLaneScale: `${overviewLaneScaleValue}`,
    laneGeometryScale: `${laneGeometryScale}`,
    overviewStyle: retainedOverviewAnnotationStyle(),
  };
}

export function renderKeyFromParts(parts: AnnotationRenderKeyParts): string {
  return [
    parts.zoom,
    parts.viewOffset,
    parts.morph,
    parts.width,
    parts.height,
    parts.geometryHeight,
    parts.themeMode,
    parts.sequenceVisible,
    parts.sequenceRevealProgress,
    parts.sequenceOpacity,
    parts.overviewLaneScale,
    parts.laneGeometryScale,
    parts.overviewStyle,
  ].join('|');
}

export function renderKeyChangeReasons(
  host: OverlayLayoutHost,
  next: AnnotationRenderKeyParts
): string[] {
  if (!host.lastRenderKeyParts) return ['initial'];
  const reasons: string[] = [];
  for (const [key, value] of Object.entries(next)) {
    if (host.lastRenderKeyParts[key] !== value) reasons.push(key);
  }
  return reasons;
}

export function prepackedAnnotationTrackBaseOffsetPx(host: OverlayLayoutHost): number | null {
  if (!host._layout) return null;
  return host._layout.annotationOffset + scaledBarHeight() / 2;
}

export function prepackedAnnotationCenterScreenY(
  host: OverlayLayoutHost,
  path: PathMapper,
  localOffsetCenter: number
): number | null {
  const trackBase = prepackedAnnotationTrackBaseOffsetPx(host);
  if (trackBase === null || !Number.isFinite(localOffsetCenter)) return null;
  return path.fwdStrandTop + trackBase + localOffsetCenter;
}
