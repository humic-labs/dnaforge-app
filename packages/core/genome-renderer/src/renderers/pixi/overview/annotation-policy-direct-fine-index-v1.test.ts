import { describe, expect, it } from 'vitest';

import type { AnnotationScenePrimitiveV1 } from './annotation-scene-binary-v1';
import {
  assertAnnotationPolicyDirectFineIndexV1,
  buildAnnotationPolicyDirectFineIndexV1,
  materializeAnnotationPolicyDirectFineTileV1,
} from './annotation-policy-direct-fine-index-v1';
import {
  buildAnnotationPolicyDirectSubmissionBankV1,
  directFineTileInstanceCountForLaneLimitV1,
} from './annotation-policy-direct-submission-bank-v1';
import { buildAnnotationPolicyGpuInstanceDataV1 } from './annotation-policy-gpu-instances-v1';
import { buildAnnotationPolicyProjectionTableV1 } from './annotation-policy-projection-v1';
import { FINE_TRANSCRIPT_VIEW_SPAN_BP } from './fine-transcript-view-planner';
import { buildPartitionedTranscriptScene } from './partitioned-transcript-scene';

const primitive = (
  featureIndex: number,
  startBp: number,
  endBp: number
): AnnotationScenePrimitiveV1 => ({
  featureIndex,
  startBp,
  endBp,
  offsetCenter: -7,
  halfH: 7,
  dirSign: 1,
  cdsFade: 0,
  color: 0x123456,
  alpha: 1,
});

function fixture() {
  const tile = FINE_TRANSCRIPT_VIEW_SPAN_BP;
  const scene = buildPartitionedTranscriptScene(
    [
      primitive(0, 100, 200),
      primitive(1, 300, 400),
      primitive(2, tile + 10, tile + 30),
      primitive(3, tile + 50, tile + 90),
    ],
    100_000_000
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
    ],
    expandedBandOrder: ['mRNA'],
    canonicalBandOrder: ['mRNA'],
  });
  const bank = buildAnnotationPolicyDirectSubmissionBankV1(
    scene,
    buildAnnotationPolicyGpuInstanceDataV1(scene.featureIndices, policy)
  );
  const expanded = buildAnnotationPolicyDirectFineIndexV1(bank.expanded, tile * 2);
  const canonical = buildAnnotationPolicyDirectFineIndexV1(
    bank.canonical,
    tile * 2,
    expanded.sourceTilePrimitiveCounts
  );
  return { bank, expanded, canonical };
}

describe('annotation policy direct fine index v1', () => {
  it('materializes exact lane-major mode tiles and preserves source hidden counts', () => {
    const { bank, expanded, canonical } = fixture();
    expect([...expanded.sourceTilePrimitiveCounts]).toEqual([2, 2]);
    expect([...expanded.tileOffsets]).toEqual([0, 2, 4]);
    expect([...canonical.tileOffsets]).toEqual([0, 1, 2]);

    const expanded0 = materializeAnnotationPolicyDirectFineTileV1(bank.expanded, expanded, 0);
    const canonical0 = materializeAnnotationPolicyDirectFineTileV1(bank.canonical, canonical, 0);
    const canonical1 = materializeAnnotationPolicyDirectFineTileV1(bank.canonical, canonical, 1);
    expect([...expanded0.sourcePrimitiveIndices!]).toEqual([1, 0]);
    expect([...canonical0.sourcePrimitiveIndices!]).toEqual([0]);
    expect([...canonical1.sourcePrimitiveIndices!]).toEqual([2]);
    expect(canonical0.hiddenByIsoformMembershipInstanceCount).toBe(1);
    expect(canonical1.hiddenByIsoformMembershipInstanceCount).toBe(1);
    expect(
      [1, 2, 3, null].map((cap) => directFineTileInstanceCountForLaneLimitV1(expanded0, cap))
    ).toEqual([1, 1, 2, 2]);
  });

  it('rejects duplicate ownership, lane disorder, bad offsets, and impossible source counts', () => {
    const { bank, expanded } = fixture();
    const duplicate = new Uint32Array(expanded.bankRecordIndices);
    duplicate[1] = duplicate[0];
    expect(() =>
      assertAnnotationPolicyDirectFineIndexV1(bank.expanded, {
        ...expanded,
        bankRecordIndices: duplicate,
      })
    ).toThrow(/ownership/);

    const disordered = new Uint32Array(expanded.bankRecordIndices);
    [disordered[0], disordered[1]] = [disordered[1], disordered[0]];
    expect(() =>
      assertAnnotationPolicyDirectFineIndexV1(bank.expanded, {
        ...expanded,
        bankRecordIndices: disordered,
      })
    ).toThrow(/ordering/);

    const badOffsets = new Uint32Array(expanded.tileOffsets);
    badOffsets[1] = badOffsets[2] + 1;
    expect(() =>
      assertAnnotationPolicyDirectFineIndexV1(bank.expanded, {
        ...expanded,
        tileOffsets: badOffsets,
      })
    ).toThrow(/offsets/);

    const badSourceCounts = new Uint32Array(expanded.sourceTilePrimitiveCounts);
    badSourceCounts[0] = 1;
    expect(() =>
      assertAnnotationPolicyDirectFineIndexV1(bank.expanded, {
        ...expanded,
        sourceTilePrimitiveCounts: badSourceCounts,
      })
    ).toThrow(/source count/);
  });
});
