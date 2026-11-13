import type { GenomeDataSource, SearchHit } from '@waypoint/genome-data';

import type {
  AssemblySequenceSearchChromosomeV1,
  AssemblySequenceSearchHitV1,
  AssemblySequenceSearchRequestV1,
  AssemblySequenceSearchResultV1,
} from '../../shared/indexed-genome';

export const ASSEMBLY_SEQUENCE_SEARCH_MAX_CONCURRENCY = 4;

interface AssemblySequenceSearchDeps {
  withSource?<Result>(
    chromosome: AssemblySequenceSearchChromosomeV1,
    use: (source: Pick<GenomeDataSource, 'searchSequence'>) => Promise<Result>
  ): Promise<Result>;
  getSource?(
    chromosome: AssemblySequenceSearchChromosomeV1
  ): Promise<Pick<GenomeDataSource, 'searchSequence' | 'close'>>;
  signal?: AbortSignal;
  concurrency?: number;
}

interface ChromosomePlacement {
  chromosome: AssemblySequenceSearchChromosomeV1;
  globalStartBp: number;
}

export async function searchAssemblySequence(
  request: AssemblySequenceSearchRequestV1,
  deps: AssemblySequenceSearchDeps
): Promise<AssemblySequenceSearchResultV1> {
  throwIfAborted(deps.signal);
  const placements = derivePlacements(request.source.chromosomes);
  const requestedConcurrency =
    deps.concurrency === undefined || !Number.isFinite(deps.concurrency)
      ? ASSEMBLY_SEQUENCE_SEARCH_MAX_CONCURRENCY
      : Math.trunc(deps.concurrency);
  const concurrency = Math.max(
    1,
    Math.min(ASSEMBLY_SEQUENCE_SEARCH_MAX_CONCURRENCY, requestedConcurrency)
  );
  const collected: AssemblySequenceSearchHitV1[] = [];
  const workController = new AbortController();
  const relayCancellation = () => workController.abort(deps.signal?.reason);
  deps.signal?.addEventListener('abort', relayCancellation, { once: true });

  try {
    for (let batchStart = 0; batchStart < placements.length; batchStart += concurrency) {
      throwIfAborted(workController.signal);
      const batch = placements.slice(batchStart, batchStart + concurrency);
      const perChromosomeLimit =
        collected.length >= request.limit ? 1 : request.limit - collected.length + 1;
      const batchTasks = batch.map((placement) =>
        searchChromosome(placement, request, perChromosomeLimit, {
          ...deps,
          signal: workController.signal,
        })
      );
      let batchHits: AssemblySequenceSearchHitV1[][];
      try {
        batchHits = await Promise.all(batchTasks);
      } catch (error) {
        if (!workController.signal.aborted) workController.abort(error);
        await Promise.allSettled(batchTasks);
        throw error;
      }
      throwIfAborted(workController.signal);

      for (const hits of batchHits) {
        collected.push(...hits);
        if (collected.length > request.limit) {
          return {
            hits: collected.slice(0, request.limit),
            truncated: true,
          };
        }
      }
    }

    return { hits: collected, truncated: false };
  } finally {
    deps.signal?.removeEventListener('abort', relayCancellation);
  }
}

function derivePlacements(
  chromosomes: ReadonlyArray<AssemblySequenceSearchChromosomeV1>
): ChromosomePlacement[] {
  let globalStartBp = 0;
  return chromosomes.map((chromosome) => {
    if (!Number.isSafeInteger(chromosome.length) || chromosome.length <= 0) {
      throw new Error(`Assembly sequence search rejected invalid length for ${chromosome.chrom}.`);
    }
    const placement = { chromosome, globalStartBp };
    globalStartBp += chromosome.length;
    if (!Number.isSafeInteger(globalStartBp)) {
      throw new Error('Assembly sequence search rejected an unsafe global axis length.');
    }
    return placement;
  });
}

async function searchChromosome(
  placement: ChromosomePlacement,
  request: AssemblySequenceSearchRequestV1,
  maxResults: number,
  deps: AssemblySequenceSearchDeps
): Promise<AssemblySequenceSearchHitV1[]> {
  throwIfAborted(deps.signal);
  const { chromosome, globalStartBp } = placement;
  const searchSource = async (
    source: Pick<GenomeDataSource, 'searchSequence'>
  ): Promise<AssemblySequenceSearchHitV1[]> => {
    throwIfAborted(deps.signal);
    const localHits: SearchHit[] = [];
    for await (const hit of source.searchSequence(chromosome.chrom, request.motif, {
      maxResults,
      reverseComplement: request.reverseComplement,
      caseSensitive: request.caseSensitive,
      signal: deps.signal,
    })) {
      throwIfAborted(deps.signal);
      assertLocalHit(hit, chromosome);
      localHits.push(hit);
    }

    localHits.sort(
      (left, right) =>
        left.start - right.start ||
        left.end - right.end ||
        strandOrder(left.strand) - strandOrder(right.strand)
    );
    const uniqueLocalHits = localHits.filter((hit, index) => {
      const previous = localHits[index - 1];
      return !previous || previous.start !== hit.start || previous.end !== hit.end;
    });
    return uniqueLocalHits.map((hit) => ({
      chrom: chromosome.chrom,
      localStartBp: hit.start,
      localEndBp: hit.end,
      globalStartBp: globalStartBp + hit.start,
      globalEndBp: globalStartBp + hit.end,
      strand: hit.strand,
      motif: request.motif,
    }));
  };
  if (deps.withSource) return deps.withSource(chromosome, searchSource);
  if (!deps.getSource) throw new Error('Assembly sequence search source owner is required.');
  const source = await deps.getSource(chromosome);
  try {
    return await searchSource(source);
  } finally {
    await source.close?.();
  }
}

function assertLocalHit(hit: SearchHit, chromosome: AssemblySequenceSearchChromosomeV1): void {
  if (
    hit.chrom !== chromosome.chrom ||
    !Number.isSafeInteger(hit.start) ||
    !Number.isSafeInteger(hit.end) ||
    hit.start < 0 ||
    hit.end <= hit.start ||
    hit.end > chromosome.length
  ) {
    throw new Error(`Assembly sequence search received an invalid hit for ${chromosome.chrom}.`);
  }
}

function strandOrder(strand: SearchHit['strand']): number {
  return strand === 'forward' ? 0 : 1;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error('Assembly sequence search was cancelled.');
  error.name = 'AbortError';
  throw error;
}
