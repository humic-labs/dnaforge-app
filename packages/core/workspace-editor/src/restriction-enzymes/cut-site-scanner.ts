import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type CutSite,
  type CutSiteWorkerRequest,
  type CutSiteWorkerResponse,
  type RestrictionEnzyme,
  type ThinCutSiteHit,
  scanAllStreaming,
  sortCutSitesByPosition,
} from '@waypoint/sequence-utils';
import CutSiteWorker from './cut-site-worker?worker&inline';

const DEBOUNCE_MS = 150;
const MAX_CACHE_ENTRIES = 256;

export type ScanPhase = 'idle' | 'scanning' | 'partial' | 'complete';

export interface CutSiteScanState {
  hits: CutSite[];
  phase: ScanPhase;
  progress: number;
  completedEnzymes: number;
  totalEnzymes: number;
  settled: boolean;
}

export interface CutSiteScannerControls {
  cancel: () => void;
}

interface CacheEntry {
  enzymeName: string;
  sequenceHash: string;
  scanLimitKey: string;
  hits: ThinCutSiteHit[];
}

class LruCache {
  private map = new Map<string, CacheEntry>();
  constructor(private readonly capacity: number) {}

  private key(enzymeName: string, sequenceHash: string, scanLimitKey: string): string {
    return `${enzymeName}\u0000${sequenceHash}\u0000${scanLimitKey}`;
  }

  get(enzymeName: string, sequenceHash: string, scanLimitKey: string): ThinCutSiteHit[] | null {
    const k = this.key(enzymeName, sequenceHash, scanLimitKey);
    const entry = this.map.get(k);
    if (!entry) return null;
    this.map.delete(k);
    this.map.set(k, entry);
    return entry.hits;
  }

  set(
    enzymeName: string,
    sequenceHash: string,
    scanLimitKey: string,
    hits: ThinCutSiteHit[]
  ): void {
    const k = this.key(enzymeName, sequenceHash, scanLimitKey);
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, { enzymeName, sequenceHash, scanLimitKey, hits });
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  clear() {
    this.map.clear();
  }
}

function fnv1aHash(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0') + '-' + str.length.toString(16);
}

interface WorkerHandle {
  worker: Worker;
  send: (msg: CutSiteWorkerRequest) => void;
  dispose: () => void;
}

function tryCreateWorker(onMessage: (msg: CutSiteWorkerResponse) => void): WorkerHandle | null {
  try {
    if (typeof Worker === 'undefined') return null;
    const w = new (CutSiteWorker as new () => Worker)();
    w.addEventListener('message', (e: MessageEvent<CutSiteWorkerResponse>) => onMessage(e.data));
    w.addEventListener('error', (e: ErrorEvent) => {
      console.warn('[cut-site-worker] worker error', e.message);
    });
    return {
      worker: w,
      send: (msg) => w.postMessage(msg),
      dispose: () => w.terminate(),
    };
  } catch (err) {
    console.warn('[cut-site-worker] could not start worker, falling back to main thread', err);
    return null;
  }
}

interface UseCutSiteScannerInput {
  sequence: string;
  circular?: boolean;
  activeEnzymes: RestrictionEnzyme[];
  maxHitsPerEnzyme?: number;
  debounceMs?: number;
}

interface ScannerInputsSnapshot {
  sequence: string;
  sequenceHash: string;
  scanLimitKey: string;
  enzymeNames: Set<string>;
}

