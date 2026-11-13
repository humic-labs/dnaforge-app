import { startTransition, useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import {
  geneticCodeKey,
  STANDARD_GENETIC_CODE_ID,
  type GeneticCodeSpec,
  type ORF,
} from '@waypoint/sequence-utils';
import { useSequenceStateOptional } from '../context';
import { findORFsCooperatively } from './cooperative-orf-detection';
import OrfWorker from './orf-worker?worker&inline';
import type { PackedORFResult, ORFWorkerRequest, ORFWorkerResponse } from './orf-worker-protocol';
import type {
  OrfComputeSource,
  OrfDetectionObservation,
  OrfObservationOptions,
  OrfPresentation,
  OrfRetirement,
} from './orf-observation';

const STORAGE_KEY_VISIBLE = 'waypoint-orf-visible';
const STORAGE_KEY_MIN_LENGTH = 'waypoint-orf-min-length';
const DEFAULT_MIN_LENGTH = 100;
const MAX_CACHE_ENTRIES = 6;
const LARGE_ORF_COMMIT_THRESHOLD = 5_000;
const LARGE_ORF_INTERACTION_QUIET_MS = 450;

type ORFDetectionResult =
  | { status: 'idle' | 'pending' | 'ready-empty' | 'cancelled'; error: null; detectedORFs: [] }
  | { status: 'ready-results'; error: null; detectedORFs: [ORF, ...ORF[]] }
  | { status: 'failed'; error: 'detector_error' | 'worker_error'; detectedORFs: [] };

export type UseORFsResult = ORFDetectionResult & {
  onOrfsPresented?: OrfPresentation['presented'];
  isVisible: boolean;
  toggleVisibility: () => void;
  minLength: number;
  setMinLength: (len: number) => void;
  retry: () => void;
};

type DetectionInputs = {
  sequence: string;
  minLength: number;
  geneticCodeKey: string;
};

type DetectionSnapshot = {
  jobId: number;
  inputs: DetectionInputs;
  result: ORFDetectionResult;
  onOrfsPresented?: OrfPresentation['presented'];
};

interface WorkerHandle {
  send: (msg: ORFWorkerRequest) => void;
  dispose: () => void;
}

interface CacheEntry extends DetectionInputs {
  orfs: ORF[];
}

function loadVisibility(): boolean {
  try {
    const stored = localStorage.getItem(STORAGE_KEY_VISIBLE);
    return stored === null ? false : stored === 'true';
  } catch {
    return false;
  }
}

function loadMinLength(): number {
  try {
    const stored = localStorage.getItem(STORAGE_KEY_MIN_LENGTH);
    if (stored !== null) {
      const value = parseInt(stored, 10);
      if (!isNaN(value) && value > 0) return value;
    }
  } catch {}
  return DEFAULT_MIN_LENGTH;
}

function sameInputs(a: DetectionInputs, b: DetectionInputs): boolean {
  return (
    a.sequence === b.sequence &&
    a.minLength === b.minLength &&
    a.geneticCodeKey === b.geneticCodeKey
  );
}

function getCachedORFs(cache: CacheEntry[], inputs: DetectionInputs): ORF[] | null {
  const index = cache.findIndex((entry) => sameInputs(entry, inputs));
  if (index === -1) return null;
  const [entry] = cache.splice(index, 1);
  cache.push(entry);
  return entry.orfs;
}

function setCachedORFs(cache: CacheEntry[], inputs: DetectionInputs, orfs: ORF[]) {
  const index = cache.findIndex((entry) => sameInputs(entry, inputs));
  if (index !== -1) cache.splice(index, 1);
  cache.push({ ...inputs, orfs });
  while (cache.length > MAX_CACHE_ENTRIES) cache.shift();
}

function unpackORFs(packed: PackedORFResult): ORF[] {
  const orfs: ORF[] = new Array(packed.starts.length);
  for (let i = 0; i < packed.starts.length; i++) {
    orfs[i] = {
      start: packed.starts[i],
      end: packed.ends[i],
      frame: packed.frames[i],
      strand: packed.strands[i] >= 0 ? '+' : '-',
      length: packed.lengths[i],
    };
  }
  return orfs;
}

function hasORFs(orfs: ORF[]): orfs is [ORF, ...ORF[]] {
  return orfs.length > 0;
}

function completedResult(orfs: ORF[]): ORFDetectionResult {
  return hasORFs(orfs)
    ? { status: 'ready-results', error: null, detectedORFs: orfs }
    : { status: 'ready-empty', error: null, detectedORFs: [] };
}

function tryCreateWorker(
  onMessage: (msg: ORFWorkerResponse) => void,
  onError: (handle: WorkerHandle) => void
): WorkerHandle | null {
  try {
    if (typeof Worker === 'undefined') return null;
    const worker = new OrfWorker();
    const handle: WorkerHandle = {
      send: (message) => worker.postMessage(message),
      dispose: () => worker.terminate(),
    };
    worker.addEventListener('message', (event: MessageEvent<ORFWorkerResponse>) =>
      onMessage(event.data)
    );
    worker.addEventListener('error', () => onError(handle));
    return handle;
  } catch {
    return null;
  }
}

function recordOrfDetectorEvent(event: string, detail: Record<string, unknown> = {}) {
  if (typeof window === 'undefined') return;
  const target = window as Window & {
    __webglExposeForTests?: boolean;
    __webglDiagnosticsEnabled?: boolean;
    __orfDetectorEvents?: Array<Record<string, unknown>>;
  };
  if (target.__webglExposeForTests !== true && target.__webglDiagnosticsEnabled !== true) return;
  const events = target.__orfDetectorEvents ?? (target.__orfDetectorEvents = []);
  events.push({ t: performance.now(), event, ...detail });
  if (events.length > 200) events.splice(0, events.length - 200);
}

export function useORFs(
  sequenceParam?: string,
  geneticCodeParam: GeneticCodeSpec = STANDARD_GENETIC_CODE_ID,
  observation?: OrfObservationOptions
): UseORFsResult {
  const codeKey = geneticCodeKey(geneticCodeParam);
  const [geneticCode, setGeneticCode] = useState<GeneticCodeSpec>(geneticCodeParam);
  if (geneticCodeKey(geneticCode) !== codeKey) setGeneticCode(geneticCodeParam);
  const sequenceState = useSequenceStateOptional();
  const sequence =
    sequenceParam !== undefined ? sequenceParam : (sequenceState?.currentSequence ?? '');
  const [isVisible, setIsVisible] = useState(loadVisibility);
  const [minLength, setMinLengthState] = useState(loadMinLength);
  const [requestEpoch, setRequestEpoch] = useState(0);
  const [snapshot, setSnapshot] = useState<DetectionSnapshot | null>(null);
  const workerRef = useRef<WorkerHandle | null>(null);
  const activeJobIdRef = useRef(-1);
  const jobIdCounterRef = useRef(0);
  const cacheRef = useRef<CacheEntry[]>([]);
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const jobInputsRef = useRef(new Map<number, DetectionInputs>());
  const lastUserInteractionTRef = useRef(0);
  const observationOptionsRef = useRef(observation);
  const observationRef = useRef<
    | { jobId: number; phase: 'detecting'; observation: OrfDetectionObservation }
    | { jobId: number; phase: 'presenting'; presentation: OrfPresentation }
    | null
  >(null);

  const settleObservation = useCallback(
    (jobId: number, settle: (current: OrfDetectionObservation) => OrfPresentation | void) => {
      const current = observationRef.current;
      if (!current || current.jobId !== jobId || current.phase !== 'detecting') return;
      observationRef.current = null;
      try {
        const presentation = settle(current.observation);
        if (!presentation) return;
        if (jobIdCounterRef.current !== jobId) presentation.retire('superseded');
        else if (!observationOptionsRef.current?.observationVisible)
          presentation.retire('view_hidden');
        else observationRef.current = { jobId, phase: 'presenting', presentation };
      } catch {}
    },
    []
  );

  const retireObservation = useCallback((reason: OrfRetirement) => {
    const current = observationRef.current;
    observationRef.current = null;
    if (!current) return;
    try {
      if (current.phase === 'detecting') current.observation.retire(reason);
      else current.presentation.retire(reason);
    } catch {}
  }, []);

  const startObservation = useCallback(
    (jobId: number, source: OrfComputeSource, length: number) => {
      const options = observationOptionsRef.current;
      if (!options?.observationVisible) return;
      try {
        const current = options.observeDetection?.({ source, sequenceLength: length });
        if (current) observationRef.current = { jobId, phase: 'detecting', observation: current };
      } catch {}
    },
    []
  );

  useLayoutEffect(() => {
    observationOptionsRef.current = observation;
    if (!observation?.observationVisible) retireObservation('view_hidden');
  }, [observation, retireObservation]);

  const cancelFallback = useCallback(() => {
    if (fallbackTimerRef.current !== null) clearTimeout(fallbackTimerRef.current);
    fallbackTimerRef.current = null;
  }, []);

  const cancelPendingCommit = useCallback(() => {
    if (commitTimerRef.current !== null) clearTimeout(commitTimerRef.current);
    commitTimerRef.current = null;
  }, []);

  const ownsJob = useCallback((jobId: number) => jobIdCounterRef.current === jobId, []);

  const commitDetectedORFs = useCallback(
    (orfs: ORF[], inputs: DetectionInputs, jobId: number) => {
      cancelPendingCommit();
      const current = observationRef.current;
      const onOrfsPresented: OrfPresentation['presented'] | undefined =
        current?.phase === 'presenting' && current.jobId === jobId
          ? (fact) => {
              if (
                observationRef.current !== current ||
                !ownsJob(jobId) ||
                !observationOptionsRef.current?.observationVisible ||
                (orfs.length === 0 ? fact.kind !== 'empty_model' : fact.kind !== 'orf_drawn')
              )
                return;
              observationRef.current = null;
              try {
                current.presentation.presented(fact);
              } catch {}
            }
          : undefined;
      const commit = () => {
        commitTimerRef.current = null;
        if (!ownsJob(jobId)) return;
        recordOrfDetectorEvent('commit', { count: orfs.length });
        startTransition(() => {
          setSnapshot((previous) =>
            ownsJob(jobId) && (!previous || previous.jobId <= jobId)
              ? { jobId, inputs, result: completedResult(orfs), onOrfsPresented }
              : previous
          );
        });
      };
      if (orfs.length < LARGE_ORF_COMMIT_THRESHOLD || typeof window === 'undefined') {
        commit();
        return;
      }
      const schedule = () => {
        if (!ownsJob(jobId)) return;
        const elapsed = performance.now() - lastUserInteractionTRef.current;
        const delay = Math.max(0, LARGE_ORF_INTERACTION_QUIET_MS - elapsed);
        if (delay <= 0) {
          commit();
          return;
        }
        recordOrfDetectorEvent('commit-deferred', { count: orfs.length, delay });
        commitTimerRef.current = setTimeout(schedule, delay);
      };
      schedule();
    },
    [cancelPendingCommit, ownsJob]
  );

  const handleWorkerMessage = useCallback(
    (message: ORFWorkerResponse) => {
      const inputs = jobInputsRef.current.get(message.jobId);
      if (message.jobId !== activeJobIdRef.current || !inputs || !ownsJob(message.jobId)) return;
      activeJobIdRef.current = -1;
      jobInputsRef.current.delete(message.jobId);
      if (message.type === 'error' || message.type === 'cancelled') {
        settleObservation(message.jobId, (current) => {
          if (message.type === 'error') current.failed('detector_error');
          else current.retire('detector_cancelled');
        });
        const result: ORFDetectionResult =
          message.type === 'error'
            ? { status: 'failed', error: 'detector_error', detectedORFs: [] }
            : { status: 'cancelled', error: null, detectedORFs: [] };
        recordOrfDetectorEvent(message.type, { jobId: message.jobId });
        setSnapshot({ jobId: message.jobId, inputs, result });
        return;
      }
      const orfs = message.orfs ?? (message.packed ? unpackORFs(message.packed) : []);
      setCachedORFs(cacheRef.current, inputs, orfs);
      settleObservation(message.jobId, (current) => current.detected(orfs.length));
      recordOrfDetectorEvent('done', {
        jobId: message.jobId,
        source: message.packed ? 'worker-packed' : 'array',
        count: orfs.length,
      });
      commitDetectedORFs(orfs, inputs, message.jobId);
    },
    [commitDetectedORFs, ownsJob, settleObservation]
  );

  const cancelActiveJob = useCallback(
    (reason: OrfRetirement = 'superseded') => {
      jobIdCounterRef.current += 1;
      retireObservation(reason);
      const previousJobId = activeJobIdRef.current;
      if (previousJobId !== -1) workerRef.current?.send({ type: 'cancel', jobId: previousJobId });
      activeJobIdRef.current = -1;
      jobInputsRef.current.clear();
      cancelFallback();
      cancelPendingCommit();
    },
    [cancelFallback, cancelPendingCommit, retireObservation]
  );

  const handleWorkerError = useCallback(
    (worker: WorkerHandle) => {
      if (workerRef.current !== worker) return;
      worker.dispose();
      workerRef.current = null;
      const jobId = activeJobIdRef.current;
      const inputs = jobInputsRef.current.get(jobId);
      activeJobIdRef.current = -1;
      jobInputsRef.current.delete(jobId);
      cancelFallback();
      if (!inputs || !ownsJob(jobId)) return;
      cancelPendingCommit();
      settleObservation(jobId, (current) => current.failed('worker_error'));
      recordOrfDetectorEvent('worker-error', { jobId });
      setSnapshot({
        jobId,
        inputs,
        result: { status: 'failed', error: 'worker_error', detectedORFs: [] },
      });
    },
    [cancelFallback, cancelPendingCommit, ownsJob, settleObservation]
  );

  useEffect(() => {
    workerRef.current = tryCreateWorker(handleWorkerMessage, handleWorkerError);
    recordOrfDetectorEvent(workerRef.current ? 'worker-created' : 'worker-fallback');
    return () => {
      cancelActiveJob('unmounted');
      workerRef.current?.dispose();
      workerRef.current = null;
    };
  }, [cancelActiveJob, handleWorkerError, handleWorkerMessage]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const markInteraction = () => {
      lastUserInteractionTRef.current = performance.now();
    };
    const options = { capture: true, passive: true };
    window.addEventListener('wheel', markInteraction, options);
    window.addEventListener('pointerdown', markInteraction, options);
    window.addEventListener('pointermove', markInteraction, options);
    window.addEventListener('keydown', markInteraction, { capture: true });
    return () => {
      window.removeEventListener('wheel', markInteraction, options);
      window.removeEventListener('pointerdown', markInteraction, options);
      window.removeEventListener('pointermove', markInteraction, options);
      window.removeEventListener('keydown', markInteraction, { capture: true });
    };
  }, []);

  useEffect(() => {
    cancelActiveJob();
    if (!isVisible || !sequence) {
      setSnapshot(null);
      return;
    }
    const inputs = { sequence, minLength, geneticCodeKey: codeKey };
    const jobId = ++jobIdCounterRef.current;
    const cached = getCachedORFs(cacheRef.current, inputs);
    const worker = workerRef.current;
    startObservation(
      jobId,
      cached !== null ? 'cache' : worker ? 'worker' : 'fallback',
      sequence.length
    );
    if (cached !== null) {
      settleObservation(jobId, (current) => current.detected(cached.length));
      commitDetectedORFs(cached, inputs, jobId);
      return;
    }
    activeJobIdRef.current = jobId;
    jobInputsRef.current.set(jobId, inputs);
    setSnapshot({ jobId, inputs, result: { status: 'pending', error: null, detectedORFs: [] } });
    if (worker) {
      recordOrfDetectorEvent('worker-detect-start', {
        jobId,
        sequenceLength: sequence.length,
        minLength,
      });
      try {
        worker.send({ type: 'detect', jobId, sequence, minLength, geneticCode });
      } catch {
        handleWorkerError(worker);
      }
      return;
    }
    fallbackTimerRef.current = setTimeout(async () => {
      fallbackTimerRef.current = null;
      if (!ownsJob(jobId)) return;
      try {
        recordOrfDetectorEvent('fallback-detect-start', {
          jobId,
          sequenceLength: sequence.length,
          minLength,
        });
        const orfs = await findORFsCooperatively(
          sequence,
          minLength,
          () => ownsJob(jobId),
          geneticCode
        );
        if (orfs) handleWorkerMessage({ type: 'done', jobId, orfs });
      } catch {
        handleWorkerMessage({ type: 'error', jobId, message: 'detector_error' });
      }
    }, 0);
  }, [
    cancelActiveJob,
    codeKey,
    commitDetectedORFs,
    geneticCode,
    handleWorkerError,
    handleWorkerMessage,
    isVisible,
    minLength,
    ownsJob,
    requestEpoch,
    sequence,
    settleObservation,
    startObservation,
  ]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY_VISIBLE, String(isVisible));
    } catch {}
  }, [isVisible]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY_MIN_LENGTH, String(minLength));
    } catch {}
  }, [minLength]);

  const retry = useCallback(() => {
    cancelActiveJob('retry');
    setRequestEpoch((previous) => previous + 1);
  }, [cancelActiveJob]);

  const toggleVisibility = useCallback(() => {
    cancelActiveJob('view_hidden');
    setIsVisible((previous) => !previous);
    setRequestEpoch((previous) => previous + 1);
  }, [cancelActiveJob]);

  const setMinLength = useCallback(
    (length: number) => {
      if (!(length > 0)) return;
      cancelActiveJob();
      setMinLengthState(length);
      setRequestEpoch((previous) => previous + 1);
    },
    [cancelActiveJob]
  );

  const result: ORFDetectionResult =
    !isVisible || !sequence
      ? { status: 'idle', error: null, detectedORFs: [] }
      : snapshot &&
          ownsJob(snapshot.jobId) &&
          sameInputs(snapshot.inputs, { sequence, minLength, geneticCodeKey: codeKey })
        ? snapshot.result
        : { status: 'pending', error: null, detectedORFs: [] };
  return {
    ...result,
    isVisible,
    toggleVisibility,
    minLength,
    setMinLength,
    retry,
    onOrfsPresented:
      observation?.observationVisible &&
      (result.status === 'ready-results' || result.status === 'ready-empty')
        ? snapshot?.onOrfsPresented
        : undefined,
  };
}
