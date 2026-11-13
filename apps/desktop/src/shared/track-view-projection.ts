import { contentFingerprint } from './content-fingerprint';
import { serializeTrackViewDocument, type TrackViewDocument } from './track-view';

export function trackViewTrackCount(document: TrackViewDocument): number {
  return document.dataTracks.length + document.bamTracks.length + (document.variantSource ? 1 : 0);
}

export function trackViewProjectionFields(document: TrackViewDocument): Record<string, unknown> {
  return {
    artifactFingerprint: contentFingerprint(serializeTrackViewDocument(document)),
    referenceAssemblyId: document.reference.assemblyId,
    referenceName: document.reference.name,
    trackCount: trackViewTrackCount(document),
  };
}
