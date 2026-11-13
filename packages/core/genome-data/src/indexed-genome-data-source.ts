import { BgzipIndexedFasta, IndexedFasta } from '@gmod/indexedfasta';
import { TabixIndexedFile } from '@gmod/tabix';
import type { GenericFilehandle } from 'generic-filehandle2';

import { bgzipFastaGziPath, isBgzipFastaPath } from './fasta-paths';
import { parseGff3Line } from './gff3';
import { LruCache } from './lru';
import { collectCoordinateOrderedMatches, motifToRegex } from './search';
import { validateIupacSequencePayload } from './sequence-validation';
import type {
  FeatureDetails,
  FeatureDetailsRequest,
  GenomeDataRequestOptions,
  GenomeDataSource,
  GenomeFeature,
  IndexedGenomeManifest,
  IndexedGenomeDataSourceOptions,
  SearchHit,
  SearchOpts,
  ZoomLevel,
} from './types';

export function tabixReaderOptions(
  gffPath: string,
  indexPath: string
): { path: string; tbiPath?: string; csiPath?: string } {
  return indexPath.endsWith('.csi')
    ? { path: gffPath, csiPath: indexPath }
    : { path: gffPath, tbiPath: indexPath };
}

const DEFAULT_SEQUENCE_BLOCK_SIZE = 4 * 1024;
const DEFAULT_FEATURE_BUCKET_SIZE = 64 * 1024;
const DEFAULT_SEARCH_CHUNK_SIZE = 64 * 1024;
const DEFAULT_MAX_SEARCH_RESULTS = 10_000;
const DEFAULT_DETAILS_WINDOW_BP = 500_000;
const MAX_RETIRED_READER_GENERATIONS = 1;
const closedIndexedReaderResources = new WeakSet<object>();

interface NormalizedRange {
  start: number;
  end: number;
}

interface IndexedReaderOwners {
  fasta: IndexedFasta;
  tabix: TabixIndexedFile | null;
}

interface IndexedReaderGeneration extends IndexedReaderOwners {
  readonly fingerprint: string | null;
}

class IndexedReaderCloseError extends Error {
  constructor(
    message: string,
    readonly causes: readonly unknown[]
  ) {
    super(message);
    this.name = 'IndexedReaderCloseError';
  }
}

export class IndexedGenomeDataSource implements GenomeDataSource {
  private generation: IndexedReaderGeneration;
  private refreshPromise: Promise<void> | null = null;
  private readonly sequenceCache: LruCache<string, string>;
  private readonly featureCache: LruCache<string, GenomeFeature[]>;
  private readonly retiredReaders: IndexedReaderOwners[] = [];
  private activeOperations = 0;
  private closeRequested = false;
  private closePromise: Promise<void> | null = null;
  private retiredCleanup: Promise<void> = Promise.resolve();
  private readonly idleWaiters = new Set<() => void>();

  private readonly sequenceBlockSize: number;
  private readonly featureBucketSize: number;
  private readonly searchChunkSize: number;
  private readonly defaultMaxSearchResults: number;
  private readonly checkFileMtimeOnRead: boolean;
  private readonly openFile: ((path: string) => GenericFilehandle) | undefined;
  private readonly fingerprintFiles: (paths: readonly string[]) => Promise<string>;

  constructor(
    private readonly manifest: IndexedGenomeManifest,
    opts: IndexedGenomeDataSourceOptions = {}
  ) {
    this.openFile = opts.openFile;
    this.fingerprintFiles = opts.fingerprintFiles ?? unfingerprintedFiles;
    this.sequenceBlockSize = opts.sequenceBlockSize ?? DEFAULT_SEQUENCE_BLOCK_SIZE;
    this.featureBucketSize = opts.featureBucketSize ?? DEFAULT_FEATURE_BUCKET_SIZE;
    this.searchChunkSize = opts.searchChunkSize ?? DEFAULT_SEARCH_CHUNK_SIZE;
    this.defaultMaxSearchResults = opts.defaultMaxSearchResults ?? DEFAULT_MAX_SEARCH_RESULTS;
    this.checkFileMtimeOnRead = opts.checkFileMtimeOnRead ?? Boolean(opts.fingerprintFiles);
    this.sequenceCache = new LruCache(opts.sequenceCacheEntries ?? 1024);
    this.featureCache = new LruCache(opts.featureCacheEntries ?? 256);
    this.generation = {
      fasta: this.createFastaReader(),
      tabix: this.createTabixReader(),
      fingerprint: null,
    };
  }

