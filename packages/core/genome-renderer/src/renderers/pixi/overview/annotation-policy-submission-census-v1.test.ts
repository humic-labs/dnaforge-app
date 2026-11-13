import { describe, expect, it } from 'vitest';

import type { AnnotationScenePrimitiveV1 } from './annotation-scene-binary-v1';
import { buildAnnotationPolicyGpuInstanceDataV1 } from './annotation-policy-gpu-instances-v1';
import { buildAnnotationPolicyProjectionTableV1 } from './annotation-policy-projection-v1';
import {
  ANNOTATION_POLICY_CENSUS_LANE_LIMITS_V1,
  buildAnnotationPolicySubmissionCensusV1,
  planExactAnnotationPolicySubmissionV1,
  type AnnotationPolicySubmissionCensusCellV1,
} from './annotation-policy-submission-census-v1';
import { buildPartitionedTranscriptScene } from './partitioned-transcript-scene';
import { TRANSCRIPT_GLYPH_INSTANCE_LAYOUT } from './transcript-glyph-instances';

const primitive = (
  featureIndex: number,
  startBp: number,
  endBp: number,
  dirSign: -1 | 0 | 1 = 1
): AnnotationScenePrimitiveV1 => ({
  startBp,
  endBp,
  featureIndex,
  offsetCenter: -7 - featureIndex * 16,
  halfH: featureIndex === 2 ? 1.5 : 7,
  color: featureIndex === 2 ? 0x112233 : 0x345678,
  alpha: featureIndex === 2 ? 0.5 : 0.85,
  cdsFade: featureIndex === 2 ? 1 : 0,
  dirSign,
});

function fixture() {
  const scene = buildPartitionedTranscriptScene(
    [
      primitive(0, 10, 20, 1),
      primitive(1, 30, 40, -1),
      primitive(2, 90, 160, 0),
      primitive(3, 110, 120, 1),
      primitive(4, 180, 190, -1),
    ],
    100
  );
  const projection = buildAnnotationPolicyProjectionTableV1({
    features: [
      {
        annotationType: 'mRNA',
        expandedLane: 0,
        expandedTrackLane: 0,
        canonicalLane: 0,
        canonicalTrackLane: 0,
      },
      {
        annotationType: 'mRNA',
        expandedLane: 11,
        expandedTrackLane: 11,
        canonicalLane: null,
        canonicalTrackLane: null,
      },
      {
        annotationType: 'mRNA',
        expandedLane: 12,
        expandedTrackLane: 12,
        canonicalLane: 12,
        canonicalTrackLane: 12,
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
        expandedLane: 65,
        expandedTrackLane: 65,
        canonicalLane: 65,
        canonicalTrackLane: 65,
      },
    ],
    expandedBandOrder: ['mRNA'],
    canonicalBandOrder: ['mRNA'],
  });
  const policyData = buildAnnotationPolicyGpuInstanceDataV1(scene.featureIndices, projection);
  return { scene, policyData };
}

function cell(
  cells: ReadonlyArray<AnnotationPolicySubmissionCensusCellV1>,
  laneLimit: number | null
): AnnotationPolicySubmissionCensusCellV1 {
  return cells.find((candidate) => candidate.laneLimit === laneLimit)!;
}

