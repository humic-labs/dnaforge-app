import { describe, expect, it } from 'vitest';
import {
  ANNOTATION_POLICY_GPU_INSTANCE_LAYOUT,
  type AnnotationPolicyGpuRuntimeV1,
} from '../overview/annotation-policy-gpu-instances-v1';
import { ANNOTATION_LANE_TOTAL } from '../shared/lane-contracts';
import { buildPrepackedAnnotationInteractionIndexV2 } from '../overview/prepacked-annotation-interaction-index-v2';
import type { PrepackedAnnotationSceneLoadInput } from '../overview/prepacked-annotation-scene';
import {
  prepackedPolicyTrackLaneForPrimitive,
  prepackedRendererIdForCanonicalIdentity,
  prepackedResidentTrackOffsetPx,
  type PrepackedPolicyLaneHost,
} from './indexed-prepacked-policy-lane';

function policy(
  overrides: Partial<AnnotationPolicyGpuRuntimeV1> = {}
): AnnotationPolicyGpuRuntimeV1 {
  return { isoformMode: 'canonical', laneLimit: null, ...overrides };
}

function gpuData(canonicalTrackLane: number, expandedTrackLane = 7): Float32Array {
  const data = new Float32Array(ANNOTATION_POLICY_GPU_INSTANCE_LAYOUT.strideFloats);
  data[ANNOTATION_POLICY_GPU_INSTANCE_LAYOUT.expandedLane] = expandedTrackLane;
  data[ANNOTATION_POLICY_GPU_INSTANCE_LAYOUT.expandedTrackLane] = expandedTrackLane;
  data[ANNOTATION_POLICY_GPU_INSTANCE_LAYOUT.canonicalLane] = canonicalTrackLane;
  data[ANNOTATION_POLICY_GPU_INSTANCE_LAYOUT.canonicalTrackLane] = canonicalTrackLane;
  return data;
}

function laneHost(overrides: Partial<PrepackedPolicyLaneHost> = {}): PrepackedPolicyLaneHost {
  return {
    prepackedAnnotationSceneInput: null,
    prepackedAnnotationRuntimePolicy: policy(),
    prepackedCanonicalRendererIdCache: new Map(),
    prepackedAnnotationSceneResidents: new Map(),
    compiledBroadSurfaceLaneStart: () => 0,
    compiledBroadSurfaceOwnerForTrack: () => null,
    ...overrides,
  };
}

describe('indexed prepacked policy lane', () => {
  it('resolves a GPU track lane and hides primitives at or above the laneLimit', () => {
    const data = gpuData(2);
    const input = { policyGpuInstanceData: data } as PrepackedAnnotationSceneLoadInput;
    const host = laneHost({
      prepackedAnnotationSceneInput: input,
      prepackedAnnotationRuntimePolicy: policy({ laneLimit: 4 }),
    });
    expect(prepackedPolicyTrackLaneForPrimitive(host, 0)).toBe(2);
    expect(
      prepackedPolicyTrackLaneForPrimitive(laneHost({ prepackedAnnotationRuntimePolicy: null }), 0)
    ).toBeUndefined();
    expect(
      prepackedPolicyTrackLaneForPrimitive(
        laneHost({
          prepackedAnnotationSceneInput: input,
          prepackedAnnotationRuntimePolicy: policy({ laneLimit: 2 }),
        }),
        0
      )
    ).toBeNull();
  });

  it('caches canonical renderer ids and offsets a resident by lane start times row height', () => {
    const identity = 'mRNA|rna-1|NM_1|10|20|forward';
    const index = buildPrepackedAnnotationInteractionIndexV2(
      [
        {
          rendererId: 42,
          startBp: 10,
          endBp: 20,
          lane: 0,
          direction: 'forward',
          displayName: 'tx',
          type: 'mRNA',
          transcriptId: 'NM_1',
          sourceId: 'rna-1',
          canonicalIdentity: identity,
        },
      ],
      [{ featureIndex: 0 }]
    );
    const cache = new Map<string, Readonly<{ ownerKey: string; rendererId: number }> | null>();
    const host = laneHost({
      prepackedCanonicalRendererIdCache: cache,
      prepackedAnnotationSceneResidents: new Map([
        [
          'mrna',
          {
            ownerKey: 'mrna',
            metadata: { trackType: 'mRNA' },
            input: { interactionIndex: index } as PrepackedAnnotationSceneLoadInput,
          },
        ],
      ]),
      compiledBroadSurfaceLaneStart: () => 2,
    });

    expect(prepackedRendererIdForCanonicalIdentity(host, identity)).toEqual({
      ownerKey: 'mrna',
      rendererId: 42,
    });
    expect(cache.get(identity)).toEqual({ ownerKey: 'mrna', rendererId: 42 });
    expect(prepackedRendererIdForCanonicalIdentity(host, identity)).toEqual({
      ownerKey: 'mrna',
      rendererId: 42,
    });
    expect(prepackedRendererIdForCanonicalIdentity(host, 'missing')).toBeNull();
    expect(cache.get('missing')).toBeNull();

    expect(
      prepackedResidentTrackOffsetPx(host, { metadata: { trackType: 'mRNA' } }, ['mRNA'], policy())
    ).toBe(-2 * ANNOTATION_LANE_TOTAL);
    expect(
      prepackedResidentTrackOffsetPx(
        laneHost({
          compiledBroadSurfaceLaneStart: () => 1,
          compiledBroadSurfaceOwnerForTrack: () => ({
            manifest: { laneRowCssHeightPx: 10 },
          }),
        }),
        { metadata: { trackType: 'gene' } },
        ['gene'],
        policy()
      )
    ).toBe(-10);
  });
});
