import {
  buildTextIntervalQueryIndex,
  parseTextIntervalTrack,
  queryTextIntervalRegions,
  type TextIntervalQueryIndex,
} from '@waypoint/genome-data';

import {
  decodeTextIntervalSource,
  MAX_TEXT_INTERVAL_DECODED_BYTES,
} from './text-interval-source-decoder';
import type {
  TextIntervalHeaderSummary,
  TextIntervalReaderWorkerRequest,
  TextIntervalReaderWorkerResponse,
} from './text-interval-reader-worker-protocol';

interface TextIntervalWorkerScope {
  onmessage: ((event: MessageEvent<TextIntervalReaderWorkerRequest>) => void) | null;
  postMessage(message: TextIntervalReaderWorkerResponse): void;
}

interface OpenTextIntervalSource {
  readonly header: TextIntervalHeaderSummary;
  readonly index: TextIntervalQueryIndex;
}

const scope = globalThis as typeof globalThis & TextIntervalWorkerScope;
const sources = new Map<string, OpenTextIntervalSource>();
const activeRequests = new Map<number, AbortController>();

scope.onmessage = (event) => {
  void handleRequest(event.data);
};

async function handleRequest(request: TextIntervalReaderWorkerRequest): Promise<void> {
  if (request.type === 'cancel') {
    activeRequests.get(request.targetId)?.abort();
    return;
  }
  const controller = new AbortController();
  activeRequests.set(request.id, controller);
  try {
    if (request.type === 'open') {
      const decoded = await decodeTextIntervalSource(
        request.bytes,
        MAX_TEXT_INTERVAL_DECODED_BYTES
      );
      throwIfAborted(controller.signal);
      const parsed = parseTextIntervalTrack(request.formatId, decoded.text, {
        ...(request.scientificKind ? { scientificKind: request.scientificKind } : {}),
      });
      throwIfAborted(controller.signal);
      const header: TextIntervalHeaderSummary = {
        formatId: parsed.formatId,
        scientificKind: parsed.scientificKind,
        referenceExtents: parsed.referenceExtents,
        recordCount: parsed.records.length,
        sourceByteLength: decoded.sourceByteLength,
        decodedByteLength: decoded.decodedByteLength,
        contentSha256: decoded.contentSha256,
      };
      sources.set(request.sourceKey, {
        header,
        index: buildTextIntervalQueryIndex(parsed.records),
      });
      postResult(request.id, header);
      return;
    }
    if (request.type === 'close') {
      sources.delete(request.sourceKey);
      postResult(request.id, true);
      return;
    }
    const source = sources.get(request.sourceKey);
    if (!source) throw new Error(`Text interval source "${request.sourceKey}" is not open.`);
    throwIfAborted(controller.signal);
    const result = queryTextIntervalRegions(source.index, request.regions, request.options);
    throwIfAborted(controller.signal);
    postResult(request.id, result);
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
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
  result: Extract<TextIntervalReaderWorkerResponse, { type: 'result' }>['result']
): void {
  scope.postMessage({ id, type: 'result', result });
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error('Text interval reader request cancelled.');
  error.name = 'AbortError';
  throw error;
}
