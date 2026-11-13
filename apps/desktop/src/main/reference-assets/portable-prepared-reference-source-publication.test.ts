import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HostedReferenceCatalogDefinitionV1 } from './hosted-reference-catalog';
import {
  buildPortablePreparedReferenceBundleV1,
  portablePreparedReferenceContentObjectKeyV1,
  type PortablePreparedReferenceObjectRoleV1,
  type PortablePreparedReferenceReadinessTierV1,
} from './portable-prepared-reference-bundle';
import type { PortablePreparedReferenceHydrationResult } from './portable-prepared-reference-hydrator';
import { publishPortablePreparedReferenceSourceGenerationV1 } from './portable-prepared-reference-source-publication';
import type { ReferenceAssetWriterLease } from './reference-asset-writer-lock';
import { listPreparedReferenceAssemblyEntries } from './prepared-reference-library';
import {
  PREPARED_REFERENCE_DEFINITION_FILE,
  PREPARED_REFERENCE_DEFINITION_V1,
  REFERENCE_PREPARATION_PIPELINE_REVISION,
} from './reference-preparation-manifest';
import { inspectPreparedReferenceSourcePublication } from './reference-preparation-engine';

const PROJECT_ROOT = resolve(process.cwd(), '../..');
const FIXTURE_ROOT = join(PROJECT_ROOT, 'test-fixtures/indexed/pUC19');
const ASSET_CACHE_KEY = 'portable-source-fixture';
const FASTA_SHA256 = 'a'.repeat(64);
const GFF_SHA256 = 'b'.repeat(64);

interface ObjectFixture {
  readonly id: string;
  readonly role: PortablePreparedReferenceObjectRoleV1;
  readonly tier: PortablePreparedReferenceReadinessTierV1;
  readonly installPath: string;
  readonly bytes: Buffer;
  readonly dependsOn: readonly string[];
}

