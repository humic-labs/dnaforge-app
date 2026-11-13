import { ANNOTATION_LANE_TOTAL } from '../shared/lane-contracts';
import {
  resolveAnnotationPolicyGpuTrackLaneV1,
  type AnnotationPolicyGpuRuntimeV1,
} from '../overview/annotation-policy-gpu-instances-v1';
import { decodeAnnotationPolicyProjectionFeatureV1 } from '../overview/annotation-policy-projection-v1';
import {
  decodePrepackedAnnotationInteractionFeatureV2,
  findPrepackedAnnotationFeatureByCanonicalIdentityV2,
} from '../overview/prepacked-annotation-interaction-index-v2';
import type { PrepackedAnnotationSceneLoadInput } from '../overview/prepacked-annotation-scene';

export type PrepackedPolicyLaneHost = {
  prepackedAnnotationSceneInput: PrepackedAnnotationSceneLoadInput | null;
  prepackedAnnotationRuntimePolicy: AnnotationPolicyGpuRuntimeV1 | null;
  prepackedCanonicalRendererIdCache: Map<
    string,
    Readonly<{ ownerKey: string; rendererId: number }> | null
  >;
  prepackedAnnotationSceneResidents: Map<
    string,
    {
      ownerKey: string;
      metadata: { trackType: string };
      input: PrepackedAnnotationSceneLoadInput;
    }
  >;
  compiledBroadSurfaceLaneStart(
    trackId: string,
    requestedLayerTypes: readonly string[],
    policy: AnnotationPolicyGpuRuntimeV1
  ): number;
  compiledBroadSurfaceOwnerForTrack(trackId: string): {
    manifest: { laneRowCssHeightPx?: number };
  } | null;
};

export function prepackedPolicyTrackLaneForPrimitive(
  host: PrepackedPolicyLaneHost,
  primitiveIndex: number,
  input: {
    policyGpuInstanceData?: Float32Array | null;
    policyProjection?: PrepackedAnnotationSceneLoadInput['policyProjection'];
    gpuReadyScene?: {
      featureIndices?: ArrayLike<number>;
      packedInstanceData?: ArrayLike<number>;
    } | null;
  } | null = host.prepackedAnnotationSceneInput
): number | null | undefined {
  const data = input?.policyGpuInstanceData;
  const policy = host.prepackedAnnotationRuntimePolicy;
  if (!policy) return undefined;
  if (data) return resolveAnnotationPolicyGpuTrackLaneV1(data, primitiveIndex, policy);
  const projection = input?.policyProjection;
  const scene = input?.gpuReadyScene;
  const featureIndices = scene?.featureIndices;
  if (
    !projection ||
    !featureIndices ||
    !Number.isSafeInteger(primitiveIndex) ||
    primitiveIndex < 0 ||
    primitiveIndex >= featureIndices.length
  ) {
    return undefined;
  }
  const feature = decodeAnnotationPolicyProjectionFeatureV1(
    projection,
    featureIndices[primitiveIndex]
  );
  const trackLane =
    policy.isoformMode === 'canonical' ? feature.canonicalTrackLane : feature.expandedTrackLane;
  const visible = trackLane !== null && (policy.laneLimit === null || trackLane < policy.laneLimit);
  return visible ? trackLane : null;
}

export function prepackedResidentTrackOffsetPx(
  host: PrepackedPolicyLaneHost,
  resident: { metadata: { trackType: string } },
  requestedLayerTypes: readonly string[],
  policy: AnnotationPolicyGpuRuntimeV1
): number {
  const laneStart = host.compiledBroadSurfaceLaneStart(
    resident.metadata.trackType,
    requestedLayerTypes,
    policy
  );
  const laneRowCssHeightPx =
    host.compiledBroadSurfaceOwnerForTrack(resident.metadata.trackType)?.manifest
      .laneRowCssHeightPx ?? ANNOTATION_LANE_TOTAL;
  return -laneStart * laneRowCssHeightPx;
}

export function prepackedRendererIdForCanonicalIdentity(
  host: PrepackedPolicyLaneHost,
  canonicalIdentity: string
): Readonly<{ ownerKey: string; rendererId: number }> | null {
  if (host.prepackedCanonicalRendererIdCache.has(canonicalIdentity)) {
    return host.prepackedCanonicalRendererIdCache.get(canonicalIdentity) ?? null;
  }
  for (const resident of host.prepackedAnnotationSceneResidents.values()) {
    const index = resident.input.interactionIndex;
    if (!index) continue;
    const featureIndex = findPrepackedAnnotationFeatureByCanonicalIdentityV2(
      index,
      canonicalIdentity
    );
    if (featureIndex === null) continue;
    const resolved = Object.freeze({
      ownerKey: resident.ownerKey,
      rendererId: decodePrepackedAnnotationInteractionFeatureV2(index, featureIndex).rendererId,
    });
    host.prepackedCanonicalRendererIdCache.set(canonicalIdentity, resolved);
    return resolved;
  }
  host.prepackedCanonicalRendererIdCache.set(canonicalIdentity, null);
  return null;
}
