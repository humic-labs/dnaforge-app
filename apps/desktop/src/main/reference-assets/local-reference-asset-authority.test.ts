import { existsSync } from 'node:fs';
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

import { ASSEMBLY_REFERENCE_ASSET_GENERATION_V1 } from '../../shared/indexed-genome';
import type {
  PreparedReferenceAssemblyEntryV1,
  ReferenceAssetPreparationProgressUpdateV1,
} from '../../shared/reference-assets-ipc';
import {
  createLocalReferenceAssetAuthority,
  developmentHelperSnapshotNeedsFsync,
  hubGenomeIdentity,
  LOCAL_REFERENCE_PREPARATION_STATUS_FILE,
  resolveDnaIndexerHelperPath,
  type LocalReferencePreparationRunner,
  type LocalReferenceSourceReadinessInspector,
} from './local-reference-asset-authority';
import type {
  ReferenceAssetPreparationInput,
  ReferenceAssetPreparationReceipt,
} from './reference-preparation-engine';

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PROJECT_ROOT = resolve(DESKTOP_ROOT, '../..');
const HELPER_NAME = 'dna-indexer-aarch64-apple-darwin';
const PUBLIC_EXPORT = existsSync(join(PROJECT_ROOT, '.dnaforge-public-export'));
const PUC19_FASTA = join(PROJECT_ROOT, 'test-fixtures/indexed/pUC19/pUC19.fa');
const PUC19_GFF3 = join(PROJECT_ROOT, 'test-fixtures/indexed/pUC19/pUC19.gff3.gz');
const PUC19_FASTA_SHA256 = '7267c78e26eef9671a4fccaf3bf12ff56c27220c90135746164c943be48aad1f';
const PUC19_GFF3_SHA256 = 'dd7cae6d069314768be3e16f7b023d7ce38f40af4f85f035a6d6bb467a10a3a8';

