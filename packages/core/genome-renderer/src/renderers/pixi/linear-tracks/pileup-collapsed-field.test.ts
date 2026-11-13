import { describe, expect, it } from 'vitest';

import type { PileupRecord } from '@waypoint/genome-data';

import {
  buildCollapsedPileupFieldFromExact,
  buildPileupVerticalScaleContract,
  overflowBaseYForMorph,
  overflowFillForHiddenCount,
} from './pileup-collapsed-field';

function read(start: number, end: number, readId: string): PileupRecord {
  return { chrom: 'chr11', start, end, readId, strand: '+', mapq: 60 };
}

describe('pileup collapsed field', () => {
  it('preserves fine-base visible and hidden depths across clipped, unsorted blocks', () => {
    const field = buildCollapsedPileupFieldFromExact(
      [
        read(3, 8, 'hidden-right'),
        read(2, 5, 'row-1'),
        read(-1, 3, 'row-0-left'),
        read(1, 4, 'hidden-middle'),
        read(3, 5, 'row-0-right'),
        read(-3, 2, 'hidden-left'),
        read(2, 2, 'empty'),
      ],
      Int32Array.from([-1, 1, 0, -1, 0, -1, -1]),
      0,
      5,
      2,
      { targetBinBp: 1, maxBins: 5 }
    )!;

    expect(Array.from(field.sourceRows)).toEqual([1, 1, 2, 2, 2]);
    expect(Array.from(field.exactDepthRows)).toEqual([1, 1, 2, 2, 2]);
    expect(Array.from(field.visibleRows)).toEqual([1, 1, 2, 2, 2]);
    expect(Array.from(field.hiddenCounts)).toEqual([1, 2, 1, 2, 1]);
    expect(Array.from(field.peakDepthRows)).toEqual([2, 3, 3, 4, 3]);
  });

  it('packs fractional blocks within a base instead of counting them as simultaneous', () => {
    const field = buildCollapsedPileupFieldFromExact(
      [read(0.5, 1, 'second'), read(0, 0.5, 'first')],
      Int32Array.from([0, 0]),
      0,
      1,
      2,
      { targetBinBp: 1, maxBins: 1 }
    )!;

    expect(Array.from(field.exactDepthRows)).toEqual([1]);
    expect(Array.from(field.visibleRows)).toEqual([1]);
    expect(Array.from(field.peakDepthRows)).toEqual([2]);
    expect(Array.from(field.hiddenCounts)).toEqual([0]);
  });

  it('saturates dense hidden and total depths without wrapping', () => {
    const records = Array.from({ length: 65_537 }, (_, i) => read(0, 2, `read-${i}`));
    const rows = new Int32Array(records.length).fill(-1);
    rows[0] = 0;
    const field = buildCollapsedPileupFieldFromExact(records, rows, 0, 2, 1, {
      targetBinBp: 1,
      maxBins: 2,
    })!;

    expect(Array.from(field.hiddenCounts)).toEqual([65_535, 65_535]);
    expect(Array.from(field.peakDepthRows)).toEqual([65_535, 65_535]);
    expect(Array.from(field.exactDepthRows)).toEqual([1, 1]);
    expect(field.maxHiddenCount).toBe(65_535);
  });

  it('keeps visible-row collapse linear while overflow height remains log-scaled', () => {
    const field = buildCollapsedPileupFieldFromExact(
      [read(0, 1000, 'row-0'), read(400, 600, 'row-1'), read(0, 1000, 'hidden')],
      Int32Array.from([0, 1, -1]),
      0,
      1000,
      2,
      { targetBinBp: 100, maxBins: 100 }
    )!;

    expect(field.visibleRows.length).toBe(10);
    expect(field.maxVisibleRows).toBe(2);
    expect(field.maxHiddenCount).toBe(1);
    expect(field.sourceRows[0]).toBe(1);
    expect(field.exactDepthRows[0]).toBe(1);
    expect(field.visibleRows[0]).toBe(1);
    expect(field.hiddenCounts[0]).toBe(1);
    expect(field.sourceRows[4]).toBe(2);
    expect(field.exactDepthRows[4]).toBe(2);
    expect(field.visibleRows[4]).toBe(2);
    expect(field.hiddenCounts[4]).toBe(1);

    const contract = buildPileupVerticalScaleContract({
      rowHeightPx: 10,
      effectiveMaxRows: 2,
      maxHiddenCount: field.maxHiddenCount,
      overflowMinFillFraction: 0.08,
      overflowMaxFillFraction: 0.98,
      overflowMinDenominatorReads: 8,
    });

    expect(contract.sourceReadHalfHeightPx).toBe(4.5);
    expect(contract.collapsedRowPitchPx).toBe(9);
    expect(contract.collapsedReadHalfHeightPx).toBe(4.5);
    expect(overflowFillForHiddenCount(contract, 1)).toBeGreaterThan(0.08);
    expect(overflowFillForHiddenCount(contract, 1)).toBeLessThan(0.98);

    expect(overflowBaseYForMorph(contract, field.visibleRows[0], 0)).toBe(20);
    expect(overflowBaseYForMorph(contract, field.visibleRows[0], 1)).toBe(9);
    expect(overflowBaseYForMorph(contract, field.visibleRows[4], 1)).toBe(18);

    const sourceRow1Center = contract.sourceRowPitchPx * 1 + contract.sourceRowPitchPx / 2;
    const collapsedRow1Center =
      contract.collapsedRowPitchPx * 1 + contract.collapsedReadHalfHeightPx;
    expect(collapsedRow1Center).toBeLessThan(sourceRow1Center);
    expect(collapsedRow1Center + contract.collapsedReadHalfHeightPx).toBeLessThan(
      sourceRow1Center + contract.sourceReadHalfHeightPx
    );
  });

  it(' — peakDepthRows reports TRUE uncapped depth even when exactDepthRows saturates at effectiveMaxRows', () => {
    const effectiveMaxRows = 2;
    const records = [
      read(0, 1000, 'r0'),
      read(400, 600, 'r1'),
      read(400, 600, 'r2'),
      read(400, 600, 'r3'),
      read(400, 600, 'r4'),
      read(400, 600, 'r5'),
    ];
    const rowAssignments = Int32Array.from([0, 1, 2, 3, 4, 5]);

    const field = buildCollapsedPileupFieldFromExact(
      records,
      rowAssignments,
      0,
      1000,
      effectiveMaxRows,
      { targetBinBp: 100, maxBins: 100 }
    )!;

    const deepBin = 4;

    expect(field.exactDepthRows[deepBin]).toBe(effectiveMaxRows);
    expect(field.maxExactDepthRows).toBe(effectiveMaxRows);

    expect(field.peakDepthRows[deepBin]).toBe(6);
    expect(field.maxPeakDepthRows).toBe(6);

    expect(field.peakDepthRows[deepBin]).toBeGreaterThan(field.exactDepthRows[deepBin]);

    expect(field.peakDepthRows[0]).toBe(1);
    expect(field.peakDepthRows[9]).toBe(1);

    expect(field.peakDepthRows.length).toBe(field.exactDepthRows.length);
  });
});
