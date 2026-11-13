import type { OverlayHitResult } from './overlay-track';
import type { Feature } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import {
  computeBBox,
  featureHitPayload,
  hitRecordPayload,
  pointInPolygon,
  transcriptHitTest,
  type HitRecord,
} from './hit-testing';
import { isTranscript } from './annotation-feature-semantics';
import { ANNOTATION_LANE_TOTAL } from '../shared/lane-contracts';
import { unpackBpCoordinate } from '../overview/bp-coordinate-packing';
import { TRANSCRIPT_GLYPH_INSTANCE_LAYOUT } from '../overview/transcript-glyph-instances';
import { RETAINED_SUBPIXEL_MIN_WIDTH_PX } from '../overview/retained-subpixel-aa';
import {
  decodePrepackedAnnotationInteractionFeatureV2,
  findPrepackedAnnotationFeaturePrimitiveCsrOrdinalV2,
  queryPrepackedAnnotationInteractionIndexV2,
  type PrepackedAnnotationFeatureLookupIndexV2,
  type PrepackedAnnotationInteractionIndexV2,
} from '../overview/prepacked-annotation-interaction-index-v2';
import { annotationPolicyLaneCenterOffsetPxV1 } from '../overview/annotation-policy-gpu-instances-v1';
import {
  decodeAnnotationPolicyProjectionFeatureV1,
  type AnnotationPolicyProjectionTableV1,
} from '../overview/annotation-policy-projection-v1';

export const PREPACKED_ANNOTATION_HIT_GRAB_PAD_PX = 3;

export type CompiledBroadHitResident = {
  ownerKey: string;
  featureLookup: PrepackedAnnotationFeatureLookupIndexV2;
  policyProjection: AnnotationPolicyProjectionTableV1;
  metadata: { annotationBarHeightPx: number };
};

export type PrepackedHitResident = {
  ownerKey: string;
  metadata: { trackType: string };
  layer?: { isPresenting: boolean } | null;
  input: {
    interactionIndex?: PrepackedAnnotationInteractionIndexV2 | null;
    gpuReadyScene?: { packedInstanceData: ArrayLike<number> } | null;
  };
};

export type AnnotationHitTestHost = {
  genomeLength: number;
  maxAnnotationLane: number;
  prepackedAnnotationRuntimePolicy: {
    isoformMode: 'canonical' | 'expanded';
    laneLimit: number | null;
  } | null;
  prepackedAnnotationLastHitOwnerKey: string | null;
  prepackedAnnotationSceneResidents: Map<string, PrepackedHitResident>;
  prepackedAnnotationInteractionQueries: number;
  prepackedAnnotationInteractionLastVisitedNodes: number;
  prepackedAnnotationInteractionMaxVisitedNodes: number;
  prepackedAnnotationInteractionLastPrimitiveCandidates: number;
  prepackedAnnotationInteractionMaxMs: number;
  prepackedAnnotationInteractionDurations: Float32Array;
  prepackedAnnotationInteractionDurationCursor: number;
  prepackedAnnotationInteractionDurationCount: number;
  annotationLayerTypesForPresentation(): string[];
  prepackedAnnotationScenePresentingResidents(): PrepackedHitResident[];
  compiledBroadAnnotationInteractionResidentForTrack(
    trackType: string
  ): CompiledBroadHitResident | null;
  compiledBroadSurfaceLaneStart(
    trackType: string,
    presentationLayerTypes: readonly string[],
    policy: { isoformMode: 'canonical' | 'expanded'; laneLimit: number | null }
  ): number;
  compiledBroadSurfaceOwnerForTrack(trackType: string): {
    manifest: { laneRowCssHeightPx: number };
    presenter: { isPresenting: boolean };
  } | null;
  compiledBroadSurfaceInteractionResidentForTrack(trackType: string): PrepackedHitResident | null;
  prepackedAnnotationCenterScreenY(path: PathMapper, offsetPx: number): number | null;
  prepackedResidentTrackOffsetPx(
    resident: PrepackedHitResident,
    presentationLayerTypes: readonly string[],
    policy: { isoformMode: 'canonical' | 'expanded'; laneLimit: number | null }
  ): number;
  prepackedPolicyTrackLaneForPrimitive(
    primitiveIndex: number,
    input: PrepackedHitResident['input']
  ): number | null | undefined;
};