describe('resolveDnaIndexerHelperPath', () => {
  it('honors an explicitly provisioned helper before packaged and development fallbacks', () => {
    expect(
      resolveDnaIndexerHelperPath({
        appPath: '/missing/app',
        resourcesPath: '/missing/resources',
        isPackaged: true,
        explicitPath: ' /ci/reference-helpers/dna-indexer ',
        platform: 'linux',
        arch: 'x64',
      })
    ).toBe('/ci/reference-helpers/dna-indexer');
  });

  it('skips copied-helper fsync only on Windows', () => {
    expect(developmentHelperSnapshotNeedsFsync('win32')).toBe(false);
    expect(developmentHelperSnapshotNeedsFsync('darwin')).toBe(true);
    expect(developmentHelperSnapshotNeedsFsync('linux')).toBe(true);
  });

  it.skipIf(PUBLIC_EXPORT)(
    'ships the Linux x64 dna-indexer helper the development resolver spawns',
    () => {
      const helper = join(
        DESKTOP_ROOT,
        'resources',
        'helpers',
        'dna-indexer-x86_64-unknown-linux-musl'
      );
      expect(existsSync(helper)).toBe(true);
      expect(
        resolveDnaIndexerHelperPath({
          appPath: join(DESKTOP_ROOT, 'out', 'main'),
          resourcesPath: '/unused/Resources',
          isPackaged: false,
          platform: 'linux',
          arch: 'x64',
        })
      ).toBe(helper);
    }
  );

  it.skipIf(PUBLIC_EXPORT)('finds source-tree helpers for built non-packaged Electron', () => {
    const expected = join(DESKTOP_ROOT, 'resources', 'helpers', HELPER_NAME);
    expect(existsSync(expected)).toBe(true);

    expect(
      resolveDnaIndexerHelperPath({
        appPath: join(DESKTOP_ROOT, 'out', 'main'),
        resourcesPath: '/unused/Resources',
        isPackaged: false,
        platform: 'darwin',
        arch: 'arm64',
      })
    ).toBe(expected);
  });

  it('executes an immutable content-addressed snapshot in development', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dna-indexer-snapshot-'));
    const appPath = join(root, 'app');
    const helperRoot = join(appPath, 'resources', 'helpers');
    const snapshotRoot = join(root, 'snapshots');
    const source = join(helperRoot, HELPER_NAME);
    await mkdir(helperRoot, { recursive: true });
    await writeFile(source, '#!/bin/sh\nprintf first\n', { mode: 0o755 });

    try {
      const first = resolveDnaIndexerHelperPath({
        appPath,
        resourcesPath: '/unused/Resources',
        isPackaged: false,
        developmentSnapshotRoot: snapshotRoot,
        platform: 'darwin',
        arch: 'arm64',
      });
      expect(first).not.toBe(source);
      await expect(readFile(first, 'utf8')).resolves.toBe('#!/bin/sh\nprintf first\n');

      await writeFile(source, '#!/bin/sh\nprintf second\n', { mode: 0o755 });
      const second = resolveDnaIndexerHelperPath({
        appPath,
        resourcesPath: '/unused/Resources',
        isPackaged: false,
        developmentSnapshotRoot: snapshotRoot,
        platform: 'darwin',
        arch: 'arm64',
      });
      expect(second).not.toBe(first);
      await expect(readFile(first, 'utf8')).resolves.toBe('#!/bin/sh\nprintf first\n');
      await expect(readFile(second, 'utf8')).resolves.toBe('#!/bin/sh\nprintf second\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves the packaged Windows helper with its executable suffix', () => {
    expect(
      resolveDnaIndexerHelperPath({
        appPath: '/opt/DNAForge/resources/app.asar',
        resourcesPath: '/opt/DNAForge/resources',
        isPackaged: true,
        platform: 'win32',
        arch: 'x64',
      })
    ).toBe(join('/opt/DNAForge', 'Helpers', 'dna-indexer-x86_64-pc-windows-msvc.exe'));
  });
});

describe('local reference source-first lifecycle', () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
    );
  });

  it('rejects the import when preparation fails before source publication', async () => {
    const runPreparation: LocalReferencePreparationRunner = vi.fn(async () => {
      throw new Error('source materialization failed');
    });
    const harness = await createLifecycleHarness(temporaryRoots, runPreparation);

    await expect(harness.importLocal()).rejects.toThrow('source materialization failed');
    expect(harness.progress).not.toContainEqual(
      expect.objectContaining({ phase: 'background-preparation-failed' })
    );
  });

  it('resolves from the admitted source publication before product completion', async () => {
    const products = gate();
    let productsCompleted = false;
    const runPreparation = vi.fn<LocalReferencePreparationRunner>(async (input) => {
      input.onProgress?.('published source generation');
      await input.onSourcePublished?.();
      await products.promise;
      productsCompleted = true;
      return preparationReceipt(input, 'ready');
    });
    const harness = await createLifecycleHarness(temporaryRoots, runPreparation);

    try {
      await expect(harness.importLocal()).resolves.toMatchObject({
        id: expect.stringMatching(/^local-[0-9a-f]{24}$/u),
      });
      expect(productsCompleted).toBe(false);
      expect(harness.inspectSourcePublication).toHaveBeenCalledOnce();
      expect(harness.inspectSourcePublication).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedSource: {
            fastaSha256: PUC19_FASTA_SHA256,
            gffSha256: PUC19_GFF3_SHA256,
          },
        })
      );
    } finally {
      products.release();
    }
    await vi.waitFor(() =>
      expect(harness.progress).toContainEqual(
        expect.objectContaining({
          assemblyId: expect.stringMatching(/^local-[0-9a-f]{24}$/u),
          phase: 'ready',
          completed: 1,
          total: 1,
        })
      )
    );
  });

  it('keeps the private preparation manifest alive until background products finish', async () => {
    const products = gate();
    let manifestPath: string | null = null;
    const runPreparation = vi.fn<LocalReferencePreparationRunner>(async (input) => {
      manifestPath = input.manifestPath ?? null;
      input.onProgress?.('published source generation');
      await input.onSourcePublished?.();
      await products.promise;
      return preparationReceipt(input, 'ready');
    });
    const harness = await createLifecycleHarness(temporaryRoots, runPreparation);

    try {
      await harness.importLocal();
      expect(manifestPath).not.toBeNull();
      await expect(stat(manifestPath!)).resolves.toMatchObject({ size: expect.any(Number) });
    } finally {
      products.release();
    }
    await vi.waitFor(async () => {
      await expect(access(manifestPath!)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('reports a post-source product failure without invalidating the opened source', async () => {
    const runPreparation = vi.fn<LocalReferencePreparationRunner>(async (input) => {
      input.onProgress?.('published source generation');
      await input.onSourcePublished?.();
      throw new Error('annotation scene build failed');
    });
    const harness = await createLifecycleHarness(temporaryRoots, runPreparation);

    const opened = await harness.importLocal();
    await vi.waitFor(() =>
      expect(harness.progress).toContainEqual(
        expect.objectContaining({
          phase: 'background-preparation-failed',
          label: expect.stringContaining('annotation scene build failed'),
        })
      )
    );
    await expect(harness.authority.listLocal()).resolves.toContainEqual(opened);
  });

  it('persists a post-source failure for reconciliation after authority reconstruction', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const failureWriteStarted = gate();
    const failureWriteAllowed = gate();
    const failureWriteSaved = gate();
    vi.mocked(rename).mockImplementation(async (source, destination) => {
      if (
        destination.toString().endsWith(LOCAL_REFERENCE_PREPARATION_STATUS_FILE) &&
        (await readFile(source, 'utf8')).includes('durable annotation failure')
      ) {
        failureWriteStarted.release();
        await failureWriteAllowed.promise;
        await actual.rename(source, destination);
        failureWriteSaved.release();
        return;
      }
      return actual.rename(source, destination);
    });
    const runPreparation = vi.fn<LocalReferencePreparationRunner>(async (input) => {
      input.onProgress?.('published source generation');
      await input.onSourcePublished?.();
      throw new Error('durable annotation failure');
    });
    try {
      const harness = await createLifecycleHarness(temporaryRoots, runPreparation);
      const opened = await harness.importLocal();
      await failureWriteStarted.promise;
      const beforeWrite = await harness.authority.getLocalPreparationStatus(opened.id);
      failureWriteAllowed.release();
      await failureWriteSaved.promise;
      await vi.waitFor(
        async () =>
          expect(await harness.authority.getLocalPreparationStatus(opened.id)).toMatchObject({
            assemblyId: opened.id,
            status: 'failed',
            phase: 'background-preparation-failed',
            label: expect.stringContaining('durable annotation failure'),
          }),
        { timeout: 10_000 }
      );
      expect(beforeWrite).toMatchObject({ assemblyId: opened.id, status: 'preparing' });

      const reconstructed = createLocalReferenceAssetAuthority({
        cacheRoot: harness.cacheRoot,
        projectRoot: PROJECT_ROOT,
        sourceBuildFingerprint: 'focused-test',
        indexerBinary: '/unused/injected-indexer',
      });
      await expect(reconstructed.getLocalPreparationStatus(opened.id)).resolves.toMatchObject({
        assemblyId: opened.id,
        status: 'failed',
        label: expect.stringContaining('durable annotation failure'),
      });
    } finally {
      failureWriteAllowed.release();
      vi.mocked(rename).mockImplementation(actual.rename);
    }
  });

  it('reclassifies a disk-only preparing receipt as an interrupted retryable failure', async () => {
    const products = gate();
    const runPreparation = vi.fn<LocalReferencePreparationRunner>(async (input) => {
      input.onProgress?.('published source generation');
      await input.onSourcePublished?.();
      await products.promise;
      return preparationReceipt(input, 'ready');
    });
    const harness = await createLifecycleHarness(temporaryRoots, runPreparation);
    const opened = await harness.importLocal();
    await expect(harness.authority.getLocalPreparationStatus(opened.id)).resolves.toMatchObject({
      status: 'preparing',
    });

    const reconstructed = createLocalReferenceAssetAuthority({
      cacheRoot: harness.cacheRoot,
      projectRoot: PROJECT_ROOT,
      sourceBuildFingerprint: 'focused-test',
      indexerBinary: '/unused/injected-indexer',
    });
    try {
      await expect(reconstructed.getLocalPreparationStatus(opened.id)).resolves.toMatchObject({
        assemblyId: opened.id,
        status: 'failed',
        phase: 'background-preparation-failed',
        label: expect.stringContaining('interrupted'),
      });
    } finally {
      products.release();
      await expect
        .poll(async () => (await harness.authority.getLocalPreparationStatus(opened.id))?.status)
        .toBe('ready');
    }
  });

  it('retries local products from the admitted publication without using raw import sources', async () => {
    let attempt = 0;
    const runPreparation = vi.fn<LocalReferencePreparationRunner>(async (input) => {
      attempt += 1;
      if (attempt === 1) {
        input.onProgress?.('published source generation');
        await input.onSourcePublished?.();
        throw new Error('first product build failed');
      }
      expect(input).toMatchObject({
        command: 'ensure',
        manifestPath: null,
        publishedEntry: expect.objectContaining({ id: expect.stringMatching(/^local-/u) }),
        expectedPublishedSource: {
          fastaSha256: PUC19_FASTA_SHA256,
          gffSha256: PUC19_GFF3_SHA256,
        },
      });
      return preparationReceipt(input, 'ready');
    });
    const harness = await createLifecycleHarness(temporaryRoots, runPreparation);
    const opened = await harness.importLocal();
    await vi.waitFor(() =>
      expect(harness.progress).toContainEqual(
        expect.objectContaining({ phase: 'background-preparation-failed' })
      )
    );

    const retryProgress: ReferenceAssetPreparationProgressUpdateV1[] = [];
    await expect(
      harness.authority.retryLocal({
        assemblyId: opened.id,
        themeMode: 'dark',
        onProgress: (update) => retryProgress.push(update),
      })
    ).resolves.toEqual(opened);
    expect(runPreparation).toHaveBeenCalledTimes(2);
    expect(retryProgress).toContainEqual(
      expect.objectContaining({
        assemblyId: opened.id,
        phase: 'ready',
        completed: 1,
        total: 1,
      })
    );
    await expect(harness.authority.getLocalPreparationStatus(opened.id)).resolves.toMatchObject({
      status: 'ready',
      phase: 'ready',
    });
  });

  it('signals the successful product publication so an open session can upgrade', async () => {
    const products = gate();
    const runPreparation = vi.fn<LocalReferencePreparationRunner>(async (input) => {
      input.onProgress?.('published source generation');
      await input.onSourcePublished?.();
      await products.promise;
      return preparationReceipt(input, 'ready');
    });
    const harness = await createLifecycleHarness(temporaryRoots, runPreparation);

    await harness.importLocal();
    expect(harness.progress).toContainEqual(
      expect.objectContaining({ phase: 'source-published', completed: 1, total: 1 })
    );
    products.release();
    await vi.waitFor(() =>
      expect(harness.progress).toContainEqual(
        expect.objectContaining({ phase: 'verifying-publication' })
      )
    );
    await vi.waitFor(() =>
      expect(harness.progress).toContainEqual(
        expect.objectContaining({ phase: 'ready', completed: 1, total: 1 })
      )
    );
    expect(harness.listPrepared).toHaveBeenCalledTimes(2);
  });

  it('opens a standalone FASTA after terminal sequence-only preparation', async () => {
    const runPreparation = vi.fn<LocalReferencePreparationRunner>(async (input) => {
      input.onProgress?.('published source generation');
      await input.onSourcePublished?.();
      return preparationReceipt(input, 'source-ready');
    });
    const harness = await createLifecycleHarness(temporaryRoots, runPreparation, {
      sequenceOnly: true,
    });

    await expect(harness.importLocal()).resolves.toMatchObject({
      members: [
        {
          manifest: {
            fastaPath: expect.any(String),
            faiPath: expect.any(String),
          },
        },
      ],
    });
    expect(harness.progress).toContainEqual({
      phase: 'source-recognized',
      label: 'Standalone FASTA recognized',
    });
    expect(harness.inspectSourcePublication).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedSource: {
          fastaSha256: PUC19_FASTA_SHA256,
        },
      })
    );
    await vi.waitFor(() =>
      expect(harness.progress).toContainEqual(
        expect.objectContaining({ phase: 'ready', completed: 1, total: 1 })
      )
    );
    expect(harness.progress).not.toContainEqual(
      expect.objectContaining({ phase: 'background-preparation-failed' })
    );
  });
});

