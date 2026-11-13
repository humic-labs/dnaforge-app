// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  INDEXED_CUT_SITE_MAX_BP_PER_PX,
  planIndexedCutSiteWindow,
  type IndexedScanWindow,
} from './indexed-cut-site-window';

const chromosomes = [
  { chrom: 'chr1', length: 1_000_000 },
  { chrom: 'chr2', length: 500_000 },
];
const widthPx = 1000;
const maxViewBp = widthPx * INDEXED_CUT_SITE_MAX_BP_PER_PX;

function plan(
  viewport: { start: number; end: number } | null,
  current: IndexedScanWindow | null = null,
  viewerWidthPx = widthPx
) {
  return planIndexedCutSiteWindow({ viewport, viewerWidthPx, chromosomes, current });
}

describe('planIndexedCutSiteWindow', () => {
  it('preloads a padded window just past the showing limit, without showing it', () => {
    const result = plan({ start: 100_000, end: 160_000 });
    expect(result.showable).toBe(false);
    expect(result.action).toBe('load');
    expect(result.window).toEqual({
      chrom: 'chr1',
      start0: 0,
      end0: 280_000,
      chromGlobalStart: 0,
    });
  });

  it('does nothing far past the preload limit and leaves the loaded window alone', () => {
    const current: IndexedScanWindow = {
      chrom: 'chr1',
      start0: 0,
      end0: 50_000,
      chromGlobalStart: 0,
    };
    const result = plan({ start: 0, end: maxViewBp * 5 }, current);
    expect(result).toMatchObject({ action: 'none', showable: false, unavailable: false });
  });

  it('pads a small view by at least twice the widest showable view, on its chromosome', () => {
    const result = plan({ start: 1_100_000, end: 1_110_000 });
    expect(result.showable).toBe(true);
    expect(result.window).toEqual({
      chrom: 'chr2',
      start0: 20_000,
      end0: 190_000,
      chromGlobalStart: 1_000_000,
    });
  });

  it('clamps to the chromosome and never crosses into the next one', () => {
    const result = plan({ start: 995_000, end: 1_005_000 });
    expect(result.window).toEqual({
      chrom: 'chr1',
      start0: 915_000,
      end0: 1_000_000,
      chromGlobalStart: 0,
    });
  });

  it('keeps the window while panning inside it, and reloads before the view reaches its edge', () => {
    const current: IndexedScanWindow = {
      chrom: 'chr1',
      start0: 20_000,
      end0: 190_000,
      chromGlobalStart: 0,
    };
    expect(plan({ start: 100_000, end: 110_000 }, current).action).toBe('keep');
    expect(plan({ start: 146_000, end: 156_000 }, current).action).toBe('load');
  });

  it('keeps a window against a chromosome end even when the view touches it', () => {
    const current: IndexedScanWindow = {
      chrom: 'chr1',
      start0: 915_000,
      end0: 1_000_000,
      chromGlobalStart: 0,
    };
    expect(plan({ start: 990_000, end: 1_000_000 }, current).action).toBe('keep');
  });

  it('is unavailable before the viewer has a size or a viewport', () => {
    expect(plan(null).unavailable).toBe(true);
    expect(plan({ start: 0, end: 10 }, null, 0).unavailable).toBe(true);
  });
});
