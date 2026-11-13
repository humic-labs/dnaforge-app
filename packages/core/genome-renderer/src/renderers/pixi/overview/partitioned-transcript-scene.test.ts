import { describe, expect, it } from 'vitest';

import type { AnnotationScenePrimitiveV1 } from './annotation-scene-binary-v1';
import {
  buildPartitionedTranscriptScene,
  featureIndexForPartitionInstance,
  planTranscriptPartitionSubmissions,
} from './partitioned-transcript-scene';
import { TRANSCRIPT_GLYPH_INSTANCE_LAYOUT } from './transcript-glyph-instances';

const primitive = (
  featureIndex: number,
  startBp: number,
  endBp: number
): AnnotationScenePrimitiveV1 => ({
  startBp,
  endBp,
  featureIndex,
  offsetCenter: featureIndex,
  halfH: 7,
  color: 0x123456,
  alpha: 0.85,
  cdsFade: 0,
  dirSign: featureIndex % 2 === 0 ? 1 : -1,
});

const INPUT = [
  primitive(10, 550_000_000, 550_001_000),
  primitive(20, 50_000_000, 310_000_000),
  primitive(30, 250_000_000, 260_000_000),
  primitive(40, 120_000_000, 130_000_000),
  primitive(50, 1_200_000_000, 1_200_001_000),
];

describe('partitioned transcript scene planner', () => {
  it('sorts records, packs one contiguous 48B stream, and emits contiguous partition ranges', () => {
    const scene = buildPartitionedTranscriptScene(INPUT, 100_000_000);
    expect(scene.sortedPrimitives.map(({ featureIndex }) => featureIndex)).toEqual([
      20, 40, 30, 10, 50,
    ]);
    expect(Array.from(scene.featureIndices)).toEqual([20, 40, 30, 10, 50]);
    expect(scene.packedInstanceData.byteLength).toBe(
      INPUT.length * TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideBytes
    );
    expect(scene.maxPrimitiveSpanBp).toBe(260_000_000);
    expect(
      scene.partitions.map(({ partitionIndex, firstInstance, instanceCount }) => [
        partitionIndex,
        firstInstance,
        instanceCount,
      ])
    ).toEqual([
      [0, 0, 1],
      [1, 1, 1],
      [2, 2, 1],
      [5, 3, 1],
      [12, 4, 1],
    ]);
    for (let i = 1; i < scene.partitions.length; i++) {
      const previous = scene.partitions[i - 1];
      expect(scene.partitions[i].firstInstance).toBe(
        previous.firstInstance + previous.instanceCount
      );
    }
  });

  it('submits every partition at full view and only relevant partitions for a 150M view', () => {
    const scene = buildPartitionedTranscriptScene(INPUT, 100_000_000);
    expect(
      planTranscriptPartitionSubmissions(scene, 0, 1_300_000_000).map(
        ({ partitionIndex }) => partitionIndex
      )
    ).toEqual([0, 1, 2, 5, 12]);
    expect(
      planTranscriptPartitionSubmissions(scene, 100_000_000, 250_000_000).map(
        ({ partitionIndex }) => partitionIndex
      )
    ).toEqual([0, 1]);
  });

  it('never drops a long primitive whose start partition is outside the viewport', () => {
    const scene = buildPartitionedTranscriptScene(INPUT, 100_000_000);
    const submissions = planTranscriptPartitionSubmissions(scene, 300_000_000, 320_000_000);
    expect(submissions.map(({ partitionIndex }) => partitionIndex)).toEqual([0]);
    expect(featureIndexForPartitionInstance(scene, submissions[0], 0)).toBe(20);
  });

  it('keeps stable feature-index mapping and rejects invalid local indices', () => {
    const scene = buildPartitionedTranscriptScene(INPUT, 100_000_000);
    const partition = scene.partitions.find(({ partitionIndex }) => partitionIndex === 5)!;
    expect(featureIndexForPartitionInstance(scene, partition, 0)).toBe(10);
    expect(featureIndexForPartitionInstance(scene, partition, -1)).toBeNull();
    expect(featureIndexForPartitionInstance(scene, partition, 1)).toBeNull();
  });

  it('fails closed on invalid partition and coordinate contracts', () => {
    expect(() => buildPartitionedTranscriptScene(INPUT, 0)).toThrow(/partitionSpanBp/);
    expect(() =>
      buildPartitionedTranscriptScene([{ ...INPUT[0], endBp: INPUT[0].startBp }], 100)
    ).toThrow(/coordinates/);
    expect(() =>
      buildPartitionedTranscriptScene([{ ...INPUT[0], alpha: Number.NaN }], 100)
    ).toThrow(/GPU instance attributes/);
    const scene = buildPartitionedTranscriptScene(INPUT, 100_000_000);
    expect(() => planTranscriptPartitionSubmissions(scene, 10, 10)).toThrow(/viewport/);
  });
});
