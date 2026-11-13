// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { assertTextIntervalReferencesCompatible } from './text-interval-reference-compatibility';

const expected = [
  { name: 'chr1', length: 1_000 },
  { name: 'chr2', length: 2_000 },
  { name: 'chrM', length: 100 },
];

describe('text interval reference compatibility', () => {
  it('allows a sparse source subset and records unambiguous aliases', async () => {
    const receipt = await assertTextIntervalReferencesCompatible({
      assemblyId: 'test-assembly',
      expected,
      actual: [
        { name: '1', maxEnd: 900 },
        { name: 'MT', maxEnd: 80 },
      ],
      formatName: 'BED',
      checkedAt: '2026-09-21T19:00:00.000Z',
    });

    expect(receipt).toMatchObject({
      assemblyId: 'test-assembly',
      contigMap: { chr1: '1', chrM: 'MT' },
      checkedContigs: 2,
      status: 'compatible',
      checkedAt: '2026-09-21T19:00:00.000Z',
    });
  });

  it('rejects coordinates outside the admitted assembly contig', async () => {
    await expect(
      assertTextIntervalReferencesCompatible({
        assemblyId: 'test-assembly',
        expected,
        actual: [{ name: 'chr1', maxEnd: 1_001 }],
        formatName: 'GFF3',
      })
    ).rejects.toThrow('GFF3 reference mismatch for chr1: coordinate 1001 exceeds length 1000');
  });

  it('rejects every source contig that cannot be mapped to the assembly', async () => {
    await expect(
      assertTextIntervalReferencesCompatible({
        assemblyId: 'test-assembly',
        expected,
        actual: [
          { name: 'chr1', maxEnd: 50 },
          { name: 'unknown', maxEnd: 20 },
        ],
        formatName: 'BED',
      })
    ).rejects.toThrow('BED reference unknown is not present in test-assembly');
  });
});

describe('a plain interval file written in another naming convention', () => {
  const GRCH38 = [
    { name: 'chr1', length: 248_956_422, aliases: ['NC_000001.11', 'CM000663.2', '1'] },
    { name: 'chr2', length: 242_193_529, aliases: ['NC_000002.12', 'CM000664.2', '2'] },
  ];

  it('accepts a file that names contigs by RefSeq accession', async () => {
    const receipt = await assertTextIntervalReferencesCompatible({
      assemblyId: 'grch38',
      expected: GRCH38,
      actual: [{ name: 'NC_000001.11', maxEnd: 1_000_000 }],
      formatName: 'BED',
    });
    expect(receipt.contigMap).toEqual({ chr1: 'NC_000001.11' });
  });

  it('accepts a file that names contigs by GenBank accession', async () => {
    const receipt = await assertTextIntervalReferencesCompatible({
      assemblyId: 'grch38',
      expected: GRCH38,
      actual: [{ name: 'CM000664.2', maxEnd: 500 }],
      formatName: 'BED',
    });
    expect(receipt.contigMap).toEqual({ chr2: 'CM000664.2' });
  });

  it('still accepts Ensembl naming, which already worked', async () => {
    const receipt = await assertTextIntervalReferencesCompatible({
      assemblyId: 'grch38',
      expected: GRCH38,
      actual: [{ name: '1', maxEnd: 500 }],
      formatName: 'BED',
    });
    expect(receipt.contigMap).toEqual({ chr1: '1' });
  });

  it('still refuses a coordinate past the end of the contig it named', async () => {
    await expect(
      assertTextIntervalReferencesCompatible({
        assemblyId: 'grch38',
        expected: GRCH38,
        actual: [{ name: 'NC_000001.11', maxEnd: 999_999_999 }],
        formatName: 'BED',
      })
    ).rejects.toThrow(/exceeds length/i);
  });

  it('does not call one contig ambiguous for answering to several names', async () => {
    const receipt = await assertTextIntervalReferencesCompatible({
      assemblyId: 'grch38',
      expected: GRCH38,
      actual: [{ name: 'NC_000001.11', maxEnd: 10 }],
      formatName: 'BED',
    });
    expect(receipt.checkedContigs).toBe(1);
  });

  it('still refuses a name the assembly never claimed', async () => {
    await expect(
      assertTextIntervalReferencesCompatible({
        assemblyId: 'grch38',
        expected: GRCH38,
        actual: [{ name: 'NC_000067.7', maxEnd: 10 }],
        formatName: 'BED',
      })
    ).rejects.toThrow(/is not present in/i);
  });
});