describe('hub genome import', () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
    );
  });

  it('unpacks the hub sequence into private staging and prepares it as a local FASTA', async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), 'dnaforge-hub-genome-authority-'));
    temporaryRoots.push(cacheRoot);
    let preparedId: string | null = null;
    let manifestPath: string | null = null;
    const runPreparation = vi.fn<LocalReferencePreparationRunner>(async (input) => {
      preparedId = input.assemblyId ?? null;
      manifestPath = input.manifestPath ?? null;
      input.onProgress?.('published source generation');
      await input.onSourcePublished?.();
      return sourceReadyReceipt();
    });
    const acquireHubGenome = vi.fn(
      async (input: {
        stagingRoot: string;
        onProgress: (update: ReferenceAssetPreparationProgressUpdateV1) => void;
      }) => {
        await mkdir(input.stagingRoot, { recursive: true });
        const fastaPath = join(input.stagingRoot, 'sacCer3.fa');
        await writeFile(fastaPath, await readFile(PUC19_FASTA));
        input.onProgress({ phase: 'downloading-hub-sequence', label: 'Downloading sacCer3' });
        return {
          fastaPath,
          download: { url: 'https://hub.example.org/sacCer3.2bit', byteLength: 7, sha256: 'a' },
          sequences: [{ name: 'puc19', length: 2_686 }],
          totalBases: 2_686,
        };
      }
    );
    const progress: ReferenceAssetPreparationProgressUpdateV1[] = [];
    const authority = createLocalReferenceAssetAuthority({
      cacheRoot,
      projectRoot: PROJECT_ROOT,
      sourceBuildFingerprint: 'focused-test',
      indexerBinary: '/unused/injected-indexer',
      runPreparation,
      listPrepared: async () => (preparedId ? [preparedEntry(preparedId, true)] : []),
      inspectSourcePublication: async () => ({
        status: 'ready',
        publicationId: 'hub-genome-publication',
        sourceGenerationRoot: cacheRoot,
      }),
      hubGenomePolicy: { allowLoopbackHttpForTests: true },
      acquireHubGenome: acquireHubGenome as never,
    });

    const opened = await authority.importHubGenome({
      source: {
        hubUrl: 'https://hub.example.org/yeast/hub.txt',
        genome: 'sacCer3',
        twoBitPath: 'sacCer3/sacCer3.2bit',
        provider: 'assembly-hub',
        organism: 'Saccharomyces cerevisiae',
      },
      themeMode: 'dark',
      onProgress: (update) => progress.push(update),
    });

    expect(opened.id).toMatch(/^local-[0-9a-f]{24}$/u);
    expect(acquireHubGenome).toHaveBeenCalledWith(
      expect.objectContaining({
        locator: {
          hubUrl: 'https://hub.example.org/yeast/hub.txt',
          genome: 'sacCer3',
          twoBitPath: 'sacCer3/sacCer3.2bit',
        },
        stagingRoot: expect.stringMatching(/\.import-staging\/[0-9a-f-]{36}\/hub-genome$/u),
        policy: { allowLoopbackHttpForTests: true },
      })
    );
    expect(progress.map((update) => update.phase)).toEqual(
      expect.arrayContaining(['downloading-hub-sequence', 'source-recognized', 'source-published'])
    );
    expect(progress).toContainEqual({
      phase: 'source-recognized',
      label: 'Hub genome sequence recognized',
    });
    expect(manifestPath).not.toBeNull();
    const manifest = JSON.parse(await readFile(manifestPath!, 'utf8')) as {
      assembly: Record<string, unknown>;
      provenance: Record<string, unknown>;
      sources: { fasta: { path: string } };
    };
    expect(manifest.assembly).toEqual({
      id: opened.id,
      name: 'sacCer3',
      organism: 'Saccharomyces cerevisiae',
      accession: 'sacCer3',
      description:
        'Assembly hub genome sacCer3 from hub.example.org, unpacked from its hub sequence: 1 sequence, 2.69 kb.',
    });
    expect(manifest.provenance).toEqual({
      provider: 'UCSC assembly hub',
      datasetId: 'sacCer3',
      datasetVersion: expect.stringMatching(/^sequence-[0-9a-f]{16}$/u),
      sourceUrl: 'https://hub.example.org/yeast/hub.txt',
    });
    expect(manifest.sources.fasta.path).toContain(join(cacheRoot, '.import-staging'));
    await vi.waitFor(() =>
      expect(progress).toContainEqual(expect.objectContaining({ phase: 'ready' }))
    );
    await vi.waitFor(async () => {
      await expect(access(join(cacheRoot, '.import-staging'))).resolves.toBeUndefined();
      await expect(readdirEmpty(join(cacheRoot, '.import-staging'))).resolves.toBe(true);
    });
  });

  it('cleans staging and rejects when the hub download fails', async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), 'dnaforge-hub-genome-authority-'));
    temporaryRoots.push(cacheRoot);
    const runPreparation: LocalReferencePreparationRunner = vi.fn();
    const authority = createLocalReferenceAssetAuthority({
      cacheRoot,
      projectRoot: PROJECT_ROOT,
      sourceBuildFingerprint: 'focused-test',
      indexerBinary: '/unused/injected-indexer',
      runPreparation,
      acquireHubGenome: (async (input: { stagingRoot: string }) => {
        await mkdir(input.stagingRoot, { recursive: true });
        await writeFile(join(input.stagingRoot, 'partial.2bit'), 'partial');
        throw new Error(
          'The hub sequence could not be downloaded (HTTP 404 from hub.example.org).'
        );
      }) as never,
    });
    await expect(
      authority.importHubGenome({
        source: {
          hubUrl: 'https://hub.example.org/yeast/hub.txt',
          genome: 'sacCer3',
          twoBitPath: 'missing.2bit',
          provider: 'genark',
        },
        themeMode: 'light',
        onProgress: () => undefined,
      })
    ).rejects.toThrow('HTTP 404');
    expect(runPreparation).not.toHaveBeenCalled();
    await expect(readdirEmpty(join(cacheRoot, '.import-staging'))).resolves.toBe(true);
  });

  it('names GenArk assemblies by accession and assembly name', () => {
    expect(
      hubGenomeIdentity(
        {
          hubUrl: 'https://hgdownload.soe.ucsc.edu/hubs/GCF/000/146/045/GCF_000146045.2/hub.txt',
          genome: 'GCF_000146045.2',
          twoBitPath: 'GCF_000146045.2.2bit',
          provider: 'genark',
          organism: 'Saccharomyces cerevisiae',
          assemblyName: 'R64',
          taxId: 559292,
        },
        {
          sequences: Array.from({ length: 17 }, (_, index) => ({ name: `c${index}`, length: 1 })),
          totalBases: 12_157_105,
        }
      )
    ).toEqual({
      name: 'R64 (GCF_000146045.2)',
      organism: 'Saccharomyces cerevisiae',
      taxId: 559292,
      accession: 'GCF_000146045.2',
      description:
        'UCSC GenArk assembly GCF_000146045.2, unpacked from its hub sequence: 17 sequences, 12.16 Mb.',
      provenance: {
        provider: 'UCSC GenArk',
        datasetId: 'GCF_000146045.2',
        sourceUrl: 'https://hgdownload.soe.ucsc.edu/hubs/GCF/000/146/045/GCF_000146045.2/hub.txt',
      },
    });
  });
});

