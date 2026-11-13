import {
  isUcscTrackSource,
  type AdmittedTrackSource,
  type UcscTrackSource,
} from '@waypoint/genome-data';
import {
  maxLevelForAssembly,
  type AssemblySegment,
  type TileData,
  type TileFetchContext,
  type TileKey,
} from '@waypoint/genome-renderer';

import {
  fetchUcscTrackRegion,
  fetchUcscWholeTrack,
  UCSC_NATIVE_SNAPSHOT_MAX_ITEMS,
  type UcscRegionResponse,
} from './ucsc-track-client';
import { adaptUcscRecords } from './ucsc-track-mapping';
import { createBbiIntervalTileSource } from './bbi-interval-tile-source';
import { createBbiQuantitativeTileSource } from './bbi-quantitative-tile-source';
import { createTextIntervalTileSource } from './text-interval-tile-source';
import { createVariantTileSource } from './variant-tile-source';
import type { UcscRenderableRecord, UcscTilePayload, UcscTileSource } from './ucsc-tile-types';
import { trackTileErrorRetryable, trackTileErrorScope } from './track-tile-retryability';

export type { UcscRenderableRecord, UcscTilePayload, UcscTileSource } from './ucsc-tile-types';

const ESTIMATED_RECORD_BYTES = 192;

export interface SortedIntervalIndex<T extends { readonly start: number; readonly end: number }> {
  readonly records: ReadonlyArray<T>;
  readonly starts: ReadonlyArray<number>;
  readonly maxEndTree: ReadonlyArray<number>;
  readonly leafBase: number;
}

type UcscSparseSnapshot = ReadonlyMap<string, SortedIntervalIndex<UcscRenderableRecord>>;

export function createAdmittedTrackTileSource(input: {
  readonly assembly: import('@waypoint/genome-renderer').Assembly;
  readonly trackId: string;
  readonly source: AdmittedTrackSource;
}): UcscTileSource {
  const source = input.source;
  if (
    source.readerKind === 'bbi' &&
    source.formatId === 'bigwig' &&
    source.scientificKind === 'quantitative'
  ) {
    return createBbiQuantitativeTileSource({ ...input, source });
  }
  if (
    source.readerKind === 'bbi' &&
    source.formatId === 'bigbed' &&
    (source.scientificKind === 'transcript' ||
      source.scientificKind === 'interval' ||
      source.scientificKind === 'peak' ||
      source.scientificKind === 'repeat')
  ) {
    return createBbiIntervalTileSource({ ...input, source });
  }
  if (
    source.readerKind === 'interval-text' &&
    (source.scientificKind === 'transcript' ||
      source.scientificKind === 'interval' ||
      source.scientificKind === 'peak' ||
      source.scientificKind === 'repeat')
  ) {
    return createTextIntervalTileSource({ ...input, source });
  }
  if (
    source.readerKind === 'variant' &&
    source.scientificKind === 'variants' &&
    (source.formatId === 'vcf' || source.formatId === 'bcf')
  ) {
    return createVariantTileSource({ ...input, source });
  }
  if (!isUcscTrackSource(source)) {
    throw new Error(
      `No indexed tile reader is registered for ${source.provenance.provider ?? 'local'}:${source.readerKind}.`
    );
  }
  if (source.readerKind === 'ucsc-rest') return createUcscRestTileSource({ ...input, source });
  throw new Error(
    `No ${source.readerKind} reader is available for ${source.formatId}:${source.scientificKind}.`
  );
}

