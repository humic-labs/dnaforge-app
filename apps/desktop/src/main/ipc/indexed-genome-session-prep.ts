import { access, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type {
  IndexedGenomeManifest,
  IndexedGenomeMetadata,
  IndexedGenomeTabState,
  GenomeOpenSource,
} from '../../shared/indexed-genome';
import {
  buildIndexedGenomePaths,
  CURRENT_INDEXED_GENOME_SCHEMA,
  extensionForPath,
  isAnnotationBearingExtension,
  type IndexedGenomePathInput,
} from '../../features/sequence/indexed-genome-paths';
import type { GenomeSourceStat } from './genome-session';
import {
  bgzfFastaProductPaths,
  migrateUncompressedFastaBundle,
  readValidBgzfFastaMigrationReceipt,
  uncompressedFastaPathFor,
  type BgzfFastaMigrationResult,
  type MigrateUncompressedFastaBundleInput,
} from '../reference-assets/bgzf-fasta-migration';
import { PREPARED_REFERENCE_DEFINITION_FILE } from '../reference-assets/reference-preparation-manifest';
import { runManagedGenomeIndex } from '../managed-genome-index-operation';

export interface PreparedIndexedGenome {
  tabState: IndexedGenomeTabState;
  reusedExistingIndex: boolean;
}

interface PersistedIndexMetadata extends IndexedGenomeMetadata {
  chrom: string;
  sourcePath: string;
  sourceSizeBytes?: number;
  sourceMtimeMs?: number;
  sourceCtimeMs?: number;
  sourceExt: string;
  indexedAt: number;
  schemaVersion?: number;
}

export interface PrepareIndexedGenomeSessionInput {
  source: GenomeOpenSource;
  stat: GenomeSourceStat;
  workspaceRoot: string;
  signal?: AbortSignal;
  loadChromosomeLength(manifest: IndexedGenomeManifest, signal: AbortSignal): Promise<number>;
  onProgress?(update: { tabState: IndexedGenomeTabState; reusedExistingIndex: boolean }): void;
  migrateUncompressedFasta?: (
    input: MigrateUncompressedFastaBundleInput
  ) => Promise<BgzfFastaMigrationResult>;
  indexerBinary?: string;
}

const MAX_SHARED_PREPARATION_WAITERS = 32;
const MAX_OPPORTUNISTIC_BGZF_MIGRATE_BYTES = 32 * 1024 * 1024;
interface InflightPreparation {
  controller: AbortController;
  promise: Promise<PreparedIndexedGenome>;
  progress: PreparationProgressState;
}

type IndexedGenomePreparationProgress = Parameters<
  NonNullable<PrepareIndexedGenomeSessionInput['onProgress']>
>[0];

interface PreparationProgressState {
  waiters: Map<symbol, PrepareIndexedGenomeSessionInput['onProgress']>;
  latest?: IndexedGenomePreparationProgress;
}

type PhysicalPreparationInput = Omit<PrepareIndexedGenomeSessionInput, 'signal' | 'onProgress'> & {
  signal: AbortSignal;
  onProgress(update: IndexedGenomePreparationProgress): void;
};

const inflight = new Map<string, InflightPreparation>();

export function clearIndexedGenomeSessionPrepInflightForTests(): void {
  for (const preparation of inflight.values()) preparation.controller.abort();
  inflight.clear();
}

export async function prepareIndexedGenomeSession(
  input: PrepareIndexedGenomeSessionInput
): Promise<PreparedIndexedGenome> {
  if (input.signal?.aborted) throw createAbortError();
  const pathInput = createPathInput(input);
  const paths = buildIndexedGenomePaths(pathInput);
  const key = `${pathInput.sourcePath}\n${paths.outputDir}`;
  for (;;) {
    let preparation = inflight.get(key);
    if (preparation?.controller.signal.aborted) {
      await waitForPreparationSettlement(preparation, input.signal);
      continue;
    }
    if (!preparation) {
      const controller = new AbortController();
      const progress: PreparationProgressState = { waiters: new Map() };
      const promise = prepareIndexedGenomeSessionUncached(
        {
          ...input,
          signal: controller.signal,
          onProgress: (update) => publishPreparationProgress(progress, update),
        },
        pathInput
      ).finally(() => {
        if (inflight.get(key)?.promise === promise) inflight.delete(key);
      });
      preparation = {
        controller,
        promise,
        progress,
      };
      inflight.set(key, preparation);
    }
    return waitForPreparation(preparation, input.signal, input.onProgress);
  }
}

async function waitForPreparation(
  preparation: InflightPreparation,
  signal?: AbortSignal,
  onProgress?: PrepareIndexedGenomeSessionInput['onProgress']
): Promise<PreparedIndexedGenome> {
  if (signal?.aborted) throw createAbortError();
  if (preparation.progress.waiters.size >= MAX_SHARED_PREPARATION_WAITERS) {
    throw new Error('Indexed genome preparation waiter queue is full.');
  }
  const waiter = Symbol('indexed-genome-preparation-waiter');
  preparation.progress.waiters.set(waiter, onProgress);
  if (preparation.progress.latest && onProgress) {
    notifyPreparationObserver(onProgress, preparation.progress.latest);
  }
  let removeAbortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    if (!signal) return;
    const onAbort = (): void => reject(createAbortError());
    signal.addEventListener('abort', onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener('abort', onAbort);
  });
  try {
    return await (signal ? Promise.race([preparation.promise, aborted]) : preparation.promise);
  } finally {
    removeAbortListener?.();
    preparation.progress.waiters.delete(waiter);
  }
}

