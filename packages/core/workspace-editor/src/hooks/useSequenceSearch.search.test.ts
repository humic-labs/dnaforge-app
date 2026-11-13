import { describe, expect, it } from 'vitest';
import { SearchTooBroadError } from '@waypoint/sequence-utils';
import { runSequenceSearchForMode } from './useSequenceSearch';

describe('runSequenceSearchForMode', () => {
  it('allows medium-breadth ambiguous DNA searches above the old 5k cutoff', () => {
    const matches = runSequenceSearchForMode({
      sequence: 'AC'.repeat(3_000),
      annotations: [],
      circular: true,
      query: 'NN',
      mode: 'nucleotide',
    });

    expect(matches.length).toBeGreaterThan(5_000);
  });

  it('rejects broad IUPAC DNA searches before rendering unbounded highlight sets', () => {
    expect(() =>
      runSequenceSearchForMode({
        sequence: 'AC'.repeat(30_000),
        annotations: [],
        circular: true,
        query: 'NN',
        mode: 'nucleotide',
      })
    ).toThrow(SearchTooBroadError);
  });
});