export function createUcscRestTileSource(input: {
  readonly assembly: import('@waypoint/genome-renderer').Assembly;
  readonly trackId: string;
  readonly source: UcscTrackSource;
  readonly fetchRegion?: typeof fetchUcscTrackRegion;
  readonly fetchWhole?: typeof fetchUcscWholeTrack;
}): UcscTileSource {
  const fetchRegion = input.fetchRegion ?? fetchUcscTrackRegion;
  const fetchWhole = input.fetchWhole ?? fetchUcscWholeTrack;
  const sourceAbort = new AbortController();
  let sparseSnapshotPromise: Promise<UcscSparseSnapshot> | null = null;

  const loadSparseSnapshot = (): Promise<UcscSparseSnapshot> => {
    if (sparseSnapshotPromise === null) {
      const pending = fetchWhole(
        {
          genome: input.source.provenance.ucscGenome,
          track: input.source.provenance.track,
          hubUrl: input.source.provenance.hubUrl,
          maxItemsOutput: UCSC_NATIVE_SNAPSHOT_MAX_ITEMS,
        },
        { signal: sourceAbort.signal }
      ).then((whole) => {
        if (!whole.complete) throw new Error(incompleteReason(whole));
        return adaptWholeSparseSnapshot(input.assembly, input.source, whole);
      });
      sparseSnapshotPromise = pending.catch((error: unknown) => {
        sparseSnapshotPromise = null;
        throw error;
      });
    }
    return sparseSnapshotPromise;
  };

  return {
    id: `ucsc-rest:${input.trackId}`,
    trackId: input.trackId,
    source: input.source,
    dispose: () => sourceAbort.abort(),
    levelRange: [0, maxLevelForAssembly(input.assembly)],
    async fetchTile(
      level: number,
      index: number,
      segments: AssemblySegment[],
      signal: AbortSignal,
      _context?: TileFetchContext
    ): Promise<TileData> {
      const key: TileKey = { sourceId: `ucsc-rest:${input.trackId}`, level, index };
      if (signal.aborted) throw abortError();

      let records: UcscRenderableRecord[];
      try {
        if (usesSourceWideSparseSnapshot(input.source)) {
          const snapshot = await awaitWithAbort(loadSparseSnapshot(), signal);
          records = recordsForSegments(snapshot, segments);
        } else if (coversCompleteAssembly(segments, input.assembly)) {
          const whole = await fetchWhole(
            {
              genome: input.source.provenance.ucscGenome,
              track: input.source.provenance.track,
              hubUrl: input.source.provenance.hubUrl,
            },
            { signal }
          );
          if (!whole.complete) throw new Error(incompleteReason(whole));
          records = adaptRegionalResponses(
            input.source,
            segments.map((segment) => ({
              response: {
                ...whole,
                records: whole.records.filter((record) => record.chrom === segment.chrom),
              },
              segment,
            }))
          );
        } else {
          const responses = await Promise.all(
            segments.map(async (segment) => {
              const response = await fetchRegion(
                {
                  genome: input.source.provenance.ucscGenome,
                  track: input.source.provenance.track,
                  chrom: segment.chrom,
                  start: segment.localStart,
                  end: segment.localEnd,
                  hubUrl: input.source.provenance.hubUrl,
                },
                { signal }
              );
              if (signal.aborted) throw abortError();
              return { response, segment };
            })
          );
          const incomplete = responses.find(({ response }) => !response.complete);
          if (incomplete) throw new Error(incompleteReason(incomplete.response));
          records = adaptRegionalResponses(input.source, responses);
        }
      } catch (error) {
        if (signal.aborted || (error as { name?: unknown } | null)?.name === 'AbortError') {
          throw abortError();
        }
        return {
          key,
          state: 'error',
          count: 0,
          byteSize: 0,
          errorReason: tileFetchErrorReason(error),
          errorRetryable: trackTileErrorRetryable(error),
          errorScope: trackTileErrorScope(error),
        };
      }
      if (signal.aborted) throw abortError();
      return {
        key,
        state: 'ready',
        count: records.length,
        byteSize: Math.max(64, records.length * ESTIMATED_RECORD_BYTES),
        payload: { records } satisfies UcscTilePayload,
      };
    },
  };
}

function usesSourceWideSparseSnapshot(source: UcscTrackSource): boolean {
  return (
    source.scientificKind === 'interval' ||
    source.scientificKind === 'peak' ||
    source.scientificKind === 'repeat'
  );
}

function coversCompleteAssembly(
  segments: ReadonlyArray<AssemblySegment>,
  assembly: import('@waypoint/genome-renderer').Assembly
): boolean {
  return (
    segments.length === assembly.chromosomes.length &&
    segments.every(
      (segment, index) =>
        segment.chrom === assembly.chromosomes[index]?.chromosome.id &&
        segment.localStart === 0 &&
        segment.localEnd === assembly.chromosomes[index]?.chromosome.length
    )
  );
}

