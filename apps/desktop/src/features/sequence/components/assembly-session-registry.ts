import type {
  GenomeOpenSource,
  GenomeSessionShell,
  IndexedGenomeManifest,
} from '../../../shared/indexed-genome';

export interface AssemblySessionHandle {
  chrom: string;
  sessionId: string;
  sourceFingerprint: string;
  manifest: IndexedGenomeManifest;
}

export interface AssemblySessionChromConfig {
  chrom: string;
  source: GenomeOpenSource;
  manifest: IndexedGenomeManifest;
}

export interface AssemblySessionDriver {
  open(source: GenomeOpenSource): Promise<GenomeSessionShell>;
  closeSession(sessionId: string): Promise<unknown>;
  cancel(sessionId: string, requestId: string): Promise<unknown> | void;
}

export interface AssemblySessionRegistryOptions {
  driver: AssemblySessionDriver;
  chroms: ReadonlyArray<AssemblySessionChromConfig>;
  cap?: number;
  onError?: (chrom: string, err: unknown) => void;
  exposeDebug?: boolean;
}

type EntryStatus = 'idle' | 'opening' | 'open' | 'closed';

interface SessionEntry {
  chrom: string;
  config: AssemblySessionChromConfig;
  status: EntryStatus;
  handle: AssemblySessionHandle | null;
  openPromise: Promise<AssemblySessionHandle | null> | null;
  touch: number;
  inflight: Set<string>;
}

export const DEFAULT_ASSEMBLY_SESSION_CAP = 4;

export class AssemblySessionRegistry {
  private readonly driver: AssemblySessionDriver;
  private readonly cap: number;
  private readonly onError?: (chrom: string, err: unknown) => void;
  private readonly exposeDebug: boolean;
  private readonly entries = new Map<string, SessionEntry>();
  private touchSeq = 0;
  private disposed = false;
  private opens = 0;
  private closes = 0;
  private peakResident = 0;

  constructor(opts: AssemblySessionRegistryOptions) {
    this.driver = opts.driver;
    this.cap = Math.max(1, opts.cap ?? DEFAULT_ASSEMBLY_SESSION_CAP);
    this.onError = opts.onError;
    this.exposeDebug = opts.exposeDebug ?? false;
    for (const config of opts.chroms) {
      this.entries.set(config.chrom, {
        chrom: config.chrom,
        config,
        status: 'idle',
        handle: null,
        openPromise: null,
        touch: 0,
        inflight: new Set(),
      });
    }
    this.publishDebug();
  }

  knownChroms(): string[] {
    return [...this.entries.keys()];
  }

  residentChroms(): string[] {
    const out: string[] = [];
    for (const e of this.entries.values()) if (e.status === 'open') out.push(e.chrom);
    return out;
  }

  peek(chrom: string): AssemblySessionHandle | null {
    const e = this.entries.get(chrom);
    if (!e || e.status !== 'open' || !e.handle) return null;
    e.touch = ++this.touchSeq;
    return e.handle;
  }

  async ensure(chrom: string): Promise<AssemblySessionHandle | null> {
    if (this.disposed) return null;
    const e = this.entries.get(chrom);
    if (!e) return null;
    e.touch = ++this.touchSeq;

    if (e.status === 'open' && e.handle) return e.handle;
    if (e.status === 'opening' && e.openPromise) return e.openPromise;

    e.status = 'opening';
    const p = (async (): Promise<AssemblySessionHandle | null> => {
      try {
        const shell = await this.driver.open(e.config.source);
        if (this.disposed) {
          this.closes += 1;
          void this.safeClose(shell.sessionId, chrom);
          this.publishDebug();
          return null;
        }
        const handle: AssemblySessionHandle = {
          chrom,
          sessionId: shell.sessionId,
          sourceFingerprint: shell.sourceFingerprint,
          manifest: shell.manifest ?? e.config.manifest,
        };
        e.handle = handle;
        e.status = 'open';
        e.openPromise = null;
        this.opens += 1;
        this.evictIfNeeded(chrom);
        this.peakResident = Math.max(this.peakResident, this.residentChroms().length);
        this.publishDebug();
        return handle;
      } catch (err) {
        e.status = 'idle';
        e.openPromise = null;
        this.onError?.(chrom, err);
        this.publishDebug();
        return null;
      }
    })();
    e.openPromise = p;
    return p;
  }

  registerInflight(chrom: string, requestId: string): void {
    this.entries.get(chrom)?.inflight.add(requestId);
  }

  clearInflight(chrom: string, requestId: string): void {
    this.entries.get(chrom)?.inflight.delete(requestId);
  }

  cancelInflightOutside(visibleChroms: ReadonlySet<string>): void {
    for (const e of this.entries.values()) {
      if (visibleChroms.has(e.chrom)) continue;
      this.cancelEntryInflight(e);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const e of this.entries.values()) {
      this.cancelEntryInflight(e);
      if (e.status === 'open' && e.handle) {
        void this.safeClose(e.handle.sessionId, e.chrom);
        this.closes += 1;
      }
      e.status = 'closed';
      e.handle = null;
      e.openPromise = null;
    }
    this.publishDebug();
  }

  stats(): {
    resident: string[];
    cap: number;
    opens: number;
    closes: number;
    peakResident: number;
  } {
    return {
      resident: this.residentChroms(),
      cap: this.cap,
      opens: this.opens,
      closes: this.closes,
      peakResident: this.peakResident,
    };
  }

  private evictIfNeeded(keepChrom: string): void {
    let open = this.residentChroms();
    while (open.length > this.cap) {
      let victim: SessionEntry | null = null;
      for (const e of this.entries.values()) {
        if (e.status !== 'open' || e.chrom === keepChrom) continue;
        if (!victim || e.touch < victim.touch) victim = e;
      }
      if (!victim) break;
      this.cancelEntryInflight(victim);
      if (!victim.handle) break;
      void this.safeClose(victim.handle.sessionId, victim.chrom);
      this.closes += 1;
      victim.status = 'closed';
      victim.handle = null;
      open = this.residentChroms();
    }
  }

  private cancelEntryInflight(e: SessionEntry): void {
    if (e.inflight.size === 0) return;
    const sessionId = e.handle?.sessionId;
    for (const requestId of e.inflight) {
      if (sessionId) {
        try {
          void this.driver.cancel(sessionId, requestId);
        } catch {}
      }
    }
    e.inflight.clear();
  }

  private async safeClose(sessionId: string, chrom: string): Promise<void> {
    try {
      await this.driver.closeSession(sessionId);
    } catch (err) {
      this.onError?.(chrom, err);
    }
  }

  private publishDebug(): void {
    if (!this.exposeDebug || typeof window === 'undefined') return;
    (window as Window & { __assemblySessionDebug?: unknown }).__assemblySessionDebug = {
      resident: this.residentChroms(),
      cap: this.cap,
      opens: this.opens,
      closes: this.closes,
      peakResident: this.peakResident,
      known: this.knownChroms().length,
    };
  }
}
