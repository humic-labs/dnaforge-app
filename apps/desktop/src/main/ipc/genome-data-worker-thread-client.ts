import type { Worker } from 'node:worker_threads';

import type {
  FeatureDetails,
  FeatureDetailsRequest,
  GenomeDataSource,
  GenomeFeature,
  IndexedGenomeManifest,
  LocalIndexedGenomeDataSourceOptions,
  SearchHit,
  SearchOpts,
} from '@waypoint/genome-data';
import type { OverviewAnnotationTilePayload } from './genome-overview-tile-cache';
import type { ViewportAnnotationTilePayload } from './genome-viewport-tile-builder';
import type {
  GenomeDataThreadRequest,
  GenomeDataThreadResponse,
  GenomeDataThreadSearchOpts,
} from './genome-data-worker-thread-protocol';

export type GenomeDataNodeWorkerFactory = () => Worker;

export interface GenomeDataWorkerThreadStats {
  activeWorkers: number;
}

export interface GenomeDataWorkerRequestOptions {
  signal?: AbortSignal;
  physicalLifecycle?: GenomeDataWorkerPhysicalRequestLifecycle;
}

export interface GenomeDataWorkerPhysicalRequestLifecycle {
  started(): void;
  settled(): void;
}

export interface GenomeDataWorkerSearchOptions extends SearchOpts {
  physicalLifecycle?: GenomeDataWorkerPhysicalRequestLifecycle;
}

interface PendingWorkerRequest {
  resolve?: (value: unknown) => void;
  reject?: (err: Error) => void;
  onHit?: (hit: SearchHit) => void;
  cleanup?: () => void;
  physicalSettled?: () => void;
  callerSettled: boolean;
}

let activeWorkers = 0;

export const MAX_GENOME_DATA_WORKER_PENDING_REQUESTS = 64;

export function getGenomeDataWorkerThreadStats(): GenomeDataWorkerThreadStats {
  return { activeWorkers };
}

export class GenomeDataWorkerThreadSource implements GenomeDataSource {
  private nextId = 1;
  private closed = false;
  private terminated = false;
  private closing: Promise<void> | null = null;
  private readonly pending = new Map<number, PendingWorkerRequest>();

  constructor(private readonly worker: Worker) {
    activeWorkers += 1;
    this.worker.on('message', this.handleMessage);
    this.worker.on('error', this.handleWorkerError);
    this.worker.on('exit', this.handleWorkerExit);
  }

  async init(
    manifest: IndexedGenomeManifest,
    options?: LocalIndexedGenomeDataSourceOptions,
    requestOptions: GenomeDataWorkerRequestOptions = {}
  ): Promise<void> {
    await this.request({ id: this.allocId(), type: 'init', manifest, options }, requestOptions);
  }

  getChromosomeLength(chrom: string): Promise<number> {
    return this.request({
      id: this.allocId(),
      type: 'getChromosomeLength',
      chrom,
    }) as Promise<number>;
  }

  getSequence(
    chrom: string,
    start: number,
    end: number,
    options: GenomeDataWorkerRequestOptions = {}
  ): Promise<string> {
    return this.request(
      {
        id: this.allocId(),
        type: 'getSequence',
        chrom,
        start,
        end,
      },
      options
    ) as Promise<string>;
  }

  getFeatures(
    chrom: string,
    start: number,
    end: number,
    zoomLevel: number,
    options: GenomeDataWorkerRequestOptions = {}
  ): Promise<GenomeFeature[]> {
    return this.request(
      {
        id: this.allocId(),
        type: 'getFeatures',
        chrom,
        start,
        end,
        zoomLevel,
      },
      options
    ) as Promise<GenomeFeature[]>;
  }

  buildAnnotationOverview(input: {
    chrom: string;
    start: number;
    end: number;
    zoomLevel: number;
    signal?: AbortSignal;
    physicalLifecycle?: GenomeDataWorkerPhysicalRequestLifecycle;
  }): Promise<OverviewAnnotationTilePayload> {
    return this.request(
      {
        id: this.allocId(),
        type: 'buildAnnotationOverview',
        chrom: input.chrom,
        start: input.start,
        end: input.end,
        zoomLevel: input.zoomLevel,
      },
      { signal: input.signal, physicalLifecycle: input.physicalLifecycle }
    ) as Promise<OverviewAnnotationTilePayload>;
  }

