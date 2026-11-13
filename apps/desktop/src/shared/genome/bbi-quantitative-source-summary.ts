import {
  buildQuantitativeSourceSummary,
  type QuantitativeSourceSummaryV1,
} from '@waypoint/genome-data';

import type { BbiQueryRegion, BbiQuantitativeRegion } from './bbi-reader-worker-protocol';
import type { BbiHeaderSummary } from './bbi-reader-worker-protocol';

export const BBI_QUANTITATIVE_SUMMARY_TARGET_BINS = 65_536;

export async function summarizeBbiQuantitativeSource(input: {
  readonly reader: {
    queryQuantitative(
      sourceKey: string,
      regions: ReadonlyArray<BbiQueryRegion>,
      basesPerSpan: number,
      signal?: AbortSignal
    ): Promise<ReadonlyArray<BbiQuantitativeRegion>>;
  };
  readonly sourceKey: string;
  readonly header: BbiHeaderSummary;
  readonly signal?: AbortSignal;
}): Promise<QuantitativeSourceSummaryV1 | undefined> {
  const references = input.header.references.filter(
    (reference) => Number.isSafeInteger(reference.length) && reference.length > 0
  );
  const totalBp = references.reduce((sum, reference) => sum + reference.length, 0);
  if (!Number.isSafeInteger(totalBp) || totalBp <= 0) return undefined;
  const basesPerSpan = Math.max(1, Math.ceil(totalBp / BBI_QUANTITATIVE_SUMMARY_TARGET_BINS));
  const regions = await input.reader.queryQuantitative(
    input.sourceKey,
    references.map((reference) => ({
      refName: reference.name,
      start: 0,
      end: reference.length,
    })),
    basesPerSpan,
    input.signal
  );
  const samples: number[] = [];
  for (const region of regions) {
    for (const value of region.values) {
      if (Number.isFinite(value)) samples.push(value);
    }
  }
  if (samples.length === 0) return undefined;
  return buildQuantitativeSourceSummary({
    samples,
    targetSampleCount: BBI_QUANTITATIVE_SUMMARY_TARGET_BINS,
    fullMin: input.header.totalSummary?.scoreMin,
    fullMax: input.header.totalSummary?.scoreMax,
  });
}