async function readdirEmpty(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length === 0;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return true;
    throw error;
  }
}

function sourceReadyReceipt(): ReferenceAssetPreparationReceipt {
  return {
    status: 'source-ready',
    message: 'sequence source ready',
  } as unknown as ReferenceAssetPreparationReceipt;
}

function preparationReceipt(
  input: ReferenceAssetPreparationInput,
  status: 'ready' | 'source-ready'
): ReferenceAssetPreparationReceipt {
  const base = {
    command: input.command,
    assemblyId: input.assemblyId ?? '',
    manifestPath: input.manifestPath ?? null,
    projectRoot: input.projectRoot,
    cacheRoot: input.cacheRoot,
    workspaceRoot: input.cacheRoot,
    sourceGenerationRoot: null,
    publication: null,
    themeMode: input.themeMode,
    sourceBuildFingerprint: input.sourceBuildFingerprint,
    durationMs: 0,
  };
  return status === 'ready'
    ? {
        ...base,
        status,
        generation: {
          contract: ASSEMBLY_REFERENCE_ASSET_GENERATION_V1,
          sourceFingerprint: 'a'.repeat(24),
          inventoryFingerprint: 'f'.repeat(64),
          themeMode: input.themeMode,
        },
        trackTypes: [],
      }
    : { ...base, status, message: 'sequence source ready' };
}

