import type { PrepackedAnnotationSceneLoadInput } from '../overview/prepacked-annotation-scene';

export type PrepackedAnnotationSceneMetadataView = Readonly<{
  genomeIdentity: string;
  genomeLengthBp: number;
  partitionSpanBp: number;
  artifactKey: string;
  themeMode: string;
  trackType: string;
  annotationBarHeightPx: number;
  laneAlgorithmToken: string;
  mapperContractToken: string;
  geometryContractToken: string;
  interactionContractToken: string;
}>;

export function prepackedAnnotationSceneMetadataEqual(
  left: PrepackedAnnotationSceneMetadataView,
  right: PrepackedAnnotationSceneMetadataView
): boolean {
  return (
    left.genomeIdentity === right.genomeIdentity &&
    left.genomeLengthBp === right.genomeLengthBp &&
    left.partitionSpanBp === right.partitionSpanBp &&
    left.artifactKey === right.artifactKey &&
    left.themeMode === right.themeMode &&
    left.trackType === right.trackType &&
    left.annotationBarHeightPx === right.annotationBarHeightPx &&
    left.laneAlgorithmToken === right.laneAlgorithmToken &&
    left.mapperContractToken === right.mapperContractToken &&
    left.geometryContractToken === right.geometryContractToken &&
    left.interactionContractToken === right.interactionContractToken
  );
}

export function prepackedAnnotationSceneBankCompatible(
  left: PrepackedAnnotationSceneMetadataView,
  right: PrepackedAnnotationSceneMetadataView
): boolean {
  return (
    left.genomeIdentity === right.genomeIdentity &&
    left.genomeLengthBp === right.genomeLengthBp &&
    left.partitionSpanBp === right.partitionSpanBp &&
    left.annotationBarHeightPx === right.annotationBarHeightPx &&
    left.laneAlgorithmToken === right.laneAlgorithmToken &&
    left.mapperContractToken === right.mapperContractToken &&
    left.geometryContractToken === right.geometryContractToken &&
    left.interactionContractToken === right.interactionContractToken
  );
}

export function trustedV4OuterProvenanceMatches(input: PrepackedAnnotationSceneLoadInput): boolean {
  const provenance = input.trustedRendererAdmissionProvenanceV4;
  const loadIdentity = input.trustedRendererAdmissionLoadIdentityV4;
  if (!provenance || !loadIdentity) return false;
  const owner = input.ownerKey.split('\n');
  return (
    loadIdentity.ownerKey === input.ownerKey &&
    loadIdentity.sceneContractSha256 === provenance.contractSha256 &&
    loadIdentity.genomeIdentity === input.metadata.genomeIdentity &&
    loadIdentity.genomeLengthBp === input.metadata.genomeLengthBp &&
    loadIdentity.partitionSpanBp === input.metadata.partitionSpanBp &&
    loadIdentity.artifactKey === input.metadata.artifactKey &&
    loadIdentity.themeMode === input.metadata.themeMode &&
    loadIdentity.trackType === input.metadata.trackType &&
    loadIdentity.annotationBarHeightPx === input.metadata.annotationBarHeightPx &&
    loadIdentity.laneAlgorithmToken === input.metadata.laneAlgorithmToken &&
    loadIdentity.mapperContractToken === input.metadata.mapperContractToken &&
    loadIdentity.geometryContractToken === input.metadata.geometryContractToken &&
    loadIdentity.interactionContractToken === input.metadata.interactionContractToken &&
    input.metadata.genomeIdentity ===
      `assembly-annotation-source-sha256.v1:${provenance.sourceSha256}` &&
    input.metadata.genomeLengthBp === provenance.assemblyLengthBp &&
    owner.length === 4 &&
    owner[0] === 'annotation-scene-owner.v3' &&
    /^[0-9a-f]{24}$/.test(owner[1]) &&
    owner[2] === provenance.payloadSha256 &&
    owner[3] === input.metadata.artifactKey
  );
}