function hitPolicy(host: AnnotationHitTestHost): {
  isoformMode: 'canonical' | 'expanded';
  laneLimit: number | null;
} {
  return (
    host.prepackedAnnotationRuntimePolicy ?? {
      isoformMode: 'canonical',
      laneLimit: Math.max(1, host.maxAnnotationLane + 1),
    }
  );
}

export function recordPrepackedAnnotationInteraction(
  host: AnnotationHitTestHost,
  visitedNodes: number,
  primitiveCandidates: number,
  durationMs: number
): void {
  host.prepackedAnnotationInteractionQueries += 1;
  host.prepackedAnnotationInteractionLastVisitedNodes = visitedNodes;
  host.prepackedAnnotationInteractionMaxVisitedNodes = Math.max(
    host.prepackedAnnotationInteractionMaxVisitedNodes,
    visitedNodes
  );
  host.prepackedAnnotationInteractionLastPrimitiveCandidates = primitiveCandidates;
  host.prepackedAnnotationInteractionMaxMs = Math.max(
    host.prepackedAnnotationInteractionMaxMs,
    durationMs
  );
  host.prepackedAnnotationInteractionDurations[host.prepackedAnnotationInteractionDurationCursor] =
    Math.fround(durationMs);
  host.prepackedAnnotationInteractionDurationCursor =
    (host.prepackedAnnotationInteractionDurationCursor + 1) %
    host.prepackedAnnotationInteractionDurations.length;
  host.prepackedAnnotationInteractionDurationCount = Math.min(
    host.prepackedAnnotationInteractionDurationCount + 1,
    host.prepackedAnnotationInteractionDurations.length
  );
}

export function prepackedAnnotationInteractionP99Ms(host: AnnotationHitTestHost): number {
  const count = host.prepackedAnnotationInteractionDurationCount;
  if (count === 0) return 0;
  const sorted = Array.from(host.prepackedAnnotationInteractionDurations.subarray(0, count)).sort(
    (left, right) => left - right
  );
  return sorted[Math.min(count - 1, Math.ceil(count * 0.99) - 1)] ?? 0;
}

