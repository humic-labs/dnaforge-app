import { describe, expect, it } from 'vitest';
import { buildPrepackedAnnotationSceneOwnerSnapshot } from './indexed-prepacked-owner-snapshot';

describe('buildPrepackedAnnotationSceneOwnerSnapshot', () => {
  it('reports an empty owner when nothing is loaded', () => {
    expect(
      buildPrepackedAnnotationSceneOwnerSnapshot({
        ownerKey: null,
        ownerGeneration: 0,
        layer: null,
        input: null,
        status: 'not-loaded',
        metadata: null,
        runtimePolicy: null,
        policyGeneration: 0,
        resident: null,
      })
    ).toMatchObject({
      ownerKey: null,
      loaded: false,
      status: 'not-loaded',
      gpuPrepared: false,
      submittedPartitionCount: 0,
      submittedInstanceCount: 0,
    });
  });

  it('counts submitted geometry only when the resident layer is the presenting owner', () => {
    const layer = { isPresenting: true, isGpuPrepared: true };
    expect(
      buildPrepackedAnnotationSceneOwnerSnapshot({
        ownerKey: 'owner-a',
        ownerGeneration: 3,
        layer,
        input: {},
        status: 'eligible',
        metadata: { trackType: 'mRNA' },
        runtimePolicy: { isoformMode: 'canonical', laneLimit: 1 },
        policyGeneration: 2,
        resident: {
          layer,
          visiblePartitionCount: 4,
          visibleInstanceCount: 40,
        },
      })
    ).toMatchObject({
      loaded: true,
      gpuPrepared: true,
      submittedPartitionCount: 4,
      submittedInstanceCount: 40,
      policyGeneration: 2,
    });
  });
});
