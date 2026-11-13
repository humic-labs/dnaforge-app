import type {
  TextIntervalQueryOptions,
  TextIntervalQueryRegion,
  TextIntervalRegionQueryResult,
  TextIntervalScientificKind,
  TextIntervalTrackFormatId,
} from '@waypoint/genome-data';

import type {
  TextIntervalHeaderSummary,
  TextIntervalReaderWorkerLike,
  TextIntervalReaderWorkerRequest,
  TextIntervalReaderWorkerResponse,
} from './text-interval-reader-worker-protocol';

type PendingResult =
  | TextIntervalHeaderSummary
  | ReadonlyArray<TextIntervalRegionQueryResult>
  | true;

export class TextIntervalReaderWorkerClient {
  private nextId = 1;
  private lifetime: { phase: 'active' } | { phase: 'failed' | 'disposed'; error: Error } = {
    phase: 'active',
  };
  private readonly pending = new Map<
    number,
    {
      readonly resolve: (value: PendingResult) => void;
      readonly reject: (error: Error) => void;
      readonly cleanup?: () => void;
    }
  >();

  constructor(private readonly worker: TextIntervalReaderWorkerLike) {
    worker.addEventListener('message', this.handleMessage);
    worker.addEventListener('error', this.handleWorkerError);
    worker.addEventListener('messageerror', this.handleWorkerMessageError);
  }

  open(
    sourceKey: string,
    formatId: TextIntervalTrackFormatId,
    bytes: Uint8Array,
    scientificKind?: TextIntervalScientificKind,
    signal?: AbortSignal
  ): Promise<TextIntervalHeaderSummary> {
    const transferableBytes = Uint8Array.from(bytes);
    const request: TextIntervalReaderWorkerRequest = {
      id: this.allocId(),
      type: 'open',
      sourceKey,
      formatId,
      ...(scientificKind ? { scientificKind } : {}),
      bytes: transferableBytes,
    };
    return this.request(request, signal, [
      transferableBytes.buffer,
    ]) as Promise<TextIntervalHeaderSummary>;
  }

  query(
    sourceKey: string,
    regions: ReadonlyArray<TextIntervalQueryRegion>,
    options: TextIntervalQueryOptions,
    signal?: AbortSignal
  ): Promise<ReadonlyArray<TextIntervalRegionQueryResult>> {
    return this.request(
      { id: this.allocId(), type: 'query', sourceKey, regions, options },
      signal
    ) as Promise<ReadonlyArray<TextIntervalRegionQueryResult>>;
  }

  async closeSource(sourceKey: string): Promise<void> {
    await this.request({ id: this.allocId(), type: 'close', sourceKey });
  }

  dispose(): void {
    if (this.lifetime.phase === 'disposed') return;
    const error = new Error('Text interval reader worker was disposed.');
    this.lifetime = { phase: 'disposed', error };
    this.rejectAll(error);
    this.worker.removeEventListener('message', this.handleMessage);
    this.worker.removeEventListener('error', this.handleWorkerError);
    this.worker.removeEventListener('messageerror', this.handleWorkerMessageError);
    this.worker.terminate?.();
  }

  private request(
    request: TextIntervalReaderWorkerRequest,
    signal?: AbortSignal,
    transfer?: ReadonlyArray<Transferable>
  ): Promise<PendingResult> {
    if (this.lifetime.phase !== 'active') return Promise.reject(this.lifetime.error);
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const abort = () => {
        const pending = this.pending.get(request.id);
        if (!pending) return;
        pending.cleanup?.();
        this.pending.delete(request.id);
        pending.reject(abortError());
        try {
          this.worker.postMessage({ id: this.allocId(), type: 'cancel', targetId: request.id });
        } catch (error) {
          this.failWorker(error instanceof Error ? error : new Error(String(error)));
        }
      };
      const cleanup = signal ? () => signal.removeEventListener('abort', abort) : undefined;
      this.pending.set(request.id, { resolve, reject, cleanup });
      signal?.addEventListener('abort', abort, { once: true });
      try {
        this.worker.postMessage(request, transfer);
      } catch (error) {
        this.failWorker(error instanceof Error ? error : new Error(String(error)));
      }
      if (signal?.aborted) abort();
    });
  }

  private allocId(): number {
    const id = this.nextId;
    this.nextId += 1;
    return id;
  }

  private handleMessage = (event: MessageEvent<TextIntervalReaderWorkerResponse>): void => {
    const response = event.data;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    pending.cleanup?.();
    if (response.type === 'result') {
      pending.resolve(response.result);
      return;
    }
    const error = new Error(response.error.message);
    error.name = response.error.name;
    pending.reject(error);
  };

  private handleWorkerError = (event: Event): void => {
    const workerEvent = event as ErrorEvent;
    const detail =
      workerEvent.error instanceof Error
        ? workerEvent.error.message
        : workerEvent.message || 'The text interval reader stopped unexpectedly.';
    this.failWorker(new Error(`Text interval reader worker failed: ${detail}`));
  };

  private handleWorkerMessageError = (): void => {
    this.failWorker(new Error('Text interval reader worker returned an unreadable message.'));
  };

  private failWorker(error: Error): void {
    if (this.lifetime.phase !== 'active') return;
    this.lifetime = { phase: 'failed', error };
    this.rejectAll(error);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.cleanup?.();
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function abortError(): Error {
  const error = new Error('Text interval reader request cancelled.');
  error.name = 'AbortError';
  return error;
}
