import type { AnnotationPolicyGpuRuntimeV1 } from '../overview/annotation-policy-gpu-instances-v1';
import { validatePrepackedAnnotationRuntimePolicy } from '../overview/prepacked-annotation-scene';
import {
  matchPrebuiltAnnotationRasterPresentation,
  type PrebuiltAnnotationRasterContractMatch,
} from '../overview/prebuilt-annotation-raster-contract';
import type { PrebuiltGenomeWideTextureMeta } from '../overview/genome-wide-texture-cache-layer';

export type PrebuiltTexturePolicyHost = {
  genomeLength: number;
  currentGenomeIdentity: string | null;
  currentAnnotationSourceFingerprint: string | null;
  currentAnnotationPlacementFingerprint: string | null;
  prepackedAnnotationSceneOwnerKey: string | null;
  prepackedAnnotationSceneResidents: {
    get(
      ownerKey: string
    ): { policyTrackLaneMaxima?: Record<'canonical' | 'expanded', number> | null } | undefined;
  };
  prepackedAnnotationRuntimePolicy: AnnotationPolicyGpuRuntimeV1 | null;
  prebuiltRasterContractForLastFrame: PrebuiltAnnotationRasterContractMatch;
  ensureGenomeWideTextureCacheLayer(): {
    preparePrebuiltTexture(image: ImageBitmap, meta: PrebuiltGenomeWideTextureMeta): unknown;
    discardPreparedPrebuiltTexture(prepared: unknown): void;
    activatePreparedPrebuiltTexture(prepared: unknown): boolean;
  };
  annotationLayerTypesForPresentation(): string[];
  updatePrepackedAnnotationPolicy(policy: AnnotationPolicyGpuRuntimeV1): boolean;
};

export function commitPrebuiltGenomeWideTexturePolicy(
  host: PrebuiltTexturePolicyHost,
  image: ImageBitmap,
  meta: PrebuiltGenomeWideTextureMeta,
  policy: AnnotationPolicyGpuRuntimeV1
): boolean {
  if (
    !validatePrepackedAnnotationRuntimePolicy(policy) ||
    host.genomeLength <= 0 ||
    meta.genomeLength !== host.genomeLength
  ) {
    return false;
  }
  const layer = host.ensureGenomeWideTextureCacheLayer();
  const prepared = layer.preparePrebuiltTexture(image, meta);
  if (!prepared) return false;

  const ownerResident = host.prepackedAnnotationSceneOwnerKey
    ? host.prepackedAnnotationSceneResidents.get(host.prepackedAnnotationSceneOwnerKey)
    : null;
  const maxima = ownerResident?.policyTrackLaneMaxima;
  if (!maxima) {
    layer.discardPreparedPrebuiltTexture(prepared);
    return false;
  }
  const expectedMaxAnnotationLane =
    policy.laneLimit === null ? maxima[policy.isoformMode] : policy.laneLimit - 1;
  const candidateContract = matchPrebuiltAnnotationRasterPresentation(
    meta.semanticReceipt,
    {
      genomeIdentity: host.currentGenomeIdentity ?? '',
      genomeLengthBp: host.genomeLength,
      sourceFingerprint: host.currentAnnotationSourceFingerprint,
      placementFingerprint: host.currentAnnotationPlacementFingerprint,
      runtimePolicy: policy,
      layerTypes: host.annotationLayerTypesForPresentation(),
      maxAnnotationLane: expectedMaxAnnotationLane,
      maxCdsLane: -1,
      themeMode: meta.semanticReceipt?.themeMode ?? 'light',
    },
    meta.laneProjection
  );
  if (!candidateContract.contractMatch) {
    layer.discardPreparedPrebuiltTexture(prepared);
    return false;
  }

  const previousPolicy = host.prepackedAnnotationRuntimePolicy
    ? { ...host.prepackedAnnotationRuntimePolicy }
    : null;
  if (!host.updatePrepackedAnnotationPolicy(policy)) {
    layer.discardPreparedPrebuiltTexture(prepared);
    return false;
  }
  if (!layer.activatePreparedPrebuiltTexture(prepared)) {
    if (previousPolicy) host.updatePrepackedAnnotationPolicy(previousPolicy);
    layer.discardPreparedPrebuiltTexture(prepared);
    return false;
  }
  host.prebuiltRasterContractForLastFrame = candidateContract;
  return true;
}
