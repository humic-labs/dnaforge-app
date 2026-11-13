import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { assignFeatureLanes } from './lane-assignment';

type Interval = { start: number; end: number };

const GRCH38_LENGTH_BP = 3_088_269_832;
const GRCH38_CHROMS = [
  ...Array.from({ length: 22 }, (_, index) => `chr${index + 1}`),
  'chrX',
  'chrY',
] as const;

function expectUncappedProjectionEqualsCap(
  features: Interval[],
  seqLength: number,
  maxLanes: number,
  uncapped = assignFeatureLanes(features, seqLength)
) {
  const capped = assignFeatureLanes(features, seqLength, { maxLanes });
  for (let featureIndex = 0; featureIndex < features.length; featureIndex += 1) {
    const uncappedLane = uncapped.laneAssignments.get(featureIndex);
    const expected =
      uncappedLane !== undefined && uncappedLane < maxLanes ? uncappedLane : undefined;
    const actual = capped.laneAssignments.get(featureIndex);
    if (actual !== expected) {
      throw new Error(
        [
          `lane-cap projection mismatch at feature ${featureIndex}`,
          `maxLanes=${maxLanes}`,
          `uncapped=${String(uncappedLane)}`,
          `expected=${String(expected)}`,
          `actual=${String(actual)}`,
          `interval=${features[featureIndex].start}-${features[featureIndex].end}`,
        ].join(' | ')
      );
    }
  }
  const expectedDroppedCount = features.length - capped.laneAssignments.size;
  if (!Object.is(capped.droppedCount, expectedDroppedCount)) {
    throw new Error(
      `lane-cap dropped-count mismatch at cap ${maxLanes}: expected ${expectedDroppedCount}, actual ${capped.droppedCount}`
    );
  }
  const expectedNumLanes = Math.min(uncapped.numLanes, maxLanes);
  if (!Object.is(capped.numLanes, expectedNumLanes)) {
    throw new Error(
      `lane-cap lane-count mismatch at cap ${maxLanes}: expected ${expectedNumLanes}, actual ${capped.numLanes}`
    );
  }
  return capped;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function laneAssignmentSha256(assignments: ReadonlyMap<number, number>): string {
  const hash = createHash('sha256');
  for (const [featureIndex, lane] of assignments) {
    hash.update(`${featureIndex}:${lane}\n`);
  }
  return hash.digest('hex');
}

describe('assignFeatureLanes', () => {
  it('keeps the greedy lane result for sorted non-overlapping linear intervals', () => {
    const result = assignFeatureLanes(
      [
        { start: 0, end: 10 },
        { start: 10, end: 20 },
        { start: 20, end: 30 },
      ],
      100
    );

    expect(result.numLanes).toBe(1);
    expect([...result.laneAssignments.entries()]).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
    ]);
  });

  it('keeps the greedy lane result for sorted overlapping linear intervals', () => {
    const result = assignFeatureLanes(
      [
        { start: 0, end: 20 },
        { start: 5, end: 25 },
        { start: 21, end: 30 },
        { start: 26, end: 35 },
      ],
      100
    );

    expect(result.numLanes).toBe(2);
    expect([...result.laneAssignments.entries()]).toEqual([
      [0, 0],
      [1, 1],
      [2, 0],
      [3, 1],
    ]);
  });

  it('keeps max-lane dropping semantics on the sorted linear path', () => {
    const result = assignFeatureLanes(
      [
        { start: 0, end: 50 },
        { start: 10, end: 60 },
        { start: 20, end: 70 },
        { start: 51, end: 80 },
      ],
      100,
      { maxLanes: 2 }
    );

    expect(result.numLanes).toBe(2);
    expect(result.droppedCount).toBe(1);
    expect([...result.laneAssignments.entries()]).toEqual([
      [0, 0],
      [1, 1],
      [3, 0],
    ]);
  });

  it('falls back safely for unsorted input while preserving greedy input-order semantics', () => {
    const result = assignFeatureLanes(
      [
        { start: 20, end: 30 },
        { start: 0, end: 10 },
        { start: 5, end: 25 },
      ],
      100
    );

    expect(result.numLanes).toBe(2);
    expect([...result.laneAssignments.entries()]).toEqual([
      [0, 0],
      [1, 0],
      [2, 1],
    ]);
  });

  it('projects an uncapped assignment exactly onto every lower cap for adversarial overlaps', () => {
    const features = [
      { start: 0, end: 1_000 },
      { start: 0, end: 1_000 },
      { start: 0, end: 1_000 },
      { start: 0, end: 1_000 },

      { start: 10, end: 20 },

      { start: 21, end: 30 },

      { start: 1_001, end: 1_010 },

      { start: 1_001, end: 1_010 },
      { start: 1_001, end: 1_010 },
    ];
    const uncapped = assignFeatureLanes(features, 2_000);

    for (let cap = 1; cap <= 6; cap += 1) {
      expectUncappedProjectionEqualsCap(features, 2_000, cap, uncapped);
    }
  });

  it('preserves the cap projection law across deterministic sorted and unsorted properties', () => {
    const random = seededRandom(0x708b_1234);
    const trials = 2_000;
    const maxFeatureCount = 128;

    for (let trial = 0; trial < trials; trial += 1) {
      const featureCount = 1 + Math.floor(random() * maxFeatureCount);
      const features = Array.from({ length: featureCount }, () => {
        const start = Math.floor(random() * 100_000);
        const span = 1 + Math.floor(random() * 20_000);
        return { start, end: start + span };
      });

      if ((trial & 1) === 0) {
        features.sort((left, right) => left.start - right.start || left.end - right.end);
      }
      const uncapped = assignFeatureLanes(features, 200_000);
      for (let cap = 1; cap <= 12; cap += 1) {
        expectUncappedProjectionEqualsCap(features, 200_000, cap, uncapped);
      }
    }
  });
});

