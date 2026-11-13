import { describe, expect, it } from 'vitest';
import type { PartitionedInstancedTranscriptLayer } from '../overview/partitioned-instanced-transcript-layer';
import type {
  PrepackedAnnotationSceneLoadInput,
  PrepackedAnnotationSceneMetadata,
} from '../overview/prepacked-annotation-scene';
import {
  commitPrepackedAnnotationSceneReplacement,
  destroyPrepackedAnnotationSceneResident,
  primeInactivePrepackedAnnotationSceneResident,
  type PrepackedSceneTeardownHost,
  type PrepackedSceneTeardownResident,
} from './indexed-prepacked-scene-teardown';

function layer(
  overrides: Partial<PartitionedInstancedTranscriptLayer> = {}
): PartitionedInstancedTranscriptLayer & {
  hidden: number;
  cameras: number;
} {
  const next = {
    isPresenting: false,
    hidden: 0,
    cameras: 0,
    hide() {
      next.hidden += 1;
    },
    updateVisibleRange() {
      return [{ instanceCount: 3 }, { instanceCount: 1 }];
    },
    updateCamera() {
      next.cameras += 1;
    },
    ...overrides,
  };
  return next as unknown as PartitionedInstancedTranscriptLayer & {
    hidden: number;
    cameras: number;
  };
}

function resident(
  overrides: Partial<PrepackedSceneTeardownResident> = {}
): PrepackedSceneTeardownResident {
  return {
    ownerKey: 'mrna',
    input: { id: 'in' } as unknown as PrepackedAnnotationSceneLoadInput,
    metadata: { trackType: 'mRNA' } as PrepackedAnnotationSceneMetadata,
    layer: layer(),
    visiblePartitionCount: 2,
    visibleInstanceCount: 4,
    ...overrides,
  };
}

function teardownHost(
  overrides: Partial<PrepackedSceneTeardownHost> = {}
): PrepackedSceneTeardownHost & {
  disposed: Array<{ wasLastComplete: boolean }>;
  reconciled: number;
} {
  const disposed: Array<{ wasLastComplete: boolean }> = [];
  const host: PrepackedSceneTeardownHost & {
    disposed: Array<{ wasLastComplete: boolean }>;
    reconciled: number;
  } = {
    disposed,
    reconciled: 0,
    prepackedAnnotationSceneLastPresentation: null,
    prepackedAnnotationSceneLayer: null,
    prepackedAnnotationSceneOwnerKey: null,
    prepackedAnnotationSceneOwnerMetadata: null,
    prepackedAnnotationSceneInput: null,
    prepackedAnnotationSceneResidents: new Map(),
    prepackedAnnotationSceneReplacementCandidates: new Map(),
    prepackedAnnotationSceneLastCompleteOwnerKeys: [],
    prepackedAnnotationSceneResidentGeneration: 0,
    prepackedAnnotationSceneOwnerGeneration: 0,
    prepackedAnnotationSceneCameraUpdates: 0,
    prepackedAnnotationSceneVisiblePartitionCount: 1,
    prepackedAnnotationSceneVisibleInstanceCount: 2,
    prepackedAnnotationSceneStatus: 'ready',
    prepackedAnnotationRuntimePolicy: { isoformMode: 'canonical', laneLimit: null },
    prepackedAnnotationInteractionVisualCouplingValidated: true,
    prepackedCanonicalRendererIdCache: { clear() {} },
    prepackedResidentPolicyFeatureIndexCache: { clear() {} },
    compiledBroadSurfaceManifest: null,
    compiledBroadSurfaceCandidateManifest: null,
    compiledBroadSurfaceTrackOwners: { size: 0 },
    compiledBroadSurfaceTrackCandidateOwners: { size: 0 },
    prepackedAnnotationTrackBaseOffsetPx: () => 0,
    disposePrepackedAnnotationSceneLayer(_layer, wasLastComplete) {
      disposed.push({ wasLastComplete });
    },
    reconcileAnnotationLaneEnvelopeAuthority() {
      host.reconciled += 1;
    },
    ...overrides,
  };
  return host;
}