function adaptWholeSparseSnapshot(
  assembly: import('@waypoint/genome-renderer').Assembly,
  source: UcscTrackSource,
  response: UcscRegionResponse
): UcscSparseSnapshot {
  const rawByChrom = new Map<string, Array<Record<string, unknown>>>();
  for (const record of response.records) {
    const chrom = record.chrom;
    if (typeof chrom !== 'string') continue;
    const current = rawByChrom.get(chrom);
    if (current) current.push(record);
    else rawByChrom.set(chrom, [record]);
  }
  const adaptedByChrom = new Map<string, SortedIntervalIndex<UcscRenderableRecord>>();
  for (const placement of assembly.chromosomes) {
    const chrom = placement.chromosome.id;
    const adapted = adaptUcscRecords(source.scientificKind, rawByChrom.get(chrom) ?? [], {
      chrom,
      localStart: 0,
      localEnd: placement.chromosome.length,
      globalStart: placement.globalStartBp,
    });
    adaptedByChrom.set(
      chrom,
      buildSortedIntervalIndex(adapted.records as ReadonlyArray<UcscRenderableRecord>)
    );
  }
  return adaptedByChrom;
}

function recordsForSegments(
  snapshot: UcscSparseSnapshot,
  segments: ReadonlyArray<AssemblySegment>
): UcscRenderableRecord[] {
  const records: UcscRenderableRecord[] = [];
  for (const segment of segments) {
    const globalStart = segment.globalStart + segment.localStart;
    const globalEnd = segment.globalStart + segment.localEnd;
    const index = snapshot.get(segment.chrom);
    if (index) records.push(...querySortedIntervalIndex(index, globalStart, globalEnd));
  }
  return records;
}

export function buildSortedIntervalIndex<
  T extends { readonly start: number; readonly end: number },
>(records: ReadonlyArray<T>): SortedIntervalIndex<T> {
  const sorted = [...records].sort(
    (left, right) => left.start - right.start || left.end - right.end
  );
  const starts = sorted.map((record) => record.start);
  let leafBase = 1;
  while (leafBase < sorted.length) leafBase *= 2;
  const maxEndTree = new Array<number>(leafBase * 2).fill(Number.NEGATIVE_INFINITY);
  for (let index = 0; index < sorted.length; index += 1) {
    maxEndTree[leafBase + index] = sorted[index].end;
  }
  for (let node = leafBase - 1; node > 0; node -= 1) {
    maxEndTree[node] = Math.max(maxEndTree[node * 2], maxEndTree[node * 2 + 1]);
  }
  return { records: sorted, starts, maxEndTree, leafBase };
}

export function querySortedIntervalIndex<
  T extends { readonly start: number; readonly end: number },
>(index: SortedIntervalIndex<T>, start: number, end: number): T[] {
  if (end <= start || index.records.length === 0) return [];

  let low = 0;
  let high = index.starts.length;
  while (low < high) {
    const midpoint = low + Math.floor((high - low) / 2);
    if (index.starts[midpoint] >= end) high = midpoint;
    else low = midpoint + 1;
  }
  const rightExclusive = low;

  const matches: T[] = [];
  const stack: Array<{ node: number; left: number; right: number }> = [
    { node: 1, left: 0, right: index.leafBase },
  ];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (
      current.left >= rightExclusive ||
      current.left >= index.records.length ||
      index.maxEndTree[current.node] <= start
    ) {
      continue;
    }
    if (current.right - current.left === 1) {
      matches.push(index.records[current.left]);
      continue;
    }
    const midpoint = current.left + Math.floor((current.right - current.left) / 2);
    stack.push({ node: current.node * 2 + 1, left: midpoint, right: current.right });
    stack.push({ node: current.node * 2, left: current.left, right: midpoint });
  }
  return matches;
}

function adaptRegionalResponses(
  source: UcscTrackSource,
  responses: ReadonlyArray<{
    readonly response: UcscRegionResponse;
    readonly segment: AssemblySegment;
  }>
): UcscRenderableRecord[] {
  const records: UcscRenderableRecord[] = [];
  for (const { response, segment } of responses) {
    const adapted = adaptUcscRecords(source.scientificKind, response.records, {
      chrom: segment.chrom,
      localStart: segment.localStart,
      localEnd: segment.localEnd,
      globalStart: segment.globalStart,
    });
    records.push(...(adapted.records as ReadonlyArray<UcscRenderableRecord>));
  }
  return records;
}

function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(abortError());
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      }
    );
  });
}

export function isUcscTilePayload(value: unknown): value is UcscTilePayload {
  return (
    value !== null &&
    typeof value === 'object' &&
    Array.isArray((value as { records?: unknown }).records)
  );
}

function incompleteReason(response: UcscRegionResponse): string {
  return `upstream-truncated:${response.itemsReturned}/${response.maxItemsOutput}`;
}

function abortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

function tileFetchErrorReason(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return 'UCSC tile request failed.';
}
