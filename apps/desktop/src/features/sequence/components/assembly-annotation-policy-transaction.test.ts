// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  isExactActiveMrnaPresentation,
  isValidAssemblyAnnotationRuntimePolicy,
  preparingAssemblyAnnotationPolicyRequest,
  type AssemblyAnnotationPresentationDescriptor,
  type AssemblyAnnotationPresentationReceipt,
  type AssemblyAnnotationPolicyTransactionState,
} from './assembly-annotation-policy-transaction';

const descriptor: AssemblyAnnotationPresentationDescriptor = {
  sourceIdentity: 'grch38-source',
  runtimeCacheKey: 'runtime-v3',
  sceneKey: 'scene-v3',
  artifact: { artifactKey: 'artifact-v3', trackType: 'mRNA' },
};

const receipt: AssemblyAnnotationPresentationReceipt = {
  descriptor,
  ownerKey: 'gpu-owner-v3',
  metadata: {
    genomeIdentity: descriptor.sourceIdentity,
    artifactKey: descriptor.artifact.artifactKey,
    trackType: descriptor.artifact.trackType,
  },
  runtimePolicy: { isoformMode: 'canonical', laneLimit: 12 },
};

describe('assembly annotation policy transaction', () => {
  it('accepts only finite positive lane caps or the explicit uncapped value', () => {
    expect(
      isValidAssemblyAnnotationRuntimePolicy({ isoformMode: 'canonical', laneLimit: 12 })
    ).toBe(true);
    expect(
      isValidAssemblyAnnotationRuntimePolicy({ isoformMode: 'expanded', laneLimit: null })
    ).toBe(true);
    for (const laneLimit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        isValidAssemblyAnnotationRuntimePolicy({
          isoformMode: 'canonical',
          laneLimit,
        })
      ).toBe(false);
    }
  });

  it('never treats a failed command as renderer preparation work', () => {
    const failed: AssemblyAnnotationPolicyTransactionState = {
      status: 'failed',
      request: {
        requestId: 8,
        policy: { isoformMode: 'expanded', laneLimit: 24 },
      },
      reason: 'ineligible',
    };
    expect(preparingAssemblyAnnotationPolicyRequest(failed)).toBeNull();
  });

  it('requires an exact current GPU presentation receipt; cache metadata alone is insufficient', () => {
    const base = {
      descriptor,
      effectiveLayerTypes: ['mRNA'],
      receiptRendererEpoch: 4,
      currentRendererEpoch: 4,
    } as const;
    expect(isExactActiveMrnaPresentation({ ...base, receipt: null })).toBe(false);
    expect(isExactActiveMrnaPresentation({ ...base, receipt })).toBe(true);
    expect(
      isExactActiveMrnaPresentation({
        ...base,
        receiptRendererEpoch: 3,
        receipt,
      })
    ).toBe(false);
    expect(
      isExactActiveMrnaPresentation({
        ...base,
        effectiveLayerTypes: ['mRNA', 'enhancer'],
        receipt,
      })
    ).toBe(false);
    expect(
      isExactActiveMrnaPresentation({
        ...base,
        receipt: {
          ...receipt,
          metadata: { ...receipt.metadata, artifactKey: 'stale-artifact' },
        },
      })
    ).toBe(false);
  });
});
