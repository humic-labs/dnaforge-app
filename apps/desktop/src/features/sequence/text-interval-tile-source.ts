import type {
  AdmittedTrackSource,
  AnnotationRecord,
  PeakRecord,
  RepeatRecord,
  TextIntervalDensityBin,
  TextIntervalRecord,
  TextIntervalRegionQueryResult,
  TranscriptRecord,
} from '@waypoint/genome-data';
import {
  maxLevelForAssembly,
  type Assembly,
  type AssemblySegment,
  type TileData,
  type TileFetchContext,
  type TileKey,
} from '@waypoint/genome-renderer';

import { getTextIntervalReaderWorkerClient } from './text-interval-reader-runtime';
import type { TextIntervalReaderWorkerClient } from './text-interval-reader-worker-client';
import {
  createTextIntervalSourceSession,
  type TextIntervalSourceSession,
} from './text-interval-source-session';
import type { UcscRenderableRecord, UcscTilePayload, UcscTileSource } from './ucsc-tile-types';
import { trackTileErrorRetryable, trackTileErrorScope } from './track-tile-retryability';

const MAX_EXACT_RECORDS = 20_000;
const MAX_EXACT_OVERLAP = 32;
const DENSITY_BIN_COUNT = 256;
const MAX_DENSITY_ROWS = 8;
const ESTIMATED_INTERVAL_RECORD_BYTES = 256;

export function createTextIntervalTileSource(input: {
  readonly assembly: Assembly;
  readonly trackId: string;
  readonly source: AdmittedTrackSource;
  readonly session?: TextIntervalSourceSession;
  readonly query?: TextIntervalReaderWorkerClient['query'];
}): UcscTileSource {
  const scientificKind = requireTextIntervalScientificKind(input.source);
  const reader = input.session && input.query ? null : getTextIntervalReaderWorkerClient();
  const query = input.query ?? reader?.query.bind(reader);
  if (!query) throw new Error('The text interval tile source has no regional query reader.');
  const session =
    input.session ??
    createTextIntervalSourceSession({
      assembly: input.assembly,
      source: input.source,
      ...(reader ? { reader } : {}),
    });
  const runtimeSourceId = `interval-text:${input.trackId}\u0000${input.source.fingerprint}`;

  return {
    id: runtimeSourceId,
    trackId: input.trackId,
    source: input.source,
    levelRange: [0, maxLevelForAssembly(input.assembly)],
    async fetchTile(
      level: number,
      index: number,
      segments: AssemblySegment[],
      signal: AbortSignal,
      _context?: TileFetchContext
    ): Promise<TileData> {
      const key: TileKey = { sourceId: runtimeSourceId, level, index };
      if (signal.aborted) throw abortError();
      try {
        const querySegments = segments.flatMap((segment) => {
          const refName = input.source.referenceReceipt.contigMap[segment.chrom];
          return refName
            ? [
                {
                  segment,
                  region: { refName, start: segment.localStart, end: segment.localEnd },
                },
              ]
            : [];
        });
        const results = await session.execute(signal, ({ sourceKey }) =>
          query(
            sourceKey,
            querySegments.map((entry) => entry.region),
            {
              maxRecords: MAX_EXACT_RECORDS,
              maxOverlap: MAX_EXACT_OVERLAP,
              densityBinCount: DENSITY_BIN_COUNT,
            },
            signal
          )
        );
        if (signal.aborted) throw abortError();
        const records = querySegments.flatMap((entry, regionIndex) =>
          materializeRegionResult(
            results[regionIndex] ?? { kind: 'records', records: [], totalRecords: 0 },
            entry.segment,
            scientificKind
          )
        );
        records.sort((left, right) => left.start - right.start || left.end - right.end);
        return {
          key,
          state: 'ready',
          count: records.length,
          byteSize: Math.max(64, records.length * ESTIMATED_INTERVAL_RECORD_BYTES),
          payload: { records } satisfies UcscTilePayload,
        };
      } catch (error) {
        if (signal.aborted || (error as { name?: unknown } | null)?.name === 'AbortError') {
          throw abortError();
        }
        return {
          key,
          state: 'error',
          count: 0,
          byteSize: 0,
          errorReason: error instanceof Error ? error.message : String(error),
          errorRetryable: trackTileErrorRetryable(error),
          errorScope: trackTileErrorScope(error),
        };
      }
    },
    dispose: () => session.dispose(),
  };
}

