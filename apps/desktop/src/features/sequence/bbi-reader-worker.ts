import { BigBed, BigWig } from '@gmod/bbi';

import {
  findBbiRangeGrantExpiredError,
  throwIfBbiRangeGrantExpiredResponse,
} from './bbi-range-grant-recovery';
import { readBbiWithSharedAbortRecovery } from './bbi-read-abort-recovery';
import { BbiRangeFile } from './bbi-range-file';
import { fetchBbiRangeWithRetry } from './bbi-range-fetch';
import { isTrustedRemoteSignalUrl } from './remote-signal-url';

import type {
  BbiHeaderSummary,
  BbiIntervalFeature,
  BbiQuantitativeRegion,
  BbiRangeGrant,
  BbiReaderWorkerRequest,
  BbiReaderWorkerResponse,
} from './bbi-reader-worker-protocol';

const MAX_BIGBED_QUERY_COMPRESSED_BYTES = 16 * 1024 * 1024;

interface BbiWorkerScope {
  onmessage: ((event: MessageEvent<BbiReaderWorkerRequest>) => void) | null;
  postMessage(message: BbiReaderWorkerResponse, transfer?: Transferable[]): void;
}

type OpenBbi = BigWig | BigBed;

const scope = globalThis as typeof globalThis & BbiWorkerScope;
const sources = new Map<
  string,
  { readonly format: 'bigwig' | 'bigbed'; readonly reader: OpenBbi }
>();
const activeRequests = new Map<number, AbortController>();

scope.onmessage = (event) => {
  void handleRequest(event.data);
};

async function handleRequest(request: BbiReaderWorkerRequest): Promise<void> {
  if (request.type === 'cancel') {
    activeRequests.get(request.targetId)?.abort();
    return;
  }
  const controller = new AbortController();
  activeRequests.set(request.id, controller);
  try {
    if (request.type === 'open') {
      const reader =
        request.format === 'bigwig'
          ? new BigWig({ filehandle: remoteFileForGrant(request.grant) })
          : new BigBed({ filehandle: remoteFileForGrant(request.grant) });
      sources.set(request.sourceKey, { format: request.format, reader });
      const header = await readBbiWithSharedAbortRecovery(
        () => reader.getHeader({ signal: controller.signal }),
        controller.signal
      );
      const references = Object.values(header.refsByNumber)
        .filter((reference): reference is NonNullable<typeof reference> => reference != null)
        .map((reference) => ({ name: reference.name, length: reference.length }));
      postResult(request.id, {
        fileType: header.fileType,
        references,
        zoomReductionLevels: header.zoomLevels.map((level) => level.reductionLevel),
        ...(header.fileType === 'bigbed' && header.autoSql ? { autoSql: header.autoSql } : {}),
        ...(header.fileType === 'bigbed' ? { fieldCount: header.fieldCount } : {}),
        totalSummary: {
          basesCovered: header.totalSummary.basesCovered,
          scoreMin: header.totalSummary.scoreMin,
          scoreMax: header.totalSummary.scoreMax,
        },
      } satisfies BbiHeaderSummary);
      return;
    }
    if (request.type === 'close') {
      sources.delete(request.sourceKey);
      postResult(request.id, true);
      return;
    }
    const source = sources.get(request.sourceKey);
    if (!source) throw new Error(`BBI source "${request.sourceKey}" is not open`);
    if (request.type === 'query-quantitative') {
      if (source.format !== 'bigwig' || !(source.reader instanceof BigWig)) {
        throw new Error('Quantitative queries require an admitted BigWig source');
      }
      const reader = source.reader;
      const packed = await readBbiWithSharedAbortRecovery(
        () =>
          reader.getFeaturesAsArraysMulti(
            request.regions.map((region) => ({
              refName: region.refName,
              start: region.start,
              end: region.end,
            })),
            {
              basesPerSpan: request.basesPerSpan,
              signal: controller.signal,
            }
          ),
        controller.signal
      );
      const regions: BbiQuantitativeRegion[] = request.regions.map((_region, index) => {
        const from = packed.regionOffsets[index] ?? 0;
        const to = packed.regionOffsets[index + 1] ?? from;
        return {
          starts: packed.starts.slice(from, to),
          ends: packed.ends.slice(from, to),
          values: packed.scores.slice(from, to),
        };
      });
      const transfer = regions.flatMap((region) => [
        region.starts.buffer,
        region.ends.buffer,
        region.values.buffer,
      ]);
      scope.postMessage({ id: request.id, type: 'result', result: regions }, transfer);
      return;
    }
    if (request.type === 'query-intervals') {
      if (source.format !== 'bigbed' || !(source.reader instanceof BigBed)) {
        throw new Error('Interval queries require an admitted BigBed source');
      }
      const regions = request.regions.map((region) => ({
        refName: region.refName,
        start: region.start,
        end: region.end,
      }));
      const reader = source.reader;
      const estimatedBytes = await readBbiWithSharedAbortRecovery(
        () => reader.getRegionByteSizeMulti(regions, { signal: controller.signal }),
        controller.signal
      );
      if (estimatedBytes > MAX_BIGBED_QUERY_COMPRESSED_BYTES) {
        throw new Error(
          `BigBed viewport needs ${estimatedBytes} compressed bytes; zoom in to keep one tile below ${MAX_BIGBED_QUERY_COMPRESSED_BYTES} bytes.`
        );
      }
      const decoded = await readBbiWithSharedAbortRecovery(
        () => reader.getFeaturesMulti(regions, { signal: controller.signal }),
        controller.signal
      );
      const result: ReadonlyArray<ReadonlyArray<BbiIntervalFeature>> = decoded.map((features) =>
        features.map((feature) => ({
          start: feature.start,
          end: feature.end,
          ...(feature.score === undefined ? {} : { score: feature.score }),
          ...(feature.rest === undefined ? {} : { rest: feature.rest }),
          ...(feature.uniqueId === undefined ? {} : { uniqueId: feature.uniqueId }),
        }))
      );
      postResult(request.id, result);
    }
  } catch (error) {
    const normalized =
      findBbiRangeGrantExpiredError(error) ??
      (error instanceof Error ? error : new Error(String(error)));
    scope.postMessage({
      id: request.id,
      type: 'error',
      error: { name: normalized.name, message: normalized.message },
    });
  } finally {
    activeRequests.delete(request.id);
  }
}

