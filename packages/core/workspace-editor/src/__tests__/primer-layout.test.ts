import { describe, it, expect } from 'vitest';
import { packPrimerLanes } from '../primer-layout';
import type { PrimerDisplay } from '../types';

function makePrimer(
  id: string,
  start: number,
  end: number,
  direction: 'forward' | 'reverse' = 'forward'
): PrimerDisplay {
  return {
    id,
    name: id,
    start,
    end,
    direction,
    bases: 'A'.repeat(Math.abs(end - start)),
    tm: 60,
    gc: 50,
    overhangLength: 0,
  };
}

describe('packPrimerLanes', () => {
  it('assigns single primer to lane 0', () => {
    const primers = [makePrimer('p1', 10, 30)];
    const { laneMap, laneCount } = packPrimerLanes(primers, 0, 100, 100);
    expect(laneCount).toBe(1);
    expect(laneMap.get('p1')).toBe(0);
  });

  it('assigns non-overlapping primers to same lane', () => {
    const primers = [makePrimer('p1', 10, 30), makePrimer('p2', 50, 70)];
    const { laneMap, laneCount } = packPrimerLanes(primers, 0, 100, 100);
    expect(laneCount).toBe(1);
    expect(laneMap.get('p1')).toBe(0);
    expect(laneMap.get('p2')).toBe(0);
  });

  it('assigns overlapping primers to different lanes', () => {
    const primers = [makePrimer('p1', 10, 40), makePrimer('p2', 20, 50)];
    const { laneMap, laneCount } = packPrimerLanes(primers, 0, 100, 100);
    expect(laneCount).toBe(2);
    expect(laneMap.get('p1')).toBe(0);
    expect(laneMap.get('p2')).toBe(1);
  });

  it('handles three overlapping primers in three lanes', () => {
    const primers = [makePrimer('p1', 10, 50), makePrimer('p2', 20, 60), makePrimer('p3', 30, 70)];
    const { laneMap, laneCount } = packPrimerLanes(primers, 0, 100, 100);
    expect(laneCount).toBe(3);
    expect(laneMap.get('p1')).toBe(0);
    expect(laneMap.get('p2')).toBe(1);
    expect(laneMap.get('p3')).toBe(2);
  });

  it('reuses lanes when primers do not overlap', () => {
    const primers = [makePrimer('p1', 10, 30), makePrimer('p2', 20, 50), makePrimer('p3', 40, 60)];
    const { laneMap, laneCount } = packPrimerLanes(primers, 0, 100, 100);
    expect(laneCount).toBe(2);
    expect(laneMap.get('p1')).toBe(0);
    expect(laneMap.get('p2')).toBe(1);
    expect(laneMap.get('p3')).toBe(0);
  });

  it('returns empty for no primers', () => {
    const { laneMap, laneCount } = packPrimerLanes([], 0, 100, 100);
    expect(laneCount).toBe(0);
    expect(laneMap.size).toBe(0);
  });

  it('skips primers not visible on this line', () => {
    const primers = [makePrimer('p1', 10, 30), makePrimer('offscreen', 200, 220)];
    const { laneMap, laneCount } = packPrimerLanes(primers, 0, 100, 500);
    expect(laneCount).toBe(1);
    expect(laneMap.get('p1')).toBe(0);
    expect(laneMap.has('offscreen')).toBe(false);
  });

  it('handles origin-spanning primer', () => {
    const primers = [makePrimer('wrap', 90, 10)];
    primers[0].bases = 'A'.repeat(20);

    const { laneMap: map1 } = packPrimerLanes(primers, 80, 100, 100);
    expect(map1.has('wrap')).toBe(true);

    const { laneMap: map2 } = packPrimerLanes(primers, 0, 20, 100);
    expect(map2.has('wrap')).toBe(true);
  });

  it('handles normal primer on origin-spanning line', () => {
    const primers = [makePrimer('near-end', 85, 95)];
    const { laneMap, laneCount } = packPrimerLanes(primers, 80, 20, 100);
    expect(laneCount).toBe(1);
    expect(laneMap.get('near-end')).toBe(0);
  });

  it('handles origin-spanning primer on origin-spanning line', () => {
    const primers = [makePrimer('wrap', 90, 10)];
    primers[0].bases = 'A'.repeat(20);
    const { laneMap, laneCount } = packPrimerLanes(primers, 80, 20, 100);
    expect(laneCount).toBe(1);
    expect(laneMap.get('wrap')).toBe(0);
  });
});