export function hitTestCompiledBroadAnnotationInteraction(
  host: AnnotationHitTestHost,
  screenX: number,
  screenY: number,
  path: PathMapper,
  presentationLayerTypes: readonly string[]
): OverlayHitResult | null {
  if (
    path.isArcMode ||
    !Number.isFinite(screenX) ||
    !Number.isFinite(screenY) ||
    !Number.isFinite(path.pixelsPerBp) ||
    path.pixelsPerBp <= 0
  ) {
    return null;
  }
  const policy = hitPolicy(host);
  const xAtViewStart = path.bpLeftX(path.viewStartBp);
  const pointerBp = path.viewStartBp + (screenX - xAtViewStart) / Math.max(path.pixelsPerBp, 1e-12);
  const queryPadBp =
    (PREPACKED_ANNOTATION_HIT_GRAB_PAD_PX + RETAINED_SUBPIXEL_MIN_WIDTH_PX / 2) / path.pixelsPerBp;
  const queryStartBp = Math.max(0, Math.floor(pointerBp - queryPadBp));
  const queryEndBp = Math.min(host.genomeLength, Math.ceil(pointerBp + queryPadBp) + 1);
  if (queryEndBp <= queryStartBp) return null;

  const orderedTrackTypes = [...presentationLayerTypes].reverse();
  for (const trackType of orderedTrackTypes) {
    const resident = host.compiledBroadAnnotationInteractionResidentForTrack(trackType);
    if (!resident) continue;
    const trackOffsetPx =
      -host.compiledBroadSurfaceLaneStart(trackType, presentationLayerTypes, policy) *
      (host.compiledBroadSurfaceOwnerForTrack(trackType)?.manifest.laneRowCssHeightPx ??
        ANNOTATION_LANE_TOTAL);
    let bestFeatureIndex = -1;
    let bestLane = -1;
    let bestDistanceSquared = Number.POSITIVE_INFINITY;
    let featureCandidates = 0;
    const interactionStartedAt = performance.now();
    const visitedNodes = queryPrepackedAnnotationInteractionIndexV2(
      resident.featureLookup,
      queryStartBp,
      queryEndBp,
      (featureIndex) => {
        featureCandidates += 1;
        if (featureIndex >= resident.policyProjection.featureCount) return;
        const feature = decodePrepackedAnnotationInteractionFeatureV2(
          resident.featureLookup,
          featureIndex
        );
        const projected = decodeAnnotationPolicyProjectionFeatureV1(
          resident.policyProjection,
          featureIndex
        );
        if (projected.annotationType !== trackType) {
          return;
        }
        const trackLane =
          policy.isoformMode === 'canonical'
            ? projected.canonicalTrackLane
            : projected.expandedTrackLane;
        if (trackLane === null || (policy.laneLimit !== null && trackLane >= policy.laneLimit)) {
          return;
        }
        let xMin = path.bpLeftX(feature.startBp);
        let xMax = path.bpLeftX(feature.endBp);
        if (xMax < xMin) [xMin, xMax] = [xMax, xMin];
        if (xMax - xMin < RETAINED_SUBPIXEL_MIN_WIDTH_PX) {
          const midpoint = (xMin + xMax) / 2;
          xMin = midpoint - RETAINED_SUBPIXEL_MIN_WIDTH_PX / 2;
          xMax = midpoint + RETAINED_SUBPIXEL_MIN_WIDTH_PX / 2;
        }
        const centerY = host.prepackedAnnotationCenterScreenY(
          path,
          annotationPolicyLaneCenterOffsetPxV1(trackLane) + trackOffsetPx
        );
        if (centerY === null) return;
        const dx = Math.max(xMin - screenX, 0, screenX - xMax);
        const dy = Math.max(
          Math.abs(screenY - centerY) - resident.metadata.annotationBarHeightPx / 2,
          0
        );
        if (dx > PREPACKED_ANNOTATION_HIT_GRAB_PAD_PX || dy > 1) return;
        const distanceSquared = dx * dx + dy * dy;
        if (
          distanceSquared < bestDistanceSquared ||
          (distanceSquared === bestDistanceSquared && featureIndex > bestFeatureIndex)
        ) {
          bestFeatureIndex = featureIndex;
          bestLane = trackLane;
          bestDistanceSquared = distanceSquared;
        }
      }
    );
    if (bestFeatureIndex < 0) {
      recordPrepackedAnnotationInteraction(
        host,
        visitedNodes,
        featureCandidates,
        performance.now() - interactionStartedAt
      );
      continue;
    }
    const feature = decodePrepackedAnnotationInteractionFeatureV2(
      resident.featureLookup,
      bestFeatureIndex
    );
    host.prepackedAnnotationLastHitOwnerKey = resident.ownerKey;
    recordPrepackedAnnotationInteraction(
      host,
      visitedNodes,
      featureCandidates,
      performance.now() - interactionStartedAt
    );
    return {
      kind: 'feature',
      payload: {
        id: feature.rendererId,
        start: feature.startBp,
        end: feature.endBp,
        canonicalIdentity: feature.canonicalIdentity,
        displayName: feature.displayName,
        type: feature.type,
        transcriptId: feature.transcriptId,
        sourceId: feature.sourceId,
        lane: bestLane,
        direction: feature.direction,
      },
    };
  }
  host.prepackedAnnotationLastHitOwnerKey = null;
  return null;
}

