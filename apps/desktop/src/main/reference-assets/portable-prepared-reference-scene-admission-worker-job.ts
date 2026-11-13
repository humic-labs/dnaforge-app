import { readFile, realpath } from 'node:fs/promises';

import {
  buildPartitionedTranscriptSceneRangeCatalogV1,
  packCompiledBroadAnnotationInteractionBinaryV1,
  projectPrepackedAnnotationFeatureLookupIndexV2,
  resealPartitionedTranscriptSceneBinaryDatasetContractV4,
  validateCompiledBroadAnnotationInteractionBinaryV1,
  validatePartitionedTranscriptSceneBinaryV4,
  type AnnotationSceneDatasetContractV1,
  type CompiledBroadAnnotationInteractionBinaryManifestV1,
  type PackedCompiledBroadAnnotationInteractionBinaryV1,
  type PartitionedTranscriptSceneBinaryManifestV4,
  type PartitionedTranscriptSceneRangeCatalogV1,
} from '@waypoint/genome-renderer/pure';
import {
  TRUSTED_MAIN_PARTITIONED_TRANSCRIPT_SCENE_VALIDATION_V4,
  unpackTrustedMainValidatedPartitionedTranscriptSceneBinaryV4,
} from '@waypoint/genome-renderer/internal/trusted-annotation-scene-transport';

import { sha256BoundedNodeV1 } from '../ipc/bounded-binary-sha256';

const WORKER_CONTRACT = 'portable-prepared-reference-scene-admission-worker.v1' as const;
const SHA256 = /^[0-9a-f]{64}$/;

interface PortablePreparedReferenceAdmissionWorkerJobBaseV1 {
  contract: typeof WORKER_CONTRACT;
  payloadPath: string;
  authorizedPayloadRealPath: string;
  expectedPayloadSha256: string;
}

export type PortablePreparedReferenceSceneAdmissionWorkerJobV1 =
  | Readonly<
      PortablePreparedReferenceAdmissionWorkerJobBaseV1 & {
        manifest: PartitionedTranscriptSceneBinaryManifestV4;
        projection?: 'full-scene' | 'compiled-broad-interaction' | 'range-catalog';
        projectionDatasetContract?: AnnotationSceneDatasetContractV1;
        expectedProjectionContractSha256?: string;
      }
    >
  | Readonly<
      PortablePreparedReferenceAdmissionWorkerJobBaseV1 & {
        projection: 'admit-persisted-compiled-broad-interaction';
        manifest: CompiledBroadAnnotationInteractionBinaryManifestV1;
      }
    >;

export type PortablePreparedReferenceSceneAdmissionWorkerResultV1 =
  | Readonly<{
      contract: typeof WORKER_CONTRACT;
      byteCount: number;
      payloadSha256: string;
      validatedPayload: Uint8Array;
    }>
  | Readonly<{
      contract: typeof WORKER_CONTRACT;
      projection: 'compiled-broad-interaction';
      sourceByteCount: number;
      sourcePayloadSha256: string;
      byteCount: number;
      payloadSha256: string;
      manifest: CompiledBroadAnnotationInteractionBinaryManifestV1;
      rangeCatalog: PartitionedTranscriptSceneRangeCatalogV1;
      validatedPayload: Uint8Array;
    }>
  | Readonly<{
      contract: typeof WORKER_CONTRACT;
      projection: 'persisted-compiled-broad-interaction';
      byteCount: number;
      payloadSha256: string;
      manifest: CompiledBroadAnnotationInteractionBinaryManifestV1;
      validatedPayload: Uint8Array;
    }>
  | Readonly<{
      contract: typeof WORKER_CONTRACT;
      projection: 'range-catalog';
      sourceByteCount: number;
      sourcePayloadSha256: string;
      sourceContractSha256: string;
      rangeCatalog: PartitionedTranscriptSceneRangeCatalogV1;
    }>;

