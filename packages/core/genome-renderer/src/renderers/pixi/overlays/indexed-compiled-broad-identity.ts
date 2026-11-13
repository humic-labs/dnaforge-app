export function shouldClearCompiledBroadOnGenomeChange(input: {
  hasCompiledSurface: boolean;
  currentLength: number | undefined;
  nextLength: number;
  previousGenomeIdentity: string;
  nextGenomeIdentity: string;
  compiledAuthority: {
    sourceFingerprint: string;
    placementFingerprint: string;
  } | null;
  nextProvenance: {
    sourceFingerprint: string;
    placementFingerprint: string;
  } | null;
}): boolean {
  if (!input.hasCompiledSurface) return false;
  return (
    input.currentLength !== input.nextLength ||
    (input.previousGenomeIdentity.length > 0 &&
      input.previousGenomeIdentity !== input.nextGenomeIdentity) ||
    (input.compiledAuthority !== null &&
      input.nextProvenance !== null &&
      (input.compiledAuthority.sourceFingerprint !== input.nextProvenance.sourceFingerprint ||
        input.compiledAuthority.placementFingerprint !== input.nextProvenance.placementFingerprint))
  );
}

export function compiledBroadSurfaceAdmissionIdentityMatches(input: {
  ownerManifest: {
    manifestFingerprint: string;
    artifactKey: string;
    trackId: string;
  };
  ownerProvenance: {
    contract: string;
    manifestFingerprint: string;
    artifactKey: string;
    trackId: string;
    genomeIdentity: string;
    genomeLengthBp: number;
    sourceFingerprint: string;
    placementFingerprint: string;
    themeMode?: string;
    prepackedOwnerKey: string;
    prepackedArtifactKey: string;
  };
  nextManifest: {
    manifestFingerprint: string;
    artifactKey: string;
    trackId: string;
  };
  nextProvenance: {
    contract: string;
    manifestFingerprint: string;
    artifactKey: string;
    trackId: string;
    genomeIdentity: string;
    genomeLengthBp: number;
    sourceFingerprint: string;
    placementFingerprint: string;
    themeMode?: string;
    prepackedOwnerKey: string;
    prepackedArtifactKey: string;
  };
}): boolean {
  const { ownerManifest, ownerProvenance, nextManifest, nextProvenance } = input;
  return (
    ownerManifest.manifestFingerprint === nextManifest.manifestFingerprint &&
    ownerManifest.artifactKey === nextManifest.artifactKey &&
    ownerManifest.trackId === nextManifest.trackId &&
    ownerProvenance.contract === nextProvenance.contract &&
    ownerProvenance.manifestFingerprint === nextProvenance.manifestFingerprint &&
    ownerProvenance.artifactKey === nextProvenance.artifactKey &&
    ownerProvenance.trackId === nextProvenance.trackId &&
    ownerProvenance.genomeIdentity === nextProvenance.genomeIdentity &&
    ownerProvenance.genomeLengthBp === nextProvenance.genomeLengthBp &&
    ownerProvenance.sourceFingerprint === nextProvenance.sourceFingerprint &&
    ownerProvenance.placementFingerprint === nextProvenance.placementFingerprint &&
    ownerProvenance.themeMode === nextProvenance.themeMode &&
    ownerProvenance.prepackedOwnerKey === nextProvenance.prepackedOwnerKey &&
    ownerProvenance.prepackedArtifactKey === nextProvenance.prepackedArtifactKey
  );
}