describe('indexed prepacked scene teardown', () => {
  it('destroys an active last-complete resident and clears the owner', () => {
    const active = resident();
    const host = teardownHost({
      prepackedAnnotationSceneResidents: new Map([[active.ownerKey, active]]),
      prepackedAnnotationSceneLayer: active.layer,
      prepackedAnnotationSceneOwnerKey: active.ownerKey,
      prepackedAnnotationSceneOwnerMetadata: active.metadata,
      prepackedAnnotationSceneInput: active.input,
      prepackedAnnotationSceneLastCompleteOwnerKeys: [active.ownerKey],
    });

    destroyPrepackedAnnotationSceneResident(host, active.ownerKey, 'evicted');

    expect(host.prepackedAnnotationSceneResidents.size).toBe(0);
    expect(host.prepackedAnnotationSceneLayer).toBeNull();
    expect(host.prepackedAnnotationSceneOwnerKey).toBeNull();
    expect(host.prepackedAnnotationSceneInput).toBeNull();
    expect(host.prepackedAnnotationRuntimePolicy).toBeNull();
    expect(host.prepackedAnnotationSceneStatus).toBe('evicted');
    expect(host.prepackedAnnotationSceneOwnerGeneration).toBe(1);
    expect(host.prepackedAnnotationSceneLastCompleteOwnerKeys).toEqual([]);
    expect(host.disposed).toEqual([{ wasLastComplete: true }]);
    expect(host.reconciled).toBe(1);

    const generation = host.prepackedAnnotationSceneResidentGeneration;
    destroyPrepackedAnnotationSceneResident(host, 'missing', 'gone');
    expect(host.prepackedAnnotationSceneResidentGeneration).toBe(generation);
  });

  it('primes an inactive resident from the last camera and ignores a non-candidate replacement', () => {
    const inactive = resident();
    const recorded = layer({ isPresenting: true });
    const host = teardownHost({
      prepackedAnnotationSceneLayer: recorded,
      prepackedAnnotationSceneLastPresentation: {
        viewportStartBp: 10,
        viewportEndBp: 40,
        contract: { projectX: () => 0, projectY: () => 0, pixelsPerBp: 1 },
        viewportWidth: 800,
        viewportHeight: 400,
        cdsDetail: 0,
        themeMode: 'light',
      },
    });
    primeInactivePrepackedAnnotationSceneResident(host, inactive);
    expect((inactive.layer as ReturnType<typeof layer>).cameras).toBe(1);
    expect((inactive.layer as ReturnType<typeof layer>).hidden).toBe(1);
    expect(inactive.visiblePartitionCount).toBe(2);
    expect(inactive.visibleInstanceCount).toBe(4);
    expect(host.prepackedAnnotationSceneCameraUpdates).toBe(1);

    const cold = resident({ ownerKey: 'gene' });
    primeInactivePrepackedAnnotationSceneResident(
      teardownHost({ prepackedAnnotationSceneLayer: null }),
      cold
    );
    expect(cold.visiblePartitionCount).toBe(0);
    expect(cold.visibleInstanceCount).toBe(0);

    const replacement = resident({ ownerKey: 'mrna', layer: layer() });
    const replaceHost = teardownHost({
      prepackedAnnotationSceneReplacementCandidates: new Map(),
    });
    commitPrepackedAnnotationSceneReplacement(replaceHost, replacement);
    expect(replaceHost.prepackedAnnotationSceneResidents.size).toBe(0);

    const incumbent = resident();
    const next = resident({ layer: layer() });
    const commitHost = teardownHost({
      prepackedAnnotationSceneResidents: new Map([[incumbent.ownerKey, incumbent]]),
      prepackedAnnotationSceneReplacementCandidates: new Map([[next.ownerKey, next]]),
      prepackedAnnotationSceneLayer: incumbent.layer,
      prepackedAnnotationSceneOwnerKey: incumbent.ownerKey,
    });
    commitPrepackedAnnotationSceneReplacement(commitHost, next);
    expect(commitHost.prepackedAnnotationSceneResidents.get('mrna')).toBe(next);
    expect(commitHost.prepackedAnnotationSceneLayer).toBe(next.layer);
    expect(commitHost.prepackedAnnotationSceneOwnerGeneration).toBe(1);
  });
});
