// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  indexedGlobalRangeToChromosome,
  parseIndexedInterval,
  resolveIndexedPrimerFindWindow,
} from './indexed-primer-find-scope';

const chromosomes = [
  { chrom: 'chr1', length: 1_000 },
  { chrom: 'chr2', length: 500 },
];

describe('indexed primer Find scope', () => {
  it('parses intervals the way people type them, 1-based and inclusive', () => {
    expect(parseIndexedInterval('chr2:101-200', chromosomes)).toEqual({
      window: { chrom: 'chr2', start0: 100, end0: 200 },
      disabledReason: null,
    });
    expect(parseIndexedInterval(' chr1 : 1,000 – 1,000 ', chromosomes).window).toEqual({
      chrom: 'chr1',
      start0: 999,
      end0: 1_000,
    });
  });

  it('explains an interval it cannot search', () => {
    expect(parseIndexedInterval('chr1 10-20', chromosomes).disabledReason).toMatch(/like chr1/);
    expect(parseIndexedInterval('chrX:1-2', chromosomes).disabledReason).toMatch(
      /not a chromosome/
    );
    expect(parseIndexedInterval('chr1:20-10', chromosomes).disabledReason).toMatch(/not after/);
    expect(parseIndexedInterval('chr2:1-501', chromosomes).disabledReason).toMatch(/500 bp long/);
  });

  it('maps a visible range onto one chromosome and refuses one that crosses a boundary', () => {
    expect(indexedGlobalRangeToChromosome({ start: 1_100, end: 1_200 }, chromosomes)).toEqual({
      chrom: 'chr2',
      start0: 100,
      end0: 200,
    });
    expect(indexedGlobalRangeToChromosome({ start: 900, end: 1_100 }, chromosomes)).toBeNull();
  });

  it('asks to zoom in, select, or enter an interval when the scope is too wide', () => {
    const tooWide = resolveIndexedPrimerFindWindow({
      mode: 'visible',
      viewport: { start: 0, end: 900 },
      selection: null,
      intervalText: '',
      chromosomes,
      maxBp: 500,
    });
    expect(tooWide.window).toBeNull();
    expect(tooWide.disabledReason).toMatch(/Zoom in, select a region, or enter an interval/);
    expect(
      resolveIndexedPrimerFindWindow({
        mode: 'visible',
        viewport: { start: 900, end: 1_100 },
        selection: null,
        intervalText: '',
        chromosomes,
      }).disabledReason
    ).toMatch(/Zoom in/);
  });

  it('searches the selection when asked to', () => {
    const selection = { chrom: 'chr1', start0: 10, end0: 40 };
    expect(
      resolveIndexedPrimerFindWindow({
        mode: 'selection',
        viewport: null,
        selection,
        intervalText: '',
        chromosomes,
      })
    ).toEqual({ window: selection, disabledReason: null });
    expect(
      resolveIndexedPrimerFindWindow({
        mode: 'selection',
        viewport: null,
        selection: null,
        intervalText: '',
        chromosomes,
      }).disabledReason
    ).toMatch(/Select a region/);
  });
});
