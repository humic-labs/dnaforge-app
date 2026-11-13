import type { Graphics } from 'pixi.js';
import type { Feature, RenderState } from '../../../types';
import { getThemedColor } from './annotation-feature-semantics';
import { isOutlineOnlyFeature, isTranscript } from './annotation-feature-semantics';
import type { PathMapper } from '../shared/path-mapper';
import { ANNOTATION_LANE_TOTAL, getAnnotationLaneEnvelope } from '../shared/lane-contracts';
import { annotationPolicyLaneCenterOffsetPxV1 } from '../overview/annotation-policy-gpu-instances-v1';
import {
  findPrepackedAnnotationFeatureByCanonicalIdentityV2,
  findPrepackedAnnotationFeaturePrimitiveCsrOrdinalV2,
} from '../overview/prepacked-annotation-interaction-index-v2';
import { TRANSCRIPT_GLYPH_INSTANCE_LAYOUT } from '../overview/transcript-glyph-instances';
import { retainedSubpixelAlphaScale } from '../overview/retained-subpixel-aa';
import { buildTranscriptGlyphBlocks } from '../overview/retained-linear-transcript-layer';
import {
  GraphicsPrimitiveSink,
  type FeaturePrimitiveSink,
} from '../overview/feature-primitive-sink';
import type { UnifiedLayout } from '../shared/track-layout';
import type { TrackContract } from '../shared/lane-contracts';
import type { OutlineCommand } from './annotation-feature-geometry';
import type { AnnotationPolicyGpuRuntimeV1 } from '../overview/annotation-policy-gpu-instances-v1';
import type { CompiledBroadSurfaceTrackOwnerV2 } from './indexed-compiled-broad-frame';
import type { PrepackedAnnotationSceneLoadInput } from '../overview/prepacked-annotation-scene';
import { flatAnnotationSearchFocusBlockGeometry } from './indexed-annotation-search-focus-geometry';

const ANNOTATION_SEARCH_FOCUS_DIM_COLOR = 0x6b7280;
const ANNOTATION_SEARCH_FOCUS_DIM_ALPHA = 0.72;

export type SearchFocusTargetResident = {
  metadata: { trackType: string };
  input?: {
    ownerKey?: string;
    interactionIndex?:
      | Parameters<typeof findPrepackedAnnotationFeatureByCanonicalIdentityV2>[0]
      | null;
    viewportDetail?: unknown;
  };
};

export function resolvePrepackedAnnotationSearchFocusTarget(
  host: {
    compiledBroadSurfacePresentingLayerTypes(): string[];
    prepackedAnnotationScenePresentingResidents(): SearchFocusTargetResident[];
    compiledBroadSurfaceInteractionResidentForTrack(
      trackId: string
    ): SearchFocusTargetResident | null;
  },
  focus: NonNullable<RenderState['annotationSearchFocus']>
): Readonly<{
  resident: SearchFocusTargetResident;
  featureIndex: number;
  presentationTrackIds: readonly string[];
}> | null {
  const broadTrackIds = host.compiledBroadSurfacePresentingLayerTypes();
  const vectorResidents = host.prepackedAnnotationScenePresentingResidents();
  const presentationTrackIds =
    broadTrackIds.length > 0
      ? broadTrackIds
      : vectorResidents.map(({ metadata }) => metadata.trackType);
  const broadResident = presentationTrackIds.includes(focus.trackId)
    ? host.compiledBroadSurfaceInteractionResidentForTrack(focus.trackId)
    : null;
  const exactVectorResidents = presentationTrackIds.includes(focus.trackId)
    ? vectorResidents.filter(({ metadata }) => metadata.trackType === focus.trackId)
    : [];
  const resident =
    broadResident?.metadata.trackType === focus.trackId
      ? broadResident
      : exactVectorResidents.length === 1
        ? exactVectorResidents[0]
        : null;
  if (!resident?.input?.interactionIndex) return null;
  const featureIndex = findPrepackedAnnotationFeatureByCanonicalIdentityV2(
    resident.input.interactionIndex,
    focus.canonicalIdentity
  );
  if (featureIndex === null) return null;
  return { resident, featureIndex, presentationTrackIds };
}

