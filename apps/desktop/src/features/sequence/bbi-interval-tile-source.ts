import {
  adaptBigBedFeatures,
  type AdmittedTrackSource,
  type BigBedScientificKind,
} from '@waypoint/genome-data';
import {
  maxLevelForAssembly,
  type Assembly,
  type AssemblySegment,
  type TileData,
  type TileFetchContext,
  type TileKey,
} from '@waypoint/genome-renderer';

import { getBbiReaderWorkerClient } from './bbi-reader-runtime';
import type { BbiReaderWorkerClient } from './bbi-reader-worker-client';
import { bbiAbortError, createBbiSourceSession, type BbiSessionReader } from './bbi-source-session';
import { admitIndexedTrack } from './indexed-track-client';
import { admitUcscTrack } from './ucsc-track-client';
import type { UcscRenderableRecord, UcscTilePayload, UcscTileSource } from './ucsc-tile-types';
import { trackTileErrorRetryable, trackTileErrorScope } from './track-tile-retryability';

const ESTIMATED_INTERVAL_RECORD_BYTES = 256;

interface IntervalBbiReader extends BbiSessionReader {
  queryIntervals: BbiReaderWorkerClient['queryIntervals'];
}

export function createBbiIntervalTileSource(input: {
  readonly assembly: Assembly;
  readonly trackId: string;
  readonly source: AdmittedTrackSource;
  readonly reader?: IntervalBbiReader;
  readonly admit?: typeof admitUcscTrack;
  readonly admitIndexed?: typeof admitIndexedTrack;
}): UcscTileSource {
  const scientificKind = requireBigBedScientificKind(input.source);
  const reader = input.reader ?? getBbiReaderWorkerClient();
  const runtimeSourceId = `bbi:${input.trackId}\u0000${input.source.fingerprint}`;
  const session = createBbiSourceSession({
    assembly: input.assembly,
    source: input.source,
    format: 'bigbed',
    reader,
    admit: input.admit,
    admitIndexed: input.admitIndexed,
  });

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
      if (signal.aborted) throw bbiAbortError();
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
        const regions = querySegments.map((entry) => entry.region);
        const { decoded, autoSql } = await session.execute(
          signal,
          async ({ sourceKey, header }) => ({
            decoded: await reader.queryIntervals(sourceKey, regions, signal),
            autoSql: header.autoSql,
          })
        );
        if (signal.aborted) throw bbiAbortError();

        const records: UcscRenderableRecord[] = [];
        for (let regionIndex = 0; regionIndex < querySegments.length; regionIndex += 1) {
          const segment = querySegments[regionIndex].segment;
          const features = decoded[regionIndex] ?? [];
          const adapted = adaptBigBedFeatures(
            scientificKind,
            features,
            {
              chrom: segment.chrom,
              localStart: segment.localStart,
              localEnd: segment.localEnd,
              globalStart: segment.globalStart,
            },
            { autoSql }
          );
          records.push(...adapted.records);
        }
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
          throw bbiAbortError();
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

function requireBigBedScientificKind(source: AdmittedTrackSource): BigBedScientificKind {
  if (source.formatId !== 'bigbed' || source.readerKind !== 'bbi') {
    throw new Error('The interval BBI reader requires an admitted BigBed source.');
  }
  switch (source.scientificKind) {
    case 'transcript':
    case 'interval':
    case 'peak':
    case 'repeat':
      return source.scientificKind;
    default:
      throw new Error(`BigBed scientific kind ${source.scientificKind} is not renderable.`);
  }
}
