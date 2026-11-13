import { describe, expect, it } from 'vitest';

import {
  createLocalPreparedSourceReceipt,
  LOCAL_PREPARED_REFERENCE_SOURCE_RECEIPT_V1,
  LOCAL_PREPARED_REFERENCE_SOURCE_RECEIPT_V2,
  localPreparedSourceReceiptMatches,
  type PreparedSourceFileIdentity,
} from './prepared-reference-source-receipt';

const fasta = identity(101, 1);
const fai = identity(17, 2);
const gff = identity(211, 3);
const tbi = identity(29, 4);

describe('local prepared source receipts', () => {
  it('preserves the legacy annotated receipt contract', () => {
    const receipt = createLocalPreparedSourceReceipt({
      chrom: 'chr1',
      indexerVersion: 'dna-indexer schema 2',
      source: { fasta, gff },
      output: { fasta, fai, gff, tbi },
    });

    expect(receipt).toMatchObject({
      contract: LOCAL_PREPARED_REFERENCE_SOURCE_RECEIPT_V1,
      chrom: 'chr1',
      source: { fasta, gff },
      output: { fasta, fai, gff, tbi },
    });
    expect(
      localPreparedSourceReceiptMatches({
        value: receipt,
        chrom: 'chr1',
        source: { fasta, gff },
        output: { fasta, fai, gff, tbi },
      })
    ).toBe(true);
  });

  it('records sequence-only materialization without annotation placeholders', () => {
    const receipt = createLocalPreparedSourceReceipt({
      chrom: 'contigA',
      indexerVersion: 'dna-indexer schema 2',
      source: { fasta },
      output: { fasta, fai },
    });

    expect(receipt).toEqual({
      contract: LOCAL_PREPARED_REFERENCE_SOURCE_RECEIPT_V2,
      variant: 'sequence-only',
      chrom: 'contigA',
      indexerVersion: 'dna-indexer schema 2',
      source: { fasta },
      output: { fasta, fai },
    });
    expect(JSON.stringify(receipt)).not.toMatch(/gff|tbi/u);
    expect(
      localPreparedSourceReceiptMatches({
        value: receipt,
        chrom: 'contigA',
        source: null,
        output: { fasta, fai },
      })
    ).toBe(true);
  });

  it('rejects source/output variant drift and stale identities', () => {
    expect(() =>
      createLocalPreparedSourceReceipt({
        chrom: 'chr1',
        indexerVersion: 'dna-indexer schema 2',
        source: { fasta },
        output: { fasta, fai, gff, tbi },
      })
    ).toThrow('mismatched annotation variant');

    const receipt = createLocalPreparedSourceReceipt({
      chrom: 'contigA',
      indexerVersion: 'dna-indexer schema 2',
      source: { fasta },
      output: { fasta, fai },
    });
    expect(
      localPreparedSourceReceiptMatches({
        value: receipt,
        chrom: 'contigA',
        source: { fasta },
        output: { fasta: identity(102, 1), fai },
      })
    ).toBe(false);
  });
});

function identity(size: number, clock: number): PreparedSourceFileIdentity {
  return { size, mtimeMs: clock, ctimeMs: clock };
}
