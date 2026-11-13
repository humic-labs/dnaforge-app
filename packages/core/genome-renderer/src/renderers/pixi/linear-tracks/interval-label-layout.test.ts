import { describe, expect, it } from 'vitest';

import { planBoundedIntervalLabels } from './interval-label-layout';

describe('planBoundedIntervalLabels', () => {
  const records = [
    { start: 0, end: 120, name: 'forward-feature', strand: '+' as const },
    { start: 140, end: 260, name: 'reverse-feature', strand: '-' as const },
    { start: 280, end: 300, name: 'too-narrow' },
    { start: 320, end: 500, name: 'outside' },
  ];

  it('keeps labels inside visible feature bounds and exposes strand direction', () => {
    const labels = planBoundedIntervalLabels({
      records,
      laneAssignments: new Int16Array([0, 0, 0, 0]),
      viewportBpRange: { start: 0, end: 320 },
      viewportWidthPx: 320,
      bpToX: (bp) => bp,
      rowHeightPx: 10,
      trackHeightPx: 10,
      maxLabels: 8,
      labelForRecord: (record) => record.name,
      strandForRecord: (record) => record.strand,
    });

    expect(labels).toEqual([
      expect.objectContaining({ text: 'forward-feature →', recordIndex: 0, x: 3, y: 1 }),
      expect.objectContaining({ text: '← reverse-feature', recordIndex: 1, x: 143, y: 1 }),
    ]);
    for (const label of labels) {
      const record = records[label.recordIndex];
      expect(label.x).toBeGreaterThanOrEqual(record.start);
      expect(label.x + label.estimatedWidthPx).toBeLessThanOrEqual(record.end);
    }
  });

  it('ellipsizes long names and never exceeds the caller-owned label budget', () => {
    const many = Array.from({ length: 20 }, (_, index) => ({
      start: index * 100,
      end: index * 100 + 90,
      name: `feature-with-a-very-long-name-${index}`,
    }));
    const labels = planBoundedIntervalLabels({
      records: many,
      laneAssignments: new Int16Array(many.length),
      viewportBpRange: { start: 0, end: 2_000 },
      viewportWidthPx: 2_000,
      bpToX: (bp) => bp,
      rowHeightPx: 10,
      trackHeightPx: 10,
      maxLabels: 4,
      labelForRecord: (record) => record.name,
    });

    expect(labels).toHaveLength(4);
    expect(labels.every(({ text }) => text.endsWith('…'))).toBe(true);
  });

  it('skips dropped lanes, unnamed records, density summaries, and invalid budgets', () => {
    const density = {
      start: 0,
      end: 200,
      name: 'Density 12',
      extra: { dnaforgeDensity: { count: 12 } },
    };
    expect(
      planBoundedIntervalLabels({
        records: [records[0], { start: 0, end: 200 }, density],
        laneAssignments: new Int16Array([-1, 0, 0]),
        viewportBpRange: { start: 0, end: 200 },
        viewportWidthPx: 200,
        bpToX: (bp) => bp,
        rowHeightPx: 10,
        trackHeightPx: 10,
        maxLabels: 8,
        labelForRecord: (record) => ('name' in record ? record.name : undefined),
        isDensityRecord: (record) => 'extra' in record && Boolean(record.extra?.dnaforgeDensity),
      })
    ).toEqual([]);

    expect(() =>
      planBoundedIntervalLabels({
        records: [],
        laneAssignments: new Int16Array(),
        viewportBpRange: { start: 0, end: 1 },
        viewportWidthPx: 1,
        bpToX: (bp) => bp,
        rowHeightPx: 10,
        trackHeightPx: 10,
        maxLabels: -1,
        labelForRecord: () => undefined,
      })
    ).toThrow(/maxLabels/);
  });
});
