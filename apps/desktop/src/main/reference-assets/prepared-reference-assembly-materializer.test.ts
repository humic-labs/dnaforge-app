import { describe, expect, it } from 'vitest';

import { parseDnaIndexerAssemblyTerminalStatus } from './prepared-reference-assembly-materializer';

const PLAN = [
  { sourceSeqId: 'NC_000001.11', name: 'chr1', expectedLengthBp: 100, circular: false },
] as const;

function terminalWithCandidates(records: readonly unknown[]): string {
  return JSON.stringify({
    ok: true,
    bundles: [
      {
        sourceSeqId: 'NC_000001.11',
        name: 'chr1',
        length: 100,
        featureCount: 2,
      },
    ],
    semanticCandidates: {
      contract: 'dna-indexer-semantic-candidates.v1',
      records,
    },
  });
}

describe('dna-indexer assembly semantic candidate boundary', () => {
  it('accepts admitted GFF3 semantic terms without deduplicating raw source rows', () => {
    const terminal = parseDnaIndexerAssemblyTerminalStatus(
      terminalWithCandidates([
        {
          sourceSeqId: 'NC_000001.11',
          type: 'centromere',
          start: 40,
          end: 60,
        },
        {
          sourceSeqId: 'NC_000001.11',
          type: 'SO:0000577',
          start: 40,
          end: 60,
        },
        {
          sourceSeqId: 'NC_000001.11',
          type: 'origin_of_replication',
          start: 75,
          end: 75,
        },
      ]),
      PLAN,
      true
    );

    expect(terminal.semanticCandidates?.records).toHaveLength(3);
  });

  it.each([
    [
      'unknown source sequence',
      { sourceSeqId: 'NC_missing', type: 'centromere', start: 40, end: 60 },
    ],
    ['unsupported term', { sourceSeqId: 'NC_000001.11', type: 'chromosome', start: 1, end: 100 }],
    [
      'out-of-range interval',
      { sourceSeqId: 'NC_000001.11', type: 'centromere', start: 40, end: 101 },
    ],
    ['reversed interval', { sourceSeqId: 'NC_000001.11', type: 'centromere', start: 60, end: 40 }],
  ])('rejects a %s', (_label, record) => {
    expect(() =>
      parseDnaIndexerAssemblyTerminalStatus(terminalWithCandidates([record]), PLAN, true)
    ).toThrow(/semantic candidate/i);
  });

  it('requires the bounded candidate envelope for GFF3 assembly ingestion', () => {
    const stdout = JSON.stringify({
      ok: true,
      bundles: [
        {
          sourceSeqId: 'NC_000001.11',
          name: 'chr1',
          length: 100,
          featureCount: 0,
        },
      ],
    });

    expect(() => parseDnaIndexerAssemblyTerminalStatus(stdout, PLAN, true)).toThrow(
      /semantic candidates/i
    );
    expect(parseDnaIndexerAssemblyTerminalStatus(stdout, PLAN, false).semanticCandidates).toBe(
      undefined
    );
  });
});
