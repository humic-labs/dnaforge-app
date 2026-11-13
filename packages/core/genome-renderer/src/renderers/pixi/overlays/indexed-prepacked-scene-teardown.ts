import type { PartitionedInstancedTranscriptLayer } from '../overview/partitioned-instanced-transcript-layer';
import type { PrepackedAnnotationSceneLoadInput } from '../overview/prepacked-annotation-scene';
import type { PrepackedAnnotationSceneMetadata } from '../overview/prepacked-annotation-scene';
import type { AnnotationPolicyGpuRuntimeV1 } from '../overview/annotation-policy-gpu-instances-v1';
import type { ViewerRenderContract } from '../overview/viewer-render-contract';
import type { AnnotationRolePaletteOverridesV1 } from '../../../annotation-role-palette';

export type PrepackedSceneTeardownResident = {
  ownerKey: string;
  input: PrepackedAnnotationSceneLoadInput;
  metadata: PrepackedAnnotationSceneMetadata;
  layer: PartitionedInstancedTranscriptLayer;
  visiblePartitionCount: number;
  visibleInstanceCount: number;
};

export type PrepackedSceneTeardownHost = {
  prepackedAnnotationSceneLastPresentation: {
    viewportStartBp: number;
    viewportEndBp: number;
    contract: ViewerRenderContract;
    viewportWidth: number;
    viewportHeight: number;
    cdsDetail: number;
    themeMode: 'light' | 'dark';
    rolePalette?: AnnotationRolePaletteOverridesV1;
  } | null;
  prepackedAnnotationSceneLayer: PartitionedInstancedTranscriptLayer | null;
  prepackedAnnotationSceneOwnerKey: string | null;
  prepackedAnnotationSceneOwnerMetadata: PrepackedAnnotationSceneMetadata | null;
  prepackedAnnotationSceneInput: PrepackedAnnotationSceneLoadInput | null;
  prepackedAnnotationSceneResidents: Map<string, PrepackedSceneTeardownResident>;
  prepackedAnnotationSceneReplacementCandidates: Map<string, PrepackedSceneTeardownResident>;
  prepackedAnnotationSceneLastCompleteOwnerKeys: readonly string[];
  prepackedAnnotationSceneResidentGeneration: number;
  prepackedAnnotationSceneOwnerGeneration: number;
  prepackedAnnotationSceneCameraUpdates: number;
  prepackedAnnotationSceneVisiblePartitionCount: number;
  prepackedAnnotationSceneVisibleInstanceCount: number;
  prepackedAnnotationSceneStatus: string;
  prepackedAnnotationRuntimePolicy: AnnotationPolicyGpuRuntimeV1 | null;
  prepackedAnnotationInteractionVisualCouplingValidated: boolean;
  prepackedCanonicalRendererIdCache: { clear(): void };
  prepackedResidentPolicyFeatureIndexCache: { clear(): void };
  compiledBroadSurfaceManifest: unknown;
  compiledBroadSurfaceCandidateManifest: unknown;
  compiledBroadSurfaceTrackOwners: { readonly size: number };
  compiledBroadSurfaceTrackCandidateOwners: { readonly size: number };
  prepackedAnnotationTrackBaseOffsetPx(): number | null;
  disposePrepackedAnnotationSceneLayer(
    layer: PartitionedInstancedTranscriptLayer,
    wasLastComplete: boolean
  ): void;
  reconcileAnnotationLaneEnvelopeAuthority(): void;
};

export function primeInactivePrepackedAnnotationSceneResident(
  host: PrepackedSceneTeardownHost,
  resident: PrepackedSceneTeardownResident
): void {
  const lastPresentation = host.prepackedAnnotationSceneLastPresentation;
  if (host.prepackedAnnotationSceneLayer?.isPresenting !== true || !lastPresentation) {
    resident.layer.hide();
    resident.visiblePartitionCount = 0;
    resident.visibleInstanceCount = 0;
    return;
  }
  const submissions = resident.layer.updateVisibleRange(
    lastPresentation.viewportStartBp,
    lastPresentation.viewportEndBp
  );
  resident.layer.updateCamera(
    lastPresentation.contract,
    lastPresentation.viewportWidth,
    lastPresentation.viewportHeight,
    lastPresentation.cdsDetail,
    host.prepackedAnnotationTrackBaseOffsetPx() ?? 0,
    lastPresentation.themeMode,
    lastPresentation.rolePalette
  );
  resident.visiblePartitionCount = submissions.length;
  resident.visibleInstanceCount = submissions.reduce(
    (count, partition) => count + partition.instanceCount,
    0
  );
  host.prepackedAnnotationSceneCameraUpdates += 1;
  resident.layer.hide();
}

