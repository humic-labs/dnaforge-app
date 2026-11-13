import { COMPILED_BROAD_SURFACE_ADMISSION_PROVENANCE_V1 } from '../overview/bounded-annotation-broad-surface';

export function compiledBroadSurfaceProvenanceFailure(input: {
  provenance:
    | {
        contract: string;
        manifestFingerprint: string;
        artifactKey: string;
        trackId: string;
        genomeIdentity: string;
        genomeLengthBp: number;
        sourceFingerprint: string;
        placementFingerprint: string;
        prepackedOwnerKey: string;
        prepackedArtifactKey: string;
      }
    | null
    | undefined;
  manifest: {
    manifestFingerprint: string;
    artifactKey: string;
    trackId: string;
  };
  currentGenomeIdentity: string;
  genomeLengthBp: number;
  currentAnnotationSourceFingerprint: string | null;
  currentAnnotationPlacementFingerprint: string | null;
}): string | null {
  const provenance = input.provenance;
  const manifest = input.manifest;
  if (
    !provenance ||
    provenance.contract !== COMPILED_BROAD_SURFACE_ADMISSION_PROVENANCE_V1 ||
    provenance.manifestFingerprint !== manifest.manifestFingerprint ||
    provenance.artifactKey !== manifest.artifactKey ||
    provenance.trackId !== manifest.trackId ||
    provenance.genomeIdentity !== input.currentGenomeIdentity ||
    provenance.genomeLengthBp !== input.genomeLengthBp ||
    provenance.sourceFingerprint.length === 0 ||
    provenance.sourceFingerprint !== input.currentAnnotationSourceFingerprint ||
    provenance.placementFingerprint.length === 0 ||
    provenance.placementFingerprint !== input.currentAnnotationPlacementFingerprint ||
    provenance.prepackedOwnerKey.length === 0 ||
    provenance.prepackedArtifactKey.length === 0
  ) {
    return 'compiled-broad-surface-provenance-identity-mismatch';
  }
  return null;
}

export function compiledBroadInteractionResidentMatchesOwner(input: {
  resident:
    | {
        input?: { ownerKey?: string };
        metadata: {
          artifactKey: string;
          genomeIdentity: string;
          genomeLengthBp: number;
          trackType: string;
        };
      }
    | undefined;
  provenance: {
    prepackedOwnerKey: string;
    prepackedArtifactKey: string;
    genomeIdentity: string;
    genomeLengthBp: number;
  };
  manifestTrackId: string;
}): boolean {
  const resident = input.resident;
  return Boolean(
    resident &&
    resident.input?.ownerKey === input.provenance.prepackedOwnerKey &&
    resident.metadata.artifactKey === input.provenance.prepackedArtifactKey &&
    resident.metadata.genomeIdentity === input.provenance.genomeIdentity &&
    resident.metadata.genomeLengthBp === input.provenance.genomeLengthBp &&
    resident.metadata.trackType.toLocaleLowerCase() === input.manifestTrackId.toLocaleLowerCase()
  );
}

export function compiledBroadCompactInteractionResidentMatches(input: {
  resident:
    | {
        ownerKey: string;
        sourceFingerprint: string;
        metadata: {
          artifactKey: string;
          genomeIdentity: string;
          genomeLengthBp: number;
          trackType: string;
        };
      }
    | undefined;
  provenance: {
    prepackedOwnerKey: string;
    sourceFingerprint: string;
    prepackedArtifactKey: string;
    genomeIdentity: string;
    genomeLengthBp: number;
  };
  manifestTrackId: string;
}): boolean {
  const resident = input.resident;
  return Boolean(
    resident &&
    resident.ownerKey === input.provenance.prepackedOwnerKey &&
    resident.sourceFingerprint === input.provenance.sourceFingerprint &&
    resident.metadata.artifactKey === input.provenance.prepackedArtifactKey &&
    resident.metadata.genomeIdentity === input.provenance.genomeIdentity &&
    resident.metadata.genomeLengthBp === input.provenance.genomeLengthBp &&
    resident.metadata.trackType.toLocaleLowerCase() === input.manifestTrackId.toLocaleLowerCase()
  );
}

export function selectUniqueOrActivePrepackedResident<
  TResident extends { ownerKey: string; layer?: unknown },
>(input: {
  candidates: readonly TResident[];
  activeOwnerKey: string | null;
  activeLayer: unknown;
}): TResident | null {
  if (input.candidates.length === 1) return input.candidates[0] ?? null;
  return (
    input.candidates.find(
      (resident) =>
        resident.ownerKey === input.activeOwnerKey && resident.layer === input.activeLayer
    ) ?? null
  );
}

export function compiledBroadInteractionBlockedByDifferentActiveOwner(input: {
  activeTrackType: string | undefined;
  activeOwnerKey: string | undefined;
  trackId: string;
  expectedOwnerKey: string;
}): boolean {
  return Boolean(
    input.activeTrackType &&
    input.activeOwnerKey &&
    input.activeTrackType === input.trackId &&
    input.activeOwnerKey !== input.expectedOwnerKey
  );
}
