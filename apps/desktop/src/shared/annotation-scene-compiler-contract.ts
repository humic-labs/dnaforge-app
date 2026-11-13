import {
  PARTITIONED_TRANSCRIPT_SCENE_BINARY_V4,
  PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
  PREPACKED_ANNOTATION_INTERACTION_TOKEN,
  PREPACKED_ANNOTATION_LANE_TOKEN,
  PREPACKED_ANNOTATION_MAPPER_TOKEN,
  PREPACKED_ANNOTATION_PARTITION_SPAN_BP,
  type AnnotationSceneDatasetContractV1,
} from '@waypoint/genome-renderer/pure';

import {
  ANNOTATION_LAYER_IDENTITY_LEGACY_RAW_QUALIFIER_CONTRACT_TOKEN,
  ANNOTATION_TRACK_IDENTITY_CONTRACT_TOKEN,
  type AnnotationTrackIdentityPublishedContractToken,
} from '../features/sequence/annotation-layer-identity';
import {
  ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
  assemblyAnnotationSceneArtifactKey,
  type AssemblyAnnotationSceneArtifactContract,
  type AssemblyAnnotationSceneScopeContract,
} from './indexed-genome';
import { sha256Hex } from './sha256-sync';

export const ASSEMBLY_TEXTURE_PLACEMENT_ALGORITHM = 'ordered-linear-assembly-placement-v1';
export const ASSEMBLY_ANNOTATION_SCENE_CACHE_VERSION = 6;
export const ASSEMBLY_ANNOTATION_SCENE_LEGACY_COMPILER_CONTRACT =
  'assembly-annotation-scene-compiler-cache.direct-bank-v4.v1' as const;

export function annotationSceneCompilerContractFingerprint(
  dataset: AnnotationSceneDatasetContractV1,
  artifact: AssemblyAnnotationSceneArtifactContract,
  scope: AssemblyAnnotationSceneScopeContract,
  layerIdentityContract: AnnotationTrackIdentityPublishedContractToken = ANNOTATION_TRACK_IDENTITY_CONTRACT_TOKEN
): string | null {
  if (
    !datasetContractsAreWellFormed(dataset) ||
    !sceneArtifactIsWellFormed(artifact) ||
    !scopeIsWellFormed(scope)
  ) {
    return null;
  }
  const compilerContract =
    layerIdentityContract === ANNOTATION_LAYER_IDENTITY_LEGACY_RAW_QUALIFIER_CONTRACT_TOKEN
      ? ASSEMBLY_ANNOTATION_SCENE_LEGACY_COMPILER_CONTRACT
      : [ASSEMBLY_ANNOTATION_SCENE_LEGACY_COMPILER_CONTRACT, layerIdentityContract].join('|');
  return sha256Hex(
    JSON.stringify({
      compilerContract,
      ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
      diskCacheVersion: ASSEMBLY_ANNOTATION_SCENE_CACHE_VERSION,
      binarySchema: PARTITIONED_TRANSCRIPT_SCENE_BINARY_V4,
      placementAlgorithm: ASSEMBLY_TEXTURE_PLACEMENT_ALGORITHM,
      scope,
      dataset: {
        datasetId: dataset.datasetId,
        datasetVersion: dataset.datasetVersion,
        sourceSha256: dataset.sourceSha256,
      },
      artifact: {
        artifactKey: artifact.artifactKey,
        themeMode: artifact.themeMode,
        trackType: artifact.trackType,
        partitionSpanBp: artifact.partitionSpanBp,
        annotationBarHeightPx: artifact.annotationBarHeightPx,
        laneAlgorithmToken: artifact.laneAlgorithmToken,
        mapperContractToken: artifact.mapperContractToken,
        geometryContractToken: artifact.geometryContractToken,
        interactionContractToken: artifact.interactionContractToken,
      },
    })
  );
}

export function datasetContractsAreWellFormed(
  contract: AnnotationSceneDatasetContractV1 | null | undefined
): contract is AnnotationSceneDatasetContractV1 {
  return (
    typeof contract?.datasetId === 'string' &&
    contract.datasetId.trim().length > 0 &&
    typeof contract.datasetVersion === 'string' &&
    contract.datasetVersion.trim().length > 0 &&
    typeof contract.sourceSha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(contract.sourceSha256)
  );
}

export function scopeIsWellFormed(
  scope: AssemblyAnnotationSceneScopeContract | null | undefined
): scope is AssemblyAnnotationSceneScopeContract {
  if (
    !scope ||
    (scope.kind !== 'complete-assembly' && scope.kind !== 'viewport-subset') ||
    !Array.isArray(scope.placements) ||
    scope.placements.length === 0
  ) {
    return false;
  }
  const names = new Set<string>();
  let totalLength = 0;
  for (const placement of scope.placements) {
    if (
      typeof placement?.chrom !== 'string' ||
      placement.chrom.trim().length === 0 ||
      placement.chrom !== placement.chrom.trim() ||
      names.has(placement.chrom) ||
      !Number.isSafeInteger(placement.length) ||
      placement.length <= 0 ||
      (placement.annotationCoverage !== 'sourced' && placement.annotationCoverage !== 'unsourced')
    ) {
      return false;
    }
    names.add(placement.chrom);
    totalLength += placement.length;
    if (!Number.isSafeInteger(totalLength)) return false;
  }
  return true;
}

export function sceneArtifactIsWellFormed(
  artifact: AssemblyAnnotationSceneArtifactContract | null | undefined
): artifact is AssemblyAnnotationSceneArtifactContract {
  return (
    typeof artifact?.artifactKey === 'string' &&
    artifact.artifactKey.trim().length > 0 &&
    (artifact.themeMode === 'light' || artifact.themeMode === 'dark') &&
    typeof artifact.trackType === 'string' &&
    artifact.trackType.trim().length > 0 &&
    artifact.trackType === artifact.trackType.trim() &&
    artifact.partitionSpanBp === PREPACKED_ANNOTATION_PARTITION_SPAN_BP &&
    Number.isFinite(artifact.annotationBarHeightPx) &&
    artifact.annotationBarHeightPx > 0 &&
    artifact.laneAlgorithmToken === PREPACKED_ANNOTATION_LANE_TOKEN &&
    artifact.mapperContractToken === PREPACKED_ANNOTATION_MAPPER_TOKEN &&
    artifact.geometryContractToken === PREPACKED_ANNOTATION_GEOMETRY_TOKEN &&
    artifact.interactionContractToken === PREPACKED_ANNOTATION_INTERACTION_TOKEN &&
    artifact.artifactKey ===
      assemblyAnnotationSceneArtifactKey({
        themeMode: artifact.themeMode,
        trackType: artifact.trackType,
        partitionSpanBp: artifact.partitionSpanBp,
        annotationBarHeightPx: artifact.annotationBarHeightPx,
        laneAlgorithmToken: artifact.laneAlgorithmToken,
        mapperContractToken: artifact.mapperContractToken,
        geometryContractToken: artifact.geometryContractToken,
        interactionContractToken: artifact.interactionContractToken,
      })
  );
}
