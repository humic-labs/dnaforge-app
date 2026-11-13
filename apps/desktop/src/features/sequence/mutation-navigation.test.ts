// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { mutationGlobalRange, mutationViewport } from './mutation-navigation';

const assembly = {
  assemblyId: 'grch38',
  displayName: 'GRCh38',
  chromosomes: [
    { chrom: 'chr1', length: 100 },
    { chrom: 'chr7', length: 80 },
    { chrom: 'chr18', length: 60 },
  ],
};

describe('mutation navigation', () => {
  it('maps a chromosome-local half-open SNV span to the assembly-global axis', () => {
    expect(
      mutationGlobalRange({
        assembly,
        activeChrom: 'chr1',
        variant: { chrom: 'chr7', start: 12, end: 13 },
      })
    ).toEqual({ start: 112, end: 113 });
  });

  it('keeps deletion reference spans exact and rejects unknown chromosomes', () => {
    expect(
      mutationGlobalRange({
        assembly,
        activeChrom: 'chr1',
        variant: { chrom: 'chr18', start: 20, end: 24 },
      })
    ).toEqual({ start: 200, end: 204 });

    expect(() =>
      mutationGlobalRange({
        assembly,
        activeChrom: 'chr1',
        variant: { chrom: '18', start: 20, end: 24 },
      })
    ).toThrow('not present');
  });

  it('centers a narrow detail viewport without crossing chromosome boundaries', () => {
    expect(
      mutationViewport({
        globalRange: { start: 112, end: 113 },
        chromosomeGlobalRange: { start: 100, end: 180 },
        targetSpanBp: 20,
      })
    ).toEqual({ start: 102, end: 122 });

    expect(
      mutationViewport({
        globalRange: { start: 100, end: 101 },
        chromosomeGlobalRange: { start: 100, end: 180 },
        targetSpanBp: 20,
      })
    ).toEqual({ start: 100, end: 120 });
  });
});