const fullGrch38ProofEnabled = process.env.RUN_FULL_GRCH38_LANE_PROOF === '1';

describe.skipIf(!fullGrch38ProofEnabled)('assignFeatureLanes full-GRCh38 projection proof', () => {
  it('matches the full expanded-source fingerprint at cap 12', () => {
    const fixturePath = fileURLToPath(
      new URL(
        '../../../../../test-fixtures/.waypoint/genome-index/assembly-overview/' +
          'grch38-32620fe8fe0c94bf08c8f7f0-expanded.features.json',
        import.meta.url
      )
    );
    expect(existsSync(fixturePath), `missing full-GRCh38 fixture: ${fixturePath}`).toBe(true);
    const envelope = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
      byChrom?: Record<string, Array<{ type?: unknown; start?: unknown; end?: unknown }>>;
    };
    const features: Interval[] = [];
    for (const chrom of GRCH38_CHROMS) {
      const records = envelope.byChrom?.[chrom];
      expect(Array.isArray(records), `missing ${chrom} feature partition`).toBe(true);
      for (const record of records ?? []) {
        if (record.type !== 'mRNA') continue;
        if (
          !Number.isSafeInteger(record.start) ||
          !Number.isSafeInteger(record.end) ||
          (record.start as number) < 0 ||
          (record.end as number) <= (record.start as number)
        ) {
          throw new Error(`invalid ${chrom} mRNA interval in full-GRCh38 fixture`);
        }
        features.push({ start: record.start as number, end: record.end as number });
      }
    }

    const uncapped = assignFeatureLanes(features, GRCH38_LENGTH_BP);
    const cap12 = expectUncappedProjectionEqualsCap(features, GRCH38_LENGTH_BP, 12, uncapped);

    expect(features).toHaveLength(131_253);
    expect(uncapped.numLanes).toBe(368);
    expect(uncapped.droppedCount).toBe(0);
    expect(cap12.numLanes).toBe(12);
    expect(cap12.laneAssignments.size).toBe(95_911);
    expect(cap12.droppedCount).toBe(35_342);
    expect(laneAssignmentSha256(uncapped.laneAssignments)).toBe(
      '160511153834d2465fd12a35286e195cbef56a997fdce2490fc3d1c2c8c7b965'
    );
    expect(laneAssignmentSha256(cap12.laneAssignments)).toBe(
      'a0e21784c9d1ec58e2dd5c36cc9f41b513db8358b12d0a4bbcb0d59e3a153367'
    );
  });
});
