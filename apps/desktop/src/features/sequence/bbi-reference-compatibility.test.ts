// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { assertBbiReferencesCompatible, referenceSignature } from './bbi-reference-compatibility';

describe('BBI reference compatibility', () => {
  it('produces a stable compact full-reference receipt independent of source contig order', async () => {
    const expected = [
      { name: 'chr1', length: 248_956_422 },
      { name: 'chr2', length: 242_193_529 },
    ];
    const receipt = await assertBbiReferencesCompatible({
      assemblyId: 'grch38',
      expected,
      actual: [...expected].reverse(),
      checkedAt: '2026-07-28T00:00:00.000Z',
    });

    expect(receipt).toMatchObject({
      assemblyId: 'grch38',
      checkedContigs: 2,
      status: 'compatible',
      contigMap: { chr1: 'chr1', chr2: 'chr2' },
    });
    expect(receipt.referenceSignature).toBe(receipt.sourceSignature);
    await expect(referenceSignature(expected)).resolves.toBe(
      await referenceSignature([...expected].reverse())
    );
    expect(receipt.sourceSignature).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('keeps a thousand-contig source receipt safely below the saved-view field limit', async () => {
    const references = Array.from({ length: 1_000 }, (_, index) => ({
      name: `chrUn_${index.toString().padStart(4, '0')}`,
      length: 10_000 + index,
    }));
    const receipt = await assertBbiReferencesCompatible({
      assemblyId: 'large-contig-roster',
      expected: references.slice(0, 2),
      actual: references,
    });

    expect(receipt.sourceSignature.length).toBe(71);
    expect(receipt.sourceSignature.length).toBeLessThanOrEqual(8_192);
  });

  it('rejects a missing or length-mismatched assembly contig', async () => {
    await expect(
      assertBbiReferencesCompatible({
        assemblyId: 'grch38',
        expected: [{ name: 'chr1', length: 248_956_422 }],
        actual: [{ name: 'chr1', length: 1 }],
      })
    ).rejects.toThrow('BigWig reference mismatch for chr1');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects an invalid declared source length %s',
    async (length) => {
      await expect(
        assertBbiReferencesCompatible({
          assemblyId: 'grch38',
          expected: [{ name: 'chr1', length: 248_956_422 }],
          actual: [{ name: 'chr1', length }],
        })
      ).rejects.toThrow('BigWig reference mismatch for chr1');
    }
  );

  it.each(['BigBed', 'BigWig'] as const)(
    'allows a sparse %s subset but verifies every represented contig',
    async (formatName) => {
      const expected = [
        { name: 'chr1', length: 248_956_422 },
        { name: 'chr2', length: 242_193_529 },
      ];
      const receipt = await assertBbiReferencesCompatible({
        assemblyId: 'grch38',
        expected,
        actual: [{ name: '1', length: 248_956_422 }],
        formatName,
        allowSourceSubset: true,
      });

      expect(receipt).toMatchObject({ checkedContigs: 1, contigMap: { chr1: '1' } });
      await expect(
        assertBbiReferencesCompatible({
          assemblyId: 'grch38',
          expected,
          actual: [{ name: 'chrUn', length: 1_000 }],
          formatName,
          allowSourceSubset: true,
        })
      ).rejects.toThrow('has no reference contig in common');
    }
  );
});

describe('recognising a contig the source names differently', () => {
  const MM39 = [
    { name: 'chr1', length: 195_154_279, aliases: ['NC_000067.7', '1'] },
    { name: 'chr2', length: 181_755_017, aliases: ['NC_000068.8', '2'] },
  ];

  it('accepts a source that names contigs by accession', async () => {
    const receipt = await assertBbiReferencesCompatible({
      assemblyId: 'mm39',
      expected: MM39,
      actual: [
        { name: 'NC_000067.7', length: 195_154_279 },
        { name: 'NC_000068.8', length: 181_755_017 },
      ],
      formatName: 'BigBed',
      allowSourceSubset: true,
    });
    expect(receipt.checkedContigs).toBe(2);
    expect(receipt.contigMap).toEqual({ chr1: 'NC_000067.7', chr2: 'NC_000068.8' });
  });

  it('still refuses an accession whose length disagrees', async () => {
    await expect(
      assertBbiReferencesCompatible({
        assemblyId: 'mm39',
        expected: MM39,
        actual: [{ name: 'NC_000067.7', length: 12_345 }],
        formatName: 'BigBed',
        allowSourceSubset: true,
      })
    ).rejects.toThrow(/reference mismatch/i);
  });

  it('prefers the exact name over an alias when the source has both', async () => {
    const receipt = await assertBbiReferencesCompatible({
      assemblyId: 'mm39',
      expected: [MM39[0]!],
      actual: [
        { name: 'NC_000067.7', length: 195_154_279 },
        { name: 'chr1', length: 195_154_279 },
      ],
      formatName: 'BigBed',
      allowSourceSubset: true,
    });
    expect(receipt.contigMap).toEqual({ chr1: 'chr1' });
  });

  it('leaves an assembly that declared no aliases exactly as it was', async () => {
    await expect(
      assertBbiReferencesCompatible({
        assemblyId: 'mm39',
        expected: [{ name: 'chr1', length: 195_154_279 }],
        actual: [{ name: 'NC_000067.7', length: 195_154_279 }],
        formatName: 'BigBed',
        allowSourceSubset: true,
      })
    ).rejects.toThrow(/no reference contig in common/i);
  });
});
