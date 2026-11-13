import type {
  FeatureDetails,
  FeatureDetailsRequest,
  GenomeDataRequestOptions,
  GenomeDataSource,
  GenomeFeature,
  IndexedGenomeManifest,
  SearchHit,
  SearchOpts,
} from './types';
import type {
  GenomeDataWorkerRequest,
  GenomeDataWorkerResponse,
  SerializableSearchOpts,
} from './worker-protocol';
import type { LocalIndexedGenomeDataSourceOptions } from './types';

export interface GenomeDataWorkerMessageLike {
  readonly data: GenomeDataWorkerResponse;
}

export interface GenomeDataWorkerLike {
  postMessage(message: GenomeDataWorkerRequest): void;
  addEventListener(type: 'message', listener: (event: GenomeDataWorkerMessageLike) => void): void;
  removeEventListener(
    type: 'message',
    listener: (event: GenomeDataWorkerMessageLike) => void
  ): void;
}

export class GenomeDataWorkerClient implements GenomeDataSource {
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (err: Error) => void;
      onHit?: (hit: SearchHit) => void;
      cleanup?: () => void;
    }
  >();

  constructor(private readonly worker: GenomeDataWorkerLike) {
    this.worker.addEventListener('message', this.handleMessage);
  }

  async init(
    manifest: IndexedGenomeManifest,
    options?: LocalIndexedGenomeDataSourceOptions
  ): Promise<void> {
    await this.request({ id: this.allocId(), type: 'init', manifest, options });
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
    options: GenomeDataRequestOptions = {}
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
    options: GenomeDataRequestOptions = {}
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

  getFeatureDetails(
    request: FeatureDetailsRequest,
    options: GenomeDataRequestOptions = {}
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
    if (this.closed) throw new Error('Genome data worker client is closed.');
    const id = this.allocId();
    const pending = this.pending;
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
      if (abortHandler) {
        abortSignal?.removeEventListener('abort', abortHandler);
        abortHandler = null;
      }
    };

    const cancelWorkerSearch = (): void => {
      if (cancelSent) return;
      cancelSent = true;
      this.worker.postMessage({ id: this.allocId(), type: 'cancel', targetId: id });
    };

    const push = (hit: SearchHit): void => {
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

    pending.set(id, {
      resolve: finish,
      reject: fail,
      onHit: push,
    });

    if (abortSignal) {
      abortHandler = cancelWorkerSearch;
      abortSignal.addEventListener('abort', abortHandler, { once: true });
    }

    const serializable = { ...opts };
    delete serializable.signal;
    this.worker.postMessage({
      id,
      type: 'searchSequence',
      chrom,
      motif,
      opts: serializable as SerializableSearchOpts,
    });
    if (abortSignal?.aborted) cancelWorkerSearch();

    return {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<SearchHit>> {
            if (failure) return Promise.reject(failure);
            const hit = queue.shift();
            if (hit) return Promise.resolve({ value: hit, done: false });
            if (done) return Promise.resolve({ value: undefined, done: true });
            return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
          },
          return(): Promise<IteratorResult<SearchHit>> {
            if (!done) {
              cancelWorkerSearch();
              pending.delete(id);
            }
            queue.length = 0;
            finish();
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.worker.removeEventListener('message', this.handleMessage);
    const requests = [...this.pending];
    this.pending.clear();
    for (const [, pending] of requests) {
      pending.cleanup?.();
      pending.reject(new Error('Genome data worker client is closed.'));
    }
    for (const [id] of requests) {
      this.worker.postMessage({ id: this.allocId(), type: 'cancel', targetId: id });
    }
  }

  private request(
    message: GenomeDataWorkerRequest,
    options: GenomeDataRequestOptions = {}
  ): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Genome data worker client is closed.'));
    if (options.signal?.aborted) {
      return Promise.reject(createAbortError());
    }
    return new Promise((resolve, reject) => {
      const abortHandler = (): void => {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        pending.cleanup?.();
        this.pending.delete(message.id);
        this.worker.postMessage({ id: this.allocId(), type: 'cancel', targetId: message.id });
        pending.reject(createAbortError());
      };
      const cleanup =
        options.signal != null
          ? (): void => options.signal?.removeEventListener('abort', abortHandler)
          : undefined;
      this.pending.set(message.id, { resolve, reject, cleanup });
      options.signal?.addEventListener('abort', abortHandler, { once: true });
      this.worker.postMessage(message);
      if (options.signal?.aborted) abortHandler();
    });
  }

  private allocId(): number {
    const id = this.nextId;
    this.nextId += 1;
    return id;
  }

  private handleMessage = (event: GenomeDataWorkerMessageLike): void => {
    const msg = event.data;
    const pending = this.pending.get(msg.id);
    if (!pending) return;

    if (msg.type === 'searchHit') {
      pending.onHit?.(msg.hit);
      return;
    }

    this.pending.delete(msg.id);
    pending.cleanup?.();
    if (msg.type === 'result') {
      pending.resolve(msg.result);
      return;
    }

    const err = new Error(msg.error.message);
    err.name = msg.error.name;
    pending.reject(err);
  };
}

function createAbortError(): Error {
  const err = new Error('Genome data request cancelled.');
  err.name = 'AbortError';
  return err;
}
