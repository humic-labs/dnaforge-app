import { describe, expect, it } from 'vitest';

import type { AnnotationScenePrimitiveV1 } from './annotation-scene-binary-v1';
import {
  buildAnnotationPolicyDirectFineTileBankV1,
  buildAnnotationPolicyDirectSubmissionBankFromProjectionV1,
  buildAnnotationPolicyDirectSubmissionBankV1,
  directFineTileInstanceCountForLaneLimitV1,
  directSubmissionInstanceCountForLaneLimitV1,
  planAnnotationPolicyDirectSubmissionV1,
} from './annotation-policy-direct-submission-bank-v1';
import { buildAnnotationPolicyGpuInstanceDataV1 } from './annotation-policy-gpu-instances-v1';
import { buildAnnotationPolicyProjectionTableV1 } from './annotation-policy-projection-v1';
import { buildPartitionedTranscriptScene } from './partitioned-transcript-scene';
import { TRANSCRIPT_GLYPH_INSTANCE_LAYOUT } from './transcript-glyph-instances';

const primitive = (
  featureIndex: number,
  startBp: number,
  endBp: number,
  offsetCenter = 10_000 + featureIndex
): AnnotationScenePrimitiveV1 => ({
  featureIndex,
  startBp,
  endBp,
  offsetCenter,
  halfH: 3 + featureIndex / 10,
  dirSign: featureIndex % 2 === 0 ? 1 : -1,
  cdsFade: featureIndex / 10,
  color: 0x123450 + featureIndex,
  alpha: 0.5 + featureIndex / 20,
});

function fixture() {
  const scene = buildPartitionedTranscriptScene(
    [
      primitive(0, 10, 20),
      primitive(1, 30, 40),
      primitive(2, 50, 60),
      primitive(3, 110, 130),
      primitive(4, 140, 160),
      primitive(5, 205, 260),
    ],
    100
  );
  const policy = buildAnnotationPolicyProjectionTableV1({
    features: [
      {
        annotationType: 'mRNA',
        expandedLane: 2,
        expandedTrackLane: 2,
        canonicalLane: 2,
        canonicalTrackLane: 2,
      },
      {
        annotationType: 'mRNA',
        expandedLane: 0,
        expandedTrackLane: 0,
        canonicalLane: null,
        canonicalTrackLane: null,
      },
      {
        annotationType: 'mRNA',
        expandedLane: 5,
        expandedTrackLane: 5,
        canonicalLane: 0,
        canonicalTrackLane: 0,
      },
      {
        annotationType: 'mRNA',
        expandedLane: 1,
        expandedTrackLane: 1,
        canonicalLane: null,
        canonicalTrackLane: null,
      },
      {
        annotationType: 'mRNA',
        expandedLane: 3,
        expandedTrackLane: 3,
        canonicalLane: 3,
        canonicalTrackLane: 3,
      },
      {
        annotationType: 'mRNA',
        expandedLane: 9,
        expandedTrackLane: 9,
        canonicalLane: 1,
        canonicalTrackLane: 1,
      },
    ],
    expandedBandOrder: ['mRNA'],
    canonicalBandOrder: ['mRNA'],
  });
  const policyGpuInstanceData = buildAnnotationPolicyGpuInstanceDataV1(
    scene.featureIndices,
    policy
  );
  return { scene, policy, policyGpuInstanceData };
}