  async getChromosomeLength(chrom: string): Promise<number> {
    this.beginOperation();
    try {
      await this.refreshIfStale();
      return await this.chromosomeLength(this.generation, chrom);
    } finally {
      await this.finishOperation();
    }
  }

  async getSequence(
    chrom: string,
    start: number,
    end: number,
    options: GenomeDataRequestOptions = {}
  ): Promise<string> {
    this.beginOperation();
    try {
      throwIfAborted(options.signal);
      await this.refreshIfStale();
      throwIfAborted(options.signal);
      const generation = this.generation;
      const length = await this.chromosomeLength(generation, chrom);
      throwIfAborted(options.signal);
      const range = normalizeRange(start, end, length);
      if (range.start === range.end) return '';

      const firstBlock = Math.floor(range.start / this.sequenceBlockSize);
      const lastBlock = Math.floor((range.end - 1) / this.sequenceBlockSize);
      const parts: string[] = [];

      const readBlock = async (block: number): Promise<string> => {
        throwIfAborted(options.signal);
        this.assertGeneration(generation);
        const blockStart = block * this.sequenceBlockSize;
        const blockEnd = Math.min(length, blockStart + this.sequenceBlockSize);
        const cacheKey = `${generation.fingerprint ?? 'unfingerprinted'}:${chrom}:${blockStart}:${blockEnd}`;
        let blockSeq = this.sequenceCache.get(cacheKey);
        if (blockSeq === undefined) {
          const fetched = await generation.fasta.getSequence(chrom, blockStart, blockEnd);
          this.assertGeneration(generation);
          if (fetched === undefined) {
            throw new Error(`Sequence range ${chrom}:${blockStart}-${blockEnd} not found`);
          }
          blockSeq = fetched.toUpperCase();
          this.sequenceCache.set(cacheKey, blockSeq);
        }
        throwIfAborted(options.signal);
        const sliceStart = Math.max(range.start, blockStart) - blockStart;
        const sliceEnd = Math.min(range.end, blockEnd) - blockStart;
        return blockSeq.slice(sliceStart, sliceEnd);
      };

      const batchSize = 4;
      for (let first = firstBlock; first <= lastBlock; first += batchSize) {
        throwIfAborted(options.signal);
        const blocks = await Promise.allSettled(
          Array.from({ length: Math.min(batchSize, lastBlock - first + 1) }, (_, index) =>
            readBlock(first + index)
          )
        );
        for (const block of blocks) {
          if (block.status === 'rejected') throw block.reason;
          parts.push(block.value);
        }
      }

      return parts.join('');
    } finally {
      await this.finishOperation();
    }
  }

