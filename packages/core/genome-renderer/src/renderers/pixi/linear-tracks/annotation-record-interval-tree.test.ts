import { describe, expect, it } from 'vitest';

import type { AnnotationRecord } from '@waypoint/genome-data';

import { AnnotationRecordIntervalTree } from './annotation-record-interval-tree';

function rec(start: number, end: number): AnnotationRecord {
  return { chrom: 'chr11', start, end };
}

describe('AnnotationRecordIntervalTree — basic', () => {
  it('handles an empty record set', () => {
    const tree = new AnnotationRecordIntervalTree([]);
    expect(tree.size).toBe(0);
    expect(tree.queryAtBp(100)).toEqual([]);
  });

  it('finds a single record at its start', () => {
    const tree = new AnnotationRecordIntervalTree([rec(100, 200)]);
    expect(tree.queryAtBp(100)).toEqual([0]);
  });

  it('does not match bp at the half-open end boundary', () => {
    const tree = new AnnotationRecordIntervalTree([rec(100, 200)]);
    expect(tree.queryAtBp(200)).toEqual([]);
    expect(tree.queryAtBp(199)).toEqual([0]);
  });

  it('does not match bp before the start', () => {
    const tree = new AnnotationRecordIntervalTree([rec(100, 200)]);
    expect(tree.queryAtBp(99)).toEqual([]);
  });

  it('finds multiple overlapping records', () => {
    const tree = new AnnotationRecordIntervalTree([rec(0, 1000), rec(100, 500), rec(200, 300)]);
    const out = tree.queryAtBp(250).sort();
    expect(out).toEqual([0, 1, 2]);
  });

  it('returns only records overlapping the query bp', () => {
    const tree = new AnnotationRecordIntervalTree([
      rec(0, 50),
      rec(100, 200),
      rec(300, 400),
      rec(500, 600),
    ]);
    expect(tree.queryAtBp(150).sort()).toEqual([1]);
    expect(tree.queryAtBp(350).sort()).toEqual([2]);
    expect(tree.queryAtBp(250).sort()).toEqual([]);
  });

  it('finds a nested record that fully covers the query bp', () => {
    const tree = new AnnotationRecordIntervalTree([
      rec(0, 10_000),
      rec(1000, 2000),
      rec(5000, 5500),
    ]);
    expect(tree.queryAtBp(5250).sort()).toEqual([0, 2]);
  });
});

describe('AnnotationRecordIntervalTree — chr11-scale stress', () => {
  it('finds hits in a realistic-shaped record set', () => {
    const N = 10_000;
    const records: AnnotationRecord[] = [];
    const span = 135_086_622;
    for (let i = 0; i < N; i++) {
      const start = Math.floor((span / N) * i);
      records.push(rec(start, start + 200));
    }
    const tree = new AnnotationRecordIntervalTree(records);
    const targetIdx = 1234;
    const targetStart = records[targetIdx].start;
    const hits = tree.queryAtBp(targetStart);
    expect(hits).toContain(targetIdx);
    const between = records[targetIdx].end + 1;
    expect(tree.queryAtBp(between)).toEqual([]);
  });

  it('is fast at 100k records', () => {
    const N = 100_000;
    const records: AnnotationRecord[] = [];
    const span = 135_086_622;
    for (let i = 0; i < N; i++) {
      const start = Math.floor((span / N) * i);
      records.push(rec(start, start + 250));
    }
    const buildStart = performance.now();
    const tree = new AnnotationRecordIntervalTree(records);
    const buildMs = performance.now() - buildStart;
    expect(buildMs).toBeLessThan(500);

    const queryStart = performance.now();
    for (let i = 0; i < 1000; i++) {
      tree.queryAtBp(Math.floor(Math.random() * span));
    }
    const queryAvgMs = (performance.now() - queryStart) / 1000;
    expect(queryAvgMs).toBeLessThan(0.5);
  });
});

describe('AnnotationRecordIntervalTree.queryAtBpLane', () => {
  it('returns only records on the requested lane', () => {
    const tree = new AnnotationRecordIntervalTree([rec(0, 1000), rec(100, 200), rec(150, 800)]);
    const laneAssignment = new Int16Array([0, 1, 0]);
    expect(tree.queryAtBpLane(180, 0, laneAssignment).sort()).toEqual([0, 2]);
    expect(tree.queryAtBpLane(180, 1, laneAssignment).sort()).toEqual([1]);
    expect(tree.queryAtBpLane(180, 2, laneAssignment).sort()).toEqual([]);
  });

  it('returns empty when no records overlap regardless of lane', () => {
    const tree = new AnnotationRecordIntervalTree([rec(100, 200)]);
    const laneAssignment = new Int16Array([0]);
    expect(tree.queryAtBpLane(50, 0, laneAssignment)).toEqual([]);
  });
});

describe('AnnotationRecordIntervalTree — edge cases', () => {
  it('zero-length record [start, start) never matches', () => {
    const tree = new AnnotationRecordIntervalTree([rec(100, 100)]);
    expect(tree.queryAtBp(100)).toEqual([]);
    expect(tree.queryAtBp(99)).toEqual([]);
  });

  it('record at bp=0 with end > 0 is found at bp=0', () => {
    const tree = new AnnotationRecordIntervalTree([rec(0, 100)]);
    expect(tree.queryAtBp(0)).toEqual([0]);
  });

  it('duplicate intervals are both returned', () => {
    const tree = new AnnotationRecordIntervalTree([rec(100, 200), rec(100, 200)]);
    expect(tree.queryAtBp(150).sort()).toEqual([0, 1]);
  });
});