function materializeRegionResult(
  result: TextIntervalRegionQueryResult,
  segment: AssemblySegment,
  scientificKind: 'transcript' | 'interval' | 'peak' | 'repeat'
): UcscRenderableRecord[] {
  if (result.kind === 'records') {
    return result.records.map((record) => globalizeRecord(record, segment));
  }
  return materializeDensity(result.bins, result.totalRecords, segment, scientificKind);
}

function globalizeRecord(
  record: TextIntervalRecord,
  segment: AssemblySegment
): UcscRenderableRecord {
  const offset = segment.globalStart;
  if ('transcriptId' in record) {
    return {
      ...record,
      chrom: segment.chrom,
      start: record.start + offset,
      end: record.end + offset,
      exons: record.exons.map((part) => ({ start: part.start + offset, end: part.end + offset })),
      cds: record.cds.map((part) => ({
        ...part,
        start: part.start + offset,
        end: part.end + offset,
      })),
    };
  }
  return {
    ...record,
    chrom: segment.chrom,
    start: record.start + offset,
    end: record.end + offset,
    ...('summit' in record && record.summit !== undefined
      ? { summit: record.summit + offset }
      : {}),
  };
}

function materializeDensity(
  bins: ReadonlyArray<TextIntervalDensityBin>,
  totalRecords: number,
  segment: AssemblySegment,
  scientificKind: 'transcript' | 'interval' | 'peak' | 'repeat'
): UcscRenderableRecord[] {
  const maxCount = Math.max(0, ...bins.map((bin) => bin.count));
  if (maxCount === 0) return [];
  return bins.flatMap((bin, binIndex) => {
    if (bin.count === 0) return [];
    const rows = Math.max(
      1,
      Math.min(
        MAX_DENSITY_ROWS,
        Math.ceil((Math.log2(bin.count + 1) / Math.log2(maxCount + 1)) * MAX_DENSITY_ROWS)
      )
    );
    return Array.from({ length: rows }, (_, rowIndex) =>
      densityRecord(scientificKind, bin, binIndex, rowIndex, totalRecords, maxCount, segment)
    );
  });
}

function densityRecord(
  scientificKind: 'transcript' | 'interval' | 'peak' | 'repeat',
  bin: TextIntervalDensityBin,
  binIndex: number,
  rowIndex: number,
  totalRecords: number,
  maxCount: number,
  segment: AssemblySegment
): UcscRenderableRecord {
  const start = segment.globalStart + bin.start;
  const end = segment.globalStart + bin.end;
  const density = { count: bin.count, totalRecords, maxCount };
  const identity = `${segment.chrom}:${bin.start}-${bin.end}:${binIndex}:${rowIndex}`;
  if (scientificKind === 'transcript') {
    return {
      chrom: segment.chrom,
      start,
      end,
      transcriptId: `density:${identity}`,
      strand: '+',
      transcriptType: 'density',
      exons: [{ start, end }],
      cds: [],
      extra: { dnaforgeDensity: density },
    } satisfies TranscriptRecord;
  }
  const base: AnnotationRecord = {
    chrom: segment.chrom,
    start,
    end,
    name: `Density ${bin.count} (${identity})`,
    color: densityColor(bin.count, maxCount),
    extra: { dnaforgeDensity: density },
  };
  if (scientificKind === 'peak') {
    return {
      ...base,
      score: Math.round((bin.count / maxCount) * 1_000),
      signalValue: bin.count,
    } satisfies PeakRecord;
  }
  if (scientificKind === 'repeat') return base satisfies RepeatRecord;
  return base;
}

function densityColor(count: number, maxCount: number): number {
  const intensity = maxCount <= 1 ? 1 : Math.log2(count + 1) / Math.log2(maxCount + 1);
  const light = [0xbf, 0xdb, 0xfe];
  const dark = [0x1d, 0x4e, 0xd8];
  const channel = (index: number) =>
    Math.round(light[index] + (dark[index] - light[index]) * intensity);
  return (channel(0) << 16) | (channel(1) << 8) | channel(2);
}

function requireTextIntervalScientificKind(
  source: AdmittedTrackSource
): 'transcript' | 'interval' | 'peak' | 'repeat' {
  if (source.readerKind !== 'interval-text') {
    throw new Error('The text interval tile source requires an interval-text reader.');
  }
  if (
    source.scientificKind === 'transcript' ||
    source.scientificKind === 'interval' ||
    source.scientificKind === 'peak' ||
    source.scientificKind === 'repeat'
  ) {
    return source.scientificKind;
  }
  throw new Error(`Text interval scientific kind ${source.scientificKind} is not renderable.`);
}

function abortError(): Error {
  const error = new Error('Text interval tile request cancelled.');
  error.name = 'AbortError';
  return error;
}