export type SearchFocusHost = {
  genomeLength: number;
  annotationSearchFocusGraphics: Graphics;
  annotationSearchFocusMaskDrawCount: number;
  annotationSearchFocusPrimitiveDrawCount: number;
  annotationSearchFocusResolvedTrackId: string | null;
  annotationSearchFocusResolvedCanonicalIdentity: string | null;
  annotationSearchFocusPresentationLane: number | null;
  layout: UnifiedLayout | null;
  contract: TrackContract | null;
  maxAnnotationLane: number;
  maxCdsLane: number;
  prepackedAnnotationRuntimePolicy: AnnotationPolicyGpuRuntimeV1 | null;
  resolvePrepackedAnnotationSearchFocusTarget(
    focus: NonNullable<RenderState['annotationSearchFocus']>
  ): {
    resident: {
      input: PrepackedAnnotationSceneLoadInput;
    };
    featureIndex: number;
    presentationTrackIds: readonly string[];
  } | null;
  compiledBroadSurfaceOwnerForTrack(trackId: string): CompiledBroadSurfaceTrackOwnerV2 | null;
  compiledBroadSurfaceLaneStart(
    trackId: string,
    presentationTrackIds: readonly string[],
    policy: AnnotationPolicyGpuRuntimeV1
  ): number;
  annotationTrackRealizedLaneCapacity(
    trackId: string,
    policy: AnnotationPolicyGpuRuntimeV1,
    singleTrack: boolean
  ): number;
  prepackedAnnotationPolicyFeatureIsDurablyVisible(
    resident: { input: PrepackedAnnotationSceneLoadInput },
    featureIndex: number
  ): boolean;
  prepackedAnnotationCenterScreenY(path: PathMapper, offsetPx: number): number | null;
  scaledBarHeight(): number;
  prepackedResidentTrackOffsetPx(
    resident: { input: PrepackedAnnotationSceneLoadInput },
    presentationTrackIds: readonly string[],
    policy: AnnotationPolicyGpuRuntimeV1
  ): number;
  cdsDetailProgress(): number;
  prepackedAnnotationPrimitiveScreenGeometry(
    path: PathMapper,
    state: RenderState,
    input: PrepackedAnnotationSceneLoadInput,
    primitiveIndex: number,
    trackOffsetPx: number,
    temporaryAdditionalLane: number | null
  ): { points: number[]; actualWidthPx: number } | null;
  featureOffset(feature: Feature): number;
  transcriptGlyphOutlineCommands(feature: Feature, path: PathMapper): OutlineCommand[];
  strokeOutlineCommands(
    graphics: Graphics,
    path: PathMapper,
    commands: OutlineCommand[],
    color: number,
    alpha: number
  ): void;
  standardFeatureDrawPoints(
    feature: Feature,
    endBp: number,
    pixelWidth: number,
    path: PathMapper,
    hitPts: number[]
  ): number[];
};

export type SearchFocusOverlayBindings = Omit<SearchFocusHost, 'layout' | 'contract'> & {
  _layout: UnifiedLayout | null;
  _contract: TrackContract | null;
};

