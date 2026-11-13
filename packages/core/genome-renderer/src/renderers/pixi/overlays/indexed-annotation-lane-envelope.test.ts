import { describe, expect, it } from 'vitest';
import type { AnnotationPolicyGpuRuntimeV1 } from '../overview/annotation-policy-gpu-instances-v1';
import {
  applyPrepackedAnnotationLaneEnvelope,
  commitAnnotationLaneEnvelope,
  reconcileAnnotationLaneEnvelopeAuthority,
  type LaneEnvelopeHost,
} from './indexed-annotation-lane-envelope';

function envelopeHost(overrides: Partial<LaneEnvelopeHost> = {}): LaneEnvelopeHost {
  const host: LaneEnvelopeHost = {
    _layout: null,
    _contract: null,
    maxAnnotationLane: 0,
    maxCdsLane: 0,
    maxLane: 0,
    sourceMaxAnnotationLane: 4,
    sourceMaxCdsLane: 2,
    prepackedAnnotationRuntimePolicy: null,
    prepackedAnnotationSceneOwnerKey: null,
    prepackedAnnotationSceneResidents: new Map(),
    annotationTrackStackMaxLane: () => -1,
    applyPrepackedAnnotationLaneEnvelope(policy, maxima) {
      applyPrepackedAnnotationLaneEnvelope(host, policy, maxima);
    },
    commitAnnotationLaneEnvelope(maxAnnotationLane, maxCdsLane) {
      commitAnnotationLaneEnvelope(host, maxAnnotationLane, maxCdsLane);
    },
    ...overrides,
  };
  return host;
}

describe('indexed annotation lane envelope', () => {
  it('commits the stack max when a runtime policy reports a non-negative stack', () => {
    const committed: Array<[number, number]> = [];
    const policy: AnnotationPolicyGpuRuntimeV1 = {
      isoformMode: 'canonical',
      laneLimit: null,
    };
    const host = envelopeHost({
      prepackedAnnotationRuntimePolicy: policy,
      annotationTrackStackMaxLane: () => 5,
      commitAnnotationLaneEnvelope(maxAnnotationLane, maxCdsLane) {
        committed.push([maxAnnotationLane, maxCdsLane]);
      },
    });
    reconcileAnnotationLaneEnvelopeAuthority(host);
    expect(committed).toEqual([[5, -1]]);
  });

  it('falls back to source lane maxima when no runtime policy is set', () => {
    const host = envelopeHost({
      sourceMaxAnnotationLane: 3,
      sourceMaxCdsLane: 1,
    });
    reconcileAnnotationLaneEnvelopeAuthority(host);
    expect(host.maxAnnotationLane).toBe(3);
    expect(host.maxCdsLane).toBe(1);
    expect(host.maxLane).toBe(3);
  });
});
