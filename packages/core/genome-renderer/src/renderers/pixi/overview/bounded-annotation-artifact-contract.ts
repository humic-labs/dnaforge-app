export const BOUNDED_ANNOTATION_ARTIFACT_IDENTITY_V1 =
  'bounded-annotation-artifact-identity.v1' as const;

export interface AnnotationTrackArtifactIdentityInputV1 {
  readonly assemblyIdentity: string;
  readonly genomeIdentity: string;
  readonly genomeLengthBp: number;
  readonly sourceFingerprint: string;
  readonly placementFingerprint: string;
  readonly trackId: string;
  readonly trackType: string;
  readonly sourceShardManifestFingerprint: string;
  readonly themeFingerprint: string;
  readonly glyphGeometryFingerprint: string;
  readonly lanePlacementContract: string;
  readonly broadSurfaceContract: string;
  readonly interactionIndexContract: string;
}

export interface AnnotationTrackArtifactIdentityV1 extends AnnotationTrackArtifactIdentityInputV1 {
  readonly contract: typeof BOUNDED_ANNOTATION_ARTIFACT_IDENTITY_V1;
  readonly artifactKey: string;
}

export function createAnnotationTrackArtifactIdentityV1(
  input: AnnotationTrackArtifactIdentityInputV1
): AnnotationTrackArtifactIdentityV1 {
  const identity: AnnotationTrackArtifactIdentityInputV1 = {
    assemblyIdentity: requiredToken(input.assemblyIdentity, 'assemblyIdentity'),
    genomeIdentity: requiredToken(input.genomeIdentity, 'genomeIdentity'),
    genomeLengthBp: positiveSafeInteger(input.genomeLengthBp, 'genomeLengthBp'),
    sourceFingerprint: sha256(input.sourceFingerprint, 'sourceFingerprint'),
    placementFingerprint: sha256(input.placementFingerprint, 'placementFingerprint'),
    trackId: requiredToken(input.trackId, 'trackId'),
    trackType: requiredToken(input.trackType, 'trackType'),
    sourceShardManifestFingerprint: sha256(
      input.sourceShardManifestFingerprint,
      'sourceShardManifestFingerprint'
    ),
    themeFingerprint: sha256(input.themeFingerprint, 'themeFingerprint'),
    glyphGeometryFingerprint: sha256(input.glyphGeometryFingerprint, 'glyphGeometryFingerprint'),
    lanePlacementContract: requiredToken(input.lanePlacementContract, 'lanePlacementContract'),
    broadSurfaceContract: requiredToken(input.broadSurfaceContract, 'broadSurfaceContract'),
    interactionIndexContract: requiredToken(
      input.interactionIndexContract,
      'interactionIndexContract'
    ),
  };
  return Object.freeze({
    contract: BOUNDED_ANNOTATION_ARTIFACT_IDENTITY_V1,
    ...identity,
    artifactKey: annotationTrackArtifactKeyV1(identity),
  });
}

export function annotationTrackArtifactKeyV1(
  input: AnnotationTrackArtifactIdentityInputV1
): string {
  return `bounded-annotation-artifact.v1:${frame([
    requiredToken(input.assemblyIdentity, 'assemblyIdentity'),
    requiredToken(input.genomeIdentity, 'genomeIdentity'),
    String(positiveSafeInteger(input.genomeLengthBp, 'genomeLengthBp')),
    sha256(input.sourceFingerprint, 'sourceFingerprint'),
    sha256(input.placementFingerprint, 'placementFingerprint'),
    requiredToken(input.trackId, 'trackId'),
    requiredToken(input.trackType, 'trackType'),
    sha256(input.sourceShardManifestFingerprint, 'sourceShardManifestFingerprint'),
    sha256(input.themeFingerprint, 'themeFingerprint'),
    sha256(input.glyphGeometryFingerprint, 'glyphGeometryFingerprint'),
    requiredToken(input.lanePlacementContract, 'lanePlacementContract'),
    requiredToken(input.broadSurfaceContract, 'broadSurfaceContract'),
    requiredToken(input.interactionIndexContract, 'interactionIndexContract'),
  ])}`;
}

function requiredToken(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`bounded annotation artifact ${label} is required`);
  }
  return value.trim();
}

function sha256(value: unknown, label: string): string {
  const normalized = requiredToken(value, label);
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(`bounded annotation artifact ${label} must be a lowercase SHA-256`);
  }
  return normalized;
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`bounded annotation artifact ${label} must be a positive safe integer`);
  }
  return value as number;
}

function frame(parts: readonly string[]): string {
  return parts.map((part) => `${part.length}:${part}`).join('');
}
