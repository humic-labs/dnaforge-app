import { describe, expect, it } from 'vitest';

import { deriveCatalogTrackData } from './catalog-derived-data';
import { computeCatalogDensity, createCatalogDensityScratch } from './catalog-density';
import { catalogTrackData, tssRecord } from './catalog-test-fixtures';

const PIXELS_PER_BP = 0.1;

const derived = deriveCatalogTrackData(
  catalogTrackData({
    kind: 'tss',
    records: [
      tssRecord(0, '+'),
      tssRecord(29, '+'),
      tssRecord(30, '+'),
      tssRecord(31, '-'),
      tssRecord(95, '-'),
      tssRecord(10_000, '+'),
    ],
  })
);

describe('computeCatalogDensity', () => {
  it('counts anchors per strand in genome-aligned bins touching the view', () => {
    const density = computeCatalogDensity({
      derived,
      viewStartBp: 0,
      viewEndBp: 120,
      pixelsPerBp: PIXELS_PER_BP,
      binPx: 3,
      scratch: createCatalogDensityScratch(),
    });
    expect(density.firstBin).toBe(0);
    expect(density.binCount).toBe(4);
    expect(Array.from(density.forward.subarray(0, 4))).toEqual([2, 1, 0, 0]);
    expect(Array.from(density.reverse.subarray(0, 4))).toEqual([0, 1, 0, 1]);
    expect(density.maxCount).toBe(2);
  });

  it('keeps a record in the same genome bin however the view is panned', () => {
    const at = (viewStartBp: number) =>
      computeCatalogDensity({
        derived,
        viewStartBp,
        viewEndBp: viewStartBp + 120,
        pixelsPerBp: PIXELS_PER_BP,
        binPx: 3,
        scratch: createCatalogDensityScratch(),
      });
    const a = at(0);
    const b = at(35);
    expect(a.forward[1 - a.firstBin]).toBe(1);
    expect(b.forward[1 - b.firstBin]).toBe(1);
  });

  it('ignores records outside the view when finding the busiest bin', () => {
    const density = computeCatalogDensity({
      derived,
      viewStartBp: 9_990,
      viewEndBp: 10_020,
      pixelsPerBp: PIXELS_PER_BP,
      binPx: 3,
      scratch: createCatalogDensityScratch(),
    });
    expect(density.maxCount).toBe(1);
  });

  it('reuses and clears the scratch buffers between calls', () => {
    const scratch = createCatalogDensityScratch();
    const input = {
      derived,
      viewStartBp: 0,
      viewEndBp: 120,
      pixelsPerBp: PIXELS_PER_BP,
      binPx: 3,
      scratch,
    };
    computeCatalogDensity(input);
    const buffer = scratch.forward;
    const second = computeCatalogDensity({ ...input, viewStartBp: 9_990, viewEndBp: 10_020 });
    expect(scratch.forward).toBe(buffer);
    expect(Array.from(second.forward.subarray(0, second.binCount))).toEqual([1]);
  });
});
