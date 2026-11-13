import type { AdmittedTrackSource, VariantRecord } from '@waypoint/genome-data';
import type {
  Assembly,
  AssemblySegment,
  TileData,
  TileFetchContext,
  TileKey,
} from '@waypoint/genome-renderer';

import { readHtsgetVariantRegion, type HtsgetRuntime } from './htsget-client';
import { readRemoteVariantRegion, type RemoteVariantRuntime } from './remote-variant-client';
import {
  MAX_VARIANT_REGION_SIZE,
  readVariantRegion,
  type VariantReferenceIdentity,
  type VariantRegion,
} from './variant-client';
import { createVariantSourceSession, type VariantSourceSession } from './variant-source-session';
import type { LocalVariantRuntime, VariantTrackRuntime } from './variant-track-admission';
import type { UcscTilePayload, UcscTileSource } from './ucsc-tile-types';
import { trackTileErrorRetryable, trackTileErrorScope } from './track-tile-retryability';

const MAX_VARIANT_TILE_LEVEL = 12;
const ESTIMATED_VARIANT_RECORD_BYTES = 384;

export function createVariantTileSource(input: {
  readonly assembly: Assembly;
  readonly trackId: string;
  readonly source: AdmittedTrackSource;
  readonly session?: VariantSourceSession;
}): UcscTileSource {
  requireVariantSource(input.source);
  const references: VariantReferenceIdentity[] = input.assembly.chromosomes.map((placement) => ({
    name: placement.chromosome.id,
    length: placement.chromosome.length,
  }));
  const session =
    input.session ??
    createVariantSourceSession({
      source: input.source,
      assemblyReferences: references,
    });
  const runtimeSourceId = `variant:${input.trackId}\u0000${input.source.fingerprint}`;

  return {
    id: runtimeSourceId,
    trackId: input.trackId,
    source: input.source,
    levelRange: [0, MAX_VARIANT_TILE_LEVEL],
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
        const records = await session.execute(signal, async (runtime) => {
          const regional = await Promise.all(
            segments.flatMap((segment) => {
              const chrom = input.source.referenceReceipt.contigMap[segment.chrom];
              if (!chrom) return [];
              return [
                queryRuntimeRegion(runtime, references, chrom, segment, signal).then((result) => ({
                  result,
                  segment,
                })),
              ];
            })
          );
          const truncated = regional.find(({ result }) => result.truncated);
          if (truncated) {
            throw new Error(
              `This ${truncated.segment.localEnd - truncated.segment.localStart}-base variant region contains more than ${MAX_VARIANT_REGION_SIZE.toLocaleString()} calls. Zoom in to render every call.`
            );
          }
          return regional.flatMap(({ result, segment }) =>
            result.variants.map((record) => globalizeVariant(record, segment))
          );
        });
        if (signal.aborted) throw abortError();
        records.sort((left, right) => left.start - right.start || left.end - right.end);
        return {
          key,
          state: 'ready',
          count: records.length,
          byteSize: Math.max(64, records.length * ESTIMATED_VARIANT_RECORD_BYTES),
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

function queryRuntimeRegion(
  runtime: VariantTrackRuntime,
  references: ReadonlyArray<VariantReferenceIdentity>,
  chrom: string,
  segment: AssemblySegment,
  signal: AbortSignal
): Promise<VariantRegion> {
  const region = {
    chrom,
    start: segment.localStart,
    end: segment.localEnd,
    limit: MAX_VARIANT_REGION_SIZE,
  };
  if (isLocalRuntime(runtime)) {
    return readVariantRegion(
      {
        queryPath: runtime.prepared.queryPath,
        indexPath: runtime.prepared.indexPath,
        sourceGeneration: runtime.prepared.sourceGeneration,
        queryGeneration: runtime.prepared.queryGeneration,
        indexGeneration: runtime.prepared.indexGeneration,
        assemblyRevision: runtime.assemblyRevision,
        ...region,
      },
      fetch,
      { signal }
    );
  }
  if (isHtsgetRuntime(runtime)) {
    return readHtsgetVariantRegion({ runtime, references, ...region }, { signal });
  }
  return readRemoteVariantRegion(
    { runtime: runtime as RemoteVariantRuntime, references, ...region },
    { signal }
  );
}

function globalizeVariant(record: VariantRecord, segment: AssemblySegment): VariantRecord {
  return {
    ...record,
    chrom: segment.chrom,
    start: record.start + segment.globalStart,
    end: record.end + segment.globalStart,
  };
}

function isLocalRuntime(runtime: VariantTrackRuntime): runtime is LocalVariantRuntime {
  return 'kind' in runtime && runtime.kind === 'local';
}

function isHtsgetRuntime(runtime: VariantTrackRuntime): runtime is HtsgetRuntime {
  return 'kind' in runtime && runtime.kind === 'htsget';
}

function requireVariantSource(source: AdmittedTrackSource): void {
  if (
    source.readerKind !== 'variant' ||
    source.scientificKind !== 'variants' ||
    (source.formatId !== 'vcf' && source.formatId !== 'bcf')
  ) {
    throw new Error('The variant tile reader requires an admitted VCF/BCF source.');
  }
}

function abortError(): Error {
  return new DOMException('Aborted', 'AbortError');
}
