// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const calls = vi.hoisted(() => [] as string[]);
const mocks = vi.hoisted(() => ({
  roots: {
    cacheRoot: '/cache',
    publicationRoot: '/publication',
    fallbackPublicationRoot: null as string | null,
  },
  registerHandlers: vi.fn(),
  listLocal: vi.fn(),
  installHosted: vi.fn(),
  releaseGeneration: vi.fn(),
  explicitE2e: { value: false },
  retention: {
    start: vi.fn(() => calls.push('retention.start')),
    checkpoint: vi.fn(async () => {
      calls.push('retention.checkpoint');
    }),
    stop: vi.fn(async () => undefined),
    pinOpening: vi.fn(async () => undefined),
    collect: vi.fn(),
    retainPreparation: vi.fn(async () => mocks.releaseGeneration),
    setRendererVersions: vi.fn(),
    releaseRenderer: vi.fn(),
  },
  reconciler: { start: vi.fn(), stop: vi.fn() },
  gate: { dispose: vi.fn() },
  uninstallGate: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => `/paths/${name}`,
    getAppPath: () => '/app',
    isPackaged: false,
  },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../shared/ipc-contract', () => ({ sendRendererIpc: vi.fn() }));
vi.mock('../config', () => ({ isExplicitE2eTestRuntime: () => mocks.explicitE2e.value }));
vi.mock('../ipc/genome-data', () => ({ activeGenomeReferencePaths: () => [] }));
vi.mock('../ipc/reference-assets', () => ({
  registerReferenceAssetIpcHandlers: mocks.registerHandlers,
}));
vi.mock('../reference-assets/bgzf-fasta-migration', () => ({
  setBgzfFastaMigrationIndexerBinary: vi.fn(),
}));
vi.mock('../reference-assets/hosted-reference-asset-authority', () => ({
  createHostedReferenceAssetAuthority: vi.fn(() => {
    calls.push('hosted-authority');
    return { listHosted: vi.fn(), installHosted: mocks.installHosted };
  }),
}));
vi.mock('../reference-assets/hosted-reference-catalog', () => ({
  DNAFORGE_HOSTED_REFERENCE_BASE_URL_ENV: 'BASE_URL',
  HOSTED_REFERENCE_CATALOG_V1: [],
}));
vi.mock('../reference-assets/hosted-reference-catalog-fixture', () => ({
  hostedReferenceCatalogForRuntime: async () => [{ id: 'grch38' }],
  HOSTED_REFERENCE_CATALOG_FIXTURE_ENV: 'FIXTURE',
}));
vi.mock('../reference-assets/hosted-reference-cache-reconciler', () => ({
  HostedReferenceCacheReconciler: vi.fn(() => mocks.reconciler),
  hostedReferenceCacheVersionsV1: () => ({}),
}));
vi.mock('../reference-assets/hosted-reference-transport', () => ({
  installHostedReferenceBodyReadGate: () => mocks.uninstallGate,
}));
vi.mock('../reference-assets/local-reference-asset-authority', () => ({
  createLocalReferenceAssetAuthority: () => ({ listLocal: mocks.listLocal }),
  resolveDnaIndexerHelperPath: () => '/bin/dna-indexer',
}));
vi.mock('../reference-assets/office-resources-download-gate', () => ({
  OfficeResourcesDownloadGate: vi.fn(() => mocks.gate),
}));
vi.mock('../reference-assets/portable-prepared-reference-view-authority', () => ({
  portablePreparedReferenceViewAuthorityV1: { releaseGeneration: vi.fn() },
}));
vi.mock('../reference-assets/reference-asset-cache-root', () => ({
  resolveReferenceAssetRootLayout: () => ({ ...mocks.roots }),
}));
vi.mock('../reference-assets/reference-asset-writer-lock', () => ({
  acquireReferenceAssetWriterLock: vi.fn(),
}));
vi.mock('../reference-assets/reference-generation-retention', () => ({
  ReferenceGenerationRetention: vi.fn(() => mocks.retention),
}));

import type { BrowserWindow } from 'electron';
import type { PreparedReferenceAssemblyEntryV1 } from '../../shared/reference-assets-ipc';
import { referenceAssetsFeature, withLocalTrackViewReference } from './reference-assets';
import {
  parsePreparedReferenceDefinition,
  preparedReferenceAssemblyEntry,
  PREPARED_REFERENCE_DEFINITION_FILE,
  PREPARED_REFERENCE_DEFINITION_V1,
  REFERENCE_PREPARATION_PIPELINE_REVISION,
} from '../reference-assets/reference-preparation-manifest';
import {
  REFERENCE_ASSET_PUBLICATION_FILE,
  REFERENCE_ASSET_PUBLICATION_V1,
} from '../../features/sequence/reference-asset-publication';
import { indexedSequenceDataLayerTarget } from '../indexed-sequence-data-layer-target';
import { sequenceDataLayerIndexedTargetId } from '../../shared/sequence-data-layer-indexed-target';

const temporaryRoots: string[] = [];

afterEach(async () => {
  referenceAssetsFeature.willQuit?.();
  calls.length = 0;
  vi.clearAllMocks();
  mocks.explicitE2e.value = false;
  mocks.roots = {
    cacheRoot: '/cache',
    publicationRoot: '/publication',
    fallbackPublicationRoot: null,
  };
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('reference assets feature', () => {
  it('pins catalog versions before the hosted authority can install them', async () => {
    await referenceAssetsFeature.prepare?.({ getMainWindow: () => null });
    expect(calls).toEqual(['retention.start', 'retention.checkpoint', 'hosted-authority']);
  });

  it('registers reference asset IPC with the prepared authorities and pins opened generations', async () => {
    await referenceAssetsFeature.prepare?.({ getMainWindow: () => null });
    referenceAssetsFeature.registerIpc?.();
    expect(mocks.registerHandlers).toHaveBeenCalledTimes(1);
    const deps = mocks.registerHandlers.mock.calls[0][0];
    expect(deps).toEqual(
      expect.objectContaining({ listLocal: expect.any(Function), listHosted: expect.any(Function) })
    );
    await deps.retainOpenedVersion('owner-1', {
      assetCacheKey: 'grch38',
      portableView: { generationRoot: '/cache/grch38/generations/gen-7' },
      members: [],
    });
    expect(mocks.retention.pinOpening).toHaveBeenCalledWith('owner-1', {
      catalogId: 'grch38',
      generationId: 'gen-7',
    });
  });

  it('registers nothing before it is prepared', () => {
    referenceAssetsFeature.registerIpc?.();
    expect(mocks.registerHandlers).not.toHaveBeenCalled();
  });

  it('starts the hosted cache reconciler once the window exists, except in E2E runs', async () => {
    await referenceAssetsFeature.prepare?.({ getMainWindow: () => null });
    referenceAssetsFeature.onMainWindow?.({} as BrowserWindow, { getMainWindow: () => null });
    expect(mocks.reconciler.start).toHaveBeenCalledTimes(1);

    referenceAssetsFeature.willQuit?.();
    mocks.explicitE2e.value = true;
    await referenceAssetsFeature.prepare?.({ getMainWindow: () => null });
    referenceAssetsFeature.onMainWindow?.({} as BrowserWindow, { getMainWindow: () => null });
    expect(mocks.reconciler.start).toHaveBeenCalledTimes(1);
  });

  it('stops retention, the reconciler and the download gate at quit', async () => {
    await referenceAssetsFeature.prepare?.({ getMainWindow: () => null });
    referenceAssetsFeature.onMainWindow?.({} as BrowserWindow, { getMainWindow: () => null });
    referenceAssetsFeature.willQuit?.();
    expect(mocks.retention.stop).toHaveBeenCalledTimes(1);
    expect(mocks.reconciler.stop).toHaveBeenCalledTimes(1);
    expect(mocks.uninstallGate).toHaveBeenCalledTimes(1);
    expect(mocks.gate.dispose).toHaveBeenCalledTimes(1);
  });
});

describe('local reference use for data layer targets', () => {
  const entry: PreparedReferenceAssemblyEntryV1 = {
    id: 'ecoli',
    name: 'E. coli',
    organism: 'E. coli',
    description: '',
    assetCacheKey: 'ecoli',
    members: [
      {
        chrom: 'NC_000913.3',
        lengthBp: 4_641_652,
        manifest: {
          fastaPath: '/cache/ecoli/generations/gen-7/reference.fa',
          faiPath: '/cache/ecoli/generations/gen-7/reference.fa.fai',
        },
      },
    ],
  };

  it('retains an existing generation for the entire callback and releases it afterward', async () => {
    await referenceAssetsFeature.prepare?.({ getMainWindow: () => null });
    mocks.listLocal.mockResolvedValue([entry]);
    const result = await withLocalTrackViewReference(entry.id, async (selected) => {
      expect(selected).toBe(entry);
      expect(mocks.retention.retainPreparation).toHaveBeenCalledWith(
        entry.members[0].manifest!.fastaPath
      );
      expect(mocks.releaseGeneration).not.toHaveBeenCalled();
      return 'measured';
    });
    expect(result).toBe('measured');
    expect(mocks.releaseGeneration).toHaveBeenCalledOnce();
    expect(mocks.installHosted).not.toHaveBeenCalled();
  });

  it('releases the generation when target resolution fails', async () => {
    await referenceAssetsFeature.prepare?.({ getMainWindow: () => null });
    mocks.listLocal.mockResolvedValue([entry]);
    await expect(
      withLocalTrackViewReference(entry.id, async () => {
        throw new Error('read failed');
      })
    ).rejects.toThrow('read failed');
    expect(mocks.releaseGeneration).toHaveBeenCalledOnce();
  });

  it.each([{ entries: [] }, { entries: [entry, entry] }])(
    'refuses missing or ambiguous local entries without starting an install',
    async ({ entries }) => {
      await referenceAssetsFeature.prepare?.({ getMainWindow: () => null });
      mocks.listLocal.mockResolvedValue(entries);
      const use = vi.fn();
      await expect(withLocalTrackViewReference(entry.id, use)).rejects.toThrow(
        'REFERENCE_NOT_PREPARED'
      );
      expect(use).not.toHaveBeenCalled();
      expect(mocks.retention.retainPreparation).not.toHaveBeenCalled();
      expect(mocks.installHosted).not.toHaveBeenCalled();
    }
  );

  it('refuses an unavailable owner without reading a registry or installing', async () => {
    await expect(withLocalTrackViewReference(entry.id, vi.fn())).rejects.toThrow(
      'Reference assets are unavailable'
    );
    expect(mocks.listLocal).not.toHaveBeenCalled();
    expect(mocks.installHosted).not.toHaveBeenCalled();
  });

  it('refuses an owner stopped while its registry read was pending', async () => {
    await referenceAssetsFeature.prepare?.({ getMainWindow: () => null });
    mocks.listLocal.mockImplementationOnce(async () => {
      referenceAssetsFeature.willQuit?.();
      return [entry];
    });
    await expect(withLocalTrackViewReference(entry.id, vi.fn())).rejects.toThrow(
      'Reference assets are unavailable'
    );
    expect(mocks.retention.retainPreparation).not.toHaveBeenCalled();
  });
});

describe('published relative reference source paths', () => {
  async function publishedFixture() {
    const directory = await mkdtemp(join(tmpdir(), 'dnaforge-relative-layer-reference-'));
    temporaryRoots.push(directory);
    mocks.roots = {
      cacheRoot: join(directory, 'cache'),
      publicationRoot: join(directory, 'publication'),
      fallbackPublicationRoot: join(directory, 'cache'),
    };
    const id = 'puc19-local';
    const generation = join(mocks.roots.cacheRoot, id, 'generations', 'generation-7');
    const prepared = join(generation, 'prepared', 'puc19');
    await mkdir(prepared, { recursive: true });
    const fixtureRoot = resolve('../../test-fixtures/indexed/pUC19');
    const files = ['pUC19.fa', 'pUC19.fa.fai', 'pUC19.gff3.gz', 'pUC19.gff3.gz.tbi'];
    await Promise.all(
      files.map((file) =>
        copyFile(join(fixtureRoot, file), join(prepared, file.replace('pUC19', 'puc19')))
      )
    );
    const definition = parsePreparedReferenceDefinition(
      {
        contract: PREPARED_REFERENCE_DEFINITION_V1,
        pipelineRevision: REFERENCE_PREPARATION_PIPELINE_REVISION,
        id,
        assetCacheKey: id,
        name: 'pUC19',
        organism: 'Synthetic construct',
        description: 'Indexed fixture.',
        source: {
          fastaSha256: createHash('sha256')
            .update(await readFile(join(fixtureRoot, 'pUC19.fa')))
            .digest('hex'),
          gffSha256: createHash('sha256')
            .update(await readFile(join(fixtureRoot, 'pUC19.gff3.gz')))
            .digest('hex'),
        },
        provenance: { provider: 'Local import', datasetId: 'pUC19', datasetVersion: '1' },
        members: [
          {
            chrom: 'puc19',
            sourceSeqId: 'puc19',
            lengthBp: 2686,
            role: 'other',
            circular: true,
            manifest: {
              fastaPath: 'prepared/puc19/puc19.fa',
              faiPath: 'prepared/puc19/puc19.fa.fai',
              gffPath: 'prepared/puc19/puc19.gff3.gz',
              tbiPath: 'prepared/puc19/puc19.gff3.gz.tbi',
            },
          },
        ],
      },
      id
    );
    await writeFile(
      join(generation, PREPARED_REFERENCE_DEFINITION_FILE),
      JSON.stringify(definition)
    );
    const publication = join(mocks.roots.publicationRoot, id, REFERENCE_ASSET_PUBLICATION_FILE);
    await mkdir(join(mocks.roots.publicationRoot, id), { recursive: true });
    await writeFile(
      publication,
      JSON.stringify({
        contract: REFERENCE_ASSET_PUBLICATION_V1,
        assetCacheKey: id,
        publicationId: 'generation-7',
        sourceMaterializationFingerprint: 'a'.repeat(64),
        publishedAtMs: 1,
      })
    );
    return { entry: preparedReferenceAssemblyEntry(definition), generation, publication };
  }

  it('projects catalog-relative manifests through the actual current publication and reads their indexed source', async () => {
    const fixture = await publishedFixture();
    await referenceAssetsFeature.prepare?.({ getMainWindow: () => null });
    mocks.listLocal.mockResolvedValue([fixture.entry]);
    const target = {
      referenceId: fixture.entry.id,
      chrom: 'puc19',
      ...fixture.entry.referenceIdentity!,
    };
    const result = await indexedSequenceDataLayerTarget(
      sequenceDataLayerIndexedTargetId(target),
      target,
      {
        withReference: withLocalTrackViewReference,
      }
    );
    expect(result.length).toBe(2686);
    expect(result.annotations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'lacZ.cds.1', start0: 145, end0: 469 }),
      ])
    );
    expect(mocks.retention.retainPreparation).toHaveBeenCalledWith(fixture.generation);
    expect(mocks.releaseGeneration).toHaveBeenCalledOnce();
    expect(mocks.installHosted).not.toHaveBeenCalled();
  });

  it('refuses a relative source without a current publication', async () => {
    const fixture = await publishedFixture();
    await rm(fixture.publication);
    await referenceAssetsFeature.prepare?.({ getMainWindow: () => null });
    mocks.listLocal.mockResolvedValue([fixture.entry]);
    const use = vi.fn();
    await expect(withLocalTrackViewReference(fixture.entry.id, use)).rejects.toThrow(
      'REFERENCE_NOT_PREPARED'
    );
    expect(use).not.toHaveBeenCalled();
    expect(mocks.installHosted).not.toHaveBeenCalled();
  });

  it('refuses a current generation whose parsed content identity differs from the owned entry', async () => {
    const fixture = await publishedFixture();
    await referenceAssetsFeature.prepare?.({ getMainWindow: () => null });
    mocks.listLocal.mockResolvedValue([
      {
        ...fixture.entry,
        referenceIdentity: {
          ...fixture.entry.referenceIdentity!,
          sequenceIdentity: 'c'.repeat(64),
        },
      },
    ]);
    const use = vi.fn();
    await expect(withLocalTrackViewReference(fixture.entry.id, use)).rejects.toThrow(
      'generation changed'
    );
    expect(use).not.toHaveBeenCalled();
    expect(mocks.releaseGeneration).toHaveBeenCalledOnce();
  });
});