export function hitTestPrepackedAnnotationScene(
  host: AnnotationHitTestHost,
  screenX: number,
  screenY: number,
  path: PathMapper,
  explicitPresentationLayerTypes?: readonly string[]
): OverlayHitResult | null {
  const requestedLayerTypes = host.annotationLayerTypesForPresentation();
  const presentingResidents = host.prepackedAnnotationScenePresentingResidents();
  const presentationLayerTypes = explicitPresentationLayerTypes
    ? [...explicitPresentationLayerTypes]
    : presentingResidents.length > 0
      ? presentingResidents.map(({ metadata }) => metadata.trackType)
      : requestedLayerTypes;
  const residentPool =
    explicitPresentationLayerTypes || presentingResidents.length === 0
      ? [...host.prepackedAnnotationSceneResidents.values()]
      : presentingResidents;
  const residents = residentPool
    .filter((resident) => presentationLayerTypes.includes(resident.metadata.trackType))
    .sort(
      (left, right) =>
        presentationLayerTypes.indexOf(right.metadata.trackType) -
        presentationLayerTypes.indexOf(left.metadata.trackType)
    );
  const policy = hitPolicy(host);
  for (const resident of residents) {
    const hit = hitTestPrepackedAnnotationResident(
      host,
      resident,
      screenX,
      screenY,
      path,
      host.prepackedResidentTrackOffsetPx(resident, presentationLayerTypes, policy)
    );
    if (hit) {
      host.prepackedAnnotationLastHitOwnerKey = resident.ownerKey;
      return hit;
    }
  }
  host.prepackedAnnotationLastHitOwnerKey = null;
  return null;
}

export function hitTestPrepackedAnnotationResident(
  host: AnnotationHitTestHost,
  resident: PrepackedHitResident,
  screenX: number,
  screenY: number,
  path: PathMapper,
  trackOffsetPx: number
): OverlayHitResult | null {
  const layer = resident.layer;
  const input = resident.input;
  const index = input?.interactionIndex;
  const scene = input?.gpuReadyScene;
  const compiledOwner = host.compiledBroadSurfaceOwnerForTrack(resident.metadata.trackType);
  const compiledBroadInteractionOwner =
    compiledOwner?.presenter.isPresenting === true &&
    host.compiledBroadSurfaceInteractionResidentForTrack(resident.metadata.trackType) === resident;
  if (
    (!layer?.isPresenting && !compiledBroadInteractionOwner) ||
    !index ||
    !scene ||
    path.isArcMode ||
    !Number.isFinite(screenX) ||
    !Number.isFinite(screenY) ||
    !Number.isFinite(path.pixelsPerBp) ||
    path.pixelsPerBp <= 0
  ) {
    return null;
  }

  const xAtViewStart = path.bpLeftX(path.viewStartBp);
  const pointerBp = path.viewStartBp + (screenX - xAtViewStart) / Math.max(path.pixelsPerBp, 1e-12);
  const queryPadBp =
    (PREPACKED_ANNOTATION_HIT_GRAB_PAD_PX + RETAINED_SUBPIXEL_MIN_WIDTH_PX / 2) / path.pixelsPerBp;
  const queryStartBp = Math.max(0, Math.floor(pointerBp - queryPadBp));
  const queryEndBp = Math.min(host.genomeLength, Math.ceil(pointerBp + queryPadBp) + 1);
  if (queryEndBp <= queryStartBp) return null;

  const packed = scene.packedInstanceData;
  const stride = TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideFloats;
  let bestFeatureIndex = -1;
  let bestPrimitiveIndex = -1;
  let bestDistanceSquared = Number.POSITIVE_INFINITY;
  let primitiveCandidates = 0;
  const interactionStartedAt = performance.now();
  const visitedNodes = queryPrepackedAnnotationInteractionIndexV2(
    index,
    queryStartBp,
    queryEndBp,
    (featureIndex) => {
      const csrOrdinal = findPrepackedAnnotationFeaturePrimitiveCsrOrdinalV2(index, featureIndex);
      if (csrOrdinal < 0) return;
      const csrStart = index.featurePrimitiveOffsets[csrOrdinal];
      const csrEnd = index.featurePrimitiveOffsets[csrOrdinal + 1];
      for (let cursor = csrStart; cursor < csrEnd; cursor += 1) {
        primitiveCandidates += 1;
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
        const actualWidth = xMax - xMin;
        if (actualWidth < RETAINED_SUBPIXEL_MIN_WIDTH_PX) {
          const midpoint = (xMin + xMax) / 2;
          xMin = midpoint - RETAINED_SUBPIXEL_MIN_WIDTH_PX / 2;
          xMax = midpoint + RETAINED_SUBPIXEL_MIN_WIDTH_PX / 2;
        }
        const centerY = host.prepackedAnnotationCenterScreenY(
          path,
          (typeof projectedTrackLane === 'number'
            ? annotationPolicyLaneCenterOffsetPxV1(projectedTrackLane)
            : packed[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.offsetCenter]) + trackOffsetPx
        );
        if (centerY === null) continue;
        const halfHeight = packed[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.halfH];
        const dx = Math.max(xMin - screenX, 0, screenX - xMax);
        const dy = Math.max(Math.abs(screenY - centerY) - halfHeight, 0);
        if (dx > PREPACKED_ANNOTATION_HIT_GRAB_PAD_PX || dy > 1) {
          continue;
        }
        const distanceSquared = dx * dx + dy * dy;
        if (
          distanceSquared < bestDistanceSquared ||
          (distanceSquared === bestDistanceSquared && primitiveIndex > bestPrimitiveIndex)
        ) {
          bestDistanceSquared = distanceSquared;
          bestFeatureIndex = featureIndex;
          bestPrimitiveIndex = primitiveIndex;
        }
      }
    }
  );
  if (bestFeatureIndex < 0) {
    recordPrepackedAnnotationInteraction(
      host,
      visitedNodes,
      primitiveCandidates,
      performance.now() - interactionStartedAt
    );
    return null;
  }

  const feature = decodePrepackedAnnotationInteractionFeatureV2(index, bestFeatureIndex);
  const projectedTrackLane = host.prepackedPolicyTrackLaneForPrimitive(bestPrimitiveIndex, input);
  const result: OverlayHitResult = {
    kind: 'feature',
    payload: {
      id: feature.rendererId,
      start: feature.startBp,
      end: feature.endBp,
      canonicalIdentity: feature.canonicalIdentity,
      displayName: feature.displayName,
      type: feature.type,
      transcriptId: feature.transcriptId,
      sourceId: feature.sourceId,
      lane: projectedTrackLane ?? feature.lane,
      direction: feature.direction,
    },
  };
  recordPrepackedAnnotationInteraction(
    host,
    visitedNodes,
    primitiveCandidates,
    performance.now() - interactionStartedAt
  );
  return result;
}