describe('annotation policy direct submission bank v1', () => {
  it('builds byte-identical banks directly from compact feature policy', () => {
    const { scene, policy, policyGpuInstanceData } = fixture();
    const primitivePolicyBank = buildAnnotationPolicyDirectSubmissionBankV1(
      scene,
      policyGpuInstanceData
    );
    const featurePolicyBank = buildAnnotationPolicyDirectSubmissionBankFromProjectionV1(
      scene,
      policy
    );

    expect(featurePolicyBank).toEqual(primitivePolicyBank);
  });

  it('preserves every accepted glyph field and stable feature identity except mode-owned y', () => {
    const { scene, policyGpuInstanceData } = fixture();
    const sourceBytes = scene.packedInstanceData.slice();
    const policyBytes = policyGpuInstanceData.slice();
    const bank = buildAnnotationPolicyDirectSubmissionBankV1(scene, policyGpuInstanceData);

    expect([...bank.expanded.sourcePrimitiveIndices]).toEqual([1, 0, 2, 3, 4, 5]);
    expect([...bank.canonical.sourcePrimitiveIndices]).toEqual([2, 0, 4, 5]);
    expect([...bank.expanded.featureIndices]).toEqual([1, 0, 2, 3, 4, 5]);
    expect([...bank.canonical.featureIndices]).toEqual([2, 0, 4, 5]);
    expect(scene.packedInstanceData).toEqual(sourceBytes);
    expect(policyGpuInstanceData).toEqual(policyBytes);

    for (const modeBank of [bank.expanded, bank.canonical]) {
      for (let directIndex = 0; directIndex < modeBank.featureIndices.length; directIndex++) {
        const sourceIndex = modeBank.sourcePrimitiveIndices[directIndex];
        const sourceBase = sourceIndex * TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideFloats;
        const directBase = directIndex * TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideFloats;
        for (let field = 0; field < TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideFloats; field++) {
          if (field === TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.offsetCenter) continue;
          expect(modeBank.packedInstanceData[directBase + field]).toBe(
            scene.packedInstanceData[sourceBase + field]
          );
        }
      }
    }
    expect(bank.expanded.packedInstanceData[TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.offsetCenter]).toBe(
      -7
    );
    expect(bank.canonical.packedInstanceData[TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.offsetCenter]).toBe(
      -7
    );
  });

  it('answers arbitrary and unlimited lane caps by immutable partition prefix', () => {
    const { scene, policyGpuInstanceData } = fixture();
    const bank = buildAnnotationPolicyDirectSubmissionBankV1(scene, policyGpuInstanceData);
    const expanded0 = bank.expanded.partitions[0];
    const canonical0 = bank.canonical.partitions[0];

    expect(
      [1, 2, 3, 5, 6, 9, 10, null].map((cap) =>
        directSubmissionInstanceCountForLaneLimitV1(expanded0, cap)
      )
    ).toEqual([1, 1, 2, 2, 3, 3, 3, 3]);
    expect(
      [1, 2, 3, 4, null].map((cap) => directSubmissionInstanceCountForLaneLimitV1(canonical0, cap))
    ).toEqual([1, 1, 2, 2, 2]);
    expect(expanded0.lanePrefixEnds).toEqual(new Uint32Array([0, 1, 1, 2, 2, 2, 3]));
  });

  it('reports exact partition-envelope submission, primitive overlap, and hidden categories', () => {
    const { scene, policyGpuInstanceData } = fixture();
    const bank = buildAnnotationPolicyDirectSubmissionBankV1(scene, policyGpuInstanceData);
    const plan = planAnnotationPolicyDirectSubmissionV1(scene, bank, 25, 155, {
      isoformMode: 'canonical',
      laneLimit: 3,
    });

    expect(plan.selectedPartitionIndices).toEqual([0, 1]);
    expect([...plan.submittedSourcePrimitiveIndices]).toEqual([2, 0]);
    expect([...plan.exactVisibleSourcePrimitiveIndices]).toEqual([2]);
    expect(plan).toMatchObject({
      actualSubmittedInstanceCount: 2,
      actualSubmittedVertexCount: 18,
      spatialEnvelopeOverfetchInstanceCount: 1,
      hiddenByIsoformMembershipInstanceCount: 2,
      hiddenByLaneCapInstanceCount: 1,
    });
  });

  it('builds mode-specific fine tiles whose key data never depends on cap', () => {
    const { scene, policyGpuInstanceData } = fixture();
    const expanded = buildAnnotationPolicyDirectFineTileBankV1(
      scene,
      policyGpuInstanceData,
      'expanded',
      0
    );
    const canonical = buildAnnotationPolicyDirectFineTileBankV1(
      scene,
      policyGpuInstanceData,
      'canonical',
      0
    );

    expect([...expanded.sourcePrimitiveIndices]).toEqual([1, 3, 0, 4, 2, 5]);
    expect([...canonical.sourcePrimitiveIndices]).toEqual([2, 5, 0, 4]);
    expect(
      [1, 3, 6, 10, null].map((cap) => directFineTileInstanceCountForLaneLimitV1(expanded, cap))
    ).toEqual([1, 3, 5, 6, 6]);
    expect(canonical.hiddenByIsoformMembershipInstanceCount).toBe(2);
  });
});