export interface PortablePreparedReferenceSceneAdmissionWorkerJobDepsV1 {
  readonly resolveRealPath?: typeof realpath;
  readonly readPayload?: (path: string) => Promise<Uint8Array>;
  readonly validateScene?: typeof validatePartitionedTranscriptSceneBinaryV4;
  readonly validateCompiledBroadInteraction?: typeof validateCompiledBroadAnnotationInteractionBinaryV1;
  readonly projectCompiledBroadInteraction?: (
    manifest: PartitionedTranscriptSceneBinaryManifestV4,
    payload: Uint8Array
  ) => Promise<PackedCompiledBroadAnnotationInteractionBinaryV1>;
  readonly buildRangeCatalog?: typeof buildPartitionedTranscriptSceneRangeCatalogV1;
  readonly resealScene?: typeof resealPartitionedTranscriptSceneBinaryDatasetContractV4;
}

export async function runPortablePreparedReferenceSceneAdmissionWorkerJobV1(
  job: PortablePreparedReferenceSceneAdmissionWorkerJobV1,
  deps: PortablePreparedReferenceSceneAdmissionWorkerJobDepsV1 = {}
): Promise<PortablePreparedReferenceSceneAdmissionWorkerResultV1> {
  validateWorkerEnvelope(job);
  const currentRealPath = await (deps.resolveRealPath ?? realpath)(job.payloadPath);
  if (currentRealPath !== job.authorizedPayloadRealPath) {
    throw new Error('Portable scene admission worker rejected a changed payload path.');
  }
  const payload = await (deps.readPayload ?? (async (path: string) => readFile(path)))(
    job.payloadPath
  );
  if (!ArrayBuffer.isView(payload) || payload.byteLength !== job.manifest.byteLength) {
    throw new Error(
      `Portable scene admission worker rejected a truncated payload: actual=${String(
        payload?.byteLength
      )}:expected=${String(job.manifest.byteLength)}.`
    );
  }
  if (job.projection === 'admit-persisted-compiled-broad-interaction') {
    await (
      deps.validateCompiledBroadInteraction ?? validateCompiledBroadAnnotationInteractionBinaryV1
    )(
      job.manifest,
      new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength),
      sha256BoundedNodeV1
    );
    return Object.freeze({
      contract: WORKER_CONTRACT,
      projection: 'persisted-compiled-broad-interaction',
      byteCount: payload.byteLength,
      payloadSha256: job.expectedPayloadSha256,
      manifest: job.manifest,
      validatedPayload: payload,
    });
  }
  await (deps.validateScene ?? validatePartitionedTranscriptSceneBinaryV4)(
    job.manifest,
    payload,
    sha256BoundedNodeV1
  );
  if (job.projection === 'compiled-broad-interaction' || job.projection === 'range-catalog') {
    const projectionDatasetContract = job.projectionDatasetContract;
    if (!projectionDatasetContract) {
      throw new Error('Portable scene admission worker rejected a missing projection dataset.');
    }
    const projectionManifest = await (
      deps.resealScene ?? resealPartitionedTranscriptSceneBinaryDatasetContractV4
    )(job.manifest, projectionDatasetContract);
    if (projectionManifest.integrity.contractSha256 !== job.expectedProjectionContractSha256) {
      throw new Error(
        'Portable scene admission worker rejected a mismatched installed parent contract.'
      );
    }
    if (job.projection === 'range-catalog') {
      const rangeCatalog = await (
        deps.buildRangeCatalog ?? buildPartitionedTranscriptSceneRangeCatalogV1
      )(projectionManifest, payload, sha256BoundedNodeV1);
      return Object.freeze({
        contract: WORKER_CONTRACT,
        projection: 'range-catalog',
        sourceByteCount: payload.byteLength,
        sourcePayloadSha256: job.expectedPayloadSha256,
        sourceContractSha256: projectionManifest.integrity.contractSha256,
        rangeCatalog,
      });
    }
    const rangeCatalog = await (
      deps.buildRangeCatalog ?? buildPartitionedTranscriptSceneRangeCatalogV1
    )(projectionManifest, payload, sha256BoundedNodeV1);
    const compact = await (deps.projectCompiledBroadInteraction ?? projectCompiledBroadInteraction)(
      projectionManifest,
      payload
    );
    return Object.freeze({
      contract: WORKER_CONTRACT,
      projection: 'compiled-broad-interaction',
      sourceByteCount: payload.byteLength,
      sourcePayloadSha256: job.expectedPayloadSha256,
      byteCount: compact.payload.byteLength,
      payloadSha256: compact.manifest.integrity.payloadSha256,
      manifest: compact.manifest,
      rangeCatalog,
      validatedPayload: compact.payload,
    });
  }
  return Object.freeze({
    contract: WORKER_CONTRACT,
    byteCount: payload.byteLength,
    payloadSha256: job.expectedPayloadSha256,
    validatedPayload: payload,
  });
}

