import { preferCurrentThread } from '../thread-scheduling.cjs';
import { parentPort } from 'node:worker_threads';

import { LocalIndexedGenomeDataSource } from '@waypoint/genome-data/node';
import type {
  GenomeDataThreadRequest,
  GenomeDataThreadResponse,
} from './genome-data-worker-thread-protocol';
import { buildOverviewAnnotationTileFromRawFeatures } from './genome-overview-tile-cache';
import { buildAnnotationViewportTileFromRawFeatures } from './genome-viewport-tile-builder';

preferCurrentThread('userInitiated');

let source: LocalIndexedGenomeDataSource | null = null;
const activeRequests = new Map<number, AbortController>();
const cancelledRequests = new Set<number>();

if (!parentPort) {
  throw new Error('[genome] Genome data worker started without a parent port.');
}

parentPort.on('message', (request: GenomeDataThreadRequest) => {
  void handleRequest(request);
});

async function handleRequest(request: GenomeDataThreadRequest): Promise<void> {
  if (request.type === 'cancel') {
    const controller = activeRequests.get(request.targetId);
    if (controller) {
      controller.abort();
      cancelledRequests.add(request.targetId);
    }
    return;
  }

  try {
    throwIfCancelled(request.id);
    if (request.type === 'init') {
      await source?.close?.();
      throwIfCancelled(request.id);
      source = new LocalIndexedGenomeDataSource(request.manifest, request.options);
      post({ id: request.id, type: 'result', result: true });
      return;
    }

    if (!source) {
      throw new Error('Genome data worker is not initialized.');
    }

    const controller = beginWorkerRequest(request.id);
    try {
      if (request.type === 'getChromosomeLength') {
        const length = await source.getChromosomeLength(request.chrom);
        throwIfCancelled(request.id);
        post({
          id: request.id,
          type: 'result',
          result: length,
        });
        return;
      }

      if (request.type === 'getSequence') {
        const bases = await source.getSequence(request.chrom, request.start, request.end, {
          signal: controller.signal,
        });
        throwIfCancelled(request.id);
        post({
          id: request.id,
          type: 'result',
          result: bases,
        });
        return;
      }

      if (request.type === 'getFeatures') {
        const features = await source.getFeatures(
          request.chrom,
          request.start,
          request.end,
          request.zoomLevel,
          { signal: controller.signal }
        );
        throwIfCancelled(request.id);
        post({
          id: request.id,
          type: 'result',
          result: features,
        });
        return;
      }

      if (request.type === 'buildAnnotationOverview') {
        const rawFeatures = await source.getFeatures(
          request.chrom,
          request.start,
          request.end,
          request.zoomLevel,
          { signal: controller.signal }
        );
        throwIfCancelled(request.id);
        post({
          id: request.id,
          type: 'result',
          result: buildOverviewAnnotationTileFromRawFeatures(rawFeatures),
        });
        return;
      }

      if (request.type === 'buildAnnotationViewportTile') {
        const rawFeatures = await source.getFeatures(
          request.chrom,
          request.start,
          request.end,
          request.zoomLevel,
          { signal: controller.signal }
        );
        throwIfCancelled(request.id);
        const payload = buildAnnotationViewportTileFromRawFeatures(rawFeatures, {
          rescuedParentIds: request.rescuedParentIds
            ? new Set(request.rescuedParentIds)
            : undefined,
        });
        post({
          id: request.id,
          type: 'result',
          result: payload,
        });
        return;
      }

      if (request.type === 'getFeatureDetails') {
        const details = await source.getFeatureDetails(request.request, {
          signal: controller.signal,
        });
        throwIfCancelled(request.id);
        post({
          id: request.id,
          type: 'result',
          result: details,
        });
        return;
      }

      if (request.type === 'searchSequence') {
        for await (const hit of source.searchSequence(request.chrom, request.motif, {
          ...request.opts,
          signal: controller.signal,
        })) {
          throwIfCancelled(request.id);
          post({ id: request.id, type: 'searchHit', hit });
        }
        throwIfCancelled(request.id);
        post({ id: request.id, type: 'result', result: true });
      }
    } finally {
      finishWorkerRequest(request.id);
    }
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    post({ id: request.id, type: 'error', error: { name: e.name, message: e.message } });
  }
}

function post(message: GenomeDataThreadResponse): void {
  parentPort?.postMessage(message);
}

function beginWorkerRequest(requestId: number): AbortController {
  const controller = new AbortController();
  activeRequests.set(requestId, controller);
  if (cancelledRequests.has(requestId)) controller.abort();
  return controller;
}

function finishWorkerRequest(requestId: number): void {
  activeRequests.delete(requestId);
  cancelledRequests.delete(requestId);
}

function throwIfCancelled(requestId: number): void {
  if (!cancelledRequests.delete(requestId)) return;
  const err = new Error('Genome data request cancelled.');
  err.name = 'AbortError';
  throw err;
}
