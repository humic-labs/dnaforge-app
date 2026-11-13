import { describe, expect, it } from 'vitest';

import {
  projectIndexedRendererRange,
  projectIndexedRendererSelection,
} from './indexed-sequence-actions';

const assembly = {
  chromosomes: [
    { chrom: 'chr1', length: 100 },
    { chrom: 'chr2', length: 50 },
  ],
};

describe('indexed sequence action targets', () => {
  it('converts an inclusive renderer selection to one chromosome-local half-open interval', () => {
    expect(projectIndexedRendererSelection([105, 109], 'chr1', assembly)).toEqual({
      chrom: 'chr2',
      start0: 5,
      end0: 10,
    });
  });

  it('normalizes a reversed selection before projecting it', () => {
    expect(projectIndexedRendererSelection([14, 10], 'chr1')).toEqual({
      chrom: 'chr1',
      start0: 10,
      end0: 15,
    });
  });

  it('rejects a selection crossing a chromosome boundary', () => {
    expect(projectIndexedRendererSelection([98, 102], 'chr1', assembly)).toBeNull();
  });

  it('projects renderer feature geometry that is already half-open', () => {
    expect(projectIndexedRendererRange({ start: 110, end: 120 }, 'chr1', assembly)).toEqual({
      chrom: 'chr2',
      start0: 10,
      end0: 20,
    });
  });
});