async function createLifecycleHarness(
  temporaryRoots: string[],
  runPreparation: LocalReferencePreparationRunner,
  options: Readonly<{ sequenceOnly?: boolean }> = {}
): Promise<{
  authority: ReturnType<typeof createLocalReferenceAssetAuthority>;
  importLocal: () => Promise<PreparedReferenceAssemblyEntryV1>;
  progress: ReferenceAssetPreparationProgressUpdateV1[];
  cacheRoot: string;
  listPrepared: ReturnType<typeof vi.fn>;
  inspectSourcePublication: ReturnType<typeof vi.fn>;
}> {
  const cacheRoot = await mkdtemp(join(tmpdir(), 'dnaforge-local-reference-authority-'));
  temporaryRoots.push(cacheRoot);
  let preparedId: string | null = null;
  const runner = vi.fn<LocalReferencePreparationRunner>(async (input) => {
    preparedId = input.assemblyId ?? null;
    return runPreparation(input);
  });
  const listPrepared = vi.fn(async () =>
    preparedId ? ([preparedEntry(preparedId, options.sequenceOnly)] as const) : ([] as const)
  );
  const inspectSourcePublication = vi.fn<LocalReferenceSourceReadinessInspector>(
    async ({ entry, expectedSource }) => {
      expect(entry.id).toBe(preparedId);
      expect(expectedSource).toEqual(
        options.sequenceOnly
          ? {
              fastaSha256: PUC19_FASTA_SHA256,
            }
          : {
              fastaSha256: PUC19_FASTA_SHA256,
              gffSha256: PUC19_GFF3_SHA256,
            }
      );
      return {
        status: 'ready',
        publicationId: 'local-source-publication',
        sourceGenerationRoot: cacheRoot,
      };
    }
  );
  const progress: ReferenceAssetPreparationProgressUpdateV1[] = [];
  const authority = createLocalReferenceAssetAuthority({
    cacheRoot,
    projectRoot: PROJECT_ROOT,
    sourceBuildFingerprint: 'focused-test',
    indexerBinary: '/unused/injected-indexer',
    runPreparation: runner,
    listPrepared,
    readRepairInput: async (_cacheRoot, assemblyId) =>
      preparedId === assemblyId
        ? {
            entry: preparedEntry(assemblyId, options.sequenceOnly),
            expectedSource: options.sequenceOnly
              ? { fastaSha256: PUC19_FASTA_SHA256 }
              : {
                  fastaSha256: PUC19_FASTA_SHA256,
                  gffSha256: PUC19_GFF3_SHA256,
                },
          }
        : null,
    inspectSourcePublication,
    resolveSelection: async () => ({
      kind: options.sequenceOnly ? 'standalone-fasta' : 'generic-folder',
      sourcePaths: options.sequenceOnly ? [PUC19_FASTA] : [PUC19_FASTA, PUC19_GFF3],
    }),
  });
  return {
    authority,
    importLocal: () =>
      authority.importLocal({
        selection: { path: '/selected/reference-folder' },
        themeMode: 'light',
        onProgress: (update) => progress.push(update),
      }),
    progress,
    cacheRoot,
    listPrepared,
    inspectSourcePublication,
  };
}

function preparedEntry(id: string, sequenceOnly = false): PreparedReferenceAssemblyEntryV1 {
  return {
    id,
    name: 'pUC19',
    organism: 'synthetic DNA construct',
    description: 'Focused local source-first fixture.',
    assetCacheKey: id,
    members: [
      {
        chrom: 'puc19',
        displayName: 'pUC19',
        lengthBp: 2_686,
        circular: true,
        manifest: {
          fastaPath: 'prepared/puc19/puc19.fa',
          faiPath: 'prepared/puc19/puc19.fa.fai',
          ...(sequenceOnly
            ? {}
            : {
                gffPath: 'prepared/puc19/puc19.gff3.gz',
                tbiPath: 'prepared/puc19/puc19.gff3.gz.tbi',
              }),
        },
      },
    ],
  };
}

function gate(): Readonly<{ promise: Promise<void>; release: () => void }> {
  let release!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  return { promise, release };
}
