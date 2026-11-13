import { open, type FileHandle } from 'node:fs/promises';

import {
  packPartitionedTranscriptSceneDetailPacketV1,
  slicePartitionedTranscriptSceneDetailRolesV1,
  type AuthenticatedTranscriptSceneRangeV1,
  type PackedPartitionedTranscriptSceneDetailPacketV1,
  type PartitionedTranscriptSceneRoleSidecarV1,
} from '@waypoint/genome-renderer/pure';

import {
  ASSEMBLY_ANNOTATION_SCENE_DETAIL_IPC_V1,
  type AssemblyAnnotationSceneDetailReadRequestV1,
  type AssemblyAnnotationSceneReadRequest,
} from '../../shared/indexed-genome';
import { sha256BoundedNodeV1 } from './bounded-binary-sha256';
import type {
  AssemblyAnnotationRoleSidecarCacheIndexV1,
  AssemblyAnnotationSceneCacheIndexHit,
  AssemblyAnnotationSceneCacheIndexReadResult,
} from './assembly-overview-texture-cache';

export interface AssemblyAnnotationSceneDetailPacketHitV1 {
  readonly status: 'hit';
  readonly fingerprint: string;
  readonly sourceBuildFingerprint: string;
  readonly scope: AssemblyAnnotationSceneCacheIndexHit['scope'];
  readonly artifact: AssemblyAnnotationSceneCacheIndexHit['artifact'];
  readonly packet: PackedPartitionedTranscriptSceneDetailPacketV1;
  readonly colorRoles?: PartitionedTranscriptSceneRoleSidecarV1;
}

export interface AssemblyAnnotationSceneDetailPacketUnavailableV1 {
  readonly status: 'unavailable';
  readonly reason: 'range-catalog-unavailable';
  readonly fingerprint: string;
  readonly sourceBuildFingerprint: string;
  readonly scope: AssemblyAnnotationSceneCacheIndexHit['scope'];
  readonly artifact: AssemblyAnnotationSceneCacheIndexHit['artifact'];
}

export type AssemblyAnnotationSceneDetailPacketReadResultV1 =
  | AssemblyAnnotationSceneDetailPacketHitV1
  | AssemblyAnnotationSceneDetailPacketUnavailableV1;

export interface AssemblyAnnotationSceneDetailPacketDepsV1 {
  readonly readIndex: (
    request: AssemblyAnnotationSceneReadRequest
  ) => Promise<AssemblyAnnotationSceneCacheIndexReadResult | null>;
  readonly readRange?: (
    path: string,
    range: AuthenticatedTranscriptSceneRangeV1
  ) => Promise<Uint8Array>;
  readonly authorizePath?: (path: string) => Promise<void>;
  readonly readRoleSidecar?: (
    index: AssemblyAnnotationRoleSidecarCacheIndexV1
  ) => Promise<PartitionedTranscriptSceneRoleSidecarV1 | null>;
}

export async function readAssemblyAnnotationSceneDetailPacketV1(
  request: AssemblyAnnotationSceneDetailReadRequestV1,
  deps: AssemblyAnnotationSceneDetailPacketDepsV1
): Promise<AssemblyAnnotationSceneDetailPacketReadResultV1 | null> {
  if (
    request?.contract !== ASSEMBLY_ANNOTATION_SCENE_DETAIL_IPC_V1 ||
    !request.source ||
    !Number.isSafeInteger(request.startBp) ||
    !Number.isSafeInteger(request.endBp) ||
    request.startBp < 0 ||
    request.endBp <= request.startBp
  ) {
    return null;
  }
  const indexed = await deps.readIndex(request.source);
  if (
    !indexed ||
    indexed.status !== 'hit' ||
    request.endBp > indexed.manifest.assemblyContract.assemblyLengthBp
  ) {
    return null;
  }
  if (!indexed.detailRangeCatalog) {
    return Object.freeze({
      status: 'unavailable',
      reason: 'range-catalog-unavailable',
      fingerprint: indexed.fingerprint,
      sourceBuildFingerprint: indexed.sourceBuildFingerprint,
      scope: indexed.scope,
      artifact: indexed.artifact,
    });
  }
  await deps.authorizePath?.(indexed.scenePath);
  const handle = deps.readRange ? null : await open(indexed.scenePath, 'r');
  let packet: PackedPartitionedTranscriptSceneDetailPacketV1;
  try {
    packet = await packPartitionedTranscriptSceneDetailPacketV1({
      sourceManifest: indexed.manifest,
      rangeCatalog: indexed.detailRangeCatalog,
      startBp: request.startBp,
      endBp: request.endBp,
      readRange: deps.readRange
        ? (range) => deps.readRange!(indexed.scenePath, range)
        : (range) => readFileRange(handle!, range),
      payloadSha256: sha256BoundedNodeV1,
    });
  } finally {
    await handle?.close();
  }
  const parentRoles =
    indexed.roleSidecar && deps.readRoleSidecar
      ? await deps.readRoleSidecar(indexed.roleSidecar)
      : null;
  const colorRoles = parentRoles
    ? slicePartitionedTranscriptSceneDetailRolesV1(
        indexed.detailRangeCatalog,
        packet.manifest.selectedPartitionIndices,
        parentRoles
      )
    : null;
  const current = await deps.readIndex(request.source);
  if (!current || current.status !== 'hit' || !sameSceneIndex(indexed, current)) return null;
  return Object.freeze({
    ...(colorRoles ? { colorRoles } : {}),
    status: 'hit',
    fingerprint: indexed.fingerprint,
    sourceBuildFingerprint: indexed.sourceBuildFingerprint,
    scope: indexed.scope,
    artifact: indexed.artifact,
    packet,
  });
}

async function readFileRange(
  handle: FileHandle,
  range: AuthenticatedTranscriptSceneRangeV1
): Promise<Uint8Array> {
  const bytes = Buffer.allocUnsafe(range.byteLength);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.read(
      bytes,
      offset,
      bytes.byteLength - offset,
      range.byteOffset + offset
    );
    if (result.bytesRead <= 0) break;
    offset += result.bytesRead;
  }
  if (offset !== bytes.byteLength) {
    throw new Error('annotation scene detail range read was truncated');
  }
  return bytes;
}

function sameSceneIndex(
  left: AssemblyAnnotationSceneCacheIndexHit,
  right: AssemblyAnnotationSceneCacheIndexHit
): boolean {
  return (
    left.scenePath === right.scenePath &&
    left.fingerprint === right.fingerprint &&
    left.sourceBuildFingerprint === right.sourceBuildFingerprint &&
    left.payloadSha256 === right.payloadSha256 &&
    left.manifest.integrity.contractSha256 === right.manifest.integrity.contractSha256 &&
    left.detailRangeCatalog?.sourceScene.payloadSha256 ===
      right.detailRangeCatalog?.sourceScene.payloadSha256 &&
    left.detailRangeCatalog?.sourceScene.contractSha256 ===
      right.detailRangeCatalog?.sourceScene.contractSha256
  );
}