describe('annotation policy submission census v1', () => {
  it('reports the exact fixed lane-cap matrix per partition and in aggregate', () => {
    const { scene, policyData } = fixture();
    const census = buildAnnotationPolicySubmissionCensusV1(scene, policyData);

    expect(census.verticesPerPrimitive).toBe(9);
    expect(census.partitions.map(({ partitionIndex }) => partitionIndex)).toEqual([0, 1]);
    expect(
      census.partitions.map(
        ({ currentFullMeshSubmittedInstanceCount }) => currentFullMeshSubmittedInstanceCount
      )
    ).toEqual([3, 2]);
    expect(census.totals.currentFullMeshSubmittedInstanceCount).toBe(5);
    expect(census.totals.currentFullMeshSubmittedVertexCount).toBe(45);
    expect(census.partitions[0].expanded.map(({ laneLimit }) => laneLimit)).toEqual(
      ANNOTATION_POLICY_CENSUS_LANE_LIMITS_V1
    );
    expect(
      census.totals.expanded.map(
        ({
          laneLimit,
          eligibleInstanceCount,
          hiddenByIsoformMembershipInstanceCount,
          hiddenByLaneCapInstanceCount,
        }) => [
          laneLimit,
          eligibleInstanceCount,
          hiddenByIsoformMembershipInstanceCount,
          hiddenByLaneCapInstanceCount,
        ]
      )
    ).toEqual([
      [4, 2, 0, 3],
      [8, 2, 0, 3],
      [12, 3, 0, 2],
      [16, 4, 0, 1],
      [24, 4, 0, 1],
      [32, 4, 0, 1],
      [64, 4, 0, 1],
      [null, 5, 0, 0],
    ]);
    expect(
      census.totals.canonical.map(
        ({
          laneLimit,
          eligibleInstanceCount,
          hiddenByIsoformMembershipInstanceCount,
          hiddenByLaneCapInstanceCount,
        }) => [
          laneLimit,
          eligibleInstanceCount,
          hiddenByIsoformMembershipInstanceCount,
          hiddenByLaneCapInstanceCount,
        ]
      )
    ).toEqual([
      [4, 2, 1, 2],
      [8, 2, 1, 2],
      [12, 2, 1, 2],
      [16, 3, 1, 1],
      [24, 3, 1, 1],
      [32, 3, 1, 1],
      [64, 3, 1, 1],
      [null, 4, 1, 0],
    ]);
    expect(cell(census.partitions[0].expanded, 12)).toEqual({
      laneLimit: 12,
      eligibleInstanceCount: 2,
      hiddenByIsoformMembershipInstanceCount: 0,
      hiddenByLaneCapInstanceCount: 1,
    });
    expect(cell(census.partitions[0].canonical, 12)).toEqual({
      laneLimit: 12,
      eligibleInstanceCount: 1,
      hiddenByIsoformMembershipInstanceCount: 1,
      hiddenByLaneCapInstanceCount: 1,
    });
    expect(cell(census.partitions[0].canonical, 16)).toEqual({
      laneLimit: 16,
      eligibleInstanceCount: 2,
      hiddenByIsoformMembershipInstanceCount: 1,
      hiddenByLaneCapInstanceCount: 0,
    });
    expect(cell(census.partitions[1].expanded, 64)).toEqual({
      laneLimit: 64,
      eligibleInstanceCount: 1,
      hiddenByIsoformMembershipInstanceCount: 0,
      hiddenByLaneCapInstanceCount: 1,
    });
    expect(cell(census.totals.expanded, 12)).toEqual({
      laneLimit: 12,
      eligibleInstanceCount: 3,
      hiddenByIsoformMembershipInstanceCount: 0,
      hiddenByLaneCapInstanceCount: 2,
    });
    expect(cell(census.totals.canonical, 12)).toEqual({
      laneLimit: 12,
      eligibleInstanceCount: 2,
      hiddenByIsoformMembershipInstanceCount: 1,
      hiddenByLaneCapInstanceCount: 2,
    });
    expect(cell(census.totals.expanded, null).eligibleInstanceCount).toBe(5);
    expect(cell(census.totals.canonical, null)).toEqual({
      laneLimit: null,
      eligibleInstanceCount: 4,
      hiddenByIsoformMembershipInstanceCount: 1,
      hiddenByLaneCapInstanceCount: 0,
    });
  });

  it('separates whole-partition submission, exact spatial overlap, membership, and lane cap', () => {
    const { scene, policyData } = fixture();
    const plan = planExactAnnotationPolicySubmissionV1(scene, policyData, 100, 140, {
      isoformMode: 'canonical',
      laneLimit: 12,
    });

    expect(plan.selectedPartitionIndices).toEqual([0, 1]);
    expect(Array.from(plan.currentFullMeshSubmittedPrimitiveIds)).toEqual([0, 1, 2, 3, 4]);
    expect(Array.from(plan.exactEligiblePrimitiveIds)).toEqual([3]);
    expect(plan).toMatchObject({
      currentFullMeshSubmittedInstanceCount: 5,
      currentFullMeshSubmittedVertexCount: 45,
      exactEligibleInstanceCount: 1,
      exactEligibleVertexCount: 9,
      spatialEnvelopeOverfetchInstanceCount: 3,
      hiddenByIsoformMembershipInstanceCount: 0,
      hiddenByLaneCapInstanceCount: 1,
    });
  });

  it('classifies canonical absence independently from spatial and lane-cap rejection', () => {
    const { scene, policyData } = fixture();
    const plan = planExactAnnotationPolicySubmissionV1(scene, policyData, 25, 45, {
      isoformMode: 'canonical',
      laneLimit: null,
    });
    expect(Array.from(plan.currentFullMeshSubmittedPrimitiveIds)).toEqual([0, 1, 2]);
    expect(Array.from(plan.exactEligiblePrimitiveIds)).toEqual([]);
    expect(plan).toMatchObject({
      spatialEnvelopeOverfetchInstanceCount: 2,
      hiddenByIsoformMembershipInstanceCount: 1,
      hiddenByLaneCapInstanceCount: 0,
    });
  });

  it('is read-only and returns IDs into byte-identical accepted glyph records', () => {
    const { scene, policyData } = fixture();
    const glyphIdentity = scene.packedInstanceData;
    const policyIdentity = policyData;
    const glyphBytesBefore = new Uint8Array(
      glyphIdentity.buffer,
      glyphIdentity.byteOffset,
      glyphIdentity.byteLength
    ).slice();
    const policyBytesBefore = new Uint8Array(
      policyIdentity.buffer,
      policyIdentity.byteOffset,
      policyIdentity.byteLength
    ).slice();

    buildAnnotationPolicySubmissionCensusV1(scene, policyData);
    const plan = planExactAnnotationPolicySubmissionV1(scene, policyData, 100, 140, {
      isoformMode: 'canonical',
      laneLimit: 12,
    });

    expect(scene.packedInstanceData).toBe(glyphIdentity);
    expect(policyData).toBe(policyIdentity);
    expect(
      new Uint8Array(glyphIdentity.buffer, glyphIdentity.byteOffset, glyphIdentity.byteLength)
    ).toEqual(glyphBytesBefore);
    expect(
      new Uint8Array(policyIdentity.buffer, policyIdentity.byteOffset, policyIdentity.byteLength)
    ).toEqual(policyBytesBefore);
    const eligiblePrimitiveIndex = plan.exactEligiblePrimitiveIds[0];
    const stride = TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideFloats;
    expect(
      scene.packedInstanceData.slice(
        eligiblePrimitiveIndex * stride,
        (eligiblePrimitiveIndex + 1) * stride
      )
    ).toEqual(
      glyphIdentity.slice(eligiblePrimitiveIndex * stride, (eligiblePrimitiveIndex + 1) * stride)
    );
    expect(
      scene.packedInstanceData[
        eligiblePrimitiveIndex * stride + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.dirSign
      ]
    ).toBe(1);
    expect(
      scene.packedInstanceData[
        eligiblePrimitiveIndex * stride + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.halfH
      ]
    ).toBe(7);
  });

  it('fails closed on mismatched policy, glyph, and partition contracts', () => {
    const { scene, policyData } = fixture();
    expect(() => buildAnnotationPolicySubmissionCensusV1(scene, policyData.slice(0, -1))).toThrow(
      /policy GPU instance data length/
    );
    expect(() =>
      buildAnnotationPolicySubmissionCensusV1(
        { ...scene, packedInstanceData: scene.packedInstanceData.slice(0, -1) },
        policyData
      )
    ).toThrow(/glyph stream/);
    expect(() =>
      buildAnnotationPolicySubmissionCensusV1(
        {
          ...scene,
          partitions: [scene.partitions[0], { ...scene.partitions[1], firstInstance: 99 }],
        },
        policyData
      )
    ).toThrow(/partition ranges/);
    expect(() =>
      planExactAnnotationPolicySubmissionV1(scene, policyData, 0, 100, {
        isoformMode: 'canonical',
        laneLimit: 16_777_217,
      })
    ).toThrow(/lane limit/);
  });
});
