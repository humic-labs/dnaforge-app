import { randomUUID } from 'node:crypto';
import { readFile, realpath, rename } from 'node:fs/promises';

import {
  validatePartitionedTranscriptSceneBinaryV4,
  type PackedPartitionedTranscriptSceneBinaryV4,
  type PartitionedTranscriptSceneBinaryManifestV4,
} from '@waypoint/genome-renderer/pure';

import type { AssemblyAnnotationSceneReadRequest } from '../../shared/indexed-genome';
import { buildAssemblyCompiledBroadRasterSurfaceManifestV1 } from '../../shared/indexed-genome';
import { compileAndPublishBroadRasterArtifactForPackedScene } from './assembly-expanded-annotation-scene-compiler';
import { assemblyCompiledBroadRasterArtifactDirectory } from './assembly-overview-texture-cache';
import { sha256BoundedNodeV1 } from './bounded-binary-sha256';
import {
  CompiledBroadRasterArtifactError,
  openCompiledBroadRasterArtifactV1,
  type CompiledBroadRasterArtifactReaderV1,
} from './compiled-broad-raster-artifact';

const SOURCE_FINGERPRINT_PATTERN = /^[0-9a-f]{24}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface AssemblyCompiledBroadRasterWorkerJobV1 {
  readonly request: AssemblyAnnotationSceneReadRequest;
  readonly sourceFingerprint: string;
  readonly scenePath: string;
  readonly authorizedSceneRealPath: string;
  readonly sceneManifest: PartitionedTranscriptSceneBinaryManifestV4;
  readonly expectedPayloadSha256: string;
  readonly expectedSurfaceManifestFingerprint: string;
  readonly forceRebuildExistingArtifact: boolean;
}

export type AssemblyCompiledBroadRasterWorkerResultV1 = Readonly<{
  status: 'already-present' | 'published';
  sourceFingerprint: string;
  surfaceManifestFingerprint: string;
  catalogFingerprint: string;
  quarantinedCorruptArtifact: boolean;
}>;

export interface AssemblyCompiledBroadRasterWorkerJobDepsV1 {
  readonly assertAuthorizedScenePath: (path: string) => Promise<void>;
  readonly readSceneFile?: (path: string) => Promise<Uint8Array>;
  readonly validateScene?: typeof validatePartitionedTranscriptSceneBinaryV4;
  readonly buildSurfaceManifest?: typeof buildAssemblyCompiledBroadRasterSurfaceManifestV1;
  readonly resolveArtifactDirectory?: typeof assemblyCompiledBroadRasterArtifactDirectory;
  readonly openArtifact?: typeof openCompiledBroadRasterArtifactV1;
  readonly compileAndPublish?: typeof compileAndPublishBroadRasterArtifactForPackedScene;
  readonly quarantineArtifactDirectory?: (artifactDirectory: string) => Promise<boolean>;
}

export function createAuthorizedCompiledBroadRasterScenePathGuard(
  authorizedPath: string,
  authorizedRealPath: string,
  realpathImpl: typeof realpath = realpath
): (path: string) => Promise<void> {
  return async (path: string): Promise<void> => {
    if (!path || path !== authorizedPath || !authorizedRealPath) {
      throw new Error('Compiled broad raster worker rejected an unauthorized scene path.');
    }
    const currentRealPath = await realpathImpl(path);
    if (currentRealPath !== authorizedRealPath) {
      throw new Error('Compiled broad raster worker rejected a changed scene path.');
    }
  };
}

export async function prepareAssemblyCompiledBroadRasterWorkerJobV1(
  job: AssemblyCompiledBroadRasterWorkerJobV1,
  deps: AssemblyCompiledBroadRasterWorkerJobDepsV1
): Promise<AssemblyCompiledBroadRasterWorkerResultV1> {
  validateJobEnvelope(job);
  const buildSurfaceManifest =
    deps.buildSurfaceManifest ?? buildAssemblyCompiledBroadRasterSurfaceManifestV1;
  const resolveArtifactDirectory =
    deps.resolveArtifactDirectory ?? assemblyCompiledBroadRasterArtifactDirectory;
  const openArtifact = deps.openArtifact ?? openCompiledBroadRasterArtifactV1;
  const compileAndPublish =
    deps.compileAndPublish ?? compileAndPublishBroadRasterArtifactForPackedScene;
  const quarantineArtifactDirectory =
    deps.quarantineArtifactDirectory ?? quarantineCorruptArtifactDirectory;
  validateSceneIdentity(job);

  const surfaceManifest = await buildSurfaceManifest({
    sceneManifest: job.sceneManifest,
    artifact: job.request.artifact,
  });
  if (surfaceManifest.manifestFingerprint !== job.expectedSurfaceManifestFingerprint) {
    throw new Error('Compiled broad raster worker rejected a changed surface identity.');
  }
  const artifactDirectory = resolveArtifactDirectory({
    request: job.request,
    sourceFingerprint: job.sourceFingerprint,
    surfaceManifestFingerprint: surfaceManifest.manifestFingerprint,
  });
  if (!artifactDirectory) {
    throw new Error('Compiled broad raster worker rejected an invalid artifact directory.');
  }

  let quarantinedCorruptArtifact = false;
  if (job.forceRebuildExistingArtifact) {
    quarantinedCorruptArtifact = await quarantineArtifactDirectory(artifactDirectory);
  } else {
    try {
      const existing = await openArtifact({
        artifactDirectory,
        expectedSurfaceManifestFingerprint: surfaceManifest.manifestFingerprint,
      });
      return resultFromReader('already-present', job, existing, false);
    } catch (error) {
      if (!isMissingArtifact(error) && !isCorruptArtifactCatalog(error)) throw error;
      if (isCorruptArtifactCatalog(error)) {
        quarantinedCorruptArtifact = await quarantineArtifactDirectory(artifactDirectory);
      }
    }
  }

  await deps.assertAuthorizedScenePath(job.scenePath);
  const readSceneFile = deps.readSceneFile ?? (async (path: string) => readFile(path));
  const validateScene = deps.validateScene ?? validatePartitionedTranscriptSceneBinaryV4;
  const payload = exactScenePayload(
    await readSceneFile(job.scenePath),
    job.sceneManifest.byteLength
  );
  await validateScene(job.sceneManifest, payload, sha256BoundedNodeV1);
  const packed = reconstituteValidatedPackedScene(job.sceneManifest, payload);
  await compileAndPublish({
    request: job.request,
    sourceFingerprint: job.sourceFingerprint,
    packed,
  });
  const published = await openArtifact({
    artifactDirectory,
    expectedSurfaceManifestFingerprint: surfaceManifest.manifestFingerprint,
  });
  return resultFromReader('published', job, published, quarantinedCorruptArtifact);
}