export function destroyPrepackedAnnotationSceneResident(
  host: PrepackedSceneTeardownHost,
  ownerKey: string,
  status: string,
  recordOwnerChange = true
): void {
  const resident = host.prepackedAnnotationSceneResidents.get(ownerKey);
  if (!resident) return;
  const wasActive =
    host.prepackedAnnotationSceneLayer === resident.layer &&
    host.prepackedAnnotationSceneOwnerKey === ownerKey;
  const wasLastComplete = host.prepackedAnnotationSceneLastCompleteOwnerKeys.includes(ownerKey);
  host.prepackedAnnotationSceneResidents.delete(ownerKey);
  host.prepackedAnnotationSceneResidentGeneration += 1;
  if (wasLastComplete) {
    host.prepackedAnnotationSceneLastCompleteOwnerKeys = Object.freeze([]);
  }
  host.disposePrepackedAnnotationSceneLayer(resident.layer, wasLastComplete);
  if (!wasActive) return;

  host.prepackedAnnotationSceneLayer = null;
  host.prepackedAnnotationSceneInput = null;
  host.prepackedAnnotationSceneOwnerKey = null;
  host.prepackedAnnotationSceneOwnerMetadata = null;
  if (
    host.prepackedAnnotationSceneResidents.size === 0 &&
    !host.compiledBroadSurfaceManifest &&
    !host.compiledBroadSurfaceCandidateManifest &&
    host.compiledBroadSurfaceTrackOwners.size === 0 &&
    host.compiledBroadSurfaceTrackCandidateOwners.size === 0
  ) {
    host.prepackedAnnotationRuntimePolicy = null;
  }
  host.prepackedAnnotationInteractionVisualCouplingValidated = false;
  host.prepackedCanonicalRendererIdCache.clear();
  host.prepackedResidentPolicyFeatureIndexCache.clear();
  host.prepackedAnnotationSceneLastPresentation = null;
  host.prepackedAnnotationSceneVisiblePartitionCount = 0;
  host.prepackedAnnotationSceneVisibleInstanceCount = 0;
  host.prepackedAnnotationSceneStatus = status;
  if (recordOwnerChange) host.prepackedAnnotationSceneOwnerGeneration += 1;
  host.reconcileAnnotationLaneEnvelopeAuthority();
}

export function commitPrepackedAnnotationSceneReplacement(
  host: PrepackedSceneTeardownHost,
  replacement: PrepackedSceneTeardownResident
): void {
  if (
    host.prepackedAnnotationSceneReplacementCandidates.get(replacement.ownerKey) !== replacement
  ) {
    return;
  }
  const incumbent = host.prepackedAnnotationSceneResidents.get(replacement.ownerKey) ?? null;
  host.prepackedAnnotationSceneReplacementCandidates.delete(replacement.ownerKey);
  host.prepackedAnnotationSceneResidents.set(replacement.ownerKey, replacement);
  host.prepackedAnnotationSceneResidentGeneration += 1;
  if (!incumbent || incumbent === replacement) return;
  const incumbentWasActive =
    host.prepackedAnnotationSceneLayer === incumbent.layer &&
    host.prepackedAnnotationSceneOwnerKey === incumbent.ownerKey;
  if (incumbentWasActive) {
    host.prepackedAnnotationSceneLayer = replacement.layer;
    host.prepackedAnnotationSceneInput = replacement.input;
    host.prepackedAnnotationSceneOwnerMetadata = replacement.metadata;
    host.prepackedAnnotationSceneOwnerGeneration += 1;
  }
  host.disposePrepackedAnnotationSceneLayer(
    incumbent.layer,
    host.prepackedAnnotationSceneLastCompleteOwnerKeys.includes(incumbent.ownerKey)
  );
  host.prepackedCanonicalRendererIdCache.clear();
  host.prepackedResidentPolicyFeatureIndexCache.clear();
}
