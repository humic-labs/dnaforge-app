import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { LocalIndexedGenomeDataSource } from './local-indexed-genome-data-source';
import {
  collectSearchHits,
  FIXTURES,
  hasPysam,
  indexFixture,
  indexRealFastaDerivedFrom,
  readFastaSequence,
} from './test-support/indexed-fixtures';

describe.skipIf(!hasPysam())('indexed fixture matrix', () => {
  it('reads GenBank flat-file indexes with circular origin-split features', async () => {
    const record = await readFile(FIXTURES.puc19Gb, 'utf8');
    const originSpanning = record.replace(
      /^(\s{5}rep_origin\s+)866\s*$/mu,
      '$1join(2315..2686,1..217)'
    );
    expect(originSpanning).not.toBe(record);
    const derivedPath = path.join(
      await mkdtemp(path.join(tmpdir(), 'genome-data-origin-')),
      'pUC19.gb'
    );
    await writeFile(derivedPath, originSpanning);
    const { manifest } = await indexFixture(derivedPath, 'pUC19');
    const source = new LocalIndexedGenomeDataSource(manifest, {
      sequenceBlockSize: 13,
      featureBucketSize: 256,
    });

    expect(await source.getChromosomeLength('pUC19')).toBe(2686);
    const expectedSequence = await readFastaSequence(manifest.fastaPath);
    expect(await source.getSequence('pUC19', 0, 8)).toBe(expectedSequence.slice(0, 8));
    expect(await source.getSequence('pUC19', 2678, 2686)).toBe(expectedSequence.slice(2678));

    const originFeatures = await source.getFeatures('pUC19', 0, 250, 1);
    const originId = originFeatures.find((feature) => feature.type === 'rep_origin')?.attributes
      .ID?.[0];
    expect(originId).toEqual(expect.any(String));
    expect(originFeatures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'rep_origin',
          start: 0,
          end: 217,
          attributes: expect.objectContaining({
            ID: [originId],
            _dnaforge_origin_spanning: ['true'],
          }),
        }),
      ])
    );

    const farOriginFeatures = await source.getFeatures('pUC19', 2300, 2686, 1);
    expect(farOriginFeatures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'rep_origin',
          start: 2314,
          end: 2686,
          attributes: expect.objectContaining({
            ID: [originId],
            _dnaforge_origin_spanning: ['true'],
          }),
        }),
      ])
    );
  });

  it('reads GBFF indexes with dense annotations and exact boundary ranges', async () => {
    const { manifest } = await indexFixture(FIXTURES.yeastChrIVGbff, 'chrIV');
    const source = new LocalIndexedGenomeDataSource(manifest, {
      sequenceBlockSize: 4096,
      featureBucketSize: 64 * 1024,
    });
    const expectedSequence = await readFastaSequence(manifest.fastaPath);

    expect(await source.getChromosomeLength('chrIV')).toBe(1_531_933);
    expect(await source.getSequence('chrIV', 0, 0)).toBe('');
    expect(await source.getSequence('chrIV', 1_531_923, 1_531_933)).toBe(
      expectedSequence.slice(1_531_923, 1_531_933)
    );

    await expect(source.getSequence('chrIV', -1, 1)).rejects.toThrow(/Invalid/);
    await expect(source.getSequence('chrIV', 10, 9)).rejects.toThrow(/Invalid/);
    await expect(source.getSequence('missing', 0, 1)).rejects.toThrow(/not found/);

    const hxt15 = await source.getFeatures('chrIV', 11_500, 13_500, 1);
    expect(hxt15).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'CDS',
          start: 11_656,
          end: 13_360,
          strand: '-',
          attributes: expect.objectContaining({ gene: ['HXT15'] }),
        }),
      ])
    );
  });

  it('reads FASTA-only indexes without requiring annotation indexes', async () => {
    const { manifest } = await indexRealFastaDerivedFrom(
      FIXTURES.mg1655RegionGb,
      'region-source',
      'region-fasta'
    );
    expect(manifest.gffPath).toBeNull();
    expect(manifest.tbiPath).toBeNull();

    const source = new LocalIndexedGenomeDataSource(manifest, { sequenceBlockSize: 29 });
    const expectedSequence = await readFastaSequence(manifest.fastaPath);

    expect(await source.getChromosomeLength('region-fasta')).toBe(expectedSequence.length);
    expect(await source.getSequence('region-fasta', 50, 90)).toBe(expectedSequence.slice(50, 90));
    expect(await source.getFeatures('region-fasta', 0, expectedSequence.length, 1)).toEqual([]);
  });

  it('caps high-cardinality searches and handles IUPAC motifs', async () => {
    const { manifest } = await indexRealFastaDerivedFrom(
      FIXTURES.mg1655RegionGb,
      'search-source',
      'search-fasta'
    );
    const source = new LocalIndexedGenomeDataSource(manifest, {
      sequenceBlockSize: 19,
      searchChunkSize: 23,
    });
    const expectedSequence = await readFastaSequence(manifest.fastaPath);

    const capped = await collectSearchHits(
      source.searchSequence('search-fasta', 'ATG', { maxResults: 5 })
    );
    expect(capped).toHaveLength(5);
    expect(capped.map((hit) => hit.start)).toEqual(
      [...capped].map((hit) => hit.start).sort((a, b) => a - b)
    );
    for (const hit of capped) {
      expect(expectedSequence.slice(hit.start, hit.end)).toBe('ATG');
    }

    const exact = expectedSequence.slice(0, 3);
    const motif = `${iupacForBase(exact[0])}${exact.slice(1)}`;
    const iupac = await collectSearchHits(
      source.searchSequence('search-fasta', motif, {
        start: 0,
        end: 1_000,
        maxResults: 1,
      })
    );
    expect(iupac).toEqual([{ chrom: 'search-fasta', start: 0, end: 3, strand: 'forward', motif }]);

    expect(
      await collectSearchHits(source.searchSequence('search-fasta', 'ATG', { maxResults: 0 }))
    ).toEqual([]);
  });
});

function iupacForBase(base: string): string {
  if (base === 'A' || base === 'G') return 'R';
  if (base === 'C' || base === 'T') return 'Y';
  return 'N';
}
