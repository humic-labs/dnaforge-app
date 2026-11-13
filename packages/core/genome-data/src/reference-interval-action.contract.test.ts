import { describe, expect, it } from 'vitest';

import { InMemoryGenomeDataSource } from './in-memory-genome-data-source';
import { runReferenceIntervalAction } from './reference-interval-action';

describe('reference interval action contract', () => {
  it('reads an exact 0-based half-open interval with source provenance', async () => {
    const source = new InMemoryGenomeDataSource({
      chrom: 'chrI',
      sequence: 'AACCGGTTAACC',
      features: [],
    });

    const result = await runReferenceIntervalAction(
      source,
      {
        chrom: 'chrI',
        start0: 0,
        end0: 6,
        strand: '+',
        operation: 'read',
      },
      { sourceId: 'fixtures/reference.fa', fastaPath: 'fixtures/reference.fa' }
    );

    expect(result).toMatchObject({
      ok: true,
      operation: 'read',
      interval: { chrom: 'chrI', start0: 0, end0: 6, strand: '+', length: 6 },
      provenance: {
        sourceId: 'fixtures/reference.fa',
        fastaPath: 'fixtures/reference.fa',
        chrom: 'chrI',
        start0: 0,
        end0: 6,
        requestedLength: 6,
      },
      sequence: 'AACCGG',
    });
  });
});