function publishPreparationProgress(
  progress: PreparationProgressState,
  update: IndexedGenomePreparationProgress
): void {
  progress.latest = update;
  for (const observer of progress.waiters.values()) {
    if (observer) notifyPreparationObserver(observer, update);
  }
}

function notifyPreparationObserver(
  observer: NonNullable<PrepareIndexedGenomeSessionInput['onProgress']>,
  update: IndexedGenomePreparationProgress
): void {
  try {
    observer(update);
  } catch (error) {
    console.error('[indexed-genome-session-prep] progress observer failed', error);
  }
}

async function waitForPreparationSettlement(
  preparation: InflightPreparation,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) throw createAbortError();
  if (preparation.progress.waiters.size >= MAX_SHARED_PREPARATION_WAITERS) {
    throw new Error('Indexed genome preparation waiter queue is full.');
  }
  const waiter = Symbol('indexed-genome-preparation-settlement-waiter');
  preparation.progress.waiters.set(waiter, undefined);
  let removeAbortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    if (!signal) return;
    const onAbort = (): void => reject(createAbortError());
    signal.addEventListener('abort', onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener('abort', onAbort);
  });
  const settled = preparation.promise.then(
    () => undefined,
    () => undefined
  );
  try {
    await (signal ? Promise.race([settled, aborted]) : settled);
  } finally {
    removeAbortListener?.();
    preparation.progress.waiters.delete(waiter);
  }
}

function createAbortError(): Error {
  const error = new Error('Indexed genome preparation was cancelled');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError();
}

export function createPendingIndexedGenomeTabState(input: {
  source: GenomeOpenSource;
  stat: GenomeSourceStat;
  workspaceRoot: string;
  error?: string;
}): IndexedGenomeTabState {
  const pathInput = createPathInput(input);
  const paths = buildIndexedGenomePaths(pathInput);
  return {
    sourcePath: input.source.sourcePath,
    sourceSizeBytes: input.stat.size,
    sourceMtimeMs: input.stat.mtimeMs,
    sourceCtimeMs: input.stat.ctimeMs,
    sourceExt: input.source.sourceExt ?? extensionForPath(input.source.sourcePath),
    chrom: input.source.chrom ?? paths.chrom,
    ...(input.error ? { error: input.error } : {}),
  };
}

