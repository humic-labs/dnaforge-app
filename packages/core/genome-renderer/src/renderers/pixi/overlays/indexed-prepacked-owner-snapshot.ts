import type {
  PrepackedAnnotationSceneMetadata,
  PrepackedAnnotationSceneOwnerSnapshot,
  PrepackedAnnotationSceneStatus,
} from '../overview/prepacked-annotation-scene';
import type { AnnotationPolicyGpuRuntimeV1 } from '../overview/annotation-policy-gpu-instances-v1';

export function buildPrepackedAnnotationSceneOwnerSnapshot(input: {
  ownerKey: string | null;
  ownerGeneration: number;
  layer: { isGpuPrepared?: boolean; isPresenting?: boolean } | null;
  input: object | null;
  status: PrepackedAnnotationSceneStatus;
  metadata: (Partial<PrepackedAnnotationSceneMetadata> & { trackType?: string }) | null;
  runtimePolicy: AnnotationPolicyGpuRuntimeV1 | null;
  policyGeneration: number;
  resident: {
    layer: object;
    visiblePartitionCount: number;
    visibleInstanceCount: number;
  } | null;
}): PrepackedAnnotationSceneOwnerSnapshot {
  const presenting = input.resident?.layer === input.layer && Boolean(input.layer?.isPresenting);
  return {
    ownerKey: input.ownerKey,
    ownerGeneration: input.ownerGeneration,
    loaded: input.layer !== null && input.input !== null && input.ownerKey !== null,
    status: input.status,
    gpuPrepared: input.layer?.isGpuPrepared ?? false,
    metadata: input.metadata ? ({ ...input.metadata } as PrepackedAnnotationSceneMetadata) : null,
    runtimePolicy: input.runtimePolicy ? { ...input.runtimePolicy } : null,
    policyGeneration: input.policyGeneration,
    submittedPartitionCount: presenting ? (input.resident?.visiblePartitionCount ?? 0) : 0,
    submittedInstanceCount: presenting ? (input.resident?.visibleInstanceCount ?? 0) : 0,
  };
}
