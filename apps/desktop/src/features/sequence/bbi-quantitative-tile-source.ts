import { type AdmittedTrackSource, type QuantitativeBin } from '@waypoint/genome-data';
import {
  maxLevelForAssembly,
  quantitativeSourceBasesPerSpan,
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
import type { UcscTilePayload, UcscTileSource } from './ucsc-tile-types';
import { trackTileErrorRetryable, trackTileErrorScope } from './track-tile-retryability';

const ESTIMATED_QUANTITATIVE_RECORD_BYTES = 48;

interface QuantitativeBbiReader extends BbiSessionReader {
  queryQuantitative: BbiReaderWorkerClient['queryQuantitative'];
}

export function createBbiQuantitativeTileSource(input: {
  readonly assembly: Assembly;
  readonly trackId: string;
  readonly source: AdmittedTrackSource;
  readonly reader?: QuantitativeBbiReader;
  readonly admit?: typeof admitUcscTrack;
  readonly admitIndexed?: typeof admitIndexedTrack;
}): UcscTileSource {
  const reader = input.reader ?? getBbiReaderWorkerClient();
  const runtimeSourceId = `bbi:${input.trackId}\u0000${input.source.fingerprint}`;
  const session = createBbiSourceSession({
    assembly: input.assembly,
    source: input.source,
    format: 'bigwig',
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
      if (signal.aborted) throw abortError();
      try {
        const sourceBasesPerSpan = quantitativeSourceBasesPerSpan(
          level,
          input.source.quantitativeColumnSemantics
        );
        const regions = segments.map((segment) => ({
          refName: input.source.referenceReceipt.contigMap[segment.chrom] ?? segment.chrom,
          start: segment.localStart,
          end: segment.localEnd,
        }));
        const decoded = await session.execute(signal, ({ sourceKey }) =>
          reader.queryQuantitative(sourceKey, regions, sourceBasesPerSpan, signal)
        );
        if (signal.aborted) throw abortError();
        const records: QuantitativeBin[] = [];
        for (let regionIndex = 0; regionIndex < segments.length; regionIndex += 1) {
          const segment = segments[regionIndex];
          const region = decoded[regionIndex];
          if (!region) continue;
          const count = Math.min(region.starts.length, region.ends.length, region.values.length);
          for (let recordIndex = 0; recordIndex < count; recordIndex += 1) {
            const start = region.starts[recordIndex];
            const end = region.ends[recordIndex];
            const value = region.values[recordIndex];
            if (!Number.isFinite(value) || end <= start) continue;
            records.push({
              chrom: segment.chrom,
              start: segment.globalStart + start,
              end: segment.globalStart + end,
              value,
            });
          }
        }
        return {
          key,
          state: 'ready',
          count: records.length,
          byteSize: Math.max(64, records.length * ESTIMATED_QUANTITATIVE_RECORD_BYTES),
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

function abortError(): Error {
  return bbiAbortError();
}
