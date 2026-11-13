interface ActiveGenomeSearchQuery {
  readonly webContentsId: number;
  readonly clientId: string;
  readonly requestId: string;
  readonly controller: AbortController;
  callerSettled: boolean;
  physicalStarted: boolean;
  physicalSettled: boolean;
  released: boolean;
}

export const MAX_ACTIVE_GENOME_SEARCH_QUERIES_PER_RENDERER = 8;
export const MAX_ACTIVE_GENOME_SEARCH_QUERIES = 32;

export class GenomeSearchQueryCapacity {
  private activeCount = 0;
  private readonly rendererCounts = new Map<number, number>();

  constructor(
    private readonly maxPerRenderer = MAX_ACTIVE_GENOME_SEARCH_QUERIES_PER_RENDERER,
    private readonly maxActive = MAX_ACTIVE_GENOME_SEARCH_QUERIES
  ) {
    if (!Number.isInteger(maxPerRenderer) || maxPerRenderer < 1) {
      throw new Error('Genome search per-renderer capacity must be a positive integer.');
    }
    if (!Number.isInteger(maxActive) || maxActive < maxPerRenderer) {
      throw new Error('Genome search global capacity must cover one renderer.');
    }
  }

  acquire(webContentsId: number): void {
    if (this.activeCount >= this.maxActive) {
      throw new Error('[genome] Active search query capacity is full.');
    }
    const rendererCount = this.rendererCounts.get(webContentsId) ?? 0;
    if (rendererCount >= this.maxPerRenderer) {
      throw new Error('[genome] Renderer search query capacity is full.');
    }
    this.activeCount += 1;
    this.rendererCounts.set(webContentsId, rendererCount + 1);
  }

  release(webContentsId: number): void {
    const rendererCount = this.rendererCounts.get(webContentsId);
    if (rendererCount === undefined) return;
    this.activeCount = Math.max(0, this.activeCount - 1);
    if (rendererCount === 1) {
      this.rendererCounts.delete(webContentsId);
    } else {
      this.rendererCounts.set(webContentsId, rendererCount - 1);
    }
  }

  activeCountForTests(): number {
    return this.activeCount;
  }
}

export interface AssemblyAnnotationQueryLease {
  readonly signal: AbortSignal;
  readonly physicalLifecycle: {
    started(): void;
    settled(): void;
  };
  complete(): void;
}

export class GenomeSearchQueryLifecycle {
  private readonly active = new Map<string, ActiveGenomeSearchQuery>();
  private readonly unsettled = new Set<ActiveGenomeSearchQuery>();

  constructor(private readonly capacity = new GenomeSearchQueryCapacity()) {}

  begin(webContentsId: number, clientId: string, requestId: string): AssemblyAnnotationQueryLease {
    const key = ownerKey(webContentsId, clientId);
    const predecessor = this.active.get(key);
    this.capacity.acquire(webContentsId);
    if (predecessor) this.abort(predecessor, 'superseded genome search query');
    const active: ActiveGenomeSearchQuery = {
      webContentsId,
      clientId,
      requestId,
      controller: new AbortController(),
      callerSettled: false,
      physicalStarted: false,
      physicalSettled: false,
      released: false,
    };
    this.active.set(key, active);
    this.unsettled.add(active);
    return {
      signal: active.controller.signal,
      physicalLifecycle: {
        started: () => {
          if (active.released) {
            throw new Error('Genome search physical work started after caller completion.');
          }
          active.physicalStarted = true;
        },
        settled: () => {
          active.physicalSettled = true;
          this.releaseIfSettled(active);
        },
      },
      complete: () => {
        if (active.callerSettled) return;
        active.callerSettled = true;
        if (this.active.get(key) === active) this.active.delete(key);
        this.releaseIfSettled(active);
      },
    };
  }

  cancel(webContentsId: number, clientId: string, requestId: string): boolean {
    const key = ownerKey(webContentsId, clientId);
    const active = this.active.get(key);
    if (!active || active.requestId !== requestId) return false;
    this.active.delete(key);
    this.abort(active, 'cancelled genome search query');
    return true;
  }

  cancelWebContents(webContentsId: number): void {
    for (const active of this.unsettled) {
      if (active.webContentsId !== webContentsId) continue;
      const key = ownerKey(active.webContentsId, active.clientId);
      if (this.active.get(key) === active) this.active.delete(key);
      this.abort(active, 'genome search owner was destroyed');
    }
  }

  dispose(): void {
    for (const active of this.unsettled) {
      this.abort(active, 'genome search runtime disposed');
    }
    this.active.clear();
  }

  activeCountForTests(): number {
    return this.active.size;
  }

  unsettledCountForTests(): number {
    return this.unsettled.size;
  }

  private abort(active: ActiveGenomeSearchQuery | undefined, message: string): void {
    if (!active || active.controller.signal.aborted) return;
    const error = new Error(message);
    error.name = 'AbortError';
    active.controller.abort(error);
  }

  private releaseIfSettled(active: ActiveGenomeSearchQuery): void {
    if (
      active.released ||
      !active.callerSettled ||
      (active.physicalStarted && !active.physicalSettled)
    ) {
      return;
    }
    active.released = true;
    this.unsettled.delete(active);
    this.capacity.release(active.webContentsId);
  }
}

function ownerKey(webContentsId: number, clientId: string): string {
  return `${webContentsId}:${clientId}`;
}

export { GenomeSearchQueryLifecycle as AssemblyAnnotationSearchQueryLifecycle };

const sharedGenomeSearchQueryCapacity = new GenomeSearchQueryCapacity();

export const assemblyAnnotationSearchQueryLifecycle = new GenomeSearchQueryLifecycle(
  sharedGenomeSearchQueryCapacity
);
export const assemblyProteinSearchQueryLifecycle = new GenomeSearchQueryLifecycle(
  sharedGenomeSearchQueryCapacity
);
export const sequenceSearchQueryLifecycle = new GenomeSearchQueryLifecycle(
  sharedGenomeSearchQueryCapacity
);

export const genomeSearchQueryLifecycle = sequenceSearchQueryLifecycle;

export function disposeGenomeSearchQueryLifecycles(): void {
  assemblyAnnotationSearchQueryLifecycle.dispose();
  assemblyProteinSearchQueryLifecycle.dispose();
  sequenceSearchQueryLifecycle.dispose();
}