  async getFeatures(
    chrom: string,
    start: number,
    end: number,
    zoomLevel: ZoomLevel,
    options: GenomeDataRequestOptions = {}
  ): Promise<GenomeFeature[]> {
    this.beginOperation();
    try {
      throwIfAborted(options.signal);
      await this.refreshIfStale();
      throwIfAborted(options.signal);
      const generation = this.generation;
      if (!generation.tabix) return [];
      const length = await this.chromosomeLength(generation, chrom);
      throwIfAborted(options.signal);
      const range = normalizeRange(start, end, length);
      if (range.start === range.end) return [];

      const firstBucket = Math.floor(range.start / this.featureBucketSize);
      const lastBucket = Math.floor((range.end - 1) / this.featureBucketSize);
      const bucketStart = firstBucket * this.featureBucketSize;
      const bucketEnd = Math.min(length, (lastBucket + 1) * this.featureBucketSize);
      const cacheKey = `${generation.fingerprint ?? 'unfingerprinted'}:${chrom}:${firstBucket}:${lastBucket}:${zoomLevel}`;

      let features = this.featureCache.get(cacheKey);
      if (features === undefined) {
        const queried: GenomeFeature[] = [];
        await generation.tabix.getLines(chrom, bucketStart, bucketEnd, {
          lineCallback: (line, fileOffset) => {
            throwIfAborted(options.signal);
            this.assertGeneration(generation);
            const parsed = parseGff3Line(line, fileOffset);
            if (parsed) queried.push(parsed);
          },
        });
        throwIfAborted(options.signal);
        this.assertGeneration(generation);
        features = queried;
        this.featureCache.set(cacheKey, features);
      }

      return features.filter((feature) => feature.end > range.start && feature.start < range.end);
    } finally {
      await this.finishOperation();
    }
  }

  async getFeatureDetails(
    request: FeatureDetailsRequest,
    options: GenomeDataRequestOptions = {}
  ): Promise<FeatureDetails> {
    this.beginOperation();
    try {
      throwIfAborted(options.signal);
      await this.refreshIfStale();
      const generation = this.generation;
      throwIfAborted(options.signal);
      if (!generation.tabix) {
        return emptyFeatureDetails(request, { start: 0, end: 0 }, false);
      }

      const length = await this.chromosomeLength(generation, request.chrom);
      throwIfAborted(options.signal);
      const range = normalizeRange(request.start, request.end, length);
      const maxWindowBp = Math.max(1, Math.trunc(request.maxWindowBp ?? DEFAULT_DETAILS_WINDOW_BP));
      const seedWindow = clampDetailsWindow(range, length, maxWindowBp);
      const seedFeatures = await this.getFeatures(
        request.chrom,
        seedWindow.start,
        seedWindow.end,
        1,
        {
          signal: options.signal,
        }
      );
      throwIfAborted(options.signal);
      this.assertGeneration(generation);
      const primary = pickPrimaryFeature(seedFeatures, request);

      if (!primary) {
        return {
          ...emptyFeatureDetails(request, seedWindow, seedWindow.truncated),
          relatedFeatures: sortAndDedupeFeatures(seedFeatures),
          sourceRecordCount: seedFeatures.length,
        };
      }

      const parentIds = new Set(parentIdsOf(primary));
      const primaryIds = new Set(featureIds(primary));
      const parents = seedFeatures.filter((feature) =>
        featureIds(feature).some((id) => parentIds.has(id))
      );
      const closureSpan = spanForFeatures([primary, ...parents]);
      const closureWindow = clampDetailsWindow(closureSpan, length, maxWindowBp);
      const closureFeatures =
        closureWindow.start === seedWindow.start && closureWindow.end === seedWindow.end
          ? seedFeatures
          : await this.getFeatures(request.chrom, closureWindow.start, closureWindow.end, 1, {
              signal: options.signal,
            });
      throwIfAborted(options.signal);
      this.assertGeneration(generation);
      const relatedFeatures = sortAndDedupeFeatures(
        closureFeatures.filter((feature) =>
          isRelatedFeature(feature, {
            primary,
            primaryIds,
            parentIds,
          })
        )
      );

      return {
        chrom: request.chrom,
        ...(request.featureId ? { featureId: request.featureId } : {}),
        feature: primary,
        relatedFeatures,
        sourceRecordCount: closureFeatures.length,
        window: {
          start: closureWindow.start,
          end: closureWindow.end,
        },
        truncated: seedWindow.truncated || closureWindow.truncated,
      };
    } finally {
      await this.finishOperation();
    }
  }

