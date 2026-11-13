import type { PartitionedTranscriptSceneRoleSidecarV1 } from './partitioned-transcript-scene-binary-v4';
import { ANNOTATION_BAR_HEIGHT, type WebGLThemeMode } from '../shared/theme';
import type { UnpackedAnnotationSceneBinaryV1 } from './annotation-scene-binary-v1';
import type { GpuReadyPartitionedTranscriptScene } from './partitioned-transcript-scene';
import type { PrepackedAnnotationInteractionIndexV2 } from './prepacked-annotation-interaction-index-v2';
import { TRANSCRIPT_PAGE_LANE_STEP_PX } from './compile-transcript-page-bundle';
import type { AnnotationPolicyGpuRuntimeV1 } from './annotation-policy-gpu-instances-v1';
import type { AnnotationPolicyProjectionTableV1 } from './annotation-policy-projection-v1';
import type { AnnotationPolicyDirectSubmissionBankV1 } from './annotation-policy-direct-submission-bank-v1';
import type { AnnotationPolicyDirectFineIndexV1 } from './annotation-policy-direct-fine-index-v1';
import type {
  TrustedPartitionedTranscriptSceneDetailInteractionAdmissionV1,
  TrustedPartitionedTranscriptSceneDetailPacketAdmissionV1,
} from './partitioned-transcript-scene-detail-packet-v1';
import type {
  TrustedPartitionedTranscriptRendererAdmissionV4,
  TrustedPartitionedTranscriptRendererLoadIdentityV4,
  TrustedPartitionedTranscriptRendererProvenanceV4,
} from './partitioned-transcript-scene-binary-v4';

export const PREPACKED_ANNOTATION_GEOMETRY_TOKEN =
  'retained-linear-directional-block.track-local.theme-final.v3' as const;
export const PREPACKED_ANNOTATION_LANE_TOKEN = 'source-lanes.v1' as const;
export const PREPACKED_ANNOTATION_MAPPER_TOKEN = 'annotation-isoform-mapper.v2' as const;
export const PREPACKED_ANNOTATION_INTERACTION_TOKEN = 'annotation-feature-hit-index.v3' as const;
export const PREPACKED_ANNOTATION_VIEWPORT_DETAIL_V1 =
  'prepacked-annotation-viewport-detail.v1' as const;
export const PREPACKED_ANNOTATION_MIN_VISIBLE_BP = 512 * 1024;
export const PREPACKED_ANNOTATION_PARTITION_SPAN_BP = 100_000_000;
export const PREPACKED_ANNOTATION_BAR_HEIGHT_PX = ANNOTATION_BAR_HEIGHT;
export const PREPACKED_ANNOTATION_LANE_STEP_PX = TRANSCRIPT_PAGE_LANE_STEP_PX;

export type PrepackedAnnotationIsoformMode = 'canonical' | 'expanded';

export interface PrepackedAnnotationSceneArtifactKeyInput {
  themeMode: WebGLThemeMode;
  trackType: string;
}

export function prepackedAnnotationSceneArtifactKey(
  artifact: PrepackedAnnotationSceneArtifactKeyInput
): string {
  const trackType = artifact.trackType.trim();
  if (trackType.length === 0) throw new Error('prepacked annotation track type is required');
  return [
    'assembly-annotation-artifact.v4',
    `theme:${artifact.themeMode}`,
    `track:${trackType}`,
    `partition:${PREPACKED_ANNOTATION_PARTITION_SPAN_BP}`,
    `bar:${PREPACKED_ANNOTATION_BAR_HEIGHT_PX}`,
    `lanes:${PREPACKED_ANNOTATION_LANE_TOKEN}`,
    `mapper:${PREPACKED_ANNOTATION_MAPPER_TOKEN}`,
    `geometry:${PREPACKED_ANNOTATION_GEOMETRY_TOKEN}`,
    `interaction:${PREPACKED_ANNOTATION_INTERACTION_TOKEN}`,
  ].join('|');
}

export type PrepackedAnnotationSceneStatus =
  | 'not-loaded'
  | 'eligible'
  | 'holding-last-good'
  | 'fine-view-pending'
  | 'outside-corridor'
  | 'mixed-layer-fallback'
  | 'scene-contains-source-shape'
  | 'genome-mismatch'
  | 'variant-mismatch'
  | 'gpu-prepare-failed'
  | 'unsupported-renderer';

export interface PrepackedAnnotationSceneMetadata {
  genomeIdentity: string;
  genomeLengthBp: number;
  partitionSpanBp: number;
  artifactKey: string;
  themeMode: WebGLThemeMode;
  trackType: string;
  annotationBarHeightPx: number;
  laneAlgorithmToken: typeof PREPACKED_ANNOTATION_LANE_TOKEN;
  mapperContractToken: typeof PREPACKED_ANNOTATION_MAPPER_TOKEN;
  geometryContractToken: typeof PREPACKED_ANNOTATION_GEOMETRY_TOKEN;
  interactionContractToken: typeof PREPACKED_ANNOTATION_INTERACTION_TOKEN;
}

