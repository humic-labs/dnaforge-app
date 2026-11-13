import type { TmModel } from './tm-model';

export interface TmMeasurementRequest {
  sequence: string;
  model: TmModel;
  concNm: number;
  signal?: AbortSignal;
}

export interface TmMeasurement {
  tm: number;
  ta?: number;
  source: string;
  verified: boolean;
  model?: TmModel;
  concNm?: number;
  pending?: boolean;
  meta?: Record<string, unknown>;
}

export interface TmProvider {
  readonly id: string;
  supports(model: TmModel): boolean;
  measure(request: TmMeasurementRequest): Promise<TmMeasurement>;
  measureMany?(requests: readonly TmMeasurementRequest[]): Promise<TmMeasurement[]>;
}

export function createLocalTmProvider(localFn: (sequence: string) => number): TmProvider {
  return {
    id: 'local',
    supports: (model) => model.kind === 'local',
    measure: async ({ sequence, model, concNm }) => ({
      tm: localFn(sequence),
      source: 'local',
      verified: false,
      model,
      concNm,
    }),
  };
}

export interface NebFetchFn {
  (args: { seq: string; prodcode: string; conc_nM: number; signal?: AbortSignal }): Promise<{
    tm: number;
    ta?: number;
    nebApiVersion: string;
    fetchedAt: string;
  }>;
}

export interface NebBatchFetchFn {
  (args: { seqs: string[]; prodcode: string; conc_nM: number; signal?: AbortSignal }): Promise<
    Array<{
      tm: number;
      ta?: number;
      nebApiVersion: string;
      fetchedAt: string;
    }>
  >;
}

function nebMeasurement(
  response: { tm: number; ta?: number; nebApiVersion: string; fetchedAt: string },
  model: Extract<TmModel, { kind: 'neb' }>,
  concNm: number
): TmMeasurement {
  return {
    tm: response.tm,
    ta: response.ta,
    source: 'neb',
    verified: true,
    model,
    concNm,
    meta: {
      polymerase: model.polymerase,
      prodcode: model.prodcode,
      nebApiVersion: response.nebApiVersion,
      fetchedAt: response.fetchedAt,
    },
  };
}

export function createNebTmProvider(
  nebFetch: NebFetchFn,
  batchFetch?: NebBatchFetchFn
): TmProvider {
  return {
    id: 'neb',
    supports: (model) => model.kind === 'neb',
    measure: async ({ sequence, model, concNm, signal }) => {
      if (model.kind !== 'neb') throw new Error('createNebTmProvider called with a non-NEB model');
      const response = await nebFetch({
        seq: sequence,
        prodcode: model.prodcode,
        conc_nM: concNm,
        ...(signal ? { signal } : {}),
      });
      return nebMeasurement(response, model, concNm);
    },
    measureMany: batchFetch
      ? async (requests) => {
          if (requests.length === 0) return [];
          const model = requests[0].model;
          if (model.kind !== 'neb') {
            throw new Error('createNebTmProvider called with a non-NEB model');
          }
          const concNm = requests[0].concNm;
          const responses = await batchFetch({
            seqs: requests.map((request) => request.sequence),
            prodcode: model.prodcode,
            conc_nM: concNm,
            ...(requests[0].signal ? { signal: requests[0].signal } : {}),
          });
          if (responses.length !== requests.length) {
            throw new Error('NEB batch returned the wrong number of Tm values.');
          }
          return responses.map((response) => nebMeasurement(response, model, concNm));
        }
      : undefined,
  };
}

export class TmProviderRegistry {
  private readonly providers: TmProvider[] = [];

  register(provider: TmProvider): this {
    const existing = this.providers.findIndex((item) => item.id === provider.id);
    if (existing >= 0) this.providers.splice(existing, 1);
    this.providers.push(provider);
    return this;
  }

  providerFor(model: TmModel): TmProvider | null {
    return this.providers.find((provider) => provider.supports(model)) ?? null;
  }

  get ids(): string[] {
    return this.providers.map((provider) => provider.id);
  }
}

export class TmMeasurementCache {
  private readonly entries = new Map<string, TmMeasurement>();
  private readonly inFlight = new Map<
    string,
    {
      controller: AbortController;
      promise: Promise<TmMeasurement>;
      subscribers: Set<symbol>;
      settled: boolean;
    }
  >();

  constructor(private readonly maxEntries = 2000) {}

  static key(request: Pick<TmMeasurementRequest, 'sequence' | 'model' | 'concNm'>): string {
    const model =
      request.model.kind === 'local'
        ? `local:${request.model.algorithm}`
        : `neb:${request.model.prodcode}`;
    return `${model}|${request.concNm}|${request.sequence}`;
  }

  get(key: string): TmMeasurement | undefined {
    const hit = this.entries.get(key);
    if (hit) {
      this.entries.delete(key);
      this.entries.set(key, hit);
    }
    return hit;
  }

  set(key: string, value: TmMeasurement): void {
    if (!value.verified) return;
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, value);
  }

  measureInFlight(
    key: string,
    signal: AbortSignal | undefined,
    loader: (signal: AbortSignal) => Promise<TmMeasurement>
  ): Promise<TmMeasurement> {
    if (signal?.aborted) return Promise.reject(tmAbortError());

    let entry = this.inFlight.get(key);
    if (!entry) {
      const controller = new AbortController();
      entry = {
        controller,
        promise: loader(controller.signal),
        subscribers: new Set(),
        settled: false,
      };
      this.inFlight.set(key, entry);
      const created = entry;
      void created.promise.then(
        () => this.finishInFlight(key, created),
        () => this.finishInFlight(key, created)
      );
    }

    const subscribed = entry;
    const token = Symbol(key);
    subscribed.subscribers.add(token);

    return new Promise<TmMeasurement>((resolve, reject) => {
      let finished = false;
      const release = () => {
        signal?.removeEventListener('abort', onAbort);
        subscribed.subscribers.delete(token);
        if (!subscribed.settled && subscribed.subscribers.size === 0) {
          if (this.inFlight.get(key) === subscribed) this.inFlight.delete(key);
          subscribed.controller.abort();
        }
      };
      const onAbort = () => {
        if (finished) return;
        finished = true;
        release();
        reject(tmAbortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      void subscribed.promise.then(
        (measurement) => {
          if (finished) return;
          finished = true;
          release();
          resolve(measurement);
        },
        (error) => {
          if (finished) return;
          finished = true;
          release();
          reject(error);
        }
      );
    });
  }

  private finishInFlight(
    key: string,
    entry: {
      controller: AbortController;
      promise: Promise<TmMeasurement>;
      subscribers: Set<symbol>;
      settled: boolean;
    }
  ): void {
    entry.settled = true;
    if (this.inFlight.get(key) === entry) this.inFlight.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
    for (const entry of this.inFlight.values()) entry.controller.abort();
    this.inFlight.clear();
  }
}

function tmAbortError(): Error {
  const error = new Error('Tm measurement was superseded.');
  error.name = 'AbortError';
  return error;
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  });

  await Promise.all(runners);
  return results;
}