async function prepareIndexedGenomeSessionUncached(
  input: PhysicalPreparationInput,
  pathInput: IndexedGenomePathInput
): Promise<PreparedIndexedGenome> {
  throwIfAborted(input.signal);
  const sourceExt = input.source.sourceExt ?? extensionForPath(input.source.sourcePath);
  const paths = buildIndexedGenomePaths(pathInput);
  const providedManifest = input.source.manifest
    ? await completeIndexedGenomeManifest(input.source.manifest, {
        sourceExt,
        migrateUncompressedFasta: input.migrateUncompressedFasta,
        indexerBinary: input.indexerBinary,
      })
    : null;

  if (input.source.manifest) {
    if (!providedManifest) {
      input.onProgress?.({
        tabState: createPendingIndexedGenomeTabState({
          source: input.source,
          stat: input.stat,
          workspaceRoot: input.workspaceRoot,
        }),
        reusedExistingIndex: false,
      });
    }
  }

  if (providedManifest) {
    throwIfAborted(input.signal);
    const length = await input.loadChromosomeLength(providedManifest, input.signal);
    throwIfAborted(input.signal);
    const manifest = { ...providedManifest, length };
    return {
      reusedExistingIndex: true,
      tabState: {
        sourcePath: input.source.sourcePath,
        sourceSizeBytes: input.stat.size,
        sourceMtimeMs: input.stat.mtimeMs,
        sourceCtimeMs: input.stat.ctimeMs,
        sourceExt,
        chrom: manifest.chrom,
        outputDir: paths.outputDir,
        manifest,
        metadata: {
          length,
          circular: manifest.circular ?? false,
        },
      },
    };
  }

  const persisted = await readPersistedMetadata(paths.metadataPath);
  const cacheIsStale =
    persisted != null &&
    (persisted.schemaVersion == null || persisted.schemaVersion < CURRENT_INDEXED_GENOME_SCHEMA);
  const persistedMatchesSource =
    persisted != null && persistedMetadataMatchesSource(persisted, input, sourceExt);
  const existingManifest =
    cacheIsStale || !persistedMatchesSource
      ? null
      : await completeIndexedGenomeManifest(paths.manifest, {
          sourceExt: persisted?.sourceExt ?? sourceExt,
          featureCount: persisted?.featureCount,
          migrateUncompressedFasta: input.migrateUncompressedFasta,
          indexerBinary: input.indexerBinary,
        });

  if (existingManifest) {
    throwIfAborted(input.signal);
    const length = await input.loadChromosomeLength(existingManifest, input.signal);
    throwIfAborted(input.signal);
    const featureCount =
      typeof persisted?.featureCount === 'number' ? persisted.featureCount : undefined;
    return {
      reusedExistingIndex: true,
      tabState: {
        sourcePath: input.source.sourcePath,
        sourceSizeBytes: input.stat.size,
        sourceMtimeMs: input.stat.mtimeMs,
        sourceCtimeMs: input.stat.ctimeMs,
        sourceExt,
        chrom: paths.chrom,
        outputDir: paths.outputDir,
        manifest: { ...existingManifest, length },
        metadata: {
          length,
          circular: persisted?.circular ?? existingManifest.circular ?? false,
          ...(featureCount !== undefined ? { featureCount } : {}),
          ...(persisted?.annotationTypes ? { annotationTypes: persisted.annotationTypes } : {}),
          ...(persisted?.annotationRasterReady !== undefined
            ? { annotationRasterReady: persisted.annotationRasterReady }
            : {}),
        },
        indexedAt: persisted?.indexedAt,
      },
    };
  }

  throwIfAborted(input.signal);
  const response = await runManagedGenomeIndex(
    {
      input: input.source.sourcePath,
      outputDir: paths.outputDir,
      name: paths.chrom,
      workspaceRoot: input.workspaceRoot,
    },
    input.signal
  );
  throwIfAborted(input.signal);

  const metadata: IndexedGenomeMetadata = {
    length: response.metadata.length,
    circular: response.metadata.circular,
    featureCount: response.metadata.featureCount,
    annotationTypes: response.metadata.annotationTypes,
    annotationRasterReady: response.metadata.annotationRasterReady,
  };
  const manifest: IndexedGenomeManifest = {
    chrom: paths.chrom,
    fastaPath: response.fastaPath,
    faiPath: response.faiPath,
    gffPath: response.gffPath ?? null,
    tbiPath: response.tbiPath ?? null,
    length: metadata.length,
    circular: metadata.circular,
  };

  await writePersistedMetadata(paths.metadataPath, {
    ...metadata,
    chrom: paths.chrom,
    sourcePath: input.source.sourcePath,
    sourceSizeBytes: input.stat.size,
    sourceMtimeMs: input.stat.mtimeMs,
    sourceCtimeMs: input.stat.ctimeMs,
    sourceExt,
    indexedAt: Date.now(),
    schemaVersion: CURRENT_INDEXED_GENOME_SCHEMA,
  });
  throwIfAborted(input.signal);
  await input.loadChromosomeLength(manifest, input.signal);
  throwIfAborted(input.signal);

  return {
    reusedExistingIndex: false,
    tabState: {
      sourcePath: input.source.sourcePath,
      sourceSizeBytes: input.stat.size,
      sourceMtimeMs: input.stat.mtimeMs,
      sourceCtimeMs: input.stat.ctimeMs,
      sourceExt,
      chrom: paths.chrom,
      outputDir: paths.outputDir,
      manifest,
      metadata,
      indexedAt: Date.now(),
    },
  };
}