export function createSearchFocusHost(overlay: SearchFocusOverlayBindings): SearchFocusHost {
  return {
    get genomeLength() {
      return overlay.genomeLength;
    },
    get annotationSearchFocusGraphics() {
      return overlay.annotationSearchFocusGraphics;
    },
    get annotationSearchFocusMaskDrawCount() {
      return overlay.annotationSearchFocusMaskDrawCount;
    },
    set annotationSearchFocusMaskDrawCount(value) {
      overlay.annotationSearchFocusMaskDrawCount = value;
    },
    get annotationSearchFocusPrimitiveDrawCount() {
      return overlay.annotationSearchFocusPrimitiveDrawCount;
    },
    set annotationSearchFocusPrimitiveDrawCount(value) {
      overlay.annotationSearchFocusPrimitiveDrawCount = value;
    },
    get annotationSearchFocusResolvedTrackId() {
      return overlay.annotationSearchFocusResolvedTrackId;
    },
    set annotationSearchFocusResolvedTrackId(value) {
      overlay.annotationSearchFocusResolvedTrackId = value;
    },
    get annotationSearchFocusResolvedCanonicalIdentity() {
      return overlay.annotationSearchFocusResolvedCanonicalIdentity;
    },
    set annotationSearchFocusResolvedCanonicalIdentity(value) {
      overlay.annotationSearchFocusResolvedCanonicalIdentity = value;
    },
    get annotationSearchFocusPresentationLane() {
      return overlay.annotationSearchFocusPresentationLane;
    },
    set annotationSearchFocusPresentationLane(value) {
      overlay.annotationSearchFocusPresentationLane = value;
    },
    get layout() {
      return overlay._layout;
    },
    get contract() {
      return overlay._contract;
    },
    get maxAnnotationLane() {
      return overlay.maxAnnotationLane;
    },
    get maxCdsLane() {
      return overlay.maxCdsLane;
    },
    get prepackedAnnotationRuntimePolicy() {
      return overlay.prepackedAnnotationRuntimePolicy;
    },
    resolvePrepackedAnnotationSearchFocusTarget: (focus) =>
      overlay.resolvePrepackedAnnotationSearchFocusTarget(focus),
    compiledBroadSurfaceOwnerForTrack: (trackId) =>
      overlay.compiledBroadSurfaceOwnerForTrack(trackId),
    compiledBroadSurfaceLaneStart: (trackId, presentationTrackIds, policy) =>
      overlay.compiledBroadSurfaceLaneStart(trackId, presentationTrackIds, policy),
    annotationTrackRealizedLaneCapacity: (trackId, policy, singleTrack) =>
      overlay.annotationTrackRealizedLaneCapacity(trackId, policy, singleTrack),
    prepackedAnnotationPolicyFeatureIsDurablyVisible: (resident, featureIndex) =>
      overlay.prepackedAnnotationPolicyFeatureIsDurablyVisible(resident, featureIndex),
    prepackedAnnotationCenterScreenY: (path, offsetPx) =>
      overlay.prepackedAnnotationCenterScreenY(path, offsetPx),
    scaledBarHeight: () => overlay.scaledBarHeight(),
    prepackedResidentTrackOffsetPx: (resident, presentationTrackIds, policy) =>
      overlay.prepackedResidentTrackOffsetPx(resident, presentationTrackIds, policy),
    cdsDetailProgress: () => overlay.cdsDetailProgress(),
    prepackedAnnotationPrimitiveScreenGeometry: (
      path,
      state,
      input,
      primitiveIndex,
      trackOffsetPx,
      temporaryAdditionalLane
    ) =>
      overlay.prepackedAnnotationPrimitiveScreenGeometry(
        path,
        state,
        input,
        primitiveIndex,
        trackOffsetPx,
        temporaryAdditionalLane
      ),
    featureOffset: (feature) => overlay.featureOffset(feature),
    transcriptGlyphOutlineCommands: (feature, path) =>
      overlay.transcriptGlyphOutlineCommands(feature, path),
    strokeOutlineCommands: (graphics, path, commands, color, alpha) =>
      overlay.strokeOutlineCommands(graphics, path, commands, color, alpha),
    standardFeatureDrawPoints: (feature, endBp, pixelWidth, path, hitPts) =>
      overlay.standardFeatureDrawPoints(feature, endBp, pixelWidth, path, hitPts),
  };
}