  buildAnnotationViewportTile(input: {
    chrom: string;
    start: number;
    end: number;
    zoomLevel: number;
    rescuedParentIds?: ReadonlyArray<string>;
    signal?: AbortSignal;
    physicalLifecycle?: GenomeDataWorkerPhysicalRequestLifecycle;
  }): Promise<ViewportAnnotationTilePayload> {
    return this.request(
      {
        id: this.allocId(),
        type: 'buildAnnotationViewportTile',
        chrom: input.chrom,
        start: input.start,
        end: input.end,
        zoomLevel: input.zoomLevel,
        ...(input.rescuedParentIds !== undefined
          ? { rescuedParentIds: input.rescuedParentIds }
          : {}),
      },
      { signal: input.signal, physicalLifecycle: input.physicalLifecycle }
    ) as Promise<ViewportAnnotationTilePayload>;
  }

  getFeatureDetails(
    request: FeatureDetailsRequest,
    options: GenomeDataWorkerRequestOptions = {}
  ): Promise<FeatureDetails> {
    return this.request(
      {
        id: this.allocId(),
        type: 'getFeatureDetails',
        request,
      },
      options
    ) as Promise<FeatureDetails>;
  }

  searchSequence(chrom: string, motif: string, opts: SearchOpts = {}): AsyncIterable<SearchHit> {
    return this.searchSequenceWithPhysicalLifecycle(chrom, motif, opts);
  }