export type AnnotationHitDispatchHost = {
  prepackedAnnotationPolicyTransactionInFlight: boolean;
  retainedOverviewMode: string;
  hitCache: HitRecord[];
  compiledBroadSurfacePresentingLayerTypes(): string[];
  hitTestCompiledBroadAnnotationInteraction(
    screenX: number,
    screenY: number,
    path: PathMapper,
    presentationLayerTypes: readonly string[]
  ): OverlayHitResult | null;
  hitTestPrepackedAnnotationScene(
    screenX: number,
    screenY: number,
    path: PathMapper,
    explicitPresentationLayerTypes?: readonly string[]
  ): OverlayHitResult | null;
  hitTestRetainedOverview(
    screenX: number,
    screenY: number,
    path: PathMapper
  ): OverlayHitResult | null;
  hitTestRetainedLinearTranscripts(
    screenX: number,
    screenY: number,
    path: PathMapper
  ): OverlayHitResult | null;
};

export function hitTestAnnotationOverlay(
  host: AnnotationHitDispatchHost,
  screenX: number,
  screenY: number,
  path: PathMapper
): OverlayHitResult | null {
  if (host.prepackedAnnotationPolicyTransactionInFlight) return null;
  const compiledBroadLayerTypes = host.compiledBroadSurfacePresentingLayerTypes();
  if (compiledBroadLayerTypes.length > 0) {
    return (
      host.hitTestCompiledBroadAnnotationInteraction(
        screenX,
        screenY,
        path,
        compiledBroadLayerTypes
      ) ?? host.hitTestPrepackedAnnotationScene(screenX, screenY, path, compiledBroadLayerTypes)
    );
  }
  const prepackedHit = host.hitTestPrepackedAnnotationScene(screenX, screenY, path);
  if (prepackedHit) return prepackedHit;
  if (host.retainedOverviewMode === 'retained') {
    const retainedHit = host.hitTestRetainedOverview(screenX, screenY, path);
    if (retainedHit) return retainedHit;
    const retainedTranscriptHit = host.hitTestRetainedLinearTranscripts(screenX, screenY, path);
    if (retainedTranscriptHit) return retainedTranscriptHit;
  }

  for (let i = host.hitCache.length - 1; i >= 0; i--) {
    const rec = host.hitCache[i];
    if (screenX < rec.xMin || screenX > rec.xMax || screenY < rec.yMin || screenY > rec.yMax)
      continue;
    if (rec.pts.length > 0 && !pointInPolygon(screenX, screenY, rec.pts)) continue;
    return {
      kind: 'feature',
      payload: hitRecordPayload(rec),
    };
  }
  return null;
}