  async *searchSequence(
    chrom: string,
    motif: string,
    opts: SearchOpts = {}
  ): AsyncIterable<SearchHit> {
    this.beginOperation();
    try {
      await this.refreshIfStale();
      const generation = this.generation;
      const regex = motifToRegex(motif, opts.caseSensitive ?? false);
      if (!regex) return;

      const length = await this.chromosomeLength(generation, chrom);
      const range = normalizeRange(opts.start ?? 0, opts.end ?? length, length);
      if (range.start === range.end) return;

      const chunkSize = Math.max(1, Math.trunc(opts.chunkSize ?? this.searchChunkSize));
      const maxResults = opts.maxResults ?? this.defaultMaxSearchResults;
      if (maxResults <= 0) return;
      const overlap = Math.max(0, motif.length - 1);
      const reverseRegex = opts.reverseComplement
        ? motifToRegex(motif, opts.caseSensitive ?? false)
        : null;
      let emitted = 0;

      for (let pos = range.start; pos < range.end; pos += chunkSize) {
        throwIfAborted(opts.signal);
        const emitEnd = Math.min(range.end, pos + chunkSize);
        const readEnd = Math.min(range.end, emitEnd + overlap);
        const sequence = await this.getSequence(chrom, pos, readEnd, { signal: opts.signal });
        this.assertGeneration(generation);
        if (opts.validateIupacDna) {
          validateIupacSequencePayload(sequence, readEnd - pos);
        }
        const chunkHits =
          emitted < maxResults
            ? collectCoordinateOrderedMatches(
                sequence,
                regex,
                reverseRegex,
                chrom,
                pos,
                pos,
                emitEnd,
                motif
              )
            : [];

        for (const hit of chunkHits) {
          this.assertGeneration(generation);
          throwIfAborted(opts.signal);
          if (emitted >= maxResults) break;
          emitted += 1;
          yield hit;
        }
        if (emitted >= maxResults && !opts.validateIupacDna) return;
      }
    } finally {
      await this.finishOperation();
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closeRequested = true;
    this.sequenceCache.clear();
    this.featureCache.clear();
    const closeAttempt = (async () => {
      await this.waitForIdle();
      await this.drainRetiredReaders();
      await closeIndexedReaders({ fasta: this.generation.fasta, tabix: this.generation.tabix });
      await this.retiredCleanup;
    })();
    this.closePromise = closeAttempt;
    try {
      await closeAttempt;
    } catch (error) {
      if (this.closePromise === closeAttempt) this.closePromise = null;
      throw error;
    }
  }

  private async chromosomeLength(
    generation: IndexedReaderGeneration,
    chrom: string
  ): Promise<number> {
    this.assertGeneration(generation);
    const length = await generation.fasta.getSequenceSize(chrom);
    this.assertGeneration(generation);
    if (length === undefined)
      throw new Error(`Chromosome ${chrom} not found in ${this.manifest.fastaPath}`);
    return length;
  }

  private assertGeneration(generation: IndexedReaderGeneration): void {
    if (generation !== this.generation) {
      throw new Error(
        'Indexed genome reader generation changed during the request; retry the complete request.'
      );
    }
  }

  private createFastaReader(): IndexedFasta {
    const open = this.openFile;
    if (isBgzipFastaPath(this.manifest.fastaPath)) {
      const gziPath = this.manifest.gziPath ?? bgzipFastaGziPath(this.manifest.fastaPath);
      return new BgzipIndexedFasta(
        open
          ? {
              fasta: open(this.manifest.fastaPath),
              fai: open(this.manifest.faiPath),
              gzi: open(gziPath),
            }
          : { path: this.manifest.fastaPath, faiPath: this.manifest.faiPath, gziPath }
      );
    }
    return new IndexedFasta(
      open
        ? { fasta: open(this.manifest.fastaPath), fai: open(this.manifest.faiPath) }
        : { path: this.manifest.fastaPath, faiPath: this.manifest.faiPath }
    );
  }

  private createTabixReader(): TabixIndexedFile | null {
    if (!this.manifest.gffPath || !this.manifest.tbiPath) return null;
    const open = this.openFile;
    if (!open) {
      return new TabixIndexedFile(tabixReaderOptions(this.manifest.gffPath, this.manifest.tbiPath));
    }
    return new TabixIndexedFile(
      this.manifest.tbiPath.endsWith('.csi')
        ? { filehandle: open(this.manifest.gffPath), csiFilehandle: open(this.manifest.tbiPath) }
        : { filehandle: open(this.manifest.gffPath), tbiFilehandle: open(this.manifest.tbiPath) }
    );
  }

  private beginOperation(): void {
    if (this.closeRequested) {
      throw new Error('Indexed genome data source is closed.');
    }
    this.activeOperations += 1;
  }

  private async finishOperation(): Promise<void> {
    this.activeOperations -= 1;
    if (this.activeOperations !== 0) return;
    try {
      await this.drainRetiredReaders();
    } finally {
      for (const resolve of this.idleWaiters) resolve();
      this.idleWaiters.clear();
    }
  }

  private async waitForIdle(): Promise<void> {
    if (this.activeOperations === 0) return;
    await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
  }

  private async drainRetiredReaders(): Promise<void> {
    const retired = this.retiredReaders.splice(0);
    if (retired.length === 0) {
      await this.retiredCleanup;
      return;
    }
    this.retiredCleanup = this.retiredCleanup
      .catch(() => undefined)
      .then(async () => {
        const results = await Promise.allSettled(retired.map(closeIndexedReaders));
        const errors: unknown[] = [];
        results.forEach((result, index) => {
          if (result.status === 'fulfilled') return;
          const readers = retired[index];
          if (readers) this.retiredReaders.push(readers);
          errors.push(result.reason);
        });
        if (errors.length > 0) {
          throw new IndexedReaderCloseError(
            'Failed to close retired indexed genome readers.',
            errors
          );
        }
      });
    await this.retiredCleanup;
  }

  private async refreshIfStale(): Promise<void> {
    if (!this.checkFileMtimeOnRead) return;
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.refreshReadersIfStale().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async refreshReadersIfStale(): Promise<void> {
    const next = await this.fingerprintFiles(
      [
        this.manifest.fastaPath,
        this.manifest.faiPath,
        this.manifest.gziPath ??
          (isBgzipFastaPath(this.manifest.fastaPath)
            ? bgzipFastaGziPath(this.manifest.fastaPath)
            : undefined),
        this.manifest.gffPath ?? undefined,
        this.manifest.tbiPath ?? undefined,
      ].filter((path): path is string => Boolean(path))
    );
    if (this.generation.fingerprint === null) {
      this.generation = { ...this.generation, fingerprint: next };
      return;
    }
    if (next === this.generation.fingerprint) return;
    if (this.retiredReaders.length >= MAX_RETIRED_READER_GENERATIONS) {
      throw new Error(
        'Indexed genome files changed again while an older reader generation is still active; retry after active reads finish.'
      );
    }

    const replacement: IndexedReaderGeneration = {
      fasta: this.createFastaReader(),
      tabix: this.createTabixReader(),
      fingerprint: next,
    };
    this.retiredReaders.push(this.generation);
    this.generation = replacement;
    this.sequenceCache.clear();
    this.featureCache.clear();
  }
}

async function closeIndexedReaders(readers: IndexedReaderOwners): Promise<void> {
  const results = await Promise.allSettled([
    closeIndexedReaderResource(readers.fasta.fasta, () => readers.fasta.fasta.close?.()),
    closeIndexedReaderResource(readers.fasta.fai, () => readers.fasta.fai.close?.()),
    readers.tabix
      ? closeIndexedReaderResource(readers.tabix.cache, () => readers.tabix?.cache.clear())
      : Promise.resolve(),
  ]);
  const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
  if (errors.length > 0) {
    throw new IndexedReaderCloseError('Failed to close indexed genome readers.', errors);
  }
}

async function closeIndexedReaderResource(
  resource: object,
  close: () => Promise<unknown> | unknown
): Promise<void> {
  if (closedIndexedReaderResources.has(resource)) return;
  await close();
  closedIndexedReaderResources.add(resource);
}

function normalizeRange(start: number, end: number, length: number): NormalizedRange {
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new Error(`Range must be finite, got ${start}-${end}`);
  }
  const s = Math.trunc(start);
  const e = Math.trunc(end);
  if (s < 0 || e < 0 || e < s) {
    throw new Error(`Invalid 0-based half-open range ${start}-${end}`);
  }
  return {
    start: Math.min(s, length),
    end: Math.min(e, length),
  };
}

type DetailsWindow = NormalizedRange & { truncated: boolean };

function emptyFeatureDetails(
  request: FeatureDetailsRequest,
  window: NormalizedRange,
  truncated: boolean
): FeatureDetails {
  return {
    chrom: request.chrom,
    ...(request.featureId ? { featureId: request.featureId } : {}),
    feature: null,
    relatedFeatures: [],
    sourceRecordCount: 0,
    window,
    truncated,
  };
}

function clampDetailsWindow(
  range: NormalizedRange,
  length: number,
  maxWindowBp: number
): DetailsWindow {
  const span = Math.max(1, range.end - range.start);
  if (span >= maxWindowBp) {
    return {
      start: range.start,
      end: Math.min(length, range.start + maxWindowBp),
      truncated: range.start + maxWindowBp < range.end,
    };
  }
  const pad = Math.floor((maxWindowBp - span) / 2);
  return {
    start: Math.max(0, range.start - pad),
    end: Math.min(length, range.end + pad),
    truncated: false,
  };
}

function pickPrimaryFeature(
  features: GenomeFeature[],
  request: FeatureDetailsRequest
): GenomeFeature | null {
  if (request.featureId) {
    const byId = features.find((feature) => featureIds(feature).includes(request.featureId!));
    if (byId) return byId;
  }

  return (
    features.find((feature) => feature.start === request.start && feature.end === request.end) ??
    features.find((feature) => feature.start <= request.start && feature.end >= request.end) ??
    features.find((feature) => feature.end > request.start && feature.start < request.end) ??
    null
  );
}

function featureIds(feature: GenomeFeature): string[] {
  return [...(feature.attributes.ID ?? []), ...(feature.attributes.Name ?? [])].filter(Boolean);
}

function parentIdsOf(feature: GenomeFeature): string[] {
  return [...(feature.attributes.Parent ?? [])].filter(Boolean);
}

function spanForFeatures(features: GenomeFeature[]): NormalizedRange {
  const start = Math.min(...features.map((feature) => feature.start));
  const end = Math.max(...features.map((feature) => feature.end));
  return { start, end };
}

function isRelatedFeature(
  feature: GenomeFeature,
  input: {
    primary: GenomeFeature;
    primaryIds: Set<string>;
    parentIds: Set<string>;
  }
): boolean {
  if (feature === input.primary) return true;

  const ids = featureIds(feature);
  if (ids.some((id) => input.primaryIds.has(id) || input.parentIds.has(id))) return true;

  const parents = parentIdsOf(feature);
  return parents.some((id) => input.primaryIds.has(id) || input.parentIds.has(id));
}

function sortAndDedupeFeatures(features: GenomeFeature[]): GenomeFeature[] {
  const seen = new Set<string>();
  const out: GenomeFeature[] = [];
  for (const feature of [...features].sort(
    (a, b) => a.start - b.start || a.end - b.end || a.type.localeCompare(b.type)
  )) {
    const key = [
      feature.chrom,
      feature.start,
      feature.end,
      feature.type,
      featureIds(feature).join(','),
      parentIdsOf(feature).join(','),
    ].join(':');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(feature);
  }
  return out;
}

async function unfingerprintedFiles(paths: readonly string[]): Promise<string> {
  return paths.join('|');
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw new DOMException('Genome data request aborted', 'AbortError');
}
