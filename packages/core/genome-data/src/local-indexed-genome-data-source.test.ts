import { existsSync } from 'node:fs';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  LocalIndexedGenomeDataSource,
  tabixReaderOptions,
} from './local-indexed-genome-data-source';
import { reverseComplement } from './search';
import {
  collectSearchHits,
  FIXTURES,
  hasPysam,
  indexFixture,
  puc19IndexedManifest,
  readFastaSequence,
  REPO_ROOT,
} from './test-support/indexed-fixtures';

describe.skipIf(!hasPysam())('LocalIndexedGenomeDataSource', () => {
  it('invalidates sequence cache entries when indexed FASTA files change', async () => {
    const puc19 = await indexFixture(FIXTURES.puc19Gb, 'pUC19-source');
    const region = await indexFixture(FIXTURES.mg1655RegionGb, 'region-source');
    const puc19Head = (await readFastaSequence(puc19.manifest.fastaPath)).slice(0, 10);
    const regionHead = (await readFastaSequence(region.manifest.fastaPath)).slice(0, 10);

    const dir = await mkdtemp(path.join(tmpdir(), 'genome-data-mtime-'));
    const fastaPath = path.join(dir, 'real-window.fa');
    const faiPath = path.join(dir, 'real-window.fa.fai');

    await writeSmallFasta(fastaPath, faiPath, 'real-window', puc19Head);

    const source = new LocalIndexedGenomeDataSource(
      { chrom: 'real-window', fastaPath, faiPath },
      { sequenceBlockSize: 4 }
    );
    expect(await source.getSequence('real-window', 0, 4)).toBe(puc19Head.slice(0, 4));

    await writeSmallFasta(fastaPath, faiPath, 'real-window', regionHead);
    const future = new Date(Date.now() + 10_000);
    await utimes(fastaPath, future, future);
    await utimes(faiPath, future, future);

    expect(await source.getSequence('real-window', 0, 4)).toBe(regionHead.slice(0, 4));
  }, 15_000);

  it('reads sequence ranges and tabix-backed features from sidecar-generated indexes', async () => {
    const { manifest } = await indexFixture(FIXTURES.puc19Gb, 'pUC19');
    const expectedSequence = await readFastaSequence(manifest.fastaPath);
    const source = new LocalIndexedGenomeDataSource(manifest, {
      sequenceBlockSize: 17,
      featureBucketSize: 8_192,
    });

    expect(await source.getChromosomeLength('pUC19')).toBe(2686);
    expect(await source.getSequence('pUC19', 0, 24)).toBe(expectedSequence.slice(0, 24));
    expect(await source.getSequence('pUC19', 1200, 1225)).toBe(expectedSequence.slice(1200, 1225));

    const features = await source.getFeatures('pUC19', 100, 500, 1);
    expect(features).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chrom: 'pUC19',
          type: 'CDS',
          start: 145,
          end: 469,
          strand: '-',
          attributes: expect.objectContaining({
            gene: ['lacZ'],
            product: ['LacZ alpha fragment'],
          }),
        }),
      ])
    );

    expect(
      (await source.getFeatures('pUC19', 900, 1500, 1)).map((feature) => feature.type)
    ).toEqual(['source']);
  });

  it('keeps zoom-level feature requests exact so transcript glyphs retain CDS children', async () => {
    const { manifest } = await indexFixture(FIXTURES.yeastChrIVGbff, 'chrIV-exact-zoom-levels');
    const source = new LocalIndexedGenomeDataSource(manifest, {
      featureBucketSize: 8_192,
    });
    const length = await source.getChromosomeLength(manifest.chrom);

    const exact = await source.getFeatures(manifest.chrom, 0, length, 1);
    const zoomedOut = await source.getFeatures(manifest.chrom, 0, length, 0);

    expect(zoomedOut).toEqual(exact);
    const types = new Set(zoomedOut.map((feature) => feature.type));
    expect(types.has('CDS')).toBe(true);
    expect(types.has('mRNA')).toBe(true);
  });

  it.skipIf(
    !existsSync(
      path.join(REPO_ROOT, 'test-fixtures/genome-rendering/generated/dense-boundary-annotations/boundary.fa')
    )
  )(
    'returns parent and child annotations that start outside a boundary viewport but overlap it',
    async () => {
      const fixtureDir = path.join(
        REPO_ROOT,
        'test-fixtures/genome-rendering/generated/dense-boundary-annotations'
      );
      const source = new LocalIndexedGenomeDataSource(
        {
          chrom: 'boundary',
          fastaPath: path.join(fixtureDir, 'boundary.fa'),
          faiPath: path.join(fixtureDir, 'boundary.fa.fai'),
          gffPath: path.join(fixtureDir, 'boundary.gff3.gz'),
          tbiPath: path.join(fixtureDir, 'boundary.gff3.gz.tbi'),
        },
        { featureBucketSize: 1_024 }
      );

      const features = await source.getFeatures('boundary', 3_000, 3_200, 1);
      const ids = new Set(features.flatMap((feature) => feature.attributes.ID ?? []));
      const parents = new Set(features.flatMap((feature) => feature.attributes.Parent ?? []));

      expect(ids).toContain('gene-boundary-0');
      expect(ids).toContain('tx-boundary-0');
      expect(ids).toContain('tx-boundary-0-exon2');
      expect(parents).toContain('tx-boundary-0');
      expect(features.every((feature) => feature.end > 3_000 && feature.start < 3_200)).toBe(true);
    }
  );

  it.skipIf(
    !existsSync(
      path.join(REPO_ROOT, 'test-fixtures/genome-rendering/generated/dense-boundary-annotations/boundary.fa')
    )
  )('returns bounded lazy feature details with parent/child closure', async () => {
    const fixtureDir = path.join(
      REPO_ROOT,
      'test-fixtures/genome-rendering/generated/dense-boundary-annotations'
    );
    const source = new LocalIndexedGenomeDataSource(
      {
        chrom: 'boundary',
        fastaPath: path.join(fixtureDir, 'boundary.fa'),
        faiPath: path.join(fixtureDir, 'boundary.fa.fai'),
        gffPath: path.join(fixtureDir, 'boundary.gff3.gz'),
        tbiPath: path.join(fixtureDir, 'boundary.gff3.gz.tbi'),
      },
      { featureBucketSize: 1_024 }
    );

    const details = await source.getFeatureDetails({
      chrom: 'boundary',
      start: 3_000,
      end: 3_200,
      featureId: 'tx-boundary-0',
      maxWindowBp: 20_000,
    });

    expect(details.feature?.attributes.ID).toContain('tx-boundary-0');
    expect(details.window.end - details.window.start).toBeLessThanOrEqual(20_000);
    expect(details.truncated).toBe(false);
    const ids = new Set(details.relatedFeatures.flatMap((feature) => feature.attributes.ID ?? []));
    const parents = new Set(
      details.relatedFeatures.flatMap((feature) => feature.attributes.Parent ?? [])
    );
    expect(ids).toContain('gene-boundary-0');
    expect(ids).toContain('tx-boundary-0');
    expect(ids).toContain('tx-boundary-0-exon1');
    expect(ids).toContain('tx-boundary-0-exon2');
    expect(parents).toContain('gene-boundary-0');
    expect(parents).toContain('tx-boundary-0');
  });

  it('aborts tabix feature parsing without caching partial stale results', async () => {
    const source = new LocalIndexedGenomeDataSource(
      {
        chrom: 'chrAbort',
        fastaPath: '/tmp/unused.fa',
        faiPath: '/tmp/unused.fa.fai',
        gffPath: '/tmp/unused.gff3.gz',
        tbiPath: '/tmp/unused.gff3.gz.tbi',
      },
      { checkFileMtimeOnRead: false, featureBucketSize: 1_000 }
    );
    const harness = source as unknown as {
      generation: {
        fasta: { getSequenceSize: (chrom: string) => Promise<number | undefined> };
        tabix: {
          getLines: (
            chrom: string,
            start: number,
            end: number,
            opts: { lineCallback: (line: string, fileOffset: number) => void }
          ) => Promise<void>;
        };
      };
    };
    const controller = new AbortController();
    let queryCount = 0;
    let callbackCount = 0;

    harness.generation.fasta = { getSequenceSize: async () => 1_000 };
    harness.generation.tabix = {
      getLines: async (_chrom, _start, _end, opts) => {
        queryCount += 1;
        callbackCount += 1;
        opts.lineCallback('chrAbort\ttest\tgene\t1\t10\t.\t+\t.\tID=first', 1);
        if (queryCount === 1) controller.abort();
        callbackCount += 1;
        opts.lineCallback('chrAbort\ttest\tgene\t20\t30\t.\t+\t.\tID=second', 2);
      },
    };

    await expect(
      source.getFeatures('chrAbort', 0, 100, 1, { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });

    const features = await source.getFeatures('chrAbort', 0, 100, 1);

    expect(queryCount).toBe(2);
    expect(callbackCount).toBe(4);
    expect(features.map((feature) => feature.attributes.ID?.[0])).toEqual(['first', 'second']);
  });

  it('streams cancellable motif hits with result caps and reverse-complement hits', async () => {
    const { manifest } = await indexFixture(FIXTURES.puc19Gb, 'pUC19');
    const expectedSequence = await readFastaSequence(manifest.fastaPath);
    const source = new LocalIndexedGenomeDataSource(manifest, {
      sequenceBlockSize: 31,
      searchChunkSize: 37,
    });

    const motif = expectedSequence.slice(120, 128);
    const forwardHits = await collectSearchHits(
      source.searchSequence('pUC19', motif, {
        start: 100,
        end: 180,
        maxResults: 1,
      })
    );
    expect(forwardHits).toEqual([
      { chrom: 'pUC19', start: 120, end: 128, strand: 'forward', motif },
    ]);

    const reverseMotif = reverseComplement(expectedSequence.slice(210, 218));
    const rcHits = await collectSearchHits(
      source.searchSequence('pUC19', reverseMotif, {
        start: 200,
        end: 240,
        reverseComplement: true,
        maxResults: 20,
      })
    );
    expect(rcHits).toEqual(
      expect.arrayContaining([
        { chrom: 'pUC19', start: 210, end: 218, strand: 'reverse', motif: reverseMotif },
      ])
    );

    const controller = new AbortController();
    controller.abort();
    await expect(
      collectSearchHits(source.searchSequence('pUC19', motif, { signal: controller.signal }))
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('LocalIndexedGenomeDataSource leftover uncompressed FASTA', () => {
  it('reads a leftover uncompressed FASTA cache without a gzip index', async () => {
    const manifest = puc19IndexedManifest();
    expect(manifest.fastaPath.endsWith('.fa')).toBe(true);
    expect(manifest.gziPath).toBeUndefined();
    expect(existsSync(`${manifest.fastaPath}.gz`)).toBe(false);

    const expected = await readFastaSequence(manifest.fastaPath);
    const source = new LocalIndexedGenomeDataSource(manifest, {
      checkFileMtimeOnRead: false,
    });
    try {
      expect(await source.getSequence(manifest.chrom, 0, 24)).toBe(expected.slice(0, 24));
      expect(await source.getSequence(manifest.chrom, 1200, 1225)).toBe(expected.slice(1200, 1225));
    } finally {
      await source.close();
    }
  });
});

describe('LocalIndexedGenomeDataSource search validation', () => {
  it('rejects malformed indexed bytes inside the worker-owned motif scan', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'genome-data-invalid-search-'));
    const fastaPath = path.join(dir, 'crafted.fa');
    const faiPath = `${fastaPath}.fai`;
    const sequence = 'AAA!';
    await writeSmallFasta(fastaPath, faiPath, 'crafted', sequence);
    const source = new LocalIndexedGenomeDataSource(
      { chrom: 'crafted', fastaPath, faiPath },
      { sequenceBlockSize: 2, searchChunkSize: 1, checkFileMtimeOnRead: false }
    );

    try {
      await expect(
        collectSearchHits(
          source.searchSequence('crafted', 'A', {
            maxResults: 1,
            validateIupacDna: true,
          })
        )
      ).rejects.toMatchObject({ name: 'InvalidGenomeSequenceError' });
    } finally {
      await source.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('tabixReaderOptions', () => {
  it('opens CSI indexes with csiPath and TBI indexes with tbiPath', () => {
    expect(tabixReaderOptions('/gff/chr1A.gff3.gz', '/gff/chr1A.gff3.gz.csi')).toEqual({
      path: '/gff/chr1A.gff3.gz',
      csiPath: '/gff/chr1A.gff3.gz.csi',
    });
    expect(tabixReaderOptions('/gff/chr1.gff3.gz', '/gff/chr1.gff3.gz.tbi')).toEqual({
      path: '/gff/chr1.gff3.gz',
      tbiPath: '/gff/chr1.gff3.gz.tbi',
    });
  });
});

async function writeSmallFasta(
  fastaPath: string,
  faiPath: string,
  chrom: string,
  sequence: string
): Promise<void> {
  await writeFile(fastaPath, `>${chrom}\n${sequence}\n`);
  await writeFile(
    faiPath,
    `${chrom}\t${sequence.length}\t${chrom.length + 2}\t${sequence.length}\t${
      sequence.length + 1
    }\n`
  );
}
