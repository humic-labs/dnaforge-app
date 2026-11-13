// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

import {
  BBI_QUANTITATIVE_SUMMARY_TARGET_BINS,
  summarizeBbiQuantitativeSource,
} from './bbi-quantitative-source-summary';

describe('BigWig quantitative source summary', () => {
  it('queries the complete source at a bounded equal-width resolution', async () => {
    const queryQuantitative = vi.fn().mockResolvedValue([
      {
        starts: new Int32Array([0, 100]),
        ends: new Int32Array([100, 200]),
        values: new Float32Array([2, 5, 10_000]),
      },
    ]);
    const summary = await summarizeBbiQuantitativeSource({
      reader: { queryQuantitative },
      sourceKey: 'source-key',
      header: {
        fileType: 'bigwig',
        references: [
          { name: 'chr1', length: 100_000 },
          { name: 'chr2', length: 50_000 },
        ],
        zoomReductionLevels: [10, 100],
        totalSummary: { basesCovered: 1_000, scoreMin: 2, scoreMax: 10_000 },
      },
    });

    expect(queryQuantitative).toHaveBeenCalledWith(
      'source-key',
      [
        { refName: 'chr1', start: 0, end: 100_000 },
        { refName: 'chr2', start: 0, end: 50_000 },
      ],
      Math.ceil(150_000 / BBI_QUANTITATIVE_SUMMARY_TARGET_BINS),
      undefined
    );
    expect(summary).toMatchObject({
      targetSampleCount: BBI_QUANTITATIVE_SUMMARY_TARGET_BINS,
      sampleCount: 3,
      fullMin: 2,
      fullMax: 10_000,
      missingData: 'excluded',
    });
  });

  it('returns no receipt for a valid source with no finite signal', async () => {
    await expect(
      summarizeBbiQuantitativeSource({
        reader: { queryQuantitative: vi.fn().mockResolvedValue([]) },
        sourceKey: 'empty',
        header: {
          fileType: 'bigwig',
          references: [{ name: 'chr1', length: 100 }],
          zoomReductionLevels: [],
        },
      })
    ).resolves.toBeUndefined();
  });
});
