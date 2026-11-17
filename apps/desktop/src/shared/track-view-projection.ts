import { contentFingerprint } from './content-fingerprint';
import { serializeTrackViewDocument, type TrackViewDocument } from './track-view';

export function trackViewTrackCount(document: TrackViewDocument): number {
  return document.dataTracks.length + document.bamTracks.length + (document.variantSource ? 1 : 0);
}

export function trackViewProjectionOwnership(
  fileWorkspaceId: number | null,
  registeredWorkspaceId: number | null | undefined
): { fileWorkspaceId: number | null; registryWorkspaceId: number | null } {
  return {
    fileWorkspaceId,
    registryWorkspaceId: fileWorkspaceId ?? registeredWorkspaceId ?? null,
  };
}

export function trackViewProjectionFields(document: TrackViewDocument) {
  return {
    artifactFingerprint: contentFingerprint(serializeTrackViewDocument(document)),
    referenceAssemblyId: document.reference.assemblyId,
    referenceName: document.reference.name,
    trackCount: trackViewTrackCount(document),
  };
}
