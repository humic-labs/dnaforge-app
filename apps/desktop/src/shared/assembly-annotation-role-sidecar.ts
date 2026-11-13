import { sha256Hex } from './sha256-sync';
import {
  isAnnotationColorRoleKeyV1,
  type AnnotationColorRoleKeyV1,
  type PartitionedTranscriptSceneBinaryManifestV4,
  type PartitionedTranscriptSceneRoleSidecarV1,
} from '@waypoint/genome-renderer/pure';

export interface AssemblyAnnotationRoleSidecarDiskDescriptorV1 {
  version: 1;
  file: string;
  byteCount: number;
  payloadSha256: string;
  roleTable: AnnotationColorRoleKeyV1[];
  expandedCount: number;
  canonicalCount: number;
}

export const ASSEMBLY_ANNOTATION_ROLE_SIDECAR_MAX_ROLES_V1 = 256;

export function annotationRoleSidecarFileNameV1(
  assemblyId: string,
  fingerprint: string,
  companionKey: string,
  sourcePayloadSha256: string,
  sidecarPayloadSha256: string
): string {
  const identitySha256 = sha256Hex(
    JSON.stringify([
      assemblyId,
      fingerprint,
      companionKey,
      sourcePayloadSha256,
      sidecarPayloadSha256,
    ])
  );
  return `${identitySha256}.annotation-roles.v1.bin`;
}

export function encodeAnnotationRoleSidecarV1(
  sidecar: PartitionedTranscriptSceneRoleSidecarV1,
  sceneManifest: PartitionedTranscriptSceneBinaryManifestV4,
  identity: { assemblyId: string; fingerprint: string; companionKey: string }
): { payload: Uint8Array; descriptor: AssemblyAnnotationRoleSidecarDiskDescriptorV1 } | null {
  const roleTable = [...sidecar.roleTable];
  const expanded = sidecar.expandedRoleIndices;
  const canonical = sidecar.canonicalRoleIndices;
  if (
    !roleTableIsValid(roleTable) ||
    !(expanded instanceof Uint8Array) ||
    !(canonical instanceof Uint8Array) ||
    expanded.length !== sceneManifest.sections.expandedGlyphs.count ||
    canonical.length !== sceneManifest.sections.canonicalGlyphs.count ||
    !indicesAreInTable(expanded, roleTable.length) ||
    !indicesAreInTable(canonical, roleTable.length)
  ) {
    return null;
  }
  const payload = new Uint8Array(expanded.length + canonical.length);
  payload.set(expanded, 0);
  payload.set(canonical, expanded.length);
  const payloadSha256 = sha256Hex(payload);
  return {
    payload,
    descriptor: {
      version: 1,
      file: annotationRoleSidecarFileNameV1(
        identity.assemblyId,
        identity.fingerprint,
        identity.companionKey,
        sceneManifest.integrity.payloadSha256,
        payloadSha256
      ),
      byteCount: payload.byteLength,
      payloadSha256,
      roleTable,
      expandedCount: expanded.length,
      canonicalCount: canonical.length,
    },
  };
}

export function annotationRoleSidecarDescriptorMatchesSceneV1(
  descriptor: AssemblyAnnotationRoleSidecarDiskDescriptorV1,
  sceneManifest: PartitionedTranscriptSceneBinaryManifestV4,
  identity: { assemblyId: string; fingerprint: string; companionKey: string }
): boolean {
  return (
    descriptor?.version === 1 &&
    typeof descriptor.payloadSha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(descriptor.payloadSha256) &&
    roleTableIsValid(descriptor.roleTable) &&
    descriptor.expandedCount === sceneManifest.sections.expandedGlyphs.count &&
    descriptor.canonicalCount === sceneManifest.sections.canonicalGlyphs.count &&
    descriptor.byteCount === descriptor.expandedCount + descriptor.canonicalCount &&
    descriptor.file ===
      annotationRoleSidecarFileNameV1(
        identity.assemblyId,
        identity.fingerprint,
        identity.companionKey,
        sceneManifest.integrity.payloadSha256,
        descriptor.payloadSha256
      )
  );
}

export function admitAnnotationRoleSidecarPayloadV1(
  descriptor: Pick<
    AssemblyAnnotationRoleSidecarDiskDescriptorV1,
    'payloadSha256' | 'roleTable' | 'expandedCount' | 'canonicalCount' | 'byteCount'
  >,
  payload: Uint8Array
): PartitionedTranscriptSceneRoleSidecarV1 | null {
  if (
    payload.byteLength !== descriptor.byteCount ||
    sha256Hex(payload) !== descriptor.payloadSha256 ||
    !indicesAreInTable(payload, descriptor.roleTable.length)
  ) {
    return null;
  }
  return {
    roleTable: [...descriptor.roleTable],
    expandedRoleIndices: payload.subarray(0, descriptor.expandedCount),
    canonicalRoleIndices: payload.subarray(descriptor.expandedCount),
  };
}

function roleTableIsValid(roleTable: unknown): roleTable is AnnotationColorRoleKeyV1[] {
  return (
    Array.isArray(roleTable) &&
    roleTable.length > 0 &&
    roleTable.length <= ASSEMBLY_ANNOTATION_ROLE_SIDECAR_MAX_ROLES_V1 &&
    roleTable.every(isAnnotationColorRoleKeyV1) &&
    new Set(roleTable).size === roleTable.length
  );
}

function indicesAreInTable(indices: Uint8Array, tableLength: number): boolean {
  for (let index = 0; index < indices.length; index++) {
    if (indices[index] >= tableLength) return false;
  }
  return true;
}
