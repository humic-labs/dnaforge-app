import { collectCoordinateOrderedMatches, motifToRegex } from './search';
import { validateIupacSequencePayload } from './sequence-validation';
import type {
  FeatureDetails,
  FeatureDetailsRequest,
  GenomeDataRequestOptions,
  GenomeDataSource,
  GenomeFeature,
  SearchHit,
  SearchOpts,
  ZoomLevel,
} from './types';

const DEFAULT_SEARCH_CHUNK_SIZE = 64 * 1024;
const DEFAULT_MAX_SEARCH_RESULTS = 10_000;

export interface InMemoryGenomeManifest {
  chrom: string;
  sequence: string;
  features: GenomeFeature[];
  circular?: boolean;
}

export interface InMemoryGenomeDataSourceOptions {
  searchChunkSize?: number;
  defaultMaxSearchResults?: number;
}

export class InMemoryGenomeDataSource implements GenomeDataSource {
  private readonly chrom: string;
  private readonly sequence: string;
  private readonly features: GenomeFeature[];
  private readonly searchChunkSize: number;
  private readonly defaultMaxSearchResults: number;

  constructor(manifest: InMemoryGenomeManifest, opts: InMemoryGenomeDataSourceOptions = {}) {
    this.chrom = manifest.chrom;
    this.sequence = manifest.sequence.toUpperCase();
    this.features = manifest.features.filter((feature) => feature.chrom === manifest.chrom);
    this.searchChunkSize = opts.searchChunkSize ?? DEFAULT_SEARCH_CHUNK_SIZE;
    this.defaultMaxSearchResults = opts.defaultMaxSearchResults ?? DEFAULT_MAX_SEARCH_RESULTS;
  }

  async getChromosomeLength(chrom: string): Promise<number> {
    this.assertChrom(chrom);
    return this.sequence.length;
  }

  async getSequence(
    chrom: string,
    start: number,
    end: number,
    options: GenomeDataRequestOptions = {}
  ): Promise<string> {
    throwIfAborted(options.signal);
    this.assertChrom(chrom);
    const range = normalizeRange(start, end, this.sequence.length);
    throwIfAborted(options.signal);
    return this.sequence.slice(range.start, range.end);
  }

  async getFeatures(
    chrom: string,
    start: number,
    end: number,
    _zoomLevel: ZoomLevel,
    options: GenomeDataRequestOptions = {}
  ): Promise<GenomeFeature[]> {
    throwIfAborted(options.signal);
    this.assertChrom(chrom);
    const range = normalizeRange(start, end, this.sequence.length);
    if (range.start === range.end) return [];
    throwIfAborted(options.signal);
    return this.features.filter(
      (feature) => feature.end > range.start && feature.start < range.end
    );
  }

  async getFeatureDetails(
    request: FeatureDetailsRequest,
    options: GenomeDataRequestOptions = {}
  ): Promise<FeatureDetails> {
    throwIfAborted(options.signal);
    this.assertChrom(request.chrom);
    const range = normalizeRange(request.start, request.end, this.sequence.length);
    const seedFeatures = this.features.filter(
      (feature) => feature.end > range.start && feature.start < range.end
    );
    const featureId = request.featureId;
    const primary = featureId
      ? (this.features.find((feature) => featureIds(feature).includes(featureId)) ?? null)
      : (seedFeatures[0] ?? null);
    const transcriptIds = new Set<string>();
    if (primary?.type.toUpperCase() === 'CDS') {
      for (const parentId of primary.attributes.Parent ?? []) transcriptIds.add(parentId);
    } else if (primary) {
      for (const id of featureIds(primary)) transcriptIds.add(id);
    } else if (featureId) {
      transcriptIds.add(featureId);
    }
    const relatedFeatures = this.features.filter((feature) => {
      if (feature === primary) return true;
      if (featureId && featureIds(feature).includes(featureId)) return true;
      return (
        featureIds(feature).some((id) => transcriptIds.has(id)) ||
        (feature.attributes.Parent ?? []).some((id) => transcriptIds.has(id))
      );
    });
    const closureStart = relatedFeatures.length
      ? Math.min(...relatedFeatures.map((feature) => feature.start))
      : range.start;
    const closureEnd = relatedFeatures.length
      ? Math.max(...relatedFeatures.map((feature) => feature.end))
      : range.end;
    const maxWindowBp = Math.max(1, Math.trunc(request.maxWindowBp ?? this.sequence.length));
    throwIfAborted(options.signal);
    return {
      chrom: request.chrom,
      ...(featureId ? { featureId } : {}),
      feature: primary,
      relatedFeatures,
      sourceRecordCount: relatedFeatures.length,
      window: { start: closureStart, end: closureEnd },
      truncated: closureEnd - closureStart > maxWindowBp,
    };
  }

  async *searchSequence(
    chrom: string,
    motif: string,
    opts: SearchOpts = {}
  ): AsyncIterable<SearchHit> {
    this.assertChrom(chrom);
    const regex = motifToRegex(motif, opts.caseSensitive ?? false);
    if (!regex) return;

    const length = this.sequence.length;
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
      const window = this.sequence.slice(pos, readEnd);
      if (opts.validateIupacDna) {
        validateIupacSequencePayload(window, readEnd - pos);
      }
      const chunkHits =
        emitted < maxResults
          ? collectCoordinateOrderedMatches(
              window,
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
        throwIfAborted(opts.signal);
        if (emitted >= maxResults) break;
        emitted += 1;
        yield hit;
      }
      if (emitted >= maxResults && !opts.validateIupacDna) return;
    }
  }

  private assertChrom(chrom: string): void {
    if (chrom !== this.chrom) {
      throw new Error(
        `InMemoryGenomeDataSource: chromosome ${chrom} not found (this source owns ${this.chrom})`
      );
    }
  }
}

function featureIds(feature: GenomeFeature): string[] {
  return [...(feature.attributes.ID ?? []), ...(feature.attributes.Name ?? [])].filter(Boolean);
}

function normalizeRange(
  start: number,
  end: number,
  length: number
): { start: number; end: number } {
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

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw new DOMException('Genome data request aborted', 'AbortError');
}