function createPathInput(input: {
  source: GenomeOpenSource;
  stat: GenomeSourceStat;
  workspaceRoot: string;
}): IndexedGenomePathInput {
  return {
    sourcePath: input.source.sourcePath,
    workspaceRoot: input.workspaceRoot,
    sizeBytes: input.stat.size,
    sourceMtimeMs: input.stat.mtimeMs,
    sourceCtimeMs: input.stat.ctimeMs,
  };
}

function persistedMetadataMatchesSource(
  persisted: PersistedIndexMetadata,
  input: PrepareIndexedGenomeSessionInput,
  sourceExt: string
): boolean {
  return (
    persisted.sourcePath === input.source.sourcePath &&
    persisted.sourceExt === sourceExt &&
    persisted.sourceSizeBytes === input.stat.size &&
    persisted.sourceMtimeMs === input.stat.mtimeMs &&
    persisted.sourceCtimeMs === input.stat.ctimeMs
  );
}

async function resolveIndexedGenomeSequenceManifest(
  manifest: IndexedGenomeManifest,
  options: {
    migrateUncompressedFasta?: PrepareIndexedGenomeSessionInput['migrateUncompressedFasta'];
    indexerBinary?: string;
  }
): Promise<IndexedGenomeManifest | null> {
  if ((await exists(manifest.fastaPath)) && (await exists(manifest.faiPath))) {
    if (isGzipFastaPath(manifest.fastaPath)) return manifest;
    const uncompressedFastaPath = uncompressedFastaPathFor(manifest.fastaPath);
    if (!uncompressedFastaPath) return manifest;
    return (
      (await migrateUncompressedSequenceManifest(manifest, uncompressedFastaPath, options)) ??
      manifest
    );
  }
  const uncompressedFastaPath = uncompressedFastaPathFor(manifest.fastaPath);
  if (!uncompressedFastaPath) return null;
  const products = bgzfFastaProductPaths(uncompressedFastaPath);
  const validReceipt = await readValidBgzfFastaMigrationReceipt(dirname(products.receiptPath));
  if (validReceipt) {
    return {
      ...manifest,
      fastaPath: products.fastaPath,
      faiPath: products.faiPath,
      gziPath: products.gziPath,
    };
  }
  if (!(await exists(uncompressedFastaPath)) || !(await exists(products.uncompressedFaiPath))) {
    return null;
  }
  return migrateUncompressedSequenceManifest(manifest, uncompressedFastaPath, options);
}

async function migrateUncompressedSequenceManifest(
  manifest: IndexedGenomeManifest,
  uncompressedFastaPath: string,
  options: {
    migrateUncompressedFasta?: PrepareIndexedGenomeSessionInput['migrateUncompressedFasta'];
    indexerBinary?: string;
  }
): Promise<IndexedGenomeManifest | null> {
  const migrate = options.migrateUncompressedFasta ?? migrateUncompressedFastaBundle;
  try {
    if (await isInsidePreparedReferenceGeneration(uncompressedFastaPath)) {
      return manifest;
    }
    if ((await stat(uncompressedFastaPath)).size > MAX_OPPORTUNISTIC_BGZF_MIGRATE_BYTES) {
      return manifest;
    }
    const migrated = await migrate({
      uncompressedFastaPath,
      indexerBinary: options.indexerBinary,
    });
    return {
      ...manifest,
      fastaPath: migrated.product.fastaPath,
      faiPath: migrated.product.faiPath,
      gziPath: migrated.product.gziPath,
    };
  } catch {
    if (await exists(uncompressedFastaPath)) return manifest;
    return null;
  }
}

function isGzipFastaPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith('.fa.gz') || lower.endsWith('.fasta.gz') || lower.endsWith('.fna.gz');
}

async function completeIndexedGenomeManifest(
  manifest: IndexedGenomeManifest,
  options: {
    sourceExt?: string;
    featureCount?: number;
    migrateUncompressedFasta?: PrepareIndexedGenomeSessionInput['migrateUncompressedFasta'];
    indexerBinary?: string;
  } = {}
): Promise<IndexedGenomeManifest | null> {
  const sequenceManifest = await resolveIndexedGenomeSequenceManifest(manifest, options);
  if (!sequenceManifest) return null;
  manifest = sequenceManifest;
  const hasFasta = await exists(manifest.fastaPath);
  const hasFai = await exists(manifest.faiPath);
  if (!hasFasta || !hasFai) return null;
  const gziPath =
    manifest.gziPath ?? (isGzipFastaPath(manifest.fastaPath) ? `${manifest.fastaPath}.gzi` : null);
  if (gziPath && !(await exists(gziPath))) return null;
  if (gziPath) manifest = { ...manifest, gziPath };

  if (options.featureCount === 0) {
    return { ...manifest, gffPath: null, tbiPath: null };
  }

  const expectsAnnotations =
    Boolean(manifest.gffPath || manifest.tbiPath) ||
    isAnnotationBearingExtension(options.sourceExt);
  if (!expectsAnnotations) {
    return { ...manifest, gffPath: null, tbiPath: null };
  }

  if (!manifest.gffPath || !manifest.tbiPath) return null;

  const hasGff = await exists(manifest.gffPath);
  const hasTbi = await exists(manifest.tbiPath);

  if (!hasGff || !hasTbi) return null;
  return {
    ...manifest,
    gffPath: manifest.gffPath,
    tbiPath: manifest.tbiPath,
  };
}

async function readPersistedMetadata(path: string): Promise<PersistedIndexMetadata | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<PersistedIndexMetadata>;
    if (
      typeof parsed.length !== 'number' ||
      typeof parsed.circular !== 'boolean' ||
      typeof parsed.chrom !== 'string' ||
      typeof parsed.sourcePath !== 'string' ||
      typeof parsed.sourceExt !== 'string' ||
      typeof parsed.indexedAt !== 'number'
    ) {
      return null;
    }
    return {
      length: parsed.length,
      circular: parsed.circular,
      ...(typeof parsed.featureCount === 'number' ? { featureCount: parsed.featureCount } : {}),
      ...(Array.isArray(parsed.annotationTypes) &&
      parsed.annotationTypes.every((value) => typeof value === 'string')
        ? { annotationTypes: parsed.annotationTypes }
        : {}),
      ...(typeof parsed.annotationRasterReady === 'boolean'
        ? { annotationRasterReady: parsed.annotationRasterReady }
        : {}),
      chrom: parsed.chrom,
      sourcePath: parsed.sourcePath,
      ...(typeof parsed.sourceSizeBytes === 'number'
        ? { sourceSizeBytes: parsed.sourceSizeBytes }
        : {}),
      ...(typeof parsed.sourceMtimeMs === 'number' ? { sourceMtimeMs: parsed.sourceMtimeMs } : {}),
      ...(typeof parsed.sourceCtimeMs === 'number' ? { sourceCtimeMs: parsed.sourceCtimeMs } : {}),
      sourceExt: parsed.sourceExt,
      indexedAt: parsed.indexedAt,
      ...(typeof parsed.schemaVersion === 'number' ? { schemaVersion: parsed.schemaVersion } : {}),
    };
  } catch {
    return null;
  }
}

async function writePersistedMetadata(
  path: string,
  metadata: PersistedIndexMetadata
): Promise<void> {
  try {
    await writeFile(path, JSON.stringify(metadata, null, 2), 'utf8');
  } catch {}
}

async function isInsidePreparedReferenceGeneration(startPath: string): Promise<boolean> {
  let directory = dirname(startPath);
  const seen = new Set<string>();
  while (!seen.has(directory)) {
    seen.add(directory);
    if (await exists(join(directory, PREPARED_REFERENCE_DEFINITION_FILE))) return true;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return false;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
