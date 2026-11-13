import { describe, expect, it } from 'vitest';
import { sanitizeClosedBetaProperties } from './analytics-allowlist';
import { sequenceSearchCountBucket } from './sequence-search-telemetry';

describe('sequence search telemetry privacy boundary', () => {
  it.each([
    [0, '0'],
    [1, '1'],
    [2, '2_10'],
    [10, '2_10'],
    [11, '11_100'],
    [100, '11_100'],
    [101, '101_1000'],
    [1000, '101_1000'],
    [1001, '1001_10000'],
    [10000, '1001_10000'],
    [10001, '10001_100000'],
    [100000, '10001_100000'],
    [100001, '100001_1000000'],
    [1000000, '100001_1000000'],
    [1000001, 'over_1000000'],
  ] as const)('buckets %s without preserving the exact count', (value, expected) => {
    expect(sequenceSearchCountBucket(value)).toBe(expected);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'refuses invalid count %s',
    (value) => expect(sequenceSearchCountBucket(value)).toBe('unknown')
  );

  it('retains only closed query-generation context and count buckets', () => {
    const properties = {
      sequence_search_source: 'in_memory',
      sequence_search_mode: 'nucleotide',
      sequence_search_topology: 'circular',
      sequence_search_result: 'matches',
      sequence_search_query_length_bucket: '11_100',
      sequence_search_sequence_length_bucket: '1001_10000',
      sequence_search_match_count_bucket: '1',
    };
    expect(sanitizeClosedBetaProperties(properties)).toEqual(properties);
  });

  it('rejects content, paths, coordinates and invented categories', () => {
    expect(
      sanitizeClosedBetaProperties({
        sequence_search_source: '/private/project',
        sequence_search_mode: 'GAGATACCTACAGCGTGA',
        sequence_search_topology: 'my plasmid',
        sequence_search_result: 'private name',
        sequence_search_query_length_bucket: 18,
        sequence_search_sequence_length_bucket: '2686',
        sequence_search_match_count_bucket: -1,
        query: 'GAGATACCTACAGCGTGA',
        sequence: 'ATGC',
        sequence_hash: 'a'.repeat(64),
        annotation_name: 'Private gene',
        file_path: '/private/project/sequence.gb',
        start: 1000,
        end: 1017,
      })
    ).toEqual({});
  });
});
