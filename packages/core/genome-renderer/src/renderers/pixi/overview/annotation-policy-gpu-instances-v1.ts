import {
  decodeAnnotationPolicyProjectionFeatureV1,
  type AnnotationPolicyIsoformModeV1,
  type AnnotationPolicyProjectionTableV1,
} from './annotation-policy-projection-v1';
import { ANNOTATION_BAR_HEIGHT } from '../shared/theme';
import { TRANSCRIPT_PAGE_LANE_STEP_PX } from './compile-transcript-page-bundle';

const PREPACKED_ANNOTATION_BAR_HEIGHT_PX = ANNOTATION_BAR_HEIGHT;
const PREPACKED_ANNOTATION_LANE_STEP_PX = TRANSCRIPT_PAGE_LANE_STEP_PX;

export const ANNOTATION_POLICY_GPU_INSTANCES_V1 = 'annotation-policy-gpu-instances.v1' as const;
export const ANNOTATION_POLICY_GPU_ABSENT_LANE = -1;
export const ANNOTATION_POLICY_GPU_MAX_EXACT_LANE = 16_777_216;

export const ANNOTATION_POLICY_GPU_INSTANCE_LAYOUT = {
  expandedLane: 0,
  expandedTrackLane: 1,
  canonicalLane: 2,
  canonicalTrackLane: 3,
  strideFloats: 4,
  strideBytes: 4 * Float32Array.BYTES_PER_ELEMENT,
} as const;

export interface AnnotationPolicyGpuRuntimeV1 {
  isoformMode: AnnotationPolicyIsoformModeV1;
  laneLimit: number | null;
}

export interface ResolvedAnnotationPolicyGpuInstanceV1 {
  visible: boolean;
  lane: number | null;
  trackLane: number | null;
  offsetCenterPx: number | null;
}

export interface AnnotationPolicyGpuTrackLaneMaximaV1 {
  readonly expanded: number;
  readonly canonical: number;
}

export function buildAnnotationPolicyGpuInstanceDataV1(
  primitiveFeatureIndices: Uint32Array,
  policy: AnnotationPolicyProjectionTableV1
): Float32Array {
  const data = new Float32Array(
    primitiveFeatureIndices.length * ANNOTATION_POLICY_GPU_INSTANCE_LAYOUT.strideFloats
  );
  for (let primitiveIndex = 0; primitiveIndex < primitiveFeatureIndices.length; primitiveIndex++) {
    const featureIndex = primitiveFeatureIndices[primitiveIndex];
    if (featureIndex >= policy.featureCount) {
      throw new Error(`annotation policy GPU primitive ${primitiveIndex} owner is invalid`);
    }
    const feature = decodeAnnotationPolicyProjectionFeatureV1(policy, featureIndex);
    validateGpuLane(feature.expandedLane, primitiveIndex, 'expandedLane');
    validateGpuLane(feature.expandedTrackLane, primitiveIndex, 'expandedTrackLane');
    if (feature.canonicalLane !== null) {
      validateGpuLane(feature.canonicalLane, primitiveIndex, 'canonicalLane');
    }
    if (feature.canonicalTrackLane !== null) {
      validateGpuLane(feature.canonicalTrackLane, primitiveIndex, 'canonicalTrackLane');
    }
    const base = primitiveIndex * ANNOTATION_POLICY_GPU_INSTANCE_LAYOUT.strideFloats;
    data[base + ANNOTATION_POLICY_GPU_INSTANCE_LAYOUT.expandedLane] = feature.expandedLane;
    data[base + ANNOTATION_POLICY_GPU_INSTANCE_LAYOUT.expandedTrackLane] =
      feature.expandedTrackLane;
    data[base + ANNOTATION_POLICY_GPU_INSTANCE_LAYOUT.canonicalLane] =
      feature.canonicalLane ?? ANNOTATION_POLICY_GPU_ABSENT_LANE;
    data[base + ANNOTATION_POLICY_GPU_INSTANCE_LAYOUT.canonicalTrackLane] =
      feature.canonicalTrackLane ?? ANNOTATION_POLICY_GPU_ABSENT_LANE;
  }
  return data;
}

export function resolveAnnotationPolicyGpuInstanceV1(
  data: Float32Array,
  primitiveIndex: number,
  runtime: AnnotationPolicyGpuRuntimeV1
): ResolvedAnnotationPolicyGpuInstanceV1 {
  const trackLane = resolveAnnotationPolicyGpuTrackLaneV1(data, primitiveIndex, runtime);
  if (trackLane === null) {
    return { visible: false, lane: null, trackLane: null, offsetCenterPx: null };
  }
  return {
    visible: true,
    lane: trackLane,
    trackLane,
    offsetCenterPx: annotationPolicyLaneCenterOffsetPxV1(trackLane),
  };
}

