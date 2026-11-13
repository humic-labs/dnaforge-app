import {
  parseScientificCloudHistory,
  scientificCloudVersionHashInput,
  type ScientificCloudHistoryV1,
} from '@waypoint/scientific-objects';
import { defineBlob, parseBlobHash, type BlobRef } from '@waypoint/workspace-revisions';
import type { WorkspaceSyncManifestV1 } from '@waypoint/share-bundle';
import { isWorkspaceSyncRemoteUuid } from './workspace-sync-remote-id';

export interface WorkspaceSyncScientificHistoryMetadata {
  scientificHistory?: ScientificCloudHistoryV1;
  scientificBlobRefs?: readonly BlobRef[];
  fileManifestSha256?: string;
}

export function parseScientificCloudResourceIdentities(
  value: unknown,
  manifest: WorkspaceSyncManifestV1
): { path: string; resourceId: string }[] {
  if (!Array.isArray(value)) throw new Error('Scientific receipt has no resource identities.');
  const paths = new Set(manifest.files.map((file) => file.path));
  const ids = new Set<string>();
  let previous: string | undefined;
  const identities = value.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error('Scientific receipt resource identity is invalid.');
    const identity = entry as Record<string, unknown>;
    if (
      Object.keys(identity).sort().join(',') !== 'path,resourceId' ||
      typeof identity.path !== 'string' ||
      !paths.delete(identity.path) ||
      !isWorkspaceSyncRemoteUuid(identity.resourceId) ||
      ids.has(identity.resourceId) ||
      (previous !== undefined &&
        Buffer.compare(Buffer.from(previous), Buffer.from(identity.path)) >= 0)
    )
      throw new Error('Scientific receipt resource identities are incomplete or not canonical.');
    previous = identity.path;
    ids.add(identity.resourceId);
    return { path: identity.path, resourceId: identity.resourceId };
  });
  if (paths.size) throw new Error('Scientific receipt resource identities are incomplete.');
  return identities;
}

export function parseWorkspaceSyncScientificHistoryMetadata(
  value: {
    scientificHistory?: unknown;
    scientificBlobRefs?: unknown;
    fileManifestSha256?: unknown;
  },
  manifestSha256: string
): Required<WorkspaceSyncScientificHistoryMetadata> | null {
  if (
    value.scientificHistory === undefined &&
    value.scientificBlobRefs === undefined &&
    value.fileManifestSha256 === undefined
  )
    return null;
  const scientificHistory = parseScientificCloudHistory(value.scientificHistory);
  if (value.fileManifestSha256 !== manifestSha256 || !Array.isArray(value.scientificBlobRefs))
    throw new Error('Scientific upload authority has inconsistent file or blob metadata.');
  let previous = '';
  const scientificBlobRefs = value.scientificBlobRefs.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error('Scientific upload blob inventory is invalid.');
    const blob = entry as Record<string, unknown>;
    const hash = typeof blob.hash === 'string' ? parseBlobHash(blob.hash) : null;
    if (
      Object.keys(blob).sort().join(',') !== 'byteLength,hash' ||
      !hash?.ok ||
      typeof blob.byteLength !== 'number' ||
      !Number.isSafeInteger(blob.byteLength) ||
      blob.byteLength < 0 ||
      hash.value <= previous
    )
      throw new Error('Scientific upload blob inventory is invalid or not canonical.');
    previous = hash.value;
    return Object.freeze({ hash: hash.value, byteLength: blob.byteLength });
  });
  return {
    scientificHistory,
    scientificBlobRefs: Object.freeze(scientificBlobRefs),
    fileManifestSha256: manifestSha256,
  };
}

export function workspaceSyncScientificContentSha256(
  manifestSha256: string,
  descriptor: ScientificCloudHistoryV1
): string {
  return defineBlob(
    new TextEncoder().encode(scientificCloudVersionHashInput(manifestSha256, descriptor))
  ).hash.slice('sha256:'.length);
}