export type RetainedOverviewHitBin = {
  featureId?: number | null;
  featureStart?: number | null;
  featureEnd?: number | null;
  startBp: number;
  endBp: number;
  offset: number;
  halfHeight: number;
};

export function hitTestRetainedOverview(
  host: { retainedOverviewHitBins: readonly RetainedOverviewHitBin[] },
  screenX: number,
  screenY: number,
  path: PathMapper
): OverlayHitResult | null {
  for (let i = host.retainedOverviewHitBins.length - 1; i >= 0; i--) {
    const bin = host.retainedOverviewHitBins[i];
    if (bin.featureId == null || bin.featureStart == null || bin.featureEnd == null) continue;

    const pts = path.featurePolygonAt(bin.startBp, bin.endBp, bin.offset, bin.halfHeight);
    const bbox = computeBBox(pts);
    if (screenX < bbox.xMin || screenX > bbox.xMax || screenY < bbox.yMin || screenY > bbox.yMax)
      continue;
    if (!pointInPolygon(screenX, screenY, pts)) continue;
    return {
      kind: 'feature',
      payload: { id: bin.featureId, start: bin.featureStart, end: bin.featureEnd },
    };
  }
  return null;
}

export type RetainedTranscriptHitHost = {
  retainedLinearTranscriptFeatureSet: Set<Feature> | null;
  scaledBarHeight(): number;
  featuresInRange(viewStartBp: number, viewEndBp: number): Feature[];
  featureOffset(feature: Feature): number;
  transcriptIntronGapRanges(
    feature: Feature,
    path: PathMapper
  ): Array<{ startBp: number; endBp: number }>;
};

export function hitTestRetainedLinearTranscripts(
  host: RetainedTranscriptHitHost,
  screenX: number,
  screenY: number,
  path: PathMapper
): OverlayHitResult | null {
  const retainedSet = host.retainedLinearTranscriptFeatureSet;
  if (!retainedSet || retainedSet.size === 0 || path.isArcMode) return null;

  const halfHeight = host.scaledBarHeight() / 2;
  const visible = host.featuresInRange(path.viewStartBp, path.viewEndBp);

  for (let i = visible.length - 1; i >= 0; i--) {
    const feature = visible[i];
    if (!retainedSet.has(feature) || !isTranscript(feature)) continue;

    let offset: number;
    try {
      offset = host.featureOffset(feature);
    } catch {
      continue;
    }
    const cy = path.featureLabelPosAt(path.viewStartBp, offset).y;
    if (screenY < cy - halfHeight || screenY > cy + halfHeight) continue;

    const exons = (feature.exons ?? []).map((exon) => ({
      x1: path.bpLeftX(exon.start - 1),
      x2: path.bpLeftX(exon.end),
    }));
    const intronGaps: { x1: number; x2: number }[] = [];
    for (const { startBp, endBp } of host.transcriptIntronGapRanges(feature, path)) {
      intronGaps.push({ x1: path.bpLeftX(startBp), x2: path.bpLeftX(endBp) });
    }
    if (transcriptHitTest(screenX, screenY, { cy, halfHeight, exons, intronGaps })) {
      return {
        kind: 'feature',
        payload: featureHitPayload(feature),
      };
    }
  }

  return null;
}