export interface PrepackedAnnotationSceneLoadInput {
  ownerKey: string;
  scene: UnpackedAnnotationSceneBinaryV1;
  gpuReadyScene?: GpuReadyPartitionedTranscriptScene;
  interactionIndex: PrepackedAnnotationInteractionIndexV2;
  policyProjection?: AnnotationPolicyProjectionTableV1;
  policyGpuInstanceData?: Float32Array;
  submissionBank?: AnnotationPolicyDirectSubmissionBankV1;
  submissionFineIndices?: Readonly<{
    expanded: AnnotationPolicyDirectFineIndexV1;
    canonical: AnnotationPolicyDirectFineIndexV1;
  }>;
  colorRoles?: PartitionedTranscriptSceneRoleSidecarV1;
  viewportDetail?: Readonly<{
    contract: typeof PREPACKED_ANNOTATION_VIEWPORT_DETAIL_V1;
    packetPayloadSha256: string;
    sourceFingerprint: string;
    interactionPayloadSha256: string;
    sourceScene: Readonly<{
      byteLength: number;
      payloadSha256: string;
      contractSha256: string;
    }>;
    empty: boolean;
    coverageStartBp: number;
    coverageEndBp: number;
    handoffStartBp: number;
    handoffEndBp: number;
  }>;
  trustedViewportDetailPacketAdmissionV1?: TrustedPartitionedTranscriptSceneDetailPacketAdmissionV1;
  trustedViewportDetailInteractionAdmissionV1?: TrustedPartitionedTranscriptSceneDetailInteractionAdmissionV1;
  trustedRendererAdmissionV4?: TrustedPartitionedTranscriptRendererAdmissionV4;
  trustedRendererAdmissionProvenanceV4?: TrustedPartitionedTranscriptRendererProvenanceV4;
  trustedRendererAdmissionLoadIdentityV4?: TrustedPartitionedTranscriptRendererLoadIdentityV4;
  runtimePolicy?: AnnotationPolicyGpuRuntimeV1;
  metadata: PrepackedAnnotationSceneMetadata;
}

export type PrepackedAnnotationSceneBuildOptions = Omit<
  PrepackedAnnotationSceneMetadata,
  'genomeIdentity' | 'genomeLengthBp'
> & { ownerKey: string };

export interface PrepackedAnnotationSceneOwnerSnapshot {
  ownerKey: string | null;
  ownerGeneration: number;
  loaded: boolean;
  status: PrepackedAnnotationSceneStatus;
  gpuPrepared: boolean;
  metadata: PrepackedAnnotationSceneMetadata | null;
  runtimePolicy: AnnotationPolicyGpuRuntimeV1 | null;
  policyGeneration: number;
  submittedPartitionCount: number;
  submittedInstanceCount: number;
}

export function validatePrepackedAnnotationRuntimePolicy(
  policy: AnnotationPolicyGpuRuntimeV1 | null | undefined
): policy is AnnotationPolicyGpuRuntimeV1 {
  return Boolean(
    policy &&
    (policy.isoformMode === 'canonical' || policy.isoformMode === 'expanded') &&
    (policy.laneLimit === null ||
      (Number.isSafeInteger(policy.laneLimit) && (policy.laneLimit as number) > 0))
  );
}

export function prepackedSceneCoversRequestedLayers(
  requestedLayerTypes: readonly string[],
  scene: UnpackedAnnotationSceneBinaryV1,
  gpuReadyPrimitiveCount = 0
): boolean {
  const requested = [...new Set(requestedLayerTypes)].filter(Boolean);
  if (requested.length !== 1) return false;
  return (
    (scene.primitives.length > 0 || gpuReadyPrimitiveCount > 0) &&
    scene.families.length > 0 &&
    scene.families.every(({ kind }) => kind === 'transcript')
  );
}

export function validatePrepackedAnnotationSceneMetadata(
  metadata: PrepackedAnnotationSceneMetadata
): boolean {
  const trackType = metadata.trackType?.trim();
  let expectedArtifactKey = '';
  if (trackType) {
    expectedArtifactKey = prepackedAnnotationSceneArtifactKey({
      themeMode: metadata.themeMode,
      trackType,
    });
  }
  return (
    metadata.genomeIdentity.length > 0 &&
    Number.isSafeInteger(metadata.genomeLengthBp) &&
    metadata.genomeLengthBp > 0 &&
    metadata.partitionSpanBp === PREPACKED_ANNOTATION_PARTITION_SPAN_BP &&
    metadata.artifactKey === expectedArtifactKey &&
    (metadata.themeMode === 'light' || metadata.themeMode === 'dark') &&
    Boolean(trackType) &&
    metadata.trackType === trackType &&
    metadata.annotationBarHeightPx === PREPACKED_ANNOTATION_BAR_HEIGHT_PX &&
    metadata.laneAlgorithmToken === PREPACKED_ANNOTATION_LANE_TOKEN &&
    metadata.mapperContractToken === PREPACKED_ANNOTATION_MAPPER_TOKEN &&
    metadata.geometryContractToken === PREPACKED_ANNOTATION_GEOMETRY_TOKEN &&
    metadata.interactionContractToken === PREPACKED_ANNOTATION_INTERACTION_TOKEN
  );
}