function validateJobEnvelope(job: AssemblyCompiledBroadRasterWorkerJobV1): void {
  if (
    !job?.request ||
    !SOURCE_FINGERPRINT_PATTERN.test(job.sourceFingerprint) ||
    typeof job.scenePath !== 'string' ||
    job.scenePath.trim().length === 0 ||
    typeof job.authorizedSceneRealPath !== 'string' ||
    job.authorizedSceneRealPath.trim().length === 0 ||
    !job.sceneManifest ||
    !SHA256_PATTERN.test(job.expectedPayloadSha256) ||
    !SHA256_PATTERN.test(job.expectedSurfaceManifestFingerprint) ||
    typeof job.forceRebuildExistingArtifact !== 'boolean'
  ) {
    throw new Error('Compiled broad raster worker rejected an invalid job envelope.');
  }
}

function validateSceneIdentity(job: AssemblyCompiledBroadRasterWorkerJobV1): void {
  const manifest = job.sceneManifest;
  const request = job.request;
  let assemblyLengthBp = 0;
  for (const chromosome of request.chromosomes) {
    assemblyLengthBp += chromosome.length;
    if (!Number.isSafeInteger(assemblyLengthBp)) {
      throw new Error('Compiled broad raster worker rejected an unsafe assembly length.');
    }
  }
  if (
    manifest.integrity.payloadSha256 !== job.expectedPayloadSha256 ||
    manifest.datasetContract.datasetId !== request.datasetContract.datasetId ||
    manifest.datasetContract.datasetVersion !== request.datasetContract.datasetVersion ||
    manifest.datasetContract.sourceSha256 !== request.datasetContract.sourceSha256 ||
    manifest.assemblyContract.assemblyId !== request.assemblyId ||
    manifest.assemblyContract.assemblyLengthBp !== assemblyLengthBp ||
    manifest.partitionSpanBp !== request.artifact.partitionSpanBp
  ) {
    throw new Error('Compiled broad raster worker rejected a mismatched scene identity.');
  }
}

function exactScenePayload(bytes: Uint8Array, expectedByteLength: number): Uint8Array {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== expectedByteLength) {
    throw new Error('Compiled broad raster worker rejected a truncated scene payload.');
  }
  return bytes;
}

function reconstituteValidatedPackedScene(
  manifest: PartitionedTranscriptSceneBinaryManifestV4,
  payload: Uint8Array
): PackedPartitionedTranscriptSceneBinaryV4 {
  return {
    manifest,
    payload,
    packWork: {
      sourcePrimitiveCount: manifest.sourcePrimitiveCount,
      expandedDirectPrimitiveCount: manifest.directContract.expanded.instanceCount,
      canonicalDirectPrimitiveCount: manifest.directContract.canonical.instanceCount,
      retainedExpandedSourceGlyphBytes: 0,
      retainedPolicyGpuBytes: 0,
      fineRecordIndexCount:
        manifest.sections.expandedFineBankRecordIndices.count +
        manifest.sections.canonicalFineBankRecordIndices.count,
    },
  };
}

function resultFromReader(
  status: AssemblyCompiledBroadRasterWorkerResultV1['status'],
  job: AssemblyCompiledBroadRasterWorkerJobV1,
  reader: CompiledBroadRasterArtifactReaderV1,
  quarantinedCorruptArtifact: boolean
): AssemblyCompiledBroadRasterWorkerResultV1 {
  if (
    reader.manifest.surfaceManifest.manifestFingerprint !== job.expectedSurfaceManifestFingerprint
  ) {
    throw new Error('Compiled broad raster worker opened a mismatched artifact.');
  }
  return Object.freeze({
    status,
    sourceFingerprint: job.sourceFingerprint,
    surfaceManifestFingerprint: job.expectedSurfaceManifestFingerprint,
    catalogFingerprint: reader.manifest.catalogFingerprint,
    quarantinedCorruptArtifact,
  });
}

function isMissingArtifact(error: unknown): boolean {
  return error instanceof CompiledBroadRasterArtifactError && error.code === 'artifact-not-found';
}

function isCorruptArtifactCatalog(error: unknown): boolean {
  return error instanceof CompiledBroadRasterArtifactError && error.code === 'invalid-manifest';
}

async function quarantineCorruptArtifactDirectory(artifactDirectory: string): Promise<boolean> {
  const quarantinePath = `${artifactDirectory}.quarantine.${Date.now()}.${randomUUID()}`;
  try {
    await rename(artifactDirectory, quarantinePath);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}
