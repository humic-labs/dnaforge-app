export interface ClosableGenomeSource {
  close(): Promise<void>;
}

interface CachedGenomeSource<Source> {
  source: Source;
  lastAccess: number;
  activeLeases: number;
}

interface GenomeSourcePreparation<Source> {
  readonly generation: number;
  readonly controller: AbortController;
  readonly promise: Promise<CachedGenomeSource<Source>>;
  claimers: number;
  settled: boolean;
}

type GenomeSourceCapacityWaiter = (capacityAvailable: boolean) => void;

function createSourceLifecycleClosedError(): Error {
  const error = new Error('Genome source preparation was superseded by runtime shutdown.');
  error.name = 'AbortError';
  return error;
}

function normalizeSourceCloseError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export class GenomeSourceLifecycle<Source extends ClosableGenomeSource> {
  private readonly sources = new Map<string, CachedGenomeSource<Source>>();
  private readonly preparations = new Map<string, GenomeSourcePreparation<Source>>();
  private readonly closingSources = new Map<Source, Promise<void>>();
  private readonly quarantinedSources = new Map<Source, Error>();
  private readonly capacityWaiters = new Set<GenomeSourceCapacityWaiter>();
  private admissionReservations = 0;
  private generation = 0;
  private closeBarrier: Promise<void> | null = null;

  constructor(
    private readonly maxOpenSources: number,
    private readonly now: () => number = Date.now
  ) {
    if (!Number.isInteger(maxOpenSources) || maxOpenSources < 1) {
      throw new Error('maxOpenSources must be a positive integer.');
    }
  }

  async withSource<Result>(
    key: string,
    create: (signal: AbortSignal) => Promise<Source>,
    use: (source: Source) => Promise<Result>,
    signal?: AbortSignal
  ): Promise<Result> {
    return this.withLeasedSource(key, create, use, false, signal);
  }

  async withEphemeralSource<Result>(
    key: string,
    create: (signal: AbortSignal) => Promise<Source>,
    use: (source: Source) => Promise<Result>,
    signal?: AbortSignal
  ): Promise<Result> {
    return this.withLeasedSource(key, create, use, true, signal);
  }

  private async withLeasedSource<Result>(
    key: string,
    create: (signal: AbortSignal) => Promise<Source>,
    use: (source: Source) => Promise<Result>,
    closeWhenIdle: boolean,
    signal: AbortSignal | undefined
  ): Promise<Result> {
    const requestGeneration = this.generation;
    this.assertRequestActive(requestGeneration, signal);
    const cached = await this.getOrCreateLeased(key, create, requestGeneration, signal);
    try {
      this.assertRequestActive(requestGeneration, signal);
      return await use(cached.source);
    } finally {
      cached.activeLeases -= 1;
      cached.lastAccess = this.now();
      if (closeWhenIdle && cached.activeLeases === 0 && this.sources.get(key) === cached) {
        this.sources.delete(key);
        await this.beginSourceClose(cached.source);
      }
      this.wakeCapacityWaiter(true);
    }
  }

  private async getOrCreateLeased(
    key: string,
    create: (signal: AbortSignal) => Promise<Source>,
    requestGeneration: number,
    signal: AbortSignal | undefined
  ): Promise<CachedGenomeSource<Source>> {
    this.assertRequestActive(requestGeneration, signal);
    const cached = this.sources.get(key);
    if (cached) {
      cached.activeLeases += 1;
      cached.lastAccess = this.now();
      return cached;
    }

    const existingPreparation = this.preparations.get(key);
    if (existingPreparation) {
      if (existingPreparation.controller.signal.aborted) {
        await this.waitForPreparationSettlement(key, existingPreparation, signal);
        return this.getOrCreateLeased(key, create, requestGeneration, signal);
      }
      return this.claimPreparation(key, existingPreparation, requestGeneration, signal);
    }

    const reservationGeneration =
      this.tryReserveSourceSlot(requestGeneration) ??
      (await this.reserveSourceSlot(requestGeneration, signal));
    let reservationOwned = true;
    try {
      this.assertRequestActive(requestGeneration, signal);

      const installed = this.sources.get(key);
      if (installed) {
        installed.activeLeases += 1;
        installed.lastAccess = this.now();
        return installed;
      }

      const joinedPreparation = this.preparations.get(key);
      if (joinedPreparation) {
        this.admissionReservations -= 1;
        reservationOwned = false;
        this.wakeCapacityWaiter(true);
        if (joinedPreparation.controller.signal.aborted) {
          await this.waitForPreparationSettlement(key, joinedPreparation, signal);
          return await this.getOrCreateLeased(key, create, requestGeneration, signal);
        }
        return await this.claimPreparation(key, joinedPreparation, requestGeneration, signal);
      }

      this.assertRequestActive(requestGeneration, signal);
      const controller = new AbortController();
      const preparation: GenomeSourcePreparation<Source> = {
        generation: reservationGeneration,
        controller,
        promise: this.prepareSource(key, reservationGeneration, controller.signal, create),
        claimers: 0,
        settled: false,
      };
      this.preparations.set(key, preparation);
      this.admissionReservations -= 1;
      reservationOwned = false;
      void preparation.promise.then(
        () => this.settlePreparation(key, preparation),
        () => this.settlePreparation(key, preparation)
      );
      return await this.claimPreparation(key, preparation, requestGeneration, signal);
    } finally {
      if (reservationOwned) {
        this.admissionReservations -= 1;
        this.wakeCapacityWaiter(true);
      }
    }
  }

  private async claimPreparation(
    key: string,
    preparation: GenomeSourcePreparation<Source>,
    requestGeneration: number,
    signal: AbortSignal | undefined
  ): Promise<CachedGenomeSource<Source>> {
    this.addPreparationClaimer(preparation);
    try {
      const cached = await this.waitForPromiseWithSignal(preparation.promise, signal);
      if (preparation.generation !== requestGeneration) {
        throw createSourceLifecycleClosedError();
      }
      this.assertRequestActive(requestGeneration, signal);
      cached.activeLeases += 1;
      cached.lastAccess = this.now();
      return cached;
    } finally {
      preparation.claimers -= 1;
      this.releasePreparationIfSettled(key, preparation);
    }
  }

  closeAll(): Promise<void> {
    if (this.closeBarrier) return this.closeBarrier;
    const barrier = this.performCloseAll();
    this.closeBarrier = barrier;
    void barrier.then(
      () => {
        if (this.closeBarrier === barrier) this.closeBarrier = null;
      },
      () => {
        if (this.closeBarrier === barrier) this.closeBarrier = null;
      }
    );
    return barrier;
  }

  private async performCloseAll(): Promise<void> {
    this.generation += 1;
    const cached = [...this.sources.values()];
    const preparations = [...this.preparations.values()];
    const pending = preparations.map(({ promise }) => promise);
    for (const preparation of preparations) {
      preparation.controller.abort(createSourceLifecycleClosedError());
    }
    this.sources.clear();
    this.preparations.clear();
    const sourcesToClose = new Set([
      ...cached.map(({ source }) => source),
      ...this.quarantinedSources.keys(),
    ]);
    for (const source of sourcesToClose) this.beginSourceClose(source);
    const closing = [...this.closingSources.values()];
    for (const wake of [...this.capacityWaiters]) wake(false);

    await Promise.allSettled([...pending, ...closing]);
    const closeFailures = [...this.quarantinedSources.values()];
    if (closeFailures.length > 0) {
      throw new AggregateError(closeFailures, 'One or more genome sources failed to close.');
    }
  }

  private async prepareSource(
    key: string,
    generation: number,
    signal: AbortSignal,
    create: (signal: AbortSignal) => Promise<Source>
  ): Promise<CachedGenomeSource<Source>> {
    const source = await create(signal);
    if (generation !== this.generation || signal.aborted) {
      await this.beginSourceClose(source);
      throw createSourceLifecycleClosedError();
    }

    const installed = this.sources.get(key);
    if (installed) {
      installed.lastAccess = this.now();
      await this.beginSourceClose(source);
      return installed;
    }

    const cached = { source, lastAccess: this.now(), activeLeases: 0 };
    this.sources.set(key, cached);
    return cached;
  }

  private async reserveSourceSlot(
    requestGeneration: number,
    signal: AbortSignal | undefined
  ): Promise<number> {
    for (;;) {
      this.assertRequestActive(requestGeneration, signal);
      const reservationGeneration = this.tryReserveSourceSlot(requestGeneration);
      if (reservationGeneration !== null) return reservationGeneration;
      const quarantined = this.quarantinedSources.keys().next().value;
      if (quarantined) {
        await this.beginSourceClose(quarantined);
        continue;
      }
      const evictable = [...this.sources.entries()]
        .filter(([key, cached]) => cached.activeLeases === 0 && !this.preparations.has(key))
        .sort((left, right) => left[1].lastAccess - right[1].lastAccess)[0];
      if (evictable) {
        this.sources.delete(evictable[0]);
        await this.beginSourceClose(evictable[1].source);
        this.assertRequestActive(requestGeneration, signal);
        const transferredReservation = this.tryReserveSourceSlot(requestGeneration);
        if (transferredReservation !== null) return transferredReservation;
        this.wakeCapacityWaiter(true);
        continue;
      }
      if (!(await this.waitForCapacity(signal))) {
        this.assertRequestActive(requestGeneration, signal);
        throw createSourceLifecycleClosedError();
      }
    }
  }

  private tryReserveSourceSlot(requestGeneration: number): number | null {
    if (requestGeneration !== this.generation) throw createSourceLifecycleClosedError();
    if (this.occupiedSourceSlots() >= this.maxOpenSources) return null;
    this.admissionReservations += 1;
    return requestGeneration;
  }

  private occupiedSourceSlots(): number {
    let preparingOnly = 0;
    for (const key of this.preparations.keys()) {
      if (!this.sources.has(key)) preparingOnly += 1;
    }
    return (
      this.sources.size +
      preparingOnly +
      this.closingSources.size +
      this.quarantinedSources.size +
      this.admissionReservations
    );
  }

  private waitForCapacity(signal: AbortSignal | undefined): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    if (this.capacityWaiters.size >= this.maxOpenSources * 4) {
      return Promise.reject(new Error('Genome source capacity queue is full.'));
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const wake: GenomeSourceCapacityWaiter = (capacityAvailable) => {
        if (settled) return;
        settled = true;
        this.capacityWaiters.delete(wake);
        signal?.removeEventListener('abort', onAbort);
        resolve(capacityAvailable);
      };
      const onAbort = () => wake(false);
      this.capacityWaiters.add(wake);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  private wakeCapacityWaiter(capacityAvailable: boolean): void {
    this.capacityWaiters.values().next().value?.(capacityAvailable);
  }

  private beginSourceClose(source: Source): Promise<void> {
    const existing = this.closingSources.get(source);
    if (existing) return existing;
    this.quarantinedSources.delete(source);
    const closing = Promise.resolve().then(() => source.close());
    this.closingSources.set(source, closing);
    void closing.then(
      () => {
        if (this.closingSources.get(source) === closing) this.closingSources.delete(source);
        this.quarantinedSources.delete(source);
        this.wakeCapacityWaiter(true);
      },
      (error: unknown) => {
        if (this.closingSources.get(source) === closing) this.closingSources.delete(source);
        this.quarantinedSources.set(source, normalizeSourceCloseError(error));
        this.wakeCapacityWaiter(true);
      }
    );
    return closing;
  }

  private assertRequestActive(requestGeneration: number, signal: AbortSignal | undefined): void {
    if (this.closeBarrier) throw createSourceLifecycleClosedError();
    if (requestGeneration !== this.generation) throw createSourceLifecycleClosedError();
    signal?.throwIfAborted();
  }

  private settlePreparation(key: string, preparation: GenomeSourcePreparation<Source>): void {
    preparation.settled = true;
    this.releasePreparationIfSettled(key, preparation);
  }

  private releasePreparationIfSettled(
    key: string,
    preparation: GenomeSourcePreparation<Source>
  ): void {
    if (preparation.claimers !== 0) return;
    if (!preparation.settled) {
      preparation.controller.abort(createSourceLifecycleClosedError());
      return;
    }
    if (this.preparations.get(key) === preparation) this.preparations.delete(key);
    this.wakeCapacityWaiter(true);
  }

  private addPreparationClaimer(preparation: GenomeSourcePreparation<Source>): void {
    if (preparation.claimers >= this.maxOpenSources * 4) {
      throw new Error('Genome source preparation claimant queue is full.');
    }
    preparation.claimers += 1;
  }

  private async waitForPreparationSettlement(
    key: string,
    preparation: GenomeSourcePreparation<Source>,
    signal: AbortSignal | undefined
  ): Promise<void> {
    this.addPreparationClaimer(preparation);
    try {
      await this.waitForPromiseWithSignal(
        preparation.promise.then(
          () => undefined,
          () => undefined
        ),
        signal
      );
    } finally {
      preparation.claimers -= 1;
      this.releasePreparationIfSettled(key, preparation);
    }
  }

  private async waitForPromiseWithSignal<Value>(
    promise: Promise<Value>,
    signal: AbortSignal | undefined
  ): Promise<Value> {
    if (!signal) return promise;
    signal.throwIfAborted();
    let rejectOnAbort: ((error: unknown) => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectOnAbort = reject;
    });
    const onAbort = (): void =>
      rejectOnAbort?.(
        signal.reason instanceof Error ? signal.reason : createSourceLifecycleClosedError()
      );
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      return await Promise.race([promise, aborted]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }
}