  searchSequenceWithPhysicalLifecycle(
    chrom: string,
    motif: string,
    opts: GenomeDataWorkerSearchOptions = {}
  ): AsyncIterable<SearchHit> {
    if (this.closed) throw new Error('Genome data worker is closed.');
    const id = this.allocId();
    const queue: SearchHit[] = [];
    const waiters: Array<{
      resolve: (value: IteratorResult<SearchHit>) => void;
      reject: (err: Error) => void;
    }> = [];
    let done = false;
    let failure: Error | null = null;
    let cancelSent = false;
    const abortSignal = opts.signal;
    let abortHandler: (() => void) | null = null;

    const cleanup = (): void => {
      if (!abortHandler) return;
      abortSignal?.removeEventListener('abort', abortHandler);
      abortHandler = null;
    };

    const cancelWorkerSearch = (): void => {
      if (cancelSent || this.closed) return;
      cancelSent = true;
      try {
        this.worker.postMessage({ id: this.allocId(), type: 'cancel', targetId: id });
      } catch {}
    };

    const push = (hit: SearchHit): void => {
      if (done) return;
      const waiter = waiters.shift();
      if (waiter) {
        waiter.resolve({ value: hit, done: false });
      } else {
        queue.push(hit);
      }
    };

    const finish = (): void => {
      done = true;
      cleanup();
      for (const waiter of waiters.splice(0)) {
        waiter.resolve({ value: undefined, done: true });
      }
    };

    const fail = (err: Error): void => {
      failure = err;
      done = true;
      queue.length = 0;
      cleanup();
      for (const waiter of waiters.splice(0)) {
        waiter.reject(err);
      }
    };

    const abortSearch = (): void => {
      if (done) return;
      const pending = this.pending.get(id);
      if (pending) {
        pending.callerSettled = true;
        pending.cleanup?.();
        pending.cleanup = undefined;
        pending.resolve = undefined;
        pending.reject = undefined;
        pending.onHit = undefined;
      }
      cancelWorkerSearch();
      fail(createAbortError());
    };

    const iterable: AsyncIterable<SearchHit> = {
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<SearchHit>> => {
          if (failure) return Promise.reject(failure);
          const hit = queue.shift();
          if (hit) return Promise.resolve({ value: hit, done: false });
          if (done) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
        },
        return: (): Promise<IteratorResult<SearchHit>> => {
          if (!done) {
            cancelWorkerSearch();
            const pending = this.pending.get(id);
            if (pending) {
              pending.callerSettled = true;
              pending.cleanup?.();
              pending.cleanup = undefined;
              pending.resolve = undefined;
              pending.reject = undefined;
              pending.onHit = undefined;
            }
          }
          queue.length = 0;
          finish();
          return Promise.resolve({ value: undefined, done: true });
        },
      }),
    };

    if (abortSignal?.aborted) {
      fail(createAbortError());
      return iterable;
    }

    this.assertPendingCapacity();
    this.pending.set(id, {
      resolve: finish,
      reject: fail,
      onHit: push,
      physicalSettled: opts.physicalLifecycle?.settled,
      callerSettled: false,
    });
    opts.physicalLifecycle?.started();

    if (abortSignal) {
      abortHandler = abortSearch;
      abortSignal.addEventListener('abort', abortHandler, { once: true });
    }

    const serializable = { ...opts };
    delete serializable.signal;
    delete serializable.physicalLifecycle;
    try {
      this.worker.postMessage({
        id,
        type: 'searchSequence',
        chrom,
        motif,
        opts: serializable as GenomeDataThreadSearchOpts,
      });
    } catch (error) {
      const pending = this.pending.get(id);
      this.pending.delete(id);
      this.settlePhysicalRequest(pending);
      fail(normalizeWorkerError(error));
    }
    if (abortSignal?.aborted) abortSearch();
    return iterable;
  }

  async close(): Promise<void> {
    if (this.terminated) return;
    if (this.closing) return this.closing;
    if (!this.closed) {
      this.closed = true;
      this.detachWorkerListeners();
      this.rejectAll(new Error('Genome data worker closed.'));
    }
    const closing = Promise.resolve().then(async () => {
      await this.worker.terminate();
      if (this.terminated) return;
      this.terminated = true;
      activeWorkers = Math.max(0, activeWorkers - 1);
    });
    this.closing = closing;
    try {
      await closing;
    } finally {
      if (this.closing === closing) this.closing = null;
    }
  }

  private request(
    message: GenomeDataThreadRequest,
    options: GenomeDataWorkerRequestOptions = {}
  ): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error('Genome data worker is closed.'));
    }
    if (options.signal?.aborted) {
      return Promise.reject(createAbortError());
    }
    if (this.pending.size >= MAX_GENOME_DATA_WORKER_PENDING_REQUESTS) {
      return Promise.reject(createWorkerRequestCapacityError());
    }
    return new Promise((resolve, reject) => {
      const abortHandler = (): void => {
        const pending = this.pending.get(message.id);
        if (!pending || pending.callerSettled) return;
        pending.cleanup?.();
        pending.cleanup = undefined;
        pending.callerSettled = true;
        const rejectCaller = pending.reject;
        pending.resolve = undefined;
        pending.reject = undefined;
        pending.onHit = undefined;
        try {
          this.worker.postMessage({ id: this.allocId(), type: 'cancel', targetId: message.id });
        } catch {}
        rejectCaller?.(createAbortError());
      };
      const cleanup =
        options.signal != null
          ? (): void => options.signal?.removeEventListener('abort', abortHandler)
          : undefined;
      this.pending.set(message.id, {
        resolve,
        reject,
        cleanup,
        physicalSettled: options.physicalLifecycle?.settled,
        callerSettled: false,
      });
      options.physicalLifecycle?.started();
      options.signal?.addEventListener('abort', abortHandler, { once: true });
      try {
        this.worker.postMessage(message);
      } catch (error) {
        cleanup?.();
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        this.settlePhysicalRequest(pending);
        reject(normalizeWorkerError(error));
      }
      if (options.signal?.aborted) abortHandler();
    });
  }

  private assertPendingCapacity(): void {
    if (this.pending.size >= MAX_GENOME_DATA_WORKER_PENDING_REQUESTS) {
      throw createWorkerRequestCapacityError();
    }
  }

  private allocId(): number {
    const id = this.nextId;
    this.nextId += 1;
    return id;
  }

  private handleMessage = (message: GenomeDataThreadResponse): void => {
    const pending = this.pending.get(message.id);
    if (!pending) return;

    if (message.type === 'searchHit') {
      if (!pending.callerSettled) pending.onHit?.(message.hit);
      return;
    }

    this.pending.delete(message.id);
    pending.cleanup?.();
    this.settlePhysicalRequest(pending);
    if (pending.callerSettled) return;
    if (message.type === 'result') {
      pending.resolve?.(message.result);
      return;
    }

    const err = new Error(message.error.message);
    err.name = message.error.name;
    pending.reject?.(err);
  };

  private handleWorkerError = (err: Error): void => {
    this.rejectAll(err);
  };

  private handleWorkerExit = (code: number): void => {
    if (this.terminated) return;
    this.terminated = true;
    this.closed = true;
    this.detachWorkerListeners();
    activeWorkers = Math.max(0, activeWorkers - 1);
    this.rejectAll(new Error(`Genome data worker exited unexpectedly with code ${code}.`));
  };

  private detachWorkerListeners(): void {
    this.worker.off('message', this.handleMessage);
    this.worker.off('error', this.handleWorkerError);
    this.worker.off('exit', this.handleWorkerExit);
  }

  private rejectAll(err: Error): void {
    for (const pending of this.pending.values()) {
      pending.cleanup?.();
      this.settlePhysicalRequest(pending);
      if (!pending.callerSettled) pending.reject?.(err);
    }
    this.pending.clear();
  }

  private settlePhysicalRequest(pending: PendingWorkerRequest | undefined): void {
    const settled = pending?.physicalSettled;
    if (pending) pending.physicalSettled = undefined;
    settled?.();
  }
}

function createAbortError(): Error {
  const err = new Error('Genome data request cancelled.');
  err.name = 'AbortError';
  return err;
}

function createWorkerRequestCapacityError(): Error {
  return new Error('Genome data worker request capacity is full.');
}

function normalizeWorkerError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