function postResult(
  id: number,
  result:
    | BbiHeaderSummary
    | ReadonlyArray<BbiQuantitativeRegion>
    | ReadonlyArray<ReadonlyArray<BbiIntervalFeature>>
    | true
): void {
  scope.postMessage({ id, type: 'result', result });
}

function remoteFileForGrant(grant: BbiRangeGrant): BbiRangeFile {
  if (grant.directRangeUrl) {
    if (!isTrustedRemoteSignalUrl(grant.directRangeUrl)) {
      throw new Error('The remote histogram URL is not a DNAForge SSH range endpoint.');
    }
    return new BbiRangeFile(grant.directRangeUrl, {
      overrides: {
        cache: 'no-store',
        credentials: 'omit',
      },
      fetch: fetchBbiRangeWithRetry,
    });
  }
  return new BbiRangeFile(`${grant.baseUrl.replace(/\/+$/, '')}/external/range`, {
    maxRangeBytes: grant.maxRangeBytes,
    headers: {
      'X-DNAForge-Source-Token': grant.sourceToken,
    },
    overrides: {
      cache: 'no-store',
      credentials: 'same-origin',
    },
    fetch: async (input, init) => {
      const response = await fetchBbiRangeWithRetry(input, init);
      if (response.ok) return response;
      await throwIfBbiRangeGrantExpiredResponse(response);
      let message = '';
      try {
        const body = (await response.clone().json()) as { detail?: { message?: unknown } };
        if (typeof body.detail?.message === 'string') message = body.detail.message;
      } catch {}
      if (!message) return response;
      return new Response(response.body, {
        status: response.status,
        statusText: message,
        headers: {
          ...Object.fromEntries(response.headers.entries()),
          'X-DNAForge-Range-Error': message,
        },
      });
    },
  });
}
