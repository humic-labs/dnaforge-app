import { describe, expect, it } from 'vitest';

import { InMemoryGenomeDataSource } from './in-memory-genome-data-source';
import { collectSearchHits } from './test-support/indexed-fixtures';
import type { GenomeFeature } from './types';

function feature(
  partial: Partial<GenomeFeature> & Pick<GenomeFeature, 'start' | 'end'>
): GenomeFeature {
  return {
    chrom: partial.chrom ?? 'chrI',
    source: partial.source ?? 'fixture',
    type: partial.type ?? 'gene',
    start: partial.start,
    end: partial.end,
    score: partial.score ?? null,
    strand: partial.strand ?? '+',
    phase: partial.phase ?? null,
    attributes: partial.attributes ?? {},
    raw:
      partial.raw ??
      `${partial.chrom ?? 'chrI'}\tfixture\tgene\t${partial.start + 1}\t${partial.end}\t.\t+\t.\tID=f`,
    ...(partial.fileOffset !== undefined ? { fileOffset: partial.fileOffset } : {}),
  };
}

describe('InMemoryGenomeDataSource', () => {
  it('returns the chromosome length from the wrapped sequence', async () => {
    const source = new InMemoryGenomeDataSource({
      chrom: 'chrI',
      sequence: 'ACGTACGTAC',
      features: [],
    });
    expect(await source.getChromosomeLength('chrI')).toBe(10);
  });

  it('throws when asked about a chromosome it does not own', async () => {
    const source = new InMemoryGenomeDataSource({
      chrom: 'chrI',
      sequence: 'ACGT',
      features: [],
    });
    await expect(source.getChromosomeLength('chrII')).rejects.toThrow(/chrII/);
    await expect(source.getSequence('chrII', 0, 4)).rejects.toThrow(/chrII/);
    await expect(source.getFeatures('chrII', 0, 4, 1)).rejects.toThrow(/chrII/);
  });

  it('slices sequence using half-open 0-based ranges, clamped to length', async () => {
    const source = new InMemoryGenomeDataSource({
      chrom: 'chrI',
      sequence: 'ACGTACGTAC',
      features: [],
    });
    expect(await source.getSequence('chrI', 0, 4)).toBe('ACGT');
    expect(await source.getSequence('chrI', 4, 10)).toBe('ACGTAC');
    expect(await source.getSequence('chrI', 0, 100)).toBe('ACGTACGTAC');
    expect(await source.getSequence('chrI', 7, 7)).toBe('');
  });

  it('returns sequence in upper case regardless of input casing', async () => {
    const source = new InMemoryGenomeDataSource({
      chrom: 'chrI',
      sequence: 'acgtACGT',
      features: [],
    });
    expect(await source.getSequence('chrI', 0, 8)).toBe('ACGTACGT');
  });

  it('rejects invalid ranges', async () => {
    const source = new InMemoryGenomeDataSource({
      chrom: 'chrI',
      sequence: 'ACGT',
      features: [],
    });
    await expect(source.getSequence('chrI', -1, 2)).rejects.toThrow();
    await expect(source.getSequence('chrI', 3, 1)).rejects.toThrow();
    await expect(source.getSequence('chrI', NaN, 4)).rejects.toThrow();
  });

  it('returns features that overlap the requested half-open range', async () => {
    const features: GenomeFeature[] = [
      feature({ start: 0, end: 100, attributes: { ID: ['a'] } }),
      feature({ start: 150, end: 250, attributes: { ID: ['b'] } }),
      feature({ start: 300, end: 400, attributes: { ID: ['c'] } }),
    ];
    const source = new InMemoryGenomeDataSource({
      chrom: 'chrI',
      sequence: 'N'.repeat(500),
      features,
    });

    const middle = await source.getFeatures('chrI', 120, 280, 1);
    expect(middle.map((f) => f.attributes.ID?.[0])).toEqual(['b']);

    const overlap = await source.getFeatures('chrI', 90, 160, 1);
    expect(overlap.map((f) => f.attributes.ID?.[0])).toEqual(['a', 'b']);

    const all = await source.getFeatures('chrI', 0, 500, 1);
    expect(all.map((f) => f.attributes.ID?.[0])).toEqual(['a', 'b', 'c']);

    const none = await source.getFeatures('chrI', 100, 150, 1);
    expect(none).toEqual([]);
  });

  it('drops features for other chromosomes even if mistakenly present in the manifest', async () => {
    const source = new InMemoryGenomeDataSource({
      chrom: 'chrI',
      sequence: 'N'.repeat(500),
      features: [
        feature({ chrom: 'chrI', start: 0, end: 100 }),
        feature({ chrom: 'chrII', start: 0, end: 100 }),
      ],
    });
    const result = await source.getFeatures('chrI', 0, 500, 1);
    expect(result).toHaveLength(1);
    expect(result[0].chrom).toBe('chrI');
  });

  it('returns the complete sibling CDS closure outside the seed interval', async () => {
    const source = new InMemoryGenomeDataSource({
      chrom: 'chrI',
      sequence: 'ATGCCCCCCCAAATTT',
      features: [
        feature({
          type: 'mRNA',
          start: 0,
          end: 13,
          attributes: { ID: ['rna1'] },
        }),
        feature({
          type: 'CDS',
          start: 0,
          end: 3,
          phase: '0',
          attributes: { ID: ['cds1'], Parent: ['rna1'] },
        }),
        feature({
          type: 'CDS',
          start: 10,
          end: 13,
          phase: '0',
          attributes: { ID: ['cds2'], Parent: ['rna1'] },
        }),
      ],
    });

    const details = await source.getFeatureDetails({
      chrom: 'chrI',
      start: 0,
      end: 3,
      featureId: 'rna1',
      maxWindowBp: 100,
    });

    expect(details.truncated).toBe(false);
    expect(details.relatedFeatures.map((row) => row.attributes.ID?.[0])).toEqual([
      'rna1',
      'cds1',
      'cds2',
    ]);
    expect(details.window).toEqual({ start: 0, end: 13 });
  });

  it('streams motif hits with maxResults cap and forward-only by default', async () => {
    const source = new InMemoryGenomeDataSource({
      chrom: 'chrI',
      sequence: 'ACGTAAAAACGTAAAAACGT',
      features: [],
    });

    const allForward = await collectSearchHits(source.searchSequence('chrI', 'ACGT'));
    expect(allForward.map((h) => h.start)).toEqual([0, 8, 16]);
    expect(allForward.every((h) => h.strand === 'forward')).toBe(true);

    const capped = await collectSearchHits(
      source.searchSequence('chrI', 'ACGT', { maxResults: 2 })
    );
    expect(capped.map((h) => h.start)).toEqual([0, 8]);
  });

  it('returns reverse-complement hits with mapped coordinates when requested', async () => {
    const source = new InMemoryGenomeDataSource({
      chrom: 'chrI',
      sequence: 'TTTTGGTTTTTT',
      features: [],
    });
    const motif = 'AACC';
    const hits = await collectSearchHits(
      source.searchSequence('chrI', motif, { reverseComplement: true })
    );
    expect(hits).toEqual([{ chrom: 'chrI', start: 4, end: 8, strand: 'reverse', motif }]);
  });

  it('applies result caps after coordinate-ordering both strands', async () => {
    const source = new InMemoryGenomeDataSource({
      chrom: 'chrI',
      sequence: 'GGTTAAAAAACC',
      features: [],
    });
    const motif = 'AACC';

    const allHits = await collectSearchHits(
      source.searchSequence('chrI', motif, { reverseComplement: true })
    );
    expect(allHits).toEqual([
      { chrom: 'chrI', start: 0, end: 4, strand: 'reverse', motif },
      { chrom: 'chrI', start: 8, end: 12, strand: 'forward', motif },
    ]);

    const capped = await collectSearchHits(
      source.searchSequence('chrI', motif, { reverseComplement: true, maxResults: 1 })
    );
    expect(capped).toEqual([{ chrom: 'chrI', start: 0, end: 4, strand: 'reverse', motif }]);
  });

  it('continues IUPAC validation after the result cap is reached', async () => {
    const source = new InMemoryGenomeDataSource(
      {
        chrom: 'chrI',
        sequence: 'AAA!',
        features: [],
      },
      { searchChunkSize: 1 }
    );

    await expect(
      collectSearchHits(
        source.searchSequence('chrI', 'A', {
          maxResults: 1,
          validateIupacDna: true,
        })
      )
    ).rejects.toMatchObject({ name: 'InvalidGenomeSequenceError' });
  });

  it('honors AbortSignal for searchSequence', async () => {
    const source = new InMemoryGenomeDataSource({
      chrom: 'chrI',
      sequence: 'ACGT'.repeat(10_000),
      features: [],
    });

    const controller = new AbortController();
    controller.abort();
    await expect(
      collectSearchHits(source.searchSequence('chrI', 'ACGT', { signal: controller.signal }))
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('respects start/end bounds in searchSequence', async () => {
    const source = new InMemoryGenomeDataSource({
      chrom: 'chrI',
      sequence: 'ACGTAAAAACGTAAAAACGT',
      features: [],
    });
    const hits = await collectSearchHits(
      source.searchSequence('chrI', 'ACGT', { start: 5, end: 20 })
    );
    expect(hits.map((h) => h.start)).toEqual([8, 16]);
  });

  it('matches IUPAC codes (N matches any base)', async () => {
    const source = new InMemoryGenomeDataSource({
      chrom: 'chrI',
      sequence: 'ACGTACGT',
      features: [],
    });
    const hits = await collectSearchHits(source.searchSequence('chrI', 'ANGT'));
    expect(hits.map((h) => h.start)).toEqual([0, 4]);
  });

  it('parity with LocalIndexedGenomeDataSource: getSequence shape and casing', async () => {
    const sequence = 'aCgTaCgTaCgT';
    const source = new InMemoryGenomeDataSource({
      chrom: 'chrI',
      sequence,
      features: [],
    });
    expect(await source.getSequence('chrI', 0, sequence.length)).toBe(sequence.toUpperCase());
  });
});