export function useCutSiteScanner(
  input: UseCutSiteScannerInput
): [CutSiteScanState, CutSiteScannerControls] {
  const { sequence, activeEnzymes } = input;
  const circular = input.circular ?? false;
  const maxHitsPerEnzyme = input.maxHitsPerEnzyme;
  const debounceMs = input.debounceMs ?? DEBOUNCE_MS;
  const scanLimitKey = maxHitsPerEnzyme === undefined ? 'all' : String(maxHitsPerEnzyme);

  const activeNamesKey = useMemo(
    () =>
      activeEnzymes
        .map((e) => e.name)
        .sort()
        .join('\u0000'),
    [activeEnzymes]
  );

  const sequenceHash = useMemo(
    () => (sequence ? `${fnv1aHash(sequence)}:${circular ? 'circular' : 'linear'}` : ''),
    [sequence, circular]
  );

  const cacheRef = useRef<LruCache>(new LruCache(MAX_CACHE_ENTRIES));
  const liveHitsRef = useRef<Map<string, ThinCutSiteHit[]>>(new Map());
  const activeJobIdRef = useRef<number>(-1);
  const jobIdCounterRef = useRef<number>(0);
  const latestInputsRef = useRef<ScannerInputsSnapshot>({
    sequence,
    sequenceHash,
    scanLimitKey,
    enzymeNames: new Set(activeEnzymes.map((e) => e.name)),
  });
  latestInputsRef.current = {
    sequence,
    sequenceHash,
    scanLimitKey,
    enzymeNames: new Set(activeEnzymes.map((e) => e.name)),
  };

  const workerRef = useRef<WorkerHandle | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [version, setVersion] = useState(0);
  const [meta, setMeta] = useState<{
    phase: ScanPhase;
    progress: number;
    completedEnzymes: number;
    totalEnzymes: number;
  }>({ phase: 'idle', progress: 0, completedEnzymes: 0, totalEnzymes: 0 });

  const handleWorkerMessage = useCallback((msg: CutSiteWorkerResponse) => {
    if (msg.type === 'error') {
      console.warn('[cut-site-worker] scan error', msg.message);
      return;
    }
    if (msg.jobId !== activeJobIdRef.current) return;

    const inputs = latestInputsRef.current;

    if (msg.type === 'progress') {
      liveHitsRef.current.set(msg.enzymeName, msg.hits);
      setVersion((v) => v + 1);
      setMeta((m) => ({ ...m, phase: 'partial' }));
      return;
    }
    if (msg.type === 'enzyme-done') {
      const final = liveHitsRef.current.get(msg.enzymeName) ?? [];
      cacheRef.current.set(msg.enzymeName, inputs.sequenceHash, inputs.scanLimitKey, final);
      liveHitsRef.current.delete(msg.enzymeName);
      setVersion((v) => v + 1);
      setMeta((m) => ({
        ...m,
        completedEnzymes: msg.enzymeIndex + 1,
        totalEnzymes: msg.totalEnzymes,
        progress: msg.totalEnzymes > 0 ? (msg.enzymeIndex + 1) / msg.totalEnzymes : 1,
      }));
      return;
    }
    if (msg.type === 'done') {
      liveHitsRef.current.clear();
      setVersion((v) => v + 1);
      setMeta((m) => ({ ...m, phase: 'complete', progress: 1 }));
      return;
    }
    if (msg.type === 'cancelled') {
      liveHitsRef.current.clear();
      setVersion((v) => v + 1);
      const allCached = Array.from(inputs.enzymeNames).every((name) =>
        cacheRef.current.get(name, inputs.sequenceHash, inputs.scanLimitKey)
      );
      setMeta((m) => ({ ...m, phase: allCached ? 'complete' : 'idle' }));
      return;
    }
  }, []);

  useEffect(() => {
    if (!sequence || activeEnzymes.length === 0) {
      const oldId = activeJobIdRef.current;
      if (oldId !== -1 && workerRef.current) {
        workerRef.current.send({ type: 'cancel', jobId: oldId });
      }
      activeJobIdRef.current = -1;
      liveHitsRef.current.clear();
      setMeta({ phase: 'idle', progress: 0, completedEnzymes: 0, totalEnzymes: 0 });
      setVersion((v) => v + 1);
      return;
    }

    const cached: RestrictionEnzyme[] = [];
    const needScan: RestrictionEnzyme[] = [];
    for (const e of activeEnzymes) {
      if (cacheRef.current.get(e.name, sequenceHash, scanLimitKey)) cached.push(e);
      else needScan.push(e);
    }

    if (needScan.length === 0) {
      const oldId = activeJobIdRef.current;
      if (oldId !== -1 && workerRef.current) {
        workerRef.current.send({ type: 'cancel', jobId: oldId });
      }
      activeJobIdRef.current = -1;
      liveHitsRef.current.clear();
      setMeta({
        phase: 'complete',
        progress: 1,
        completedEnzymes: activeEnzymes.length,
        totalEnzymes: activeEnzymes.length,
      });
      setVersion((v) => v + 1);
      return;
    }

    const previousJobId = activeJobIdRef.current;
    const newJobId = ++jobIdCounterRef.current;
    activeJobIdRef.current = newJobId;
    if (workerRef.current && previousJobId !== -1) {
      workerRef.current.send({ type: 'cancel', jobId: previousJobId });
    }

    setMeta({
      phase: 'scanning',
      progress: cached.length / activeEnzymes.length,
      completedEnzymes: cached.length,
      totalEnzymes: activeEnzymes.length,
    });

    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      if (activeJobIdRef.current !== newJobId) return;
      const handle = workerRef.current ?? tryCreateWorker(handleWorkerMessage);
      workerRef.current = handle;
      if (handle) {
        handle.send({
          type: 'scan',
          jobId: newJobId,
          sequence,
          enzymes: needScan,
          circular,
          maxHitsPerEnzyme,
        });
      } else {
        runMainThreadScan({
          sequence,
          enzymes: needScan,
          jobId: newJobId,
          circular,
          maxHitsPerEnzyme,
          isStillActive: () => activeJobIdRef.current === newJobId,
          handler: handleWorkerMessage,
        });
      }
    }, debounceMs);

    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [
    sequence,
    sequenceHash,
    scanLimitKey,
    activeNamesKey,
    activeEnzymes,
    maxHitsPerEnzyme,
    circular,
    debounceMs,
    handleWorkerMessage,
  ]);

  useEffect(() => {
    return () => {
      workerRef.current?.dispose();
      workerRef.current = null;
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, []);

  const hits = useMemo((): CutSite[] => {
    if (!sequence || activeEnzymes.length === 0) return [];
    const out: CutSite[] = [];
    for (const enzyme of activeEnzymes) {
      const live = liveHitsRef.current.get(enzyme.name);
      const cached = cacheRef.current.get(enzyme.name, sequenceHash, scanLimitKey);
      const thin = live ?? cached ?? [];
      for (const t of thin) {
        out.push({
          enzyme,
          cutPositionTop: t.cutPositionTop,
          cutPositionBottom: t.cutPositionBottom,
          recognitionStart: t.recognitionStart,
          recognitionEnd: t.recognitionEnd,
          strand: t.strand,
        });
      }
    }
    return sortCutSitesByPosition(out);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sequence, sequenceHash, scanLimitKey, activeNamesKey, activeEnzymes, version]);

  const settled = useMemo(
    () =>
      !!sequence &&
      activeEnzymes.every((enzyme) =>
        cacheRef.current.get(enzyme.name, sequenceHash, scanLimitKey)
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `version` ticks when the cache fills.
    [sequence, sequenceHash, scanLimitKey, activeNamesKey, activeEnzymes, version]
  );

  const cancel = useCallback(() => {
    const oldId = activeJobIdRef.current;
    if (oldId !== -1 && workerRef.current) {
      workerRef.current.send({ type: 'cancel', jobId: oldId });
    }
    activeJobIdRef.current = -1;
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    liveHitsRef.current.clear();
    setMeta((m) => ({ ...m, phase: 'idle' }));
    setVersion((v) => v + 1);
  }, []);

  const state: CutSiteScanState = {
    hits,
    phase: meta.phase,
    progress: meta.progress,
    completedEnzymes: meta.completedEnzymes,
    totalEnzymes: meta.totalEnzymes,
    settled,
  };

  return [state, { cancel }];
}

interface MainThreadScanArgs {
  sequence: string;
  enzymes: RestrictionEnzyme[];
  jobId: number;
  circular: boolean;
  maxHitsPerEnzyme?: number;
  isStillActive: () => boolean;
  handler: (msg: CutSiteWorkerResponse) => void;
}

function runMainThreadScan(args: MainThreadScanArgs): void {
  const { sequence, enzymes, jobId, circular, maxHitsPerEnzyme, isStillActive, handler } = args;
  const yieldToEventLoop = () => new Promise<void>((res) => setTimeout(res, 0));
  scanAllStreaming(
    sequence,
    enzymes,
    {
      onProgress: (enzymeName, hits, enzymeIndex, totalEnzymes) => {
        if (!isStillActive()) return;
        handler({ type: 'progress', jobId, enzymeName, hits, enzymeIndex, totalEnzymes });
      },
      onEnzymeDone: (enzymeName, enzymeIndex, totalEnzymes) => {
        if (!isStillActive()) return;
        handler({ type: 'enzyme-done', jobId, enzymeName, enzymeIndex, totalEnzymes });
      },
      yieldToEventLoop,
      isCancelled: () => !isStillActive(),
    },
    { maxHitsPerEnzyme, circular }
  )
    .then(() => {
      if (!isStillActive()) {
        handler({ type: 'cancelled', jobId });
      } else {
        handler({ type: 'done', jobId });
      }
    })
    .catch((err: unknown) => {
      handler({
        type: 'error',
        jobId,
        message: err instanceof Error ? err.message : String(err),
      });
    });
}
