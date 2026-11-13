import { describe, expect, it } from 'vitest';

import { LocalIndexedGenomeDataSource } from './local-indexed-genome-data-source';
import {
  collectSearchHits,
  FIXTURES,
  indexFixture,
  readFastaSequence,
} from './test-support/indexed-fixtures';

const stressIt = process.env.GENOME_DATA_STRESS === '1' ? it : it.skip;

describe('indexed fixture stress matrix', () => {
  stressIt('reads yeast chrIV GBFF indexes at chromosome scale', async () => {
    const { manifest } = await indexFixture(FIXTURES.yeastChrIVGbff, 'chrIV');
    const source = new LocalIndexedGenomeDataSource(manifest, {
      sequenceBlockSize: 4096,
      featureBucketSize: 64 * 1024,
      searchChunkSize: 64 * 1024,
    });

    expect(await source.getChromosomeLength('chrIV')).toBe(1_531_933);
    const expectedSequence = await readFastaSequence(manifest.fastaPath);
    expect(await source.getSequence('chrIV', 500_000, 500_128)).toBe(
      expectedSequence.slice(500_000, 500_128)
    );

    const features = await source.getFeatures('chrIV', 500_000, 600_000, 1);
    expect(features.length).toBeGreaterThan(5);

    const motif = expectedSequence.slice(800_000, 800_010);
    const hits = await collectSearchHits(
      source.searchSequence('chrIV', motif, {
        start: 799_000,
        end: 801_000,
        maxResults: 1,
      })
    );
    expect(hits).toEqual([
      { chrom: 'chrIV', start: 800_000, end: 800_010, strand: 'forward', motif },
    ]);
  });

  stressIt('reads complete MG1655 GenBank flat-file indexes with dense features', async () => {
    const { manifest } = await indexFixture(FIXTURES.mg1655CompleteGb, 'mg1655');
    const source = new LocalIndexedGenomeDataSource(manifest, {
      sequenceBlockSize: 4096,
      featureBucketSize: 64 * 1024,
      searchChunkSize: 64 * 1024,
    });

    expect(await source.getChromosomeLength('mg1655')).toBe(4_641_652);
    const expectedSequence = await readFastaSequence(manifest.fastaPath);
    expect(await source.getSequence('mg1655', 1_000_000, 1_000_128)).toBe(
      expectedSequence.slice(1_000_000, 1_000_128)
    );

    const features = await source.getFeatures('mg1655', 1_000_000, 1_100_000, 1);
    expect(features.length).toBeGreaterThan(50);

    const capped = await collectSearchHits(
      source.searchSequence('mg1655', 'ATG', {
        start: 0,
        end: 500_000,
        maxResults: 100,
      })
    );
    expect(capped).toHaveLength(100);
  });
});