async function projectCompiledBroadInteraction(
  manifest: PartitionedTranscriptSceneBinaryManifestV4,
  payload: Uint8Array
): Promise<PackedCompiledBroadAnnotationInteractionBinaryV1> {
  const admitted = unpackTrustedMainValidatedPartitionedTranscriptSceneBinaryV4(
    manifest,
    payload,
    TRUSTED_MAIN_PARTITIONED_TRANSCRIPT_SCENE_VALIDATION_V4
  );
  return packCompiledBroadAnnotationInteractionBinaryV1({
    sourceScene: {
      schema: manifest.schema,
      payloadSha256: manifest.integrity.payloadSha256,
      contractSha256: manifest.integrity.contractSha256,
      byteLength: manifest.byteLength,
    },
    datasetContract: manifest.datasetContract,
    assemblyContract: manifest.assemblyContract,
    policyProjection: admitted.policyProjection,
    featureLookup: projectPrepackedAnnotationFeatureLookupIndexV2(admitted.interactionIndex),
    payloadSha256: sha256BoundedNodeV1,
  });
}

function validateWorkerEnvelope(job: PortablePreparedReferenceSceneAdmissionWorkerJobV1): void {
  if (
    job?.contract !== WORKER_CONTRACT ||
    typeof job.payloadPath !== 'string' ||
    job.payloadPath.trim().length === 0 ||
    typeof job.authorizedPayloadRealPath !== 'string' ||
    job.authorizedPayloadRealPath.trim().length === 0 ||
    !job.manifest ||
    !Number.isSafeInteger(job.manifest.byteLength) ||
    job.manifest.byteLength <= 0 ||
    !SHA256.test(job.expectedPayloadSha256) ||
    job.manifest.integrity?.payloadSha256 !== job.expectedPayloadSha256
  ) {
    throw new Error('Portable scene admission worker rejected an invalid job envelope.');
  }
  if (job.projection === 'admit-persisted-compiled-broad-interaction') {
    if (
      job.manifest.integrity?.payloadSha256 !== job.expectedPayloadSha256 ||
      job.manifest.byteLength <= 0
    ) {
      throw new Error('Portable scene admission worker rejected an invalid compact authority.');
    }
    return;
  }
  const installedProjection =
    job.projection === 'compiled-broad-interaction' || job.projection === 'range-catalog';
  if (
    installedProjection !== Boolean(job.projectionDatasetContract) ||
    installedProjection !== Boolean(job.expectedProjectionContractSha256) ||
    (job.expectedProjectionContractSha256 != null &&
      !SHA256.test(job.expectedProjectionContractSha256))
  ) {
    throw new Error('Portable scene admission worker rejected an invalid projection authority.');
  }
  if (
    job.projection !== undefined &&
    job.projection !== 'full-scene' &&
    job.projection !== 'compiled-broad-interaction' &&
    job.projection !== 'range-catalog'
  ) {
    throw new Error('Portable scene admission worker rejected an invalid projection.');
  }
}

export function portablePreparedReferenceSceneAdmissionWorkerContractV1(): typeof WORKER_CONTRACT {
  return WORKER_CONTRACT;
}
