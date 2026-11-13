import { describe, expect, it } from 'vitest';

import { assignFeatureLanesByType } from './lane-assignment';

describe('assignFeatureLanesByType', () => {
  it('stacks different types into separate lane bands', () => {
    const features = [
      { start: 100, end: 500, type: 'mRNA' },
      { start: 200, end: 600, type: 'mRNA' },
      { start: 100, end: 500, type: 'gene' },
      { start: 200, end: 600, type: 'gene' },
    ];
    const result = assignFeatureLanesByType(features, 10000);
    expect(result.numLanes).toBe(5);
    expect(result.byType).toHaveLength(2);
    expect(result.byType[0].type).toBe('gene');
    expect(result.byType[0].laneStart).toBe(0);
    expect(result.byType[0].laneCount).toBe(2);
    expect(result.byType[1].type).toBe('mRNA');
    expect(result.byType[1].laneStart).toBe(3);
    expect(result.byType[1].laneCount).toBe(2);
    expect(result.laneAssignments.get(0)).toBe(3);
    expect(result.laneAssignments.get(1)).toBe(4);
    expect(result.laneAssignments.get(2)).toBe(0);
    expect(result.laneAssignments.get(3)).toBe(1);
  });

  it('honors typeOrder for stack priority; remaining types appended alphabetically', () => {
    const features = [
      { start: 100, end: 200, type: 'mRNA' },
      { start: 100, end: 200, type: 'gene' },
      { start: 100, end: 200, type: 'regulatory' },
      { start: 100, end: 200, type: 'lncRNA' },
    ];
    const result = assignFeatureLanesByType(features, 10000, {
      typeOrder: ['mRNA', 'gene'],
    });
    expect(result.byType.map((b) => b.type)).toEqual(['mRNA', 'gene', 'lncRNA', 'regulatory']);
  });

  it('spacerLanes=0 packs bands without gaps', () => {
    const features = [
      { start: 100, end: 200, type: 'gene' },
      { start: 100, end: 200, type: 'mRNA' },
    ];
    const result = assignFeatureLanesByType(features, 10000, { spacerLanes: 0 });
    expect(result.numLanes).toBe(2);
    expect(result.byType[1].laneStart).toBe(1);
  });

  it('respects maxLanes per type group (overflow drops within the group)', () => {
    const features = [
      { start: 100, end: 500, type: 'mRNA' },
      { start: 100, end: 500, type: 'mRNA' },
      { start: 100, end: 500, type: 'mRNA' },
      { start: 100, end: 500, type: 'mRNA' },
      { start: 100, end: 500, type: 'gene' },
    ];
    const result = assignFeatureLanesByType(features, 10000, { maxLanes: 2 });
    expect(result.droppedCount).toBe(2);
    expect(result.byType.find((b) => b.type === 'mRNA')?.droppedCount).toBe(2);
    expect(result.byType.find((b) => b.type === 'gene')?.droppedCount).toBe(0);
  });

  it('keeps later track origins fixed when earlier reserved tracks are sparse or empty', () => {
    const assign = (features: ReadonlyArray<{ start: number; end: number; type: string }>) =>
      assignFeatureLanesByType(features, 10000, {
        maxLanes: 4,
        typeOrder: ['gene', 'mRNA'],
        bandTypes: ['gene', 'mRNA'],
        fixedBandCapacity: 4,
      });

    const sparse = assign([
      { start: 100, end: 200, type: 'gene' },
      { start: 100, end: 200, type: 'mRNA' },
    ]);
    const emptyPredecessor = assign([{ start: 100, end: 200, type: 'mRNA' }]);

    expect(sparse.byType).toEqual([
      { type: 'gene', laneStart: 0, laneCount: 1, laneCapacity: 4, droppedCount: 0 },
      { type: 'mRNA', laneStart: 5, laneCount: 1, laneCapacity: 4, droppedCount: 0 },
    ]);
    expect(emptyPredecessor.byType).toEqual([
      { type: 'gene', laneStart: 0, laneCount: 0, laneCapacity: 4, droppedCount: 0 },
      { type: 'mRNA', laneStart: 5, laneCount: 1, laneCapacity: 4, droppedCount: 0 },
    ]);
    expect(sparse.laneAssignments.get(1)).toBe(5);
    expect(emptyPredecessor.laneAssignments.get(0)).toBe(5);
    expect(sparse.localLaneAssignments.get(1)).toBe(0);
    expect(emptyPredecessor.localLaneAssignments.get(0)).toBe(0);
    expect(sparse.numLanes).toBe(9);
    expect(emptyPredecessor.numLanes).toBe(9);
  });

  it('empty input returns zero lanes', () => {
    const result = assignFeatureLanesByType([], 10000);
    expect(result.numLanes).toBe(0);
    expect(result.byType).toHaveLength(0);
    expect(result.laneAssignments.size).toBe(0);
  });

  it('single type behaves like flat assignFeatureLanes', () => {
    const features = [
      { start: 100, end: 200, type: 'mRNA' },
      { start: 150, end: 250, type: 'mRNA' },
      { start: 300, end: 400, type: 'mRNA' },
    ];
    const result = assignFeatureLanesByType(features, 10000);
    expect(result.byType).toHaveLength(1);
    expect(result.byType[0].laneStart).toBe(0);
    expect(result.numLanes).toBe(result.byType[0].laneCount);
  });
});