export function renderAnnotationSearchFocusMask(
  host: SearchFocusHost,
  graphics: Graphics,
  path: PathMapper,
  state: RenderState,
  top: number,
  bottom: number
): void {
  const genomeStartX = path.bpLeftX(0);
  const genomeEndX = path.bpLeftX(host.genomeLength);
  if (!Number.isFinite(genomeStartX) || !Number.isFinite(genomeEndX)) return;
  const left = Math.max(0, Math.min(state.width, genomeStartX, genomeEndX));
  const right = Math.max(0, Math.min(state.width, Math.max(genomeStartX, genomeEndX)));
  if (right <= left || bottom <= top) return;
  graphics.rect(left, top, right - left, bottom - top).fill({
    color: ANNOTATION_SEARCH_FOCUS_DIM_COLOR,
    alpha: ANNOTATION_SEARCH_FOCUS_DIM_ALPHA,
  });
  host.annotationSearchFocusMaskDrawCount = 1;
}

export function renderAnnotationSearchFocus(
  host: SearchFocusHost,
  path: PathMapper,
  state: RenderState
): void {
  const graphics = host.annotationSearchFocusGraphics;
  graphics.clear();
  graphics.visible = false;
  host.annotationSearchFocusMaskDrawCount = 0;
  host.annotationSearchFocusPrimitiveDrawCount = 0;
  host.annotationSearchFocusResolvedTrackId = null;
  host.annotationSearchFocusResolvedCanonicalIdentity = null;
  host.annotationSearchFocusPresentationLane = null;

  const focus = state.annotationSearchFocus;
  if (
    !focus ||
    path.isArcMode ||
    focus.trackId.length === 0 ||
    focus.canonicalIdentity.length === 0 ||
    !host.layout
  ) {
    return;
  }

  const target = host.resolvePrepackedAnnotationSearchFocusTarget(focus);
  if (!target) {
    renderFlatAnnotationSearchFocus(host, path, state);
    return;
  }
  const { resident, featureIndex, presentationTrackIds } = target;

  const interactionIndex = resident.input.interactionIndex;
  const scene = resident.input.gpuReadyScene;
  if (!interactionIndex || !scene) {
    renderFlatAnnotationSearchFocus(host, path, state);
    return;
  }
  const runtimePolicy = host.prepackedAnnotationRuntimePolicy ?? {
    isoformMode: 'canonical' as const,
    laneLimit: Math.max(1, host.maxAnnotationLane + 1),
  };
  const laneRowCssHeightPx =
    host.compiledBroadSurfaceOwnerForTrack(focus.trackId)?.manifest.laneRowCssHeightPx ??
    ANNOTATION_LANE_TOTAL;
  const laneStart = host.compiledBroadSurfaceLaneStart(
    focus.trackId,
    presentationTrackIds,
    runtimePolicy
  );
  const laneCapacity = host.annotationTrackRealizedLaneCapacity(
    focus.trackId,
    runtimePolicy,
    presentationTrackIds.length <= 1
  );
  const temporaryAdditionalLane =
    focus.presentation === 'temporary-additional-lane' &&
    !host.prepackedAnnotationPolicyFeatureIsDurablyVisible(resident, featureIndex)
      ? Math.max(0, host.maxAnnotationLane + 1)
      : null;
  const lane0CenterY = host.prepackedAnnotationCenterScreenY(
    path,
    temporaryAdditionalLane === null
      ? -host.scaledBarHeight() / 2 - laneStart * laneRowCssHeightPx
      : annotationPolicyLaneCenterOffsetPxV1(temporaryAdditionalLane)
  );
  if (lane0CenterY === null) return;

  const slotTop =
    temporaryAdditionalLane === null
      ? lane0CenterY - (laneCapacity - 1) * laneRowCssHeightPx - laneRowCssHeightPx / 2
      : lane0CenterY - laneRowCssHeightPx / 2;
  const slotBottom = lane0CenterY + laneRowCssHeightPx / 2;
  const clippedTop = Math.max(0, slotTop);
  const clippedBottom = Math.min(state.height, slotBottom);
  if (state.width <= 0 || clippedBottom <= clippedTop) return;

  graphics.visible = true;
  host.annotationSearchFocusResolvedTrackId = focus.trackId;
  host.annotationSearchFocusResolvedCanonicalIdentity = focus.canonicalIdentity;
  host.annotationSearchFocusPresentationLane = temporaryAdditionalLane;
  if (focus.presentation !== 'temporary-additional-lane' || temporaryAdditionalLane !== null) {
    renderAnnotationSearchFocusMask(host, graphics, path, state, clippedTop, clippedBottom);
  }

  const trackOffsetPx = host.prepackedResidentTrackOffsetPx(
    resident,
    presentationTrackIds,
    runtimePolicy
  );
  const packed = scene.packedInstanceData;
  const stride = TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideFloats;
  const cdsDetail = host.cdsDetailProgress();
  const csrOrdinal = findPrepackedAnnotationFeaturePrimitiveCsrOrdinalV2(
    interactionIndex,
    featureIndex
  );
  if (csrOrdinal < 0) return;
  const csrStart = interactionIndex.featurePrimitiveOffsets[csrOrdinal];
  const csrEnd = interactionIndex.featurePrimitiveOffsets[csrOrdinal + 1];
  for (let cursor = csrStart; cursor < csrEnd; cursor += 1) {
    const primitiveIndex = interactionIndex.featurePrimitiveIndices[cursor];
    const geometry = host.prepackedAnnotationPrimitiveScreenGeometry(
      path,
      state,
      resident.input,
      primitiveIndex,
      trackOffsetPx,
      temporaryAdditionalLane
    );
    if (!geometry) continue;
    const base = primitiveIndex * stride;
    const red = Math.round(
      Math.max(0, Math.min(1, packed[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.color])) * 255
    );
    const green = Math.round(
      Math.max(0, Math.min(1, packed[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.color + 1])) * 255
    );
    const blue = Math.round(
      Math.max(0, Math.min(1, packed[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.color + 2])) * 255
    );
    const sourceAlpha = Math.max(
      0,
      Math.min(1, packed[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.color + 3])
    );
    const cdsFade = Math.max(
      0,
      Math.min(1, packed[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.cdsFade])
    );
    const alpha =
      sourceAlpha *
      Math.max(0, 1 - cdsFade * cdsDetail) *
      retainedSubpixelAlphaScale(geometry.actualWidthPx);
    if (alpha <= 0) continue;
    graphics.poly(geometry.points).fill({ color: (red << 16) | (green << 8) | blue, alpha });
    host.annotationSearchFocusPrimitiveDrawCount += 1;
  }
}

