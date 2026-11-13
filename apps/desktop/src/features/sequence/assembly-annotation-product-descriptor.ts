import {
  PREPACKED_ANNOTATION_BAR_HEIGHT_PX,
  PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
  PREPACKED_ANNOTATION_INTERACTION_TOKEN,
  PREPACKED_ANNOTATION_LANE_TOKEN,
  PREPACKED_ANNOTATION_MAPPER_TOKEN,
  PREPACKED_ANNOTATION_PARTITION_SPAN_BP,
  prepackedAnnotationSceneArtifactKey,
  type PrepackedAnnotationIsoformMode,
} from '@waypoint/genome-renderer/pure';

import type {
  AssemblyAnnotationSceneArtifactContract,
  AssemblyAnnotationSceneReadRequest,
  AssemblyAnnotationSceneSourceRequest,
} from '../../shared/indexed-genome';
import {
  ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
  assemblyAnnotationSceneScopeMatchesChromosomes,
} from '../../shared/indexed-genome';

export const ASSEMBLY_ANNOTATION_DATASET_VERSION =
  'resolved-annotation-v4:structural-composite-kinds.v1';
const ASSEMBLY_PLACEMENT_ALGORITHM = 'ordered-linear-assembly-placement-v1';

export interface AssemblyPrepackedAnnotationScenePolicy {
  trackType: string;
  isoformMode: PrepackedAnnotationIsoformMode;
  laneLimit: number | null;
}

export interface AssemblyPrepackedAnnotationSceneDescriptor {
  sourceIdentity: string;
  placementFingerprint: string;
  datasetContract: AssemblyAnnotationSceneReadRequest['datasetContract'];
  artifact: AssemblyAnnotationSceneArtifactContract;
  runtimeCacheKey: string;
  sceneKey: string;
  request: AssemblyAnnotationSceneReadRequest;
}

export interface DeriveAssemblyPrepackedAnnotationSceneDescriptorInput {
  request: AssemblyAnnotationSceneSourceRequest;
  themeMode: 'light' | 'dark';
  policy: AssemblyPrepackedAnnotationScenePolicy;
}

export async function deriveAssemblyPrepackedAnnotationSceneDescriptor(
  input: DeriveAssemblyPrepackedAnnotationSceneDescriptorInput
): Promise<AssemblyPrepackedAnnotationSceneDescriptor> {
  if (
    !assemblyAnnotationSceneScopeMatchesChromosomes(input.request.scope, input.request.chromosomes)
  ) {
    throw new Error('Annotation scene scope does not match the ordered source request.');
  }
  const trackType = input.policy.trackType.trim();
  const datasetVersion =
    input.request.datasetVersion?.trim() || ASSEMBLY_ANNOTATION_DATASET_VERSION;
  if (input.policy.isoformMode !== 'canonical' && input.policy.isoformMode !== 'expanded') {
    throw new Error('invalid annotation isoform mode');
  }
  if (
    input.policy.laneLimit !== null &&
    (!Number.isSafeInteger(input.policy.laneLimit) || input.policy.laneLimit <= 0)
  ) {
    throw new Error('invalid annotation lane limit');
  }
  const workspaceRoot = normalizePath(input.request.workspaceRoot).replace(/\/$/, '');
  const orderedSources = input.request.chromosomes.map((chromosome, index) => {
    const sourcePath = normalizePath(chromosome.sourcePath ?? '');
    const relativeSource =
      workspaceRoot && sourcePath.startsWith(`${workspaceRoot}/`)
        ? `workspace:${sourcePath.slice(workspaceRoot.length + 1)}`
        : sourcePath
          ? `absolute:${sourcePath}`
          : 'none';
    return `${index}|${chromosome.chrom}|${chromosome.length}|${relativeSource}`;
  });
  const sourceDescriptor = [
    'assembly-annotation-source.v1',
    input.request.assemblyId,
    datasetVersion,
    input.request.scope.kind,
    ...input.request.scope.placements.map(
      (placement, index) =>
        `${index}|${placement.chrom}|${placement.length}|${placement.annotationCoverage}`
    ),
    ...orderedSources,
  ].join('\n');
  const sourceSha256 = await sha256Hex(sourceDescriptor);
  const placementSignature = exactOrderedAssemblyPlacementSignature(input.request.chromosomes);
  const placementFingerprint = `ap1:${(await sha256Hex(placementSignature)).slice(0, 24)}`;
  const sourceIdentity = `assembly-annotation-source-sha256.v1:${sourceSha256}`;
  const datasetContract = {
    datasetId: `waypoint:assembly-annotation:${input.request.assemblyId}`,
    datasetVersion,
    sourceSha256,
  };
  const artifactWithoutKey = {
    themeMode: input.themeMode,
    trackType,
    partitionSpanBp: PREPACKED_ANNOTATION_PARTITION_SPAN_BP,
    annotationBarHeightPx: PREPACKED_ANNOTATION_BAR_HEIGHT_PX,
    laneAlgorithmToken: PREPACKED_ANNOTATION_LANE_TOKEN,
    mapperContractToken: PREPACKED_ANNOTATION_MAPPER_TOKEN,
    geometryContractToken: PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
    interactionContractToken: PREPACKED_ANNOTATION_INTERACTION_TOKEN,
  } satisfies Omit<AssemblyAnnotationSceneArtifactContract, 'artifactKey'>;
  const artifact: AssemblyAnnotationSceneArtifactContract = {
    artifactKey: prepackedAnnotationSceneArtifactKey({
      themeMode: input.themeMode,
      trackType,
    }),
    ...artifactWithoutKey,
  };
  const sceneKey = [
    sourceDescriptor,
    datasetContract.datasetId,
    datasetContract.datasetVersion,
    datasetContract.sourceSha256,
    artifact.artifactKey,
  ].join('\n');
  const runtimeCacheKey = ['assembly-annotation-scene-runtime.v1', workspaceRoot, sceneKey].join(
    '\n'
  );
  return {
    sourceIdentity,
    placementFingerprint,
    datasetContract,
    artifact,
    runtimeCacheKey,
    sceneKey,
    request: {
      ...input.request,
      datasetVersion,
      ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
      datasetContract,
      artifact,
      requestedPolicy: {
        isoformMode: input.policy.isoformMode,
        laneLimit: input.policy.laneLimit,
      },
    },
  };
}

function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
}

function exactOrderedAssemblyPlacementSignature(
  chromosomes: AssemblyAnnotationSceneSourceRequest['chromosomes']
): string {
  let startBp = 0;
  const placements = chromosomes.map((chromosome, index) => {
    const endBp = startBp + chromosome.length;
    const placement = `${index}|${chromosome.chrom}|${startBp}|${endBp}|${chromosome.length}`;
    startBp = endBp;
    return placement;
  });
  return [`placement:${ASSEMBLY_PLACEMENT_ALGORITHM}`, `total:${startBp}`, ...placements].join(
    '\n'
  );
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
