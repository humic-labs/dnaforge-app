import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { LocalIndexedGenomeDataSource } from '@waypoint/genome-data/node';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HostedReferenceCatalogDefinitionV1 } from './hosted-reference-catalog';
import {
  bgzfFastaProductPaths,
  BGZF_FASTA_MIGRATION_RECEIPT_FILE,
  migrateUncompressedFastaBundle,
  resolveBuiltDnaIndexerBinary,
} from './bgzf-fasta-migration';
import { createPortablePreparedReferenceHydrator } from './portable-prepared-reference-hydrator';
import {
  buildPortablePreparedReferenceBundleV1,
  portablePreparedReferenceContentObjectKeyV1,
  type PortablePreparedReferenceObjectRoleV1,
  type PortablePreparedReferenceReadinessTierV1,
} from './portable-prepared-reference-bundle';

const MINIMAL_BGZF = Buffer.from([
  0x1f, 0x8b, 0x08, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0x06, 0x00, 0x42, 0x43, 0x02, 0x00,
  0x1b, 0x00,
]);
const REPO_ROOT = resolve(process.cwd(), '../..');
const INDEXER = resolveBuiltDnaIndexerBinary(REPO_ROOT);

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('portable hydrator BGZF FASTA migration', () => {
  it('reuses an already admitted cache without converting its reference files', async () => {
    const fixture = await preparedFastaFixture();
    const fetchAsset = vi.fn(async (input: string | URL) => {
      const bytes = fixture.assets.get(new URL(input).pathname.slice(1));
      return bytes ? new Response(bytes) : new Response(null, { status: 404 });
    });
    const cold = await createPortablePreparedReferenceHydrator({
      cacheRoot: fixture.cacheRoot,
      assetBaseUrl: new URL('https://assets.example.test/'),
      fetchAsset,
    }).hydrate({ definition: fixture.definition, tiers: ['detail'] });
    fetchAsset.mockClear();
    const migrateUncompressedFasta = vi.fn(async () => {
      throw new Error('Opening an admitted cache must not start reference conversion');
    });
    const warm = await createPortablePreparedReferenceHydrator({
      cacheRoot: fixture.cacheRoot,
      assetBaseUrl: new URL('https://assets.example.test/'),
      fetchAsset,
      migrateUncompressedFasta,
    }).hydrate({ definition: fixture.definition, tiers: ['detail'] });

    expect(migrateUncompressedFasta).not.toHaveBeenCalled();
    expect(fetchAsset).not.toHaveBeenCalled();
    expect(warm.objectPaths).toEqual(cold.objectPaths);
    const fasta = fixture.bundle.objects.find(({ role }) => role === 'fasta')!;
    expect(await readFile(join(warm.generationRoot, fasta.installPath))).toEqual(
      fixture.assets.get(fasta.objectKey)
    );
  });

  it('converts admitted uncompressed FASTA in place and does not re-fetch it', async () => {
    const fixture = await preparedFastaFixture();
    const requests: string[] = [];
    const fetchAsset = vi.fn(async (input: string | URL) => {
      const key = new URL(input).pathname.slice(1);
      requests.push(key);
      const bytes = fixture.assets.get(key);
      return bytes ? new Response(bytes) : new Response(null, { status: 404 });
    });
    const hydrator = createPortablePreparedReferenceHydrator({
      cacheRoot: fixture.cacheRoot,
      assetBaseUrl: new URL('https://assets.example.test/'),
      fetchAsset,
      migrateUncompressedFasta: (input) =>
        migrateUncompressedFastaBundle({
          ...input,
          compress: async (fastaPath) => {
            const products = bgzfFastaProductPaths(fastaPath);
            await writeFile(products.fastaPath, MINIMAL_BGZF);
            await writeFile(products.faiPath, await readFile(`${fastaPath}.fai`));
            await writeFile(products.gziPath, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
          },
        }),
    });

    const cold = await hydrator.hydrate({
      definition: fixture.definition,
      tiers: ['detail'],
    });
    const fastaObject = fixture.bundle.objects.find(({ role }) => role === 'fasta')!;
    const originalFastaPath = join(cold.generationRoot, fastaObject.installPath);
    await expect(readFile(originalFastaPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(`${originalFastaPath}.gz`)).toEqual(MINIMAL_BGZF);
    expect(
      await readFile(join(cold.generationRoot, 'prepared/chr1', BGZF_FASTA_MIGRATION_RECEIPT_FILE))
    ).toBeTruthy();
    const fastaKey = fastaObject.objectKey;
    expect(requests).toContain(fastaKey);
    const requestsAfterCold = requests.length;

    await hydrator.hydrate({
      definition: fixture.definition,
      tiers: ['detail'],
    });
    expect(requests.filter((key) => key === fastaKey)).toHaveLength(1);
    expect(requests.length).toBe(requestsAfterCold);
  });

  it('keeps admitted uncompressed FASTA when conversion throws', async () => {
    const fixture = await preparedFastaFixture();
    const fetchAsset = vi.fn(async (input: string | URL) => {
      const key = new URL(input).pathname.slice(1);
      const bytes = fixture.assets.get(key);
      return bytes ? new Response(bytes) : new Response(null, { status: 404 });
    });
    const hydrator = createPortablePreparedReferenceHydrator({
      cacheRoot: fixture.cacheRoot,
      assetBaseUrl: new URL('https://assets.example.test/'),
      fetchAsset,
      migrateUncompressedFasta: async () => {
        throw new Error('compress-fasta unavailable');
      },
    });

    const cold = await hydrator.hydrate({
      definition: fixture.definition,
      tiers: ['detail'],
    });
    const fastaObject = fixture.bundle.objects.find(({ role }) => role === 'fasta')!;
    const originalFastaPath = join(cold.generationRoot, fastaObject.installPath);
    expect(await readFile(originalFastaPath)).toEqual(fixture.assets.get(fastaObject.objectKey));
    await expect(readFile(`${originalFastaPath}.gz`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(!INDEXER)(
    'hydrates, compresses with dna-indexer, reads the same bases, and does not re-fetch',
    async () => {
      const fixture = await preparedFastaFixture();
      const requests: string[] = [];
      const fetchAsset = vi.fn(async (input: string | URL) => {
        const key = new URL(input).pathname.slice(1);
        requests.push(key);
        const bytes = fixture.assets.get(key);
        return bytes ? new Response(bytes) : new Response(null, { status: 404 });
      });
      const hydrator = createPortablePreparedReferenceHydrator({
        cacheRoot: fixture.cacheRoot,
        assetBaseUrl: new URL('https://assets.example.test/'),
        fetchAsset,
        indexerBinary: INDEXER!,
      });

      const cold = await hydrator.hydrate({
        definition: fixture.definition,
        tiers: ['detail'],
      });
      const fastaObject = fixture.bundle.objects.find(({ role }) => role === 'fasta')!;
      const originalFastaPath = join(cold.generationRoot, fastaObject.installPath);
      await expect(readFile(originalFastaPath)).rejects.toMatchObject({ code: 'ENOENT' });
      const reader = new LocalIndexedGenomeDataSource(
        {
          chrom: 'chr1',
          fastaPath: `${originalFastaPath}.gz`,
          faiPath: `${originalFastaPath}.gz.fai`,
          gziPath: `${originalFastaPath}.gz.gzi`,
        },
        { checkFileMtimeOnRead: false }
      );
      expect(await reader.getSequence('chr1', 0, 8)).toBe('ACGTACGT');
      await reader.close();
      const fastaKey = fastaObject.objectKey;
      expect(requests).toContain(fastaKey);
      const requestsAfterCold = requests.length;

      await hydrator.hydrate({
        definition: fixture.definition,
        tiers: ['detail'],
      });
      expect(requests.filter((key) => key === fastaKey)).toHaveLength(1);
      expect(requests.length).toBe(requestsAfterCold);
    }
  );
});

async function preparedFastaFixture() {
  const cacheRoot = join(
    tmpdir(),
    `portable-hydrator-bgzf-${process.pid}-${Date.now()}-${roots.length}`
  );
  roots.push(cacheRoot);
  const fastaBytes = Buffer.from('>chr1\nACGTACGT\n');
  const faiBytes = Buffer.from('chr1\t8\t6\t8\t9\n');
  const objectBytes = new Map<string, Buffer>();
  const objectDrafts = [
    object('definition', 'prepared-reference-definition', 'shell', 'shell/definition.bin'),
    object('view-catalog', 'view-catalog', 'view', 'view/view-catalog.bin', ['definition']),
    object(
      'raster-manifest',
      'broad-raster-manifest',
      'view',
      'view/raster/compiled-broad-raster-manifest.v1.json',
      ['view-catalog']
    ),
    object('fasta', 'fasta', 'detail', 'prepared/chr1/chr1.fa', ['definition']),
    object('fai', 'fasta-index', 'detail', 'prepared/chr1/chr1.fa.fai', ['fasta']),
    object('gff', 'gff3-bgzf', 'detail', 'prepared/chr1/chr1.gff3.gz', ['definition']),
    object('tbi', 'gff3-tabix', 'detail', 'prepared/chr1/chr1.gff3.gz.tbi', ['gff']),
    object('scene-manifest', 'annotation-scene-manifest', 'detail', 'detail/scene-manifest.bin', [
      'raster-manifest',
    ]),
    object('scene-payload', 'annotation-scene-payload', 'detail', 'detail/scene-payload.bin', [
      'scene-manifest',
    ]),
    object(
      'annotation-search-manifest',
      'annotation-search-manifest',
      'search',
      'search/annotation-search-manifest.bin',
      ['definition']
    ),
    object(
      'annotation-search-payload',
      'annotation-search-payload',
      'search',
      'search/annotation-search-payload.bin',
      ['annotation-search-manifest']
    ),
    object(
      'protein-search-manifest',
      'protein-search-manifest',
      'search',
      'search/protein-search-manifest.bin',
      ['definition']
    ),
    object(
      'protein-search-payload',
      'protein-search-payload',
      'search',
      'search/protein-search-payload.bin',
      ['protein-search-manifest']
    ),
  ];
  const objects = objectDrafts.map((entry) => {
    const bytes =
      entry.id === 'fasta'
        ? fastaBytes
        : entry.id === 'fai'
          ? faiBytes
          : Buffer.from(`${entry.id}\n`);
    objectBytes.set(entry.id, bytes);
    const sha256 = digest(bytes);
    return {
      ...entry,
      objectKey: portablePreparedReferenceContentObjectKeyV1(sha256),
      byteLength: bytes.byteLength,
      sha256,
    };
  });
  const bundle = buildPortablePreparedReferenceBundleV1({
    assembly: {
      id: 'fixture',
      assetCacheKey: 'fixture',
      preparationPipelineRevision: 1,
      assemblyLengthBp: 8,
      contigCount: 1,
      source: { fastaSha256: '1'.repeat(64), gffSha256: '2'.repeat(64) },
    },
    objects,
    readiness: {
      shell: { dependsOn: [], objectIds: ['definition'] },
      view: { dependsOn: ['shell'], objectIds: ['view-catalog', 'raster-manifest'] },
      detail: {
        dependsOn: ['view'],
        objectIds: ['fasta', 'fai', 'gff', 'tbi', 'scene-manifest', 'scene-payload'],
      },
      search: {
        dependsOn: ['shell'],
        objectIds: [
          'annotation-search-manifest',
          'annotation-search-payload',
          'protein-search-manifest',
          'protein-search-payload',
        ],
      },
    },
  });
  const manifestBytes = Buffer.from(`${JSON.stringify(bundle)}\n`);
  const manifestSha256 = digest(manifestBytes);
  const manifestKey = portablePreparedReferenceContentObjectKeyV1(manifestSha256);
  const assets = new Map<string, Buffer>([[manifestKey, manifestBytes]]);
  for (const object of objects) assets.set(object.objectKey, objectBytes.get(object.id)!);
  const definition: HostedReferenceCatalogDefinitionV1 = {
    id: 'fixture',
    name: 'Fixture',
    organism: 'Test organism',
    description: 'BGZF FASTA migration fixture.',
    sources: {
      fasta: { relativePath: 'raw.fa', sha256: '1'.repeat(64), byteLength: 1 },
      annotations: { relativePath: 'raw.gff3', sha256: '2'.repeat(64), byteLength: 1 },
    },
    preparedBundle: {
      manifest: {
        relativePath: manifestKey,
        sha256: manifestSha256,
        byteLength: manifestBytes.byteLength,
      },
    },
    provenance: { provider: 'test', datasetId: 'test', datasetVersion: '1' },
    contigs: [
      {
        chrom: 'chr1',
        sourceSeqId: 'chr1',
        displayName: 'chr1',
        lengthBp: 8,
        role: 'assembled-molecule',
        circular: false,
      },
    ],
  };
  return { assets, bundle, cacheRoot, definition };
}

function object(
  id: string,
  role: PortablePreparedReferenceObjectRoleV1,
  tier: PortablePreparedReferenceReadinessTierV1,
  installPath: string,
  dependsOn: readonly string[] = []
) {
  return {
    id,
    role,
    installPath,
    contractToken: `${role}.v1`,
    dependsOn,
  };
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