export function resolveAnnotationPolicyGpuTrackLaneV1(
  data: Float32Array,
  primitiveIndex: number,
  runtime: AnnotationPolicyGpuRuntimeV1
): number | null {
  validateGpuDataIndex(data, primitiveIndex);
  validateRuntime(runtime);
  const base = primitiveIndex * ANNOTATION_POLICY_GPU_INSTANCE_LAYOUT.strideFloats;
  const canonical = runtime.isoformMode === 'canonical';
  const trackLane =
    data[
      base +
        (canonical
          ? ANNOTATION_POLICY_GPU_INSTANCE_LAYOUT.canonicalTrackLane
          : ANNOTATION_POLICY_GPU_INSTANCE_LAYOUT.expandedTrackLane)
    ];
  const visible = trackLane >= 0 && (runtime.laneLimit === null || trackLane < runtime.laneLimit);
  return visible ? trackLane : null;
}

export function annotationPolicyLaneCenterOffsetPxV1(lane: number): number {
  validateGpuLane(lane, 0, 'lane');
  return Math.fround(
    -PREPACKED_ANNOTATION_BAR_HEIGHT_PX / 2 - lane * PREPACKED_ANNOTATION_LANE_STEP_PX
  );
}

export function validateAnnotationPolicyGpuInstanceDataV1(
  data: Float32Array,
  primitiveCount: number
): AnnotationPolicyGpuTrackLaneMaximaV1 {
  if (
    !(data instanceof Float32Array) ||
    !Number.isSafeInteger(primitiveCount) ||
    primitiveCount < 0 ||
    data.length !== primitiveCount * ANNOTATION_POLICY_GPU_INSTANCE_LAYOUT.strideFloats
  ) {
    throw new Error('annotation policy GPU instance data length is invalid');
  }
  let expanded = -1;
  let canonical = -1;
  for (let primitiveIndex = 0; primitiveIndex < primitiveCount; primitiveIndex++) {
    const base = primitiveIndex * ANNOTATION_POLICY_GPU_INSTANCE_LAYOUT.strideFloats;
    validateGpuLane(
      data[base + ANNOTATION_POLICY_GPU_INSTANCE_LAYOUT.expandedLane],
      primitiveIndex,
      'expandedLane'
    );
    validateGpuLane(
      data[base + ANNOTATION_POLICY_GPU_INSTANCE_LAYOUT.expandedTrackLane],
      primitiveIndex,
      'expandedTrackLane'
    );
    validateGpuOptionalLane(
      data[base + ANNOTATION_POLICY_GPU_INSTANCE_LAYOUT.canonicalLane],
      primitiveIndex,
      'canonicalLane'
    );
    validateGpuOptionalLane(
      data[base + ANNOTATION_POLICY_GPU_INSTANCE_LAYOUT.canonicalTrackLane],
      primitiveIndex,
      'canonicalTrackLane'
    );
    expanded = Math.max(
      expanded,
      data[base + ANNOTATION_POLICY_GPU_INSTANCE_LAYOUT.expandedTrackLane]
    );
    const canonicalTrackLane =
      data[base + ANNOTATION_POLICY_GPU_INSTANCE_LAYOUT.canonicalTrackLane];
    if (canonicalTrackLane !== ANNOTATION_POLICY_GPU_ABSENT_LANE) {
      canonical = Math.max(canonical, canonicalTrackLane);
    }
  }
  return { expanded, canonical };
}

function validateGpuDataIndex(data: Float32Array, primitiveIndex: number): void {
  const primitiveCount = data.length / ANNOTATION_POLICY_GPU_INSTANCE_LAYOUT.strideFloats;
  if (
    !(data instanceof Float32Array) ||
    !Number.isSafeInteger(primitiveIndex) ||
    primitiveIndex < 0 ||
    primitiveIndex >= primitiveCount
  ) {
    throw new Error('annotation policy GPU primitive index is invalid');
  }
}

function validateGpuOptionalLane(value: number, primitiveIndex: number, label: string): void {
  if (value === ANNOTATION_POLICY_GPU_ABSENT_LANE) return;
  validateGpuLane(value, primitiveIndex, label);
}

function validateGpuLane(value: number, primitiveIndex: number, label: string): void {
  if (
    !Number.isInteger(value) ||
    value < 0 ||
    value > ANNOTATION_POLICY_GPU_MAX_EXACT_LANE ||
    Math.fround(value) !== value
  ) {
    throw new Error(`annotation policy GPU primitive ${primitiveIndex} ${label} is not exact`);
  }
}

function validateRuntime(runtime: AnnotationPolicyGpuRuntimeV1): void {
  if (runtime.isoformMode !== 'canonical' && runtime.isoformMode !== 'expanded') {
    throw new Error('annotation policy GPU isoform mode is invalid');
  }
  if (
    runtime.laneLimit !== null &&
    (!Number.isSafeInteger(runtime.laneLimit) ||
      runtime.laneLimit <= 0 ||
      runtime.laneLimit > ANNOTATION_POLICY_GPU_MAX_EXACT_LANE)
  ) {
    throw new Error('annotation policy GPU lane limit is invalid');
  }
}
