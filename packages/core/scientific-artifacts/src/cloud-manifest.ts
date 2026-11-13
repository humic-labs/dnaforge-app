import {
  inspectResourceRevision,
  inspectResourceState,
  listWorkspaceResources,
  type BlobRef,
  type ResourceId,
  type RevisionGraph,
  type WorkspaceVersionId,
} from '@waypoint/workspace-revisions';
import type { WorkspaceSyncManifestV1 } from '@waypoint/share-bundle';
import { isSequencePackageAdmissionMarker } from '@waypoint/share-bundle/sequence-package-admission';

export interface ScientificHistoryCurrentFile {
  readonly path: string;
  readonly resourceId: ResourceId;
  readonly blob: BlobRef;
}

export function scientificHistoryCurrentFiles(
  graph: RevisionGraph,
  head: WorkspaceVersionId | null
): readonly ScientificHistoryCurrentFile[] {
  if (head === null) return [];
  const listed = listWorkspaceResources(graph, head);
  if (!listed.ok) throw new Error('Scientific cloud namespace is unavailable.');
  const files: ScientificHistoryCurrentFile[] = [];
  for (const slot of listed.value) {
    if (slot.tombstone || slot.path === null) continue;
    const revision = inspectResourceRevision(graph, slot.revisionId);
    const state =
      revision.ok && revision.value.stateHash
        ? inspectResourceState(graph, revision.value.stateHash)
        : null;
    if (!state?.ok) throw new Error('Scientific cloud projection has no accepted bytes.');
    if (state.value.layout === 'file')
      files.push({ path: slot.path, resourceId: slot.resourceId, blob: state.value.blob });
    else
      for (const member of state.value.members)
        files.push({
          path: `${slot.path}/${member.relativePath}`,
          resourceId: slot.resourceId,
          blob: member.blob,
        });
  }
  return Object.freeze(
    files
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((file) => Object.freeze(file))
  );
}

export function validateScientificCloudManifest(
  graph: RevisionGraph,
  head: WorkspaceVersionId | null,
  manifest: WorkspaceSyncManifestV1
): void {
  validateScientificCloudFileProjection(scientificHistoryCurrentFiles(graph, head), manifest);
}

export function validateScientificCloudFileProjection(
  projection: readonly ScientificHistoryCurrentFile[],
  manifest: WorkspaceSyncManifestV1
): void {
  const accepted = new Map(projection.map((file) => [file.path, file]));
  const files = new Map(manifest.files.map((file) => [file.path, file]));
  for (const [path, expected] of accepted) {
    const file = files.get(path);
    if (
      !file ||
      file.contentSha256 !== expected.blob.hash.slice('sha256:'.length) ||
      file.sizeBytes !== expected.blob.byteLength
    )
      throw new Error(
        `Cloud files differ from accepted scientific history: ${path}. Save or finish local delivery before syncing.`
      );
  }
  for (const file of manifest.files)
    if (isSequencePackageAdmissionMarker(file.path) && !accepted.has(file.path))
      throw new Error(`Cloud sequence package has no accepted scientific owner: ${file.path}.`);
}
