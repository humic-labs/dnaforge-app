import {
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat as statFile,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { LocalIndexedGenomeDataSource } from '@waypoint/genome-data/node';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config', () => ({
  getApiUrl: () => 'http://127.0.0.1:8128',
}));

vi.mock('../managed-genome-index-operation', () => ({
  runManagedGenomeIndex: async (body: unknown, signal?: AbortSignal) => {
    const response = await globalThis.fetch('http://api.test/genome/index', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.json();
  },
}));

import {
  buildIndexedGenomePaths,
  CURRENT_INDEXED_GENOME_SCHEMA,
} from '../../features/sequence/indexed-genome-paths';
import {
  bgzfFastaProductPaths,
  migrateUncompressedFastaBundle,
  resolveBuiltDnaIndexerBinary,
} from '../reference-assets/bgzf-fasta-migration';
import { isBgzfFile } from '../reference-assets/reference-preparation-file-integrity';
import {
  clearIndexedGenomeSessionPrepInflightForTests,
  prepareIndexedGenomeSession,
  type PrepareIndexedGenomeSessionInput,
} from './indexed-genome-session-prep';

const realFetch = globalThis.fetch;
const REPO_ROOT = resolve(process.cwd(), '../..');
const DNA_INDEXER = resolveBuiltDnaIndexerBinary(REPO_ROOT);

function readAborted(signal: AbortSignal | null): boolean | undefined {
  return signal?.aborted;
}

describe('prepareIndexedGenomeSession', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    clearIndexedGenomeSessionPrepInflightForTests();
    workspaceRoot = await mkdtemp(join(tmpdir(), 'waypoint-genome-session-'));
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    clearIndexedGenomeSessionPrepInflightForTests();
    await rm(workspaceRoot, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('reuses an existing bundle only when persisted source identity matches current stat', async () => {
    const sourcePath = join(workspaceRoot, 'chr11.gbff');
    const stat = { size: 1234, mtimeMs: 10_000, ctimeMs: 20_000 };
    const paths = await writeIndexedBundle({
      workspaceRoot,
      sourcePath,
      stat,
      metadataPatch: {},
    });
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const loadChromosomeLength = vi.fn().mockResolvedValue(135_086_622);

    const result = await prepareIndexedGenomeSession({
      source: {
        sourcePath,
        workspaceRoot,
        sourceExt: 'gbff',
        sourceSizeBytes: stat.size,
        intent: { kind: 'reference-single' },
      },
      stat,
      workspaceRoot,
      loadChromosomeLength,
    });

    expect(result.reusedExistingIndex).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(loadChromosomeLength).toHaveBeenCalledWith(
      expect.objectContaining(paths.manifest),
      expect.any(AbortSignal)
    );
    expect(result.tabState.manifest).toMatchObject({
      fastaPath: paths.manifest.fastaPath,
      gffPath: paths.manifest.gffPath,
      tbiPath: paths.manifest.tbiPath,
    });
  });

  it('reindexes instead of reusing when persisted source identity differs', async () => {
    const sourcePath = join(workspaceRoot, 'chr11.gbff');
    const stat = { size: 1234, mtimeMs: 10_000, ctimeMs: 20_000 };
    await writeIndexedBundle({
      workspaceRoot,
      sourcePath,
      stat,
      metadataPatch: { sourceCtimeMs: 19_999 },
    });
    const fetchMock = mockIndexResponse({
      fastaPath: join(workspaceRoot, 'fresh', 'chr11.fa'),
      faiPath: join(workspaceRoot, 'fresh', 'chr11.fa.fai'),
      gffPath: join(workspaceRoot, 'fresh', 'chr11.gff3.gz'),
      tbiPath: join(workspaceRoot, 'fresh', 'chr11.gff3.gz.tbi'),
      metadata: { length: 135_086_622, circular: false, featureCount: 10_000 },
    });
    const loadChromosomeLength = vi.fn().mockResolvedValue(135_086_622);

    const result = await prepareIndexedGenomeSession({
      source: {
        sourcePath,
        workspaceRoot,
        sourceExt: 'gbff',
        sourceSizeBytes: stat.size,
        intent: { kind: 'reference-single' },
      },
      stat,
      workspaceRoot,
      loadChromosomeLength,
    });

    expect(result.reusedExistingIndex).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(requestHeaders.get('Content-Type')).toBe('application/json');
    expect(requestHeaders.get('X-DNAForge-Session')).toBeNull();
    expect(result.tabState.manifest).toMatchObject({
      fastaPath: join(workspaceRoot, 'fresh', 'chr11.fa'),
      gffPath: join(workspaceRoot, 'fresh', 'chr11.gff3.gz'),
    });
  });

  it('uses the main-process stat size, not a renderer-provided size, for cache identity', async () => {
    const sourcePath = join(workspaceRoot, 'chr11.gbff');
    const stat = { size: 1234, mtimeMs: 10_000, ctimeMs: 20_000 };
    const staleRendererSize = 9999;
    await writeIndexedBundle({
      workspaceRoot,
      sourcePath,
      stat: { ...stat, size: staleRendererSize },
      metadataPatch: {},
    });
    const fetchMock = mockIndexResponse({
      fastaPath: join(workspaceRoot, 'fresh', 'chr11.fa'),
      faiPath: join(workspaceRoot, 'fresh', 'chr11.fa.fai'),
      gffPath: join(workspaceRoot, 'fresh', 'chr11.gff3.gz'),
      tbiPath: join(workspaceRoot, 'fresh', 'chr11.gff3.gz.tbi'),
      metadata: { length: 135_086_622, circular: false, featureCount: 10_000 },
    });
    const loadChromosomeLength = vi.fn().mockResolvedValue(135_086_622);
    const expectedPaths = buildIndexedGenomePaths({
      sourcePath,
      workspaceRoot,
      sizeBytes: stat.size,
      sourceMtimeMs: stat.mtimeMs,
      sourceCtimeMs: stat.ctimeMs,
    });

    const result = await prepareIndexedGenomeSession({
      source: {
        sourcePath,
        workspaceRoot,
        sourceExt: 'gbff',
        sourceSizeBytes: staleRendererSize,
        intent: { kind: 'reference-single' },
      },
      stat,
      workspaceRoot,
      loadChromosomeLength,
    });

    expect(result.reusedExistingIndex).toBe(false);
    expect(result.tabState.sourceSizeBytes).toBe(stat.size);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(requestBody.outputDir).toBe(expectedPaths.outputDir);
  });

  it('migrates a legacy uncompressed workspace bundle and reuses it without reindexing', async () => {
    const sourcePath = join(workspaceRoot, 'chr11.gbff');
    const stat = { size: 1234, mtimeMs: 10_000, ctimeMs: 20_000 };
    const paths = await writeIndexedBundle({
      workspaceRoot,
      sourcePath,
      stat,
      metadataPatch: {},
      legacyUncompressedFasta: true,
    });
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const loadChromosomeLength = vi.fn().mockResolvedValue(135_086_622);
    const uncompressedFastaPath = paths.manifest.fastaPath.replace(/\.gz$/, '');

    const result = await prepareIndexedGenomeSession({
      source: {
        sourcePath,
        workspaceRoot,
        sourceExt: 'gbff',
        sourceSizeBytes: stat.size,
        intent: { kind: 'reference-single' },
      },
      stat,
      workspaceRoot,
      loadChromosomeLength,
      migrateUncompressedFasta: (input) =>
        migrateUncompressedFastaBundle({
          ...input,
          compress: async (fastaPath) => {
            const products = bgzfFastaProductPaths(fastaPath);
            await writeFile(
              products.fastaPath,
              Buffer.from([
                0x1f, 0x8b, 0x08, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0x06, 0x00, 0x42, 0x43,
                0x02, 0x00, 0x1b, 0x00,
              ])
            );
            await writeFile(products.faiPath, await readFile(`${fastaPath}.fai`));
            await writeFile(products.gziPath, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
          },
        }),
    });

    expect(result.reusedExistingIndex).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.tabState.manifest).toMatchObject({
      fastaPath: paths.manifest.fastaPath,
      faiPath: paths.manifest.faiPath,
      gziPath: paths.manifest.gziPath,
    });
    await expect(readFile(uncompressedFastaPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(!DNA_INDEXER)(
    'replays a real pUC19 legacy bundle through session prep and reads the same bases',
    async () => {
      const sourcePath = join(workspaceRoot, 'puc19.fa');
      const fixtureFa = join(REPO_ROOT, 'test-fixtures/indexed/pUC19/pUC19.fa');
      const fixtureFai = join(REPO_ROOT, 'test-fixtures/indexed/pUC19/pUC19.fa.fai');
      await copyFile(fixtureFa, sourcePath);
      const stat = {
        size: (await readFile(sourcePath)).byteLength,
        mtimeMs: 10_000,
        ctimeMs: 20_000,
      };
      const paths = buildIndexedGenomePaths({
        sourcePath,
        workspaceRoot,
        sizeBytes: stat.size,
        sourceMtimeMs: stat.mtimeMs,
        sourceCtimeMs: stat.ctimeMs,
      });
      await mkdir(paths.outputDir, { recursive: true });
      const uncompressedFastaPath = paths.manifest.fastaPath.replace(/\.fa\.gz$/, '.fa');
      await copyFile(fixtureFa, uncompressedFastaPath);
      await copyFile(fixtureFai, `${uncompressedFastaPath}.fai`);
      await writeFile(
        paths.metadataPath,
        JSON.stringify({
          length: 2686,
          circular: true,
          featureCount: 0,
          chrom: paths.chrom,
          sourcePath,
          sourceSizeBytes: stat.size,
          sourceMtimeMs: stat.mtimeMs,
          sourceCtimeMs: stat.ctimeMs,
          sourceExt: 'fa',
          indexedAt: 123,
          schemaVersion: CURRENT_INDEXED_GENOME_SCHEMA,
        })
      );
      const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
        realFetch(input, init)
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const before = new LocalIndexedGenomeDataSource(
        {
          chrom: 'puc19',
          fastaPath: uncompressedFastaPath,
          faiPath: `${uncompressedFastaPath}.fai`,
        },
        { checkFileMtimeOnRead: false }
      );
      const expected = await before.getSequence('puc19', 0, 2686);
      await before.close();

      const result = await prepareIndexedGenomeSession({
        source: {
          sourcePath,
          workspaceRoot,
          sourceExt: 'fa',
          sourceSizeBytes: stat.size,
          intent: { kind: 'reference-single' },
        },
        stat,
        workspaceRoot,
        indexerBinary: DNA_INDEXER!,
        loadChromosomeLength: async () => 2686,
      });

      expect(result.reusedExistingIndex).toBe(true);
      expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/genome/index'))).toBe(
        false
      );
      const migrated = result.tabState.manifest;
      expect(migrated?.fastaPath).toBe(paths.manifest.fastaPath);
      expect(migrated?.gziPath).toBe(paths.manifest.gziPath);
      expect(migrated?.fastaPath).toBeTruthy();
      expect(await isBgzfFile(migrated!.fastaPath)).toBe(true);
      expect((await statFile(migrated!.faiPath!)).size).toBeGreaterThan(0);
      expect((await statFile(migrated!.gziPath!)).size).toBeGreaterThan(0);
      expect(await readdir(paths.outputDir)).toEqual(
        expect.arrayContaining(['puc19.fa.gz', 'puc19.fa.gz.fai', 'puc19.fa.gz.gzi'])
      );
      const after = new LocalIndexedGenomeDataSource(
        {
          chrom: 'puc19',
          fastaPath: migrated!.fastaPath,
          faiPath: migrated!.faiPath,
          gziPath: migrated!.gziPath,
        },
        { checkFileMtimeOnRead: false }
      );
      expect(await after.getSequence('puc19', 0, 2686)).toBe(expected);
      await after.close();
      await expect(readFile(uncompressedFastaPath)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  );

  it('uses a verified provided manifest without shelling out to the sidecar indexer', async () => {
    const sourceDir = join(workspaceRoot, 'test-fixtures', 'indexed', 'provided-reference');
    await mkdir(sourceDir, { recursive: true });
    const sourcePath = join(sourceDir, 'reference.gff3.gz');
    const manifest = {
      chrom: 'reference',
      fastaPath: join(sourceDir, 'reference.fa'),
      faiPath: join(sourceDir, 'reference.fa.fai'),
      gffPath: sourcePath,
      tbiPath: `${sourcePath}.tbi`,
      length: 100_000,
    };
    await writeFile(sourcePath, 'bgzf gff bytes', 'utf8');
    await writeFile(manifest.tbiPath, 'tbi bytes', 'utf8');
    await writeFile(manifest.fastaPath, '>reference\nACGT\n', 'utf8');
    await writeFile(manifest.faiPath, 'reference\t4\t11\t4\t5\n', 'utf8');

    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const loadChromosomeLength = vi.fn().mockResolvedValue(100_000);
    const migratedManifest = {
      ...manifest,
      fastaPath: `${manifest.fastaPath}.gz`,
      faiPath: `${manifest.faiPath.replace(/\.fai$/, '')}.gz.fai`,
      gziPath: `${manifest.fastaPath}.gz.gzi`,
    };

    const result = await prepareIndexedGenomeSession({
      source: {
        sourcePath,
        workspaceRoot,
        sourceExt: 'gff3',
        sourceSizeBytes: 1234,
        manifest,
        intent: { kind: 'reference-single' },
      },
      stat: { size: 1234, mtimeMs: 10_000, ctimeMs: 20_000 },
      workspaceRoot,
      loadChromosomeLength,
      migrateUncompressedFasta: (input) =>
        migrateUncompressedFastaBundle({
          ...input,
          compress: async (fastaPath) => {
            const products = bgzfFastaProductPaths(fastaPath);
            await writeFile(
              products.fastaPath,
              Buffer.from([
                0x1f, 0x8b, 0x08, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0x06, 0x00, 0x42, 0x43,
                0x02, 0x00, 0x1b, 0x00,
              ])
            );
            await writeFile(products.faiPath, await readFile(`${fastaPath}.fai`));
            await writeFile(products.gziPath, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
          },
        }),
    });

    expect(result.reusedExistingIndex).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(loadChromosomeLength).toHaveBeenCalledWith(
      expect.objectContaining({
        fastaPath: migratedManifest.fastaPath,
        faiPath: migratedManifest.faiPath,
        gziPath: migratedManifest.gziPath,
      }),
      expect.any(AbortSignal)
    );
    expect(result.tabState.manifest).toMatchObject({
      fastaPath: migratedManifest.fastaPath,
      gffPath: manifest.gffPath,
      tbiPath: manifest.tbiPath,
    });
    expect(result.tabState.chrom).toBe('reference');
  });

  it('keeps a provided uncompressed FASTA bundle when conversion is unavailable', async () => {
    const sourceDir = join(workspaceRoot, 'test-fixtures', 'indexed', 'provided-uncompressed');
    await mkdir(sourceDir, { recursive: true });
    const sourcePath = join(sourceDir, 'reference.gff3.gz');
    const manifest = {
      chrom: 'reference',
      fastaPath: join(sourceDir, 'reference.fa'),
      faiPath: join(sourceDir, 'reference.fa.fai'),
      gffPath: sourcePath,
      tbiPath: `${sourcePath}.tbi`,
      length: 4,
    };
    await writeFile(sourcePath, 'bgzf gff bytes', 'utf8');
    await writeFile(manifest.tbiPath, 'tbi bytes', 'utf8');
    await writeFile(manifest.fastaPath, '>reference\nACGT\n', 'utf8');
    await writeFile(manifest.faiPath, 'reference\t4\t11\t4\t5\n', 'utf8');
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const loadChromosomeLength = vi.fn().mockResolvedValue(4);

    const result = await prepareIndexedGenomeSession({
      source: {
        sourcePath,
        workspaceRoot,
        sourceExt: 'gff3',
        sourceSizeBytes: 1234,
        manifest,
        intent: { kind: 'reference-single' },
      },
      stat: { size: 1234, mtimeMs: 10_000, ctimeMs: 20_000 },
      workspaceRoot,
      loadChromosomeLength,
      migrateUncompressedFasta: async () => {
        throw new Error('dna-indexer executable not found for compress-fasta');
      },
    });

    expect(result.reusedExistingIndex).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.tabState.manifest).toMatchObject({
      fastaPath: manifest.fastaPath,
      faiPath: manifest.faiPath,
      gffPath: manifest.gffPath,
      tbiPath: manifest.tbiPath,
    });
    expect(result.tabState.manifest?.gziPath).toBeUndefined();
  });

  it('does not convert uncompressed FASTA larger than the opportunistic budget', async () => {
    const sourceDir = join(workspaceRoot, 'test-fixtures', 'indexed', 'provided-large');
    await mkdir(sourceDir, { recursive: true });
    const sourcePath = join(sourceDir, 'reference.gff3.gz');
    const manifest = {
      chrom: 'reference',
      fastaPath: join(sourceDir, 'reference.fa'),
      faiPath: join(sourceDir, 'reference.fa.fai'),
      gffPath: sourcePath,
      tbiPath: `${sourcePath}.tbi`,
      length: 4,
    };
    await writeFile(sourcePath, 'bgzf gff bytes', 'utf8');
    await writeFile(manifest.tbiPath, 'tbi bytes', 'utf8');
    await writeFile(manifest.fastaPath, '>reference\nACGT\n', 'utf8');
    const handle = await open(manifest.fastaPath, 'r+');
    await handle.truncate(32 * 1024 * 1024 + 1);
    await handle.close();
    await writeFile(manifest.faiPath, 'reference\t4\t11\t4\t5\n', 'utf8');
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const loadChromosomeLength = vi.fn().mockResolvedValue(4);
    const migrateUncompressedFasta = vi.fn(async () => {
      throw new Error('should not convert large FASTA');
    });

    const result = await prepareIndexedGenomeSession({
      source: {
        sourcePath,
        workspaceRoot,
        sourceExt: 'gff3',
        sourceSizeBytes: 1234,
        manifest,
        intent: { kind: 'reference-single' },
      },
      stat: { size: 1234, mtimeMs: 10_000, ctimeMs: 20_000 },
      workspaceRoot,
      loadChromosomeLength,
      migrateUncompressedFasta,
    });

    expect(migrateUncompressedFasta).not.toHaveBeenCalled();
    expect(result.tabState.manifest).toMatchObject({
      fastaPath: manifest.fastaPath,
      faiPath: manifest.faiPath,
    });
  });

  it('does not convert FASTA inside a published prepared-reference generation', async () => {
    const generationRoot = join(
      workspaceRoot,
      'pombeAsm294v3',
      'generations',
      '5f7bb3f5bda4b27429a295f658ae189168437a08c32f40a5aafe30a5f38db144'
    );
    const sourceDir = join(generationRoot, 'prepared', 'chr1');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      join(generationRoot, 'prepared-reference-definition.v1.json'),
      `${JSON.stringify({ contract: 'dnaforge-prepared-reference-definition.v1' })}\n`,
      'utf8'
    );
    const sourcePath = join(sourceDir, 'chr1.gff3.gz');
    const manifest = {
      chrom: 'chr1',
      fastaPath: join(sourceDir, 'chr1.fa'),
      faiPath: join(sourceDir, 'chr1.fa.fai'),
      gffPath: sourcePath,
      tbiPath: `${sourcePath}.tbi`,
      length: 4,
    };
    await writeFile(sourcePath, 'bgzf gff bytes', 'utf8');
    await writeFile(manifest.tbiPath, 'tbi bytes', 'utf8');
    await writeFile(manifest.fastaPath, '>chr1\nACGT\n', 'utf8');
    await writeFile(manifest.faiPath, 'chr1\t4\t6\t4\t5\n', 'utf8');
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const loadChromosomeLength = vi.fn().mockResolvedValue(4);
    const migrateUncompressedFasta = vi.fn(async () => {
      throw new Error('should not convert published prepared FASTA');
    });

    const result = await prepareIndexedGenomeSession({
      source: {
        sourcePath,
        workspaceRoot,
        sourceExt: 'gff3',
        sourceSizeBytes: 1234,
        manifest,
        intent: { kind: 'reference-single' },
      },
      stat: { size: 1234, mtimeMs: 10_000, ctimeMs: 20_000 },
      workspaceRoot,
      loadChromosomeLength,
      migrateUncompressedFasta,
    });

    expect(migrateUncompressedFasta).not.toHaveBeenCalled();
    expect(result.tabState.manifest).toMatchObject({
      fastaPath: manifest.fastaPath,
      faiPath: manifest.faiPath,
    });
    expect(await readFile(manifest.fastaPath, 'utf8')).toBe('>chr1\nACGT\n');
  });

  it('keeps the application-owned index producer alive after its last session waiter releases', async () => {
    const sourcePath = join(workspaceRoot, 'shared.gbff');
    await writeFile(sourcePath, 'LOCUS shared\n', 'utf8');
    let producerSignal: AbortSignal | null = null;
    const fetchMock = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      producerSignal = init?.signal ?? null;
      return new Promise<Response>((_resolve, reject) => {
        producerSignal?.addEventListener(
          'abort',
          () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          },
          { once: true }
        );
      });
    });
    globalThis.fetch = fetchMock;
    const firstOwner = new AbortController();
    const secondOwner = new AbortController();
    const baseInput: PrepareIndexedGenomeSessionInput = {
      source: {
        sourcePath,
        workspaceRoot,
        sourceExt: 'gbff',
        sourceSizeBytes: 42,
        intent: { kind: 'reference-single' },
      },
      stat: { size: 42, mtimeMs: 10_000, ctimeMs: 20_000 },
      workspaceRoot,
      loadChromosomeLength: vi.fn().mockResolvedValue(4),
    };

    const first = prepareIndexedGenomeSession({ ...baseInput, signal: firstOwner.signal });
    const second = prepareIndexedGenomeSession({ ...baseInput, signal: secondOwner.signal });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    firstOwner.abort();
    await expect(first).rejects.toHaveProperty('name', 'AbortError');
    expect(readAborted(producerSignal)).toBe(false);

    secondOwner.abort();
    await expect(second).rejects.toHaveProperty('name', 'AbortError');
    expect(readAborted(producerSignal)).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('lets a reopened session rejoin the producer after every prior waiter detaches', async () => {
    const sourcePath = join(workspaceRoot, 'retry.gbff');
    await writeFile(sourcePath, 'LOCUS retry\n', 'utf8');
    let producerSignal: AbortSignal | null = null;
    let resolveFirst: ((response: Response) => void) | undefined;
    const responseBody = {
      fastaPath: join(workspaceRoot, 'fresh', 'retry.fa'),
      faiPath: join(workspaceRoot, 'fresh', 'retry.fa.fai'),
      gffPath: join(workspaceRoot, 'fresh', 'retry.gff3.gz'),
      tbiPath: join(workspaceRoot, 'fresh', 'retry.gff3.gz.tbi'),
      metadata: {
        length: 4,
        circular: false,
        featureCount: 1,
        annotationTypes: ['gene'],
        annotationRasterReady: true,
      },
    };
    const fetchMock = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      producerSignal = init?.signal ?? null;
      return new Promise<Response>((resolve) => {
        resolveFirst = resolve;
      });
    });
    globalThis.fetch = fetchMock;
    const firstOwner = new AbortController();
    let physicalValidationSignal: AbortSignal | undefined;
    const baseInput: PrepareIndexedGenomeSessionInput = {
      source: {
        sourcePath,
        workspaceRoot,
        sourceExt: 'gbff',
        sourceSizeBytes: 42,
        intent: { kind: 'reference-single' },
      },
      stat: { size: 42, mtimeMs: 10_000, ctimeMs: 20_000 },
      workspaceRoot,
      loadChromosomeLength: async (_manifest, signal) => {
        physicalValidationSignal = signal;
        signal.throwIfAborted();
        return 4;
      },
    };

    const first = prepareIndexedGenomeSession({ ...baseInput, signal: firstOwner.signal });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    firstOwner.abort();
    await expect(first).rejects.toHaveProperty('name', 'AbortError');
    expect(readAborted(producerSignal)).toBe(false);

    const retry = prepareIndexedGenomeSession(baseInput);
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledOnce();

    resolveFirst?.({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => responseBody,
    } as Response);

    await expect(retry).resolves.toMatchObject({
      reusedExistingIndex: false,
      tabState: { manifest: { fastaPath: responseBody.fastaPath } },
    });
    expect(physicalValidationSignal).toBeDefined();
    expect(physicalValidationSignal).not.toBe(firstOwner.signal);
    expect(physicalValidationSignal?.aborted).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

async function writeIndexedBundle(input: {
  workspaceRoot: string;
  sourcePath: string;
  stat: { size: number; mtimeMs: number; ctimeMs: number };
  metadataPatch: Record<string, unknown>;
  legacyUncompressedFasta?: boolean;
}) {
  await writeFile(input.sourcePath, 'LOCUS chr11\n', 'utf8');
  const paths = buildIndexedGenomePaths({
    sourcePath: input.sourcePath,
    workspaceRoot: input.workspaceRoot,
    sizeBytes: input.stat.size,
    sourceMtimeMs: input.stat.mtimeMs,
    sourceCtimeMs: input.stat.ctimeMs,
  });
  await mkdir(paths.outputDir, { recursive: true });
  if (input.legacyUncompressedFasta) {
    const uncompressedFastaPath = paths.manifest.fastaPath.replace(/\.gz$/, '');
    await writeFile(uncompressedFastaPath, '>chr11\nACGT\n', 'utf8');
    await writeFile(`${uncompressedFastaPath}.fai`, 'chr11\t4\t7\t4\t5\n', 'utf8');
  } else {
    await writeFile(paths.manifest.fastaPath, '>chr11\nACGT\n', 'utf8');
    await writeFile(paths.manifest.faiPath, 'chr11\t4\t7\t4\t5\n', 'utf8');
    if (paths.manifest.gziPath) {
      await writeFile(paths.manifest.gziPath, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
    }
  }
  if (!paths.manifest.gffPath || !paths.manifest.tbiPath) {
    throw new Error('Expected annotation-bearing manifest in test fixture.');
  }
  await writeFile(paths.manifest.gffPath, 'bgzf bytes', 'utf8');
  await writeFile(paths.manifest.tbiPath, 'tbi bytes', 'utf8');
  await writeFile(
    paths.metadataPath,
    JSON.stringify(
      {
        length: 135_086_622,
        circular: false,
        featureCount: 10_000,
        chrom: paths.chrom,
        sourcePath: input.sourcePath,
        sourceSizeBytes: input.stat.size,
        sourceMtimeMs: input.stat.mtimeMs,
        sourceCtimeMs: input.stat.ctimeMs,
        sourceExt: 'gbff',
        indexedAt: 123,
        schemaVersion: CURRENT_INDEXED_GENOME_SCHEMA,
        ...input.metadataPatch,
      },
      null,
      2
    ),
    'utf8'
  );
  return paths;
}

function mockIndexResponse(body: {
  fastaPath: string;
  faiPath: string;
  gffPath: string;
  tbiPath: string;
  metadata: { length: number; circular: boolean; featureCount: number };
}) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: vi.fn().mockResolvedValue(body),
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}