describe('portable prepared-reference source publication', () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
    );
  });

  it('atomically makes authenticated hydrated source bytes visible to the ordinary library', async () => {
    const fixture = await createFixture(temporaryRoots);
    const commitPointer = vi.fn(async (temporaryPath: string, pointerPath: string) => {
      await rename(temporaryPath, pointerPath);
    });
    const writerLease: ReferenceAssetWriterLease = {
      assertOwned: vi.fn(async () => undefined),
      commitPointer,
      acceptReconciledCommit: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    };

    await expect(listPreparedReferenceAssemblyEntries(fixture.cacheRoot)).resolves.toEqual([]);

    const entry = await publishPortablePreparedReferenceSourceGenerationV1({
      cacheRoot: fixture.cacheRoot,
      definition: fixture.catalogDefinition,
      hydration: fixture.hydration,
      writerLease,
    });

    expect(commitPointer).toHaveBeenCalledTimes(1);
    const pointer = JSON.parse(
      await readFile(
        join(fixture.cacheRoot, ASSET_CACHE_KEY, 'current-reference-assets.v1.json'),
        'utf8'
      )
    ) as { publicationId: string };
    expect(pointer.publicationId).toBe(fixture.hydration.bundle.bundleFingerprint);
    await expect(listPreparedReferenceAssemblyEntries(fixture.cacheRoot)).resolves.toEqual([entry]);
    await expect(
      inspectPreparedReferenceSourcePublication({
        entry,
        cacheRoot: fixture.cacheRoot,
        expectedSource: {
          fastaSha256: FASTA_SHA256,
          gffSha256: GFF_SHA256,
        },
      })
    ).resolves.toEqual({
      status: 'ready',
      publicationId: fixture.hydration.bundle.bundleFingerprint,
      sourceGenerationRoot: fixture.hydration.generationRoot,
    });
  });

  it('publishes the hydrated canonical generation through an alias of the same cache root', async () => {
    const fixture = await createFixture(temporaryRoots);
    const alias = join(fixture.cacheRoot, 'cache-alias');
    await symlink(fixture.cacheRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const writerLease = passthroughWriterLease();
    const entry = await publishPortablePreparedReferenceSourceGenerationV1({
      cacheRoot: alias,
      definition: fixture.catalogDefinition,
      hydration: fixture.hydration,
      writerLease,
    });

    expect(entry.id).toBe(ASSET_CACHE_KEY);
    const pointer = JSON.parse(
      await readFile(join(alias, ASSET_CACHE_KEY, 'current-reference-assets.v1.json'), 'utf8')
    ) as { publicationId: string };
    expect(pointer.publicationId).toBe(fixture.hydration.bundle.bundleFingerprint);
    await expect(listPreparedReferenceAssemblyEntries(fixture.cacheRoot)).resolves.toEqual([entry]);
  });

  it('still rejects a generation outside the canonical cache before committing a pointer', async () => {
    const fixture = await createFixture(temporaryRoots);
    const outside = await mkdtemp(join(tmpdir(), 'dnaforge-portable-source-outside-'));
    temporaryRoots.push(outside);
    const commitPointer = vi.fn();
    await expect(
      publishPortablePreparedReferenceSourceGenerationV1({
        cacheRoot: fixture.cacheRoot,
        definition: fixture.catalogDefinition,
        hydration: { ...fixture.hydration, generationRoot: await realpath(outside) },
        writerLease: { ...passthroughWriterLease(), commitPointer },
      })
    ).rejects.toThrow('Portable prepared-reference generation escapes its cache root.');
    expect(commitPointer).not.toHaveBeenCalled();
  });

  it('admits a listed entry whose annotation identity came from another pipeline revision', async () => {
    const fixture = await createFixture(temporaryRoots);
    const entry = await publishPortablePreparedReferenceSourceGenerationV1({
      cacheRoot: fixture.cacheRoot,
      definition: fixture.catalogDefinition,
      hydration: fixture.hydration,
      writerLease: passthroughWriterLease(),
    });
    expect(entry.referenceIdentity).toBeDefined();
    const expectedSource = { fastaSha256: FASTA_SHA256, gffSha256: GFF_SHA256 };

    await expect(
      inspectPreparedReferenceSourcePublication({
        entry: {
          ...entry,
          referenceIdentity: {
            sequenceIdentity: entry.referenceIdentity!.sequenceIdentity,
            annotationIdentity: 'c'.repeat(64),
          },
        },
        cacheRoot: fixture.cacheRoot,
        expectedSource,
      })
    ).resolves.toMatchObject({ status: 'ready' });

    await expect(
      inspectPreparedReferenceSourcePublication({
        entry: {
          ...entry,
          referenceIdentity: {
            sequenceIdentity: 'd'.repeat(64),
            annotationIdentity: entry.referenceIdentity!.annotationIdentity,
          },
        },
        cacheRoot: fixture.cacheRoot,
        expectedSource,
      })
    ).resolves.toMatchObject({ status: 'needs-refresh' });
  });

  it('publishes source coordinates from detail before independent search hydration finishes', async () => {
    const fixture = await createFixture(temporaryRoots);
    const writerLease: ReferenceAssetWriterLease = {
      assertOwned: vi.fn(async () => undefined),
      commitPointer: vi.fn(async (temporaryPath: string, pointerPath: string) => {
        await rename(temporaryPath, pointerPath);
      }),
      acceptReconciledCommit: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    };

    const entry = await publishPortablePreparedReferenceSourceGenerationV1({
      cacheRoot: fixture.cacheRoot,
      definition: fixture.catalogDefinition,
      hydration: {
        ...fixture.hydration,
        hydratedTiers: ['detail'],
      },
      writerLease,
    });

    expect(entry).toMatchObject({ id: ASSET_CACHE_KEY });
    await expect(
      inspectPreparedReferenceSourcePublication({
        entry,
        cacheRoot: fixture.cacheRoot,
        expectedSource: {
          fastaSha256: FASTA_SHA256,
          gffSha256: GFF_SHA256,
        },
      })
    ).resolves.toMatchObject({ status: 'ready' });
  });

  it('commits only a profile pointer while reusing the shared immutable generation', async () => {
    const fixture = await createFixture(temporaryRoots);
    const publicationRoot = await mkdtemp(
      join(tmpdir(), 'dnaforge-portable-source-profile-publication-')
    );
    temporaryRoots.push(publicationRoot);
    const writerLease: ReferenceAssetWriterLease = {
      assertOwned: vi.fn(async () => undefined),
      commitPointer: vi.fn(async (temporaryPath: string, pointerPath: string) => {
        await rename(temporaryPath, pointerPath);
      }),
      acceptReconciledCommit: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    };

    const entry = await publishPortablePreparedReferenceSourceGenerationV1({
      cacheRoot: fixture.cacheRoot,
      publicationRoot,
      definition: fixture.catalogDefinition,
      hydration: fixture.hydration,
      writerLease,
    });

    await expect(
      readFile(join(fixture.cacheRoot, ASSET_CACHE_KEY, 'current-reference-assets.v1.json'), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' });
    const profilePointer = JSON.parse(
      await readFile(
        join(publicationRoot, ASSET_CACHE_KEY, 'current-reference-assets.v1.json'),
        'utf8'
      )
    ) as { publicationId: string };
    expect(profilePointer.publicationId).toBe(fixture.hydration.bundle.bundleFingerprint);
    expect(fixture.hydration.generationRoot).toBe(
      join(
        fixture.cacheRoot,
        ASSET_CACHE_KEY,
        'generations',
        fixture.hydration.bundle.bundleFingerprint
      )
    );
    await expect(
      listPreparedReferenceAssemblyEntries(fixture.cacheRoot, publicationRoot, fixture.cacheRoot)
    ).resolves.toEqual([entry]);
  });

  it('does not publish a pointer when an authenticated object is unavailable', async () => {
    const fixture = await createFixture(temporaryRoots);
    const fasta = fixture.hydration.bundle.objects.find(({ role }) => role === 'fasta')!;
    const objectPaths = new Map(fixture.hydration.objectPaths);
    objectPaths.delete(fasta.id);
    const writerLease: ReferenceAssetWriterLease = {
      assertOwned: vi.fn(async () => undefined),
      commitPointer: vi.fn(async () => undefined),
      acceptReconciledCommit: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    };

    await expect(
      publishPortablePreparedReferenceSourceGenerationV1({
        cacheRoot: fixture.cacheRoot,
        definition: fixture.catalogDefinition,
        hydration: { ...fixture.hydration, objectPaths },
        writerLease,
      })
    ).rejects.toThrow(`Portable prepared object ${fasta.id} was not hydrated`);
    expect(writerLease.commitPointer).not.toHaveBeenCalled();
    await expect(listPreparedReferenceAssemblyEntries(fixture.cacheRoot)).resolves.toEqual([]);
  });

  it('accepts an exact atomic pointer commit whose helper acknowledgement was lost', async () => {
    const fixture = await createFixture(temporaryRoots);
    const acceptReconciledCommit = vi.fn(async () => undefined);
    const writerLease: ReferenceAssetWriterLease = {
      assertOwned: vi.fn(async () => undefined),
      commitPointer: vi.fn(async (temporaryPath: string, pointerPath: string) => {
        await rename(temporaryPath, pointerPath);
        throw new Error('focused lost acknowledgement');
      }),
      acceptReconciledCommit,
      release: vi.fn(async () => undefined),
    };

    await expect(
      publishPortablePreparedReferenceSourceGenerationV1({
        cacheRoot: fixture.cacheRoot,
        definition: fixture.catalogDefinition,
        hydration: fixture.hydration,
        writerLease,
      })
    ).resolves.toEqual(expect.objectContaining({ id: ASSET_CACHE_KEY }));
    expect(acceptReconciledCommit).toHaveBeenCalledOnce();
    await expect(listPreparedReferenceAssemblyEntries(fixture.cacheRoot)).resolves.toHaveLength(1);
  });
});

async function createFixture(temporaryRoots: string[]): Promise<{
  readonly cacheRoot: string;
  readonly catalogDefinition: HostedReferenceCatalogDefinitionV1;
  readonly hydration: PortablePreparedReferenceHydrationResult;
}> {
  const cacheRoot = await realpath(
    await mkdtemp(join(tmpdir(), 'dnaforge-portable-source-publication-'))
  );
  temporaryRoots.push(cacheRoot);
  const definition = {
    contract: PREPARED_REFERENCE_DEFINITION_V1,
    pipelineRevision: REFERENCE_PREPARATION_PIPELINE_REVISION,
    id: ASSET_CACHE_KEY,
    name: 'Portable source fixture',
    organism: 'synthetic DNA construct',
    description: 'Authenticated portable source publication fixture.',
    assetCacheKey: ASSET_CACHE_KEY,
    source: {
      fastaSha256: FASTA_SHA256,
      gffSha256: GFF_SHA256,
    },
    provenance: {
      provider: 'DNAForge fixture',
      datasetId: 'pUC19',
      datasetVersion: '1',
    },
    members: [
      {
        chrom: 'puc19',
        displayName: 'pUC19',
        lengthBp: 2_686,
        role: 'other',
        circular: true,
        sourceSeqId: 'puc19',
        manifest: {
          fastaPath: 'prepared/puc19/puc19.fa',
          faiPath: 'prepared/puc19/puc19.fa.fai',
          gffPath: 'prepared/puc19/puc19.gff3.gz',
          tbiPath: 'prepared/puc19/puc19.gff3.gz.tbi',
        },
      },
    ],
  } as const;
  const objects: ObjectFixture[] = [
    object(
      'definition',
      'prepared-reference-definition',
      'shell',
      PREPARED_REFERENCE_DEFINITION_FILE,
      Buffer.from(`${JSON.stringify(definition, null, 2)}\n`)
    ),
    object(
      'view-catalog',
      'view-catalog',
      'view',
      'derived/view-catalog.v1.json',
      Buffer.from('view-catalog'),
      ['definition']
    ),
    object(
      'raster-manifest',
      'broad-raster-manifest',
      'view',
      'derived/broad-raster-manifest.v1.json',
      Buffer.from('raster-manifest'),
      ['view-catalog']
    ),
    object(
      'fasta',
      'fasta',
      'detail',
      definition.members[0].manifest.fastaPath,
      await readFile(join(FIXTURE_ROOT, 'pUC19.fa')),
      ['definition']
    ),
    object(
      'fai',
      'fasta-index',
      'detail',
      definition.members[0].manifest.faiPath,
      await readFile(join(FIXTURE_ROOT, 'pUC19.fa.fai')),
      ['fasta']
    ),
    object(
      'gff',
      'gff3-bgzf',
      'detail',
      definition.members[0].manifest.gffPath,
      await readFile(join(FIXTURE_ROOT, 'pUC19.gff3.gz')),
      ['definition']
    ),
    object(
      'tbi',
      'gff3-tabix',
      'detail',
      definition.members[0].manifest.tbiPath,
      await readFile(join(FIXTURE_ROOT, 'pUC19.gff3.gz.tbi')),
      ['gff']
    ),
    object(
      'scene-manifest',
      'annotation-scene-manifest',
      'detail',
      'derived/annotation-scene-manifest.v1.json',
      Buffer.from('scene-manifest'),
      ['raster-manifest']
    ),
    object(
      'scene-payload',
      'annotation-scene-payload',
      'detail',
      'derived/annotation-scene-payload.bin',
      Buffer.from('scene-payload'),
      ['scene-manifest']
    ),
    object(
      'annotation-search-manifest',
      'annotation-search-manifest',
      'search',
      'derived/annotation-search-manifest.v1.json',
      Buffer.from('annotation-search-manifest'),
      ['definition']
    ),
    object(
      'annotation-search-payload',
      'annotation-search-payload',
      'search',
      'derived/annotation-search-payload.bin',
      Buffer.from('annotation-search-payload'),
      ['annotation-search-manifest']
    ),
    object(
      'protein-search-manifest',
      'protein-search-manifest',
      'search',
      'derived/protein-search-manifest.v1.json',
      Buffer.from('protein-search-manifest'),
      ['definition']
    ),
    object(
      'protein-search-payload',
      'protein-search-payload',
      'search',
      'derived/protein-search-payload.bin',
      Buffer.from('protein-search-payload'),
      ['protein-search-manifest']
    ),
  ];
  const bundle = buildPortablePreparedReferenceBundleV1({
    assembly: {
      id: ASSET_CACHE_KEY,
      assetCacheKey: ASSET_CACHE_KEY,
      preparationPipelineRevision: REFERENCE_PREPARATION_PIPELINE_REVISION,
      assemblyLengthBp: 2_686,
      contigCount: 1,
      source: {
        fastaSha256: FASTA_SHA256,
        gffSha256: GFF_SHA256,
      },
    },
    objects: objects.map((entry) => {
      const sha256 = sha256Bytes(entry.bytes);
      return {
        id: entry.id,
        role: entry.role,
        objectKey: portablePreparedReferenceContentObjectKeyV1(sha256),
        installPath: entry.installPath,
        byteLength: entry.bytes.byteLength,
        sha256,
        contractToken: `${entry.role}.fixture-v1`,
        dependsOn: entry.dependsOn,
      };
    }),
    readiness: {
      shell: { dependsOn: [], objectIds: ['definition'] },
      view: {
        dependsOn: ['shell'],
        objectIds: ['view-catalog', 'raster-manifest'],
      },
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
  const hydrationRoot = join(cacheRoot, ASSET_CACHE_KEY, 'generations', bundle.bundleFingerprint);
  await mkdir(hydrationRoot, { recursive: true });
  const objectPaths = new Map<string, string>();
  for (const entry of objects) {
    const path = join(hydrationRoot, entry.installPath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, entry.bytes, { flag: 'wx' });
    objectPaths.set(entry.id, path);
  }
  const catalogDefinition: HostedReferenceCatalogDefinitionV1 = {
    id: ASSET_CACHE_KEY,
    name: definition.name,
    organism: definition.organism,
    description: definition.description,
    sources: {
      fasta: {
        relativePath: 'fixtures/source.fa',
        sha256: FASTA_SHA256,
        byteLength: 1,
      },
      annotations: {
        relativePath: 'fixtures/source.gff3',
        sha256: GFF_SHA256,
        byteLength: 1,
      },
    },
    provenance: definition.provenance,
    contigs: [
      {
        chrom: 'puc19',
        sourceSeqId: 'puc19',
        displayName: 'pUC19',
        lengthBp: 2_686,
        role: 'other',
        circular: true,
      },
    ],
  };
  return {
    cacheRoot,
    catalogDefinition,
    hydration: {
      bundle,
      generationRoot: hydrationRoot,
      hydratedTiers: ['detail', 'search'],
      objectPaths,
    },
  };
}

function object(
  id: string,
  role: PortablePreparedReferenceObjectRoleV1,
  tier: PortablePreparedReferenceReadinessTierV1,
  installPath: string,
  bytes: Buffer,
  dependsOn: readonly string[] = []
): ObjectFixture {
  return { id, role, tier, installPath, bytes, dependsOn };
}

function sha256Bytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function passthroughWriterLease(): ReferenceAssetWriterLease {
  return {
    assertOwned: vi.fn(async () => undefined),
    commitPointer: vi.fn(async (temporaryPath: string, pointerPath: string) => {
      await rename(temporaryPath, pointerPath);
    }),
    acceptReconciledCommit: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
  };
}
