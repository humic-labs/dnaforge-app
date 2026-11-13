import {
  InvalidGenomeSequenceError,
  ReferenceIntervalSourceUnavailableError,
  type FeatureDetails,
  type FeatureDetailsRequest,
  type GenomeDataSource,
  type GenomeFeature,
  type IndexedGenomeManifest,
  type SearchHit,
  type SearchOpts,
} from '@waypoint/genome-data';
import { platform } from '../platform';
import {
  INDEXED_GENOME_INVALID_SEQUENCE_ERROR_CODE,
  INDEXED_GENOME_SOURCE_UNAVAILABLE_ERROR_CODE,
} from './indexed-genome';

interface AdmittedIndexedGenomeManifest {
  chrom: string;
  fastaPath: string;
  faiPath: string;
  gffPath?: string;
  tbiPath?: string;
  workspaceRootPaths: string[];
}

export function createPlatformIndexedGenomeDataSource(
  manifest: IndexedGenomeManifest,
  admittedWorkspaceRootPaths: readonly string[] = []
): GenomeDataSource {
  const workspaceRootPaths = [
    ...new Set([...(manifest.workspaceRootPaths ?? []), ...admittedWorkspaceRootPaths]),
  ];
  return new PlatformIndexedGenomeDataSource({
    chrom: manifest.chrom,
    fastaPath: manifest.fastaPath,
    faiPath: manifest.faiPath,
    ...(manifest.gffPath ? { gffPath: manifest.gffPath } : {}),
    ...(manifest.tbiPath ? { tbiPath: manifest.tbiPath } : {}),
    workspaceRootPaths,
  });
}

class PlatformIndexedGenomeDataSource implements GenomeDataSource {
  constructor(private readonly manifest: AdmittedIndexedGenomeManifest) {}

  private manifestFor(chrom: string): AdmittedIndexedGenomeManifest {
    return { ...this.manifest, chrom };
  }

  async getChromosomeLength(chrom: string): Promise<number> {
    const result = await readIndexedSource(() => platform().genome.init(this.manifestFor(chrom)));
    return result.length;
  }

  async getSequence(
    chrom: string,
    start: number,
    end: number,
    options?: { signal?: AbortSignal }
  ): Promise<string> {
    throwIfAborted(options?.signal);
    const sequence = await readIndexedSource(() =>
      platform().genome.getSequence(this.manifestFor(chrom), chrom, start, end)
    );
    throwIfAborted(options?.signal);
    return sequence;
  }

  async getFeatures(
    chrom: string,
    start: number,
    end: number,
    zoomLevel: number,
    options?: { signal?: AbortSignal }
  ): Promise<GenomeFeature[]> {
    throwIfAborted(options?.signal);
    const features = await readIndexedSource(() =>
      platform().genome.getFeatures(this.manifestFor(chrom), chrom, start, end, zoomLevel)
    );
    throwIfAborted(options?.signal);
    return features;
  }

  async getFeatureDetails(
    request: FeatureDetailsRequest,
    options?: { signal?: AbortSignal }
  ): Promise<FeatureDetails> {
    throwIfAborted(options?.signal);
    const details = await readIndexedSource(() =>
      platform().genome.getFeatureDetailsByManifest(this.manifestFor(request.chrom), request)
    );
    throwIfAborted(options?.signal);
    return details;
  }

  async *searchSequence(
    chrom: string,
    motif: string,
    opts: SearchOpts = {}
  ): AsyncIterable<SearchHit> {
    throwIfAborted(opts.signal);
    const requestId = allocateSearchRequestId();
    const control = {
      clientId: `inspect_reference_interval:${requestId}`,
      requestId,
      ...(opts.signal ? { signal: opts.signal } : {}),
    };
    const { signal: _signal, ...searchOpts } = opts;
    const hits = await readIndexedSource(() =>
      platform().genome.searchSequence(
        this.manifestFor(chrom),
        chrom,
        motif,
        { ...searchOpts, maxResults: opts.maxResults ?? 500 },
        control
      )
    );
    throwIfAborted(opts.signal);
    for (const hit of hits) {
      throwIfAborted(opts.signal);
      yield hit;
    }
  }
}

async function readIndexedSource<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (isIndexedSourceUnavailable(error)) throw new ReferenceIntervalSourceUnavailableError();
    if (isInvalidIndexedSequence(error)) {
      throw new InvalidGenomeSequenceError(
        'Indexed source returned characters outside the IUPAC nucleotide alphabet.'
      );
    }
    throw error;
  }
}

function isInvalidIndexedSequence(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(INDEXED_GENOME_INVALID_SEQUENCE_ERROR_CODE);
}

export function isIndexedSourceUnavailable(error: unknown): boolean {
  const code =
    error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'EPERM'].includes(code)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes(INDEXED_GENOME_SOURCE_UNAVAILABLE_ERROR_CODE) ||
    /\bENOENT\b|no such file or directory|indexed genome file missing/i.test(message)
  );
}

let fallbackSearchRequestSequence = 0;

function allocateSearchRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  fallbackSearchRequestSequence += 1;
  return `inspect-reference-interval-${Date.now()}-${fallbackSearchRequestSequence}`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw new DOMException('Genome data request aborted', 'AbortError');
}