export function renderFlatAnnotationSearchFocus(
  host: SearchFocusHost,
  path: PathMapper,
  state: RenderState
): void {
  const focus = state.annotationSearchFocus;
  const feature = state.annotationSearchFocusFeature;
  const layout = host.layout;
  const contract = host.contract;
  if (
    !focus ||
    !feature ||
    !layout ||
    !contract ||
    (feature.annotationTrackId ?? feature.type) !== focus.trackId ||
    feature.canonicalIdentity !== focus.canonicalIdentity
  ) {
    return;
  }

  const featureLane = feature.type === 'CDS' ? (feature.cdsLane ?? feature.lane) : feature.lane;
  const localLane = feature.annotationTrackLane ?? 0;
  const laneCapacity = feature.annotationTrackLaneCapacity ?? 1;
  const trackBaseLane = featureLane - localLane;
  const trackLastLane = trackBaseLane + laneCapacity - 1;
  if (
    !Number.isSafeInteger(featureLane) ||
    !Number.isSafeInteger(localLane) ||
    localLane < 0 ||
    !Number.isSafeInteger(laneCapacity) ||
    laneCapacity <= 0 ||
    localLane >= laneCapacity ||
    !Number.isSafeInteger(trackBaseLane) ||
    trackBaseLane < 0 ||
    !Number.isSafeInteger(trackLastLane)
  ) {
    return;
  }
  const firstLane = getAnnotationLaneEnvelope(contract, feature.type, trackBaseLane);
  const lastLane = getAnnotationLaneEnvelope(contract, feature.type, trackLastLane);
  if (!firstLane || !lastLane) return;

  const laneStep = feature.type === 'CDS' ? layout.cdsLaneStep : layout.annotationStep;
  if (!Number.isFinite(laneStep) || laneStep <= 0) return;
  const slotTop =
    path.fwdStrandTop + Math.min(firstLane.centerOffset, lastLane.centerOffset) - laneStep / 2;
  const slotBottom =
    path.fwdStrandTop + Math.max(firstLane.centerOffset, lastLane.centerOffset) + laneStep / 2;
  const clippedTop = Math.max(0, slotTop);
  const clippedBottom = Math.min(state.height, slotBottom);
  if (state.width <= 0 || clippedBottom <= clippedTop) return;

  const graphics = host.annotationSearchFocusGraphics;
  const presentationLane =
    focus.presentation === 'temporary-additional-lane' &&
    (feature.type === 'CDS' ? featureLane > host.maxCdsLane : featureLane > host.maxAnnotationLane)
      ? featureLane
      : null;
  graphics.visible = true;
  host.annotationSearchFocusResolvedTrackId = focus.trackId;
  host.annotationSearchFocusResolvedCanonicalIdentity = focus.canonicalIdentity;
  host.annotationSearchFocusPresentationLane = presentationLane;
  if (focus.presentation !== 'temporary-additional-lane' || presentationLane !== null) {
    renderAnnotationSearchFocusMask(host, graphics, path, state, clippedTop, clippedBottom);
  }

  const offset = host.featureOffset(feature);
  if (isTranscript(feature)) {
    if (isOutlineOnlyFeature(feature)) {
      const commands = host.transcriptGlyphOutlineCommands(feature, path);
      host.strokeOutlineCommands(
        graphics,
        path,
        commands,
        getThemedColor(feature, state.themeMode),
        0.9
      );
      host.annotationSearchFocusPrimitiveDrawCount += commands.length;
      return;
    }
    const cdsDetail = host.cdsDetailProgress();
    const blocks = buildTranscriptGlyphBlocks([feature], {
      getOffset: () => offset,
      halfHeight: host.scaledBarHeight() / 2,
      themeMode: state.themeMode,
      cdsDetail,
    });
    for (const block of blocks) {
      const geometry = flatAnnotationSearchFocusBlockGeometry(path, state, block);
      if (!geometry) continue;
      const alpha =
        block.alpha *
        Math.max(0, 1 - block.cdsFade * cdsDetail) *
        retainedSubpixelAlphaScale(geometry.actualWidthPx);
      if (alpha <= 0) continue;
      graphics.poly(geometry.points).fill({ color: block.color, alpha });
      host.annotationSearchFocusPrimitiveDrawCount += 1;
    }
    return;
  }

  const featureLen =
    feature.end > feature.start
      ? feature.end - feature.start
      : host.genomeLength - feature.start + feature.end;
  if (featureLen <= 0) return;
  const pixelWidth = featureLen * path.pixelsPerBp;
  const endBp = feature.end > feature.start ? feature.end : feature.end + host.genomeLength;
  const hitPts = path.featurePolygonAt(feature.start, endBp, offset, host.scaledBarHeight() / 2);
  const drawPts = host.standardFeatureDrawPoints(feature, endBp, pixelWidth, path, hitPts);
  const sink: FeaturePrimitiveSink = new GraphicsPrimitiveSink(graphics, path);
  const color = getThemedColor(feature, state.themeMode);
  if (isOutlineOnlyFeature(feature)) {
    sink.strokePoly(drawPts, color, 0.9);
  } else {
    sink.fillPoly(drawPts, color, 0.85);
  }
  host.annotationSearchFocusPrimitiveDrawCount = 1;
}
