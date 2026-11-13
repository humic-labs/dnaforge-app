/**
 * @vitest-environment jsdom
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { startTransition, Suspense, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useORFs } from './useORFs';
import type { ORFWorkerRequest, ORFWorkerResponse } from './orf-worker-protocol';
import type { ObserveOrfDetection, OrfFailure, OrfRetirement } from './orf-observation';

const workerMock = vi.hoisted(() => {
  class MockWorker extends EventTarget {
    static instances: MockWorker[] = [];
    static failConstruction = false;
    readonly messages: ORFWorkerRequest[] = [];
    terminated = false;

    constructor() {
      super();
      if (MockWorker.failConstruction) throw new Error('controlled constructor failure');
      MockWorker.instances.push(this);
    }

    postMessage(message: ORFWorkerRequest) {
      this.messages.push(message);
    }

    terminate() {
      this.terminated = true;
    }

    emit(message: ORFWorkerResponse) {
      this.dispatchEvent(new MessageEvent('message', { data: message }));
    }

    fail() {
      this.dispatchEvent(
        new ErrorEvent('error', { message: 'controlled worker transport failure' })
      );
    }
  }

  return { MockWorker };
});

vi.mock('./orf-worker?worker&inline', () => ({
  default: workerMock.MockWorker,
}));

const ORF_A = [{ start: 0, end: 104, frame: 1, strand: '+' as const, length: 105 }];
const ORF_B = [{ start: 9, end: 122, frame: 1, strand: '+' as const, length: 114 }];

function packForTest(orfs: typeof ORF_A) {
  return {
    starts: new Int32Array(orfs.map((orf) => orf.start)),
    ends: new Int32Array(orfs.map((orf) => orf.end)),
    frames: new Int8Array(orfs.map((orf) => orf.frame)),
    strands: new Int8Array(orfs.map((orf) => (orf.strand === '+' ? 1 : -1))),
    lengths: new Int32Array(orfs.map((orf) => orf.length)),
  };
}

function currentDetection() {
  const worker = workerMock.MockWorker.instances.at(-1);
  const request = worker?.messages.filter((message) => message.type === 'detect').at(-1);
  if (!worker || request?.type !== 'detect') throw new Error('Expected a detector request');
  return { worker, request };
}

function observationMock() {
  return {
    detected: vi.fn<(count: number) => void>(),
    failed: vi.fn<(reason: OrfFailure) => void>(),
    retire: vi.fn<(reason: OrfRetirement) => void>(),
  };
}

function detectionObserverForTest() {
  const observations: ReturnType<typeof observationMock>[] = [];
  const observeDetection = vi.fn<ObserveOrfDetection>(() => {
    const current = observationMock();
    observations.push(current);
    return current;
  });
  return { observations, observeDetection };
}

describe('useORFs', () => {
  const originalWorker = globalThis.Worker;

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('waypoint-orf-visible', 'true');
    workerMock.MockWorker.instances.length = 0;
    workerMock.MockWorker.failConstruction = false;
    vi.stubGlobal('Worker', workerMock.MockWorker);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalWorker === undefined) {
      Reflect.deleteProperty(globalThis, 'Worker');
    } else {
      globalThis.Worker = originalWorker;
    }
  });

  it('presents only the current committed ORF result and retires replaced presentation', () => {
    const presented = vi.fn();
    const retirePresentation = vi.fn();
    const observeDetection = vi.fn(() => ({
      detected: vi.fn(() => ({ presented, retire: retirePresentation })),
      failed: vi.fn(),
      retire: vi.fn(),
    }));
    const { result, rerender } = renderHook(
      ({ sequence }) => useORFs(sequence, 1, { observeDetection, observationVisible: true }),
      { initialProps: { sequence: 'ATG'.repeat(100) + 'TAA' } }
    );
    expect(Reflect.get(result.current, 'onOrfsPresented')).toBeUndefined();
    const first = currentDetection();
    act(() => first.worker.emit({ type: 'done', jobId: first.request.jobId, orfs: ORF_A }));
    const stale = Reflect.get(result.current, 'onOrfsPresented');
    expect(stale).toBeTypeOf('function');
    if (typeof stale !== 'function') throw new Error('Expected a ready presentation capability');
    rerender({ sequence: 'ATG'.repeat(101) + 'TAA' });
    expect(retirePresentation).toHaveBeenCalledExactlyOnceWith('superseded');
    act(() => stale({ kind: 'orf_drawn', surface: 'sequence_canvas' }));
    expect(presented).not.toHaveBeenCalled();
    const second = currentDetection();
    act(() => second.worker.emit({ type: 'done', jobId: second.request.jobId, orfs: ORF_B }));
    const current = Reflect.get(result.current, 'onOrfsPresented');
    expect(current).toBeTypeOf('function');
    if (typeof current !== 'function')
      throw new Error('Expected a current presentation capability');
    act(() => current({ kind: 'empty_model', surface: 'sequence_canvas' }));
    expect(presented).not.toHaveBeenCalled();
    act(() => current({ kind: 'orf_drawn', surface: 'sequence_tracks' }));
    act(() => current({ kind: 'orf_drawn', surface: 'plasmid_map' }));
    expect(presented).toHaveBeenCalledExactlyOnceWith({
      kind: 'orf_drawn',
      surface: 'sequence_tracks',
    });
    expect(result.current.detectedORFs).toEqual(ORF_B);
  });

  it('gives valid empty cache readmissions distinct presentation capabilities', () => {
    const presentations: Array<{
      presented: ReturnType<typeof vi.fn>;
      retire: ReturnType<typeof vi.fn>;
    }> = [];
    const observeDetection = vi.fn(() => ({
      detected: vi.fn(() => {
        const presentation = { presented: vi.fn(), retire: vi.fn() };
        presentations.push(presentation);
        return presentation;
      }),
      failed: vi.fn(),
      retire: vi.fn(),
    }));
    const { result } = renderHook(() =>
      useORFs('CCC'.repeat(50), 1, { observeDetection, observationVisible: true })
    );
    const job = currentDetection();
    act(() => job.worker.emit({ type: 'done', jobId: job.request.jobId, orfs: [] }));
    const first = result.current.onOrfsPresented;
    expect(first).toBeTypeOf('function');
    act(() => first?.({ kind: 'orf_drawn', surface: 'plasmid_map' }));
    expect(presentations[0].presented).not.toHaveBeenCalled();
    act(() => first?.({ kind: 'empty_model', surface: 'sequence_canvas' }));
    expect(presentations[0].presented).toHaveBeenCalledExactlyOnceWith({
      kind: 'empty_model',
      surface: 'sequence_canvas',
    });
    act(() => result.current.toggleVisibility());
    act(() => result.current.toggleVisibility());
    expect(result.current.status).toBe('ready-empty');
    expect(result.current.onOrfsPresented).not.toBe(first);
    expect(presentations).toHaveLength(2);
    act(() =>
      result.current.onOrfsPresented?.({ kind: 'empty_model', surface: 'sequence_tracks' })
    );
    expect(presentations[1].presented).toHaveBeenCalledExactlyOnceWith({
      kind: 'empty_model',
      surface: 'sequence_tracks',
    });
    expect(job.worker.messages.filter((message) => message.type === 'detect')).toHaveLength(1);
  });

  it('retires a ready presentation on host hide without changing the physical result', () => {
    const presented = vi.fn();
    const retire = vi.fn();
    const observeDetection = vi.fn(() => ({
      detected: () => ({ presented, retire }),
      failed: vi.fn(),
      retire: vi.fn(),
    }));
    const { result, rerender, unmount } = renderHook(
      ({ visible }) =>
        useORFs('ATG'.repeat(100) + 'TAA', 1, { observeDetection, observationVisible: visible }),
      { initialProps: { visible: true } }
    );
    const job = currentDetection();
    act(() => job.worker.emit({ type: 'done', jobId: job.request.jobId, orfs: ORF_A }));
    const callback = result.current.onOrfsPresented;
    expect(callback).toBeTypeOf('function');
    rerender({ visible: false });
    expect(retire).toHaveBeenCalledExactlyOnceWith('view_hidden');
    expect(result.current.onOrfsPresented).toBeUndefined();
    expect(result.current.detectedORFs).toEqual(ORF_A);
    rerender({ visible: true });
    act(() => callback?.({ kind: 'orf_drawn', surface: 'sequence_canvas' }));
    expect(presented).not.toHaveBeenCalled();
    expect(observeDetection).toHaveBeenCalledTimes(1);
    unmount();
    expect(retire).toHaveBeenCalledTimes(1);
  });

  it.each(['presented', 'retire'] as const)(
    'isolates a throwing presentation %s from physical detector state',
    (method) => {
      const presentation = { presented: vi.fn(), retire: vi.fn() };
      presentation[method].mockImplementation(() => {
        throw new Error('controlled presentation failure');
      });
      const observeDetection = () => ({
        detected: () => presentation,
        failed: vi.fn(),
        retire: vi.fn(),
      });
      const { result } = renderHook(() =>
        useORFs('ATG'.repeat(100) + 'TAA', 1, { observeDetection, observationVisible: true })
      );
      const job = currentDetection();
      act(() => job.worker.emit({ type: 'done', jobId: job.request.jobId, orfs: ORF_A }));
      if (method === 'presented')
        act(() =>
          result.current.onOrfsPresented?.({ kind: 'orf_drawn', surface: 'sequence_canvas' })
        );
      else act(() => result.current.retry());
      expect(presentation[method]).toHaveBeenCalledTimes(1);
      if (method === 'presented') expect(result.current.detectedORFs).toEqual(ORF_A);
      else expect(result.current.status).toBe('ready-results');
    }
  );

  it('observes one accepted detector generation before work and one owned result', () => {
    let requestsAtAdmission = -1;
    const detected = vi.fn();
    const failed = vi.fn();
    const retire = vi.fn();
    const observeDetection = vi.fn(() => {
      requestsAtAdmission = workerMock.MockWorker.instances[0].messages.length;
      return { detected, failed, retire };
    });
    const sequence = 'ATG'.repeat(100) + 'TAA';
    const { result } = renderHook(() =>
      useORFs(sequence, 1, { observeDetection, observationVisible: true })
    );
    expect(observeDetection).toHaveBeenCalledExactlyOnceWith({
      source: 'worker',
      sequenceLength: sequence.length,
    });
    expect(requestsAtAdmission).toBe(0);
    const job = currentDetection();
    act(() => job.worker.emit({ type: 'done', jobId: job.request.jobId, orfs: ORF_A }));
    act(() => job.worker.emit({ type: 'done', jobId: job.request.jobId, orfs: ORF_B }));
    expect(detected).toHaveBeenCalledExactlyOnceWith(1);
    expect(failed).not.toHaveBeenCalled();
    expect(retire).not.toHaveBeenCalled();
    expect(result.current.detectedORFs).toEqual(ORF_A);
  });

  it.each([
    { orfs: ORF_A, count: 1 },
    { orfs: [], count: 0 },
  ])(
    'observes cache readmission with $count results without posting new work',
    ({ orfs, count }) => {
      const { observations, observeDetection } = detectionObserverForTest();
      const { result } = renderHook(() =>
        useORFs('ATG'.repeat(100) + 'TAA', 1, {
          observeDetection,
          observationVisible: true,
        })
      );
      const job = currentDetection();
      act(() => job.worker.emit({ type: 'done', jobId: job.request.jobId, orfs }));
      expect(observations[0].detected).toHaveBeenCalledExactlyOnceWith(count);
      act(() => result.current.toggleVisibility());
      act(() => result.current.toggleVisibility());
      expect(observeDetection).toHaveBeenCalledTimes(2);
      expect(observeDetection).toHaveBeenLastCalledWith({ source: 'cache', sequenceLength: 303 });
      expect(observations[1].detected).toHaveBeenCalledExactlyOnceWith(count);
      expect(observations[0].retire).not.toHaveBeenCalled();
      expect(job.worker.messages.filter((message) => message.type === 'detect')).toHaveLength(1);
      expect(result.current.status).toBe(count ? 'ready-results' : 'ready-empty');
    }
  );

  it('observes worker failure and a distinct real fallback retry without reviving the old result', async () => {
    const { observations, observeDetection } = detectionObserverForTest();
    const { result } = renderHook(() =>
      useORFs('ATG'.repeat(40) + 'TAA', 1, { observeDetection, observationVisible: true })
    );
    const old = currentDetection();
    act(() => old.worker.fail());
    expect(observations[0].failed).toHaveBeenCalledExactlyOnceWith('worker_error');
    expect(result.current.status).toBe('failed');
    act(() => result.current.retry());
    expect(observeDetection).toHaveBeenLastCalledWith({ source: 'fallback', sequenceLength: 123 });
    await waitFor(() => expect(result.current.status).toBe('ready-results'));
    expect(observations[1].detected).toHaveBeenCalledExactlyOnceWith(1);
    act(() => old.worker.emit({ type: 'done', jobId: old.request.jobId, orfs: ORF_B }));
    expect(observations[0].detected).not.toHaveBeenCalled();
    expect(observations[0].retire).not.toHaveBeenCalled();
    expect(observations[1].detected).toHaveBeenCalledTimes(1);
    expect(result.current.detectedORFs[0].start).toBe(0);
  });

  it('observes finite detector errors and current cancellation as distinct terminals', () => {
    const { observations, observeDetection } = detectionObserverForTest();
    const { result } = renderHook(() =>
      useORFs('CCC'.repeat(50), 2, { observeDetection, observationVisible: true })
    );
    const first = currentDetection();
    act(() =>
      first.worker.emit({ type: 'error', jobId: first.request.jobId, message: 'private error' })
    );
    expect(observations[0].failed).toHaveBeenCalledExactlyOnceWith('detector_error');
    act(() => result.current.retry());
    const second = currentDetection();
    act(() => second.worker.emit({ type: 'cancelled', jobId: second.request.jobId }));
    act(() => second.worker.emit({ type: 'done', jobId: second.request.jobId, orfs: ORF_A }));
    expect(observations[1].retire).toHaveBeenCalledExactlyOnceWith('detector_cancelled');
    expect(observations[1].detected).not.toHaveBeenCalled();
    expect(observations[1].failed).not.toHaveBeenCalled();
    expect(result.current.status).toBe('cancelled');
  });

  it('retires pending observations once for source replacement retry hide and unmount', () => {
    const { observations, observeDetection } = detectionObserverForTest();
    const { result, rerender, unmount } = renderHook(
      ({ sequence }) => useORFs(sequence, 1, { observeDetection, observationVisible: true }),
      { initialProps: { sequence: 'ATG'.repeat(100) + 'TAA' } }
    );
    const old = currentDetection();
    rerender({ sequence: 'CCC'.repeat(120) });
    expect(observations[0].retire).toHaveBeenCalledExactlyOnceWith('superseded');
    act(() => old.worker.emit({ type: 'done', jobId: old.request.jobId, orfs: ORF_A }));
    expect(observations[0].detected).not.toHaveBeenCalled();
    act(() => result.current.retry());
    expect(observations[1].retire).toHaveBeenCalledExactlyOnceWith('retry');
    act(() => result.current.toggleVisibility());
    expect(observations[2].retire).toHaveBeenCalledExactlyOnceWith('view_hidden');
    act(() => result.current.toggleVisibility());
    expect(observations).toHaveLength(4);
    unmount();
    expect(observations[3].retire).toHaveBeenCalledExactlyOnceWith('unmounted');
  });

  it('retires hidden host observation without cancelling computation or reconstructing a start', () => {
    const { observations, observeDetection } = detectionObserverForTest();
    const { result, rerender } = renderHook(
      ({ visible }) =>
        useORFs('ATG'.repeat(100) + 'TAA', 1, {
          observeDetection,
          observationVisible: visible,
        }),
      { initialProps: { visible: true } }
    );
    const job = currentDetection();
    rerender({ visible: false });
    expect(observations[0].retire).toHaveBeenCalledExactlyOnceWith('view_hidden');
    expect(job.worker.messages).toHaveLength(1);
    expect(workerMock.MockWorker.instances).toHaveLength(1);
    act(() => job.worker.emit({ type: 'done', jobId: job.request.jobId, orfs: ORF_A }));
    expect(result.current.detectedORFs).toEqual(ORF_A);
    expect(observations[0].detected).not.toHaveBeenCalled();
    rerender({ visible: true });
    expect(observeDetection).toHaveBeenCalledTimes(1);
    expect(job.worker.messages).toHaveLength(1);
    act(() => result.current.retry());
    expect(observeDetection).toHaveBeenCalledTimes(2);
    expect(observeDetection).toHaveBeenLastCalledWith({ source: 'cache', sequenceLength: 303 });
    expect(observations[1].detected).toHaveBeenCalledExactlyOnceWith(1);
    expect(job.worker.messages).toHaveLength(1);
  });

  it.each(['start', 'detected', 'failed', 'retire'] as const)(
    'isolates a throwing observation %s from physical detector state',
    (boundary) => {
      const current = observationMock();
      const failObservation = () => {
        throw new Error('controlled observation failure');
      };
      if (boundary !== 'start') current[boundary].mockImplementation(failObservation);
      const observeDetection = vi.fn<ObserveOrfDetection>(() => {
        if (boundary === 'start') failObservation();
        return current;
      });
      const { result, rerender } = renderHook(
        ({ sequence }) => useORFs(sequence, 1, { observeDetection, observationVisible: true }),
        { initialProps: { sequence: 'ATG'.repeat(100) + 'TAA' } }
      );
      let job = currentDetection();
      if (boundary === 'retire') {
        rerender({ sequence: 'CCC'.repeat(120) });
        expect(job.worker.messages).toContainEqual({ type: 'cancel', jobId: job.request.jobId });
        job = currentDetection();
      }
      if (boundary === 'failed') {
        act(() => job.worker.fail());
        expect(result.current.status).toBe('failed');
        expect(result.current.error).toBe('worker_error');
      } else {
        act(() => job.worker.emit({ type: 'done', jobId: job.request.jobId, orfs: ORF_A }));
        expect(result.current.status).toBe('ready-results');
        expect(result.current.detectedORFs).toEqual(ORF_A);
      }
    }
  );

  it('does not run ORF detection synchronously during render when worker fallback is needed', async () => {
    Reflect.deleteProperty(globalThis, 'Worker');

    const { result } = renderHook(() => useORFs('ATG'.repeat(40) + 'TAA'));

    expect(result.current.detectedORFs).toEqual([]);

    await waitFor(() => expect(result.current.detectedORFs).toHaveLength(1));
    expect(result.current.detectedORFs[0]).toMatchObject({
      start: 0,
      end: 122,
      frame: 1,
      strand: '+',
      length: 123,
    });
  });

  it('drops stale worker results when the sequence changes before an older job completes', async () => {
    globalThis.Worker = workerMock.MockWorker as unknown as typeof Worker;

    const { result, rerender } = renderHook(({ sequence }) => useORFs(sequence), {
      initialProps: { sequence: 'ATG'.repeat(100) + 'TAA' },
    });

    await waitFor(() => expect(workerMock.MockWorker.instances[0]?.messages.length).toBe(1));
    const worker = workerMock.MockWorker.instances[0];
    const firstDetect = worker.messages[0] as { type: 'detect'; jobId: number };
    expect(firstDetect.type).toBe('detect');

    rerender({ sequence: 'ATG'.repeat(120) + 'TAA' });

    await waitFor(() => expect(worker.messages.length).toBe(3));
    const secondDetect = worker.messages[2] as { type: 'detect'; jobId: number };
    expect(worker.messages[1]).toEqual({ type: 'cancel', jobId: firstDetect.jobId });
    expect(secondDetect.type).toBe('detect');

    act(() => {
      worker.emit({ type: 'done', jobId: firstDetect.jobId, orfs: ORF_A });
    });
    expect(result.current.detectedORFs).toEqual([]);

    act(() => {
      worker.emit({ type: 'done', jobId: secondDetect.jobId, packed: packForTest(ORF_B) });
    });
    expect(result.current.detectedORFs).toEqual(ORF_B);
  });

  it('settles a real ErrorEvent and retries through the real cooperative path', async () => {
    vi.stubGlobal('Worker', workerMock.MockWorker);
    const { result } = renderHook(() => useORFs('ATG'.repeat(40) + 'TAA'));
    const { worker, request } = currentDetection();
    act(() => worker.fail());
    expect(worker.terminated).toBe(true);
    expect(result.current.status).toBe('failed');
    expect(result.current.error).toBe('worker_error');
    expect(result.current.detectedORFs).toEqual([]);
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe('ready-results'));
    expect(result.current.detectedORFs).toEqual([
      { start: 0, end: 122, frame: 1, strand: '+', length: 123 },
    ]);
    act(() => worker.emit({ type: 'done', jobId: request.jobId, orfs: ORF_B }));
    expect(result.current.detectedORFs[0].start).toBe(0);
  });

  it('separates valid zero, typed failure and cancellation, and retries the same inputs', () => {
    const sequence = 'CCC'.repeat(50);
    const { result } = renderHook(() => useORFs(sequence, 2));
    expect(result.current.status).toBe('pending');
    let job = currentDetection();
    act(() =>
      job.worker.emit({
        type: 'error',
        jobId: job.request.jobId,
        message: 'controlled detector failure',
      })
    );
    expect(result.current.status).toBe('failed');
    expect(result.current.error).toBe('detector_error');
    act(() => result.current.retry());
    job = currentDetection();
    expect(job.request).toMatchObject({ sequence, geneticCode: 2, minLength: 100 });
    act(() => job.worker.emit({ type: 'cancelled', jobId: job.request.jobId }));
    expect(result.current.status).toBe('cancelled');
    expect(result.current.error).toBeNull();
    act(() => result.current.retry());
    job = currentDetection();
    act(() => job.worker.emit({ type: 'done', jobId: job.request.jobId, orfs: [] }));
    expect(result.current.status).toBe('ready-empty');
    expect(result.current.detectedORFs).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('rejects old code/minimum/source jobs and hide/reopen results without losing intent', () => {
    const { result, rerender } = renderHook(({ sequence, code }) => useORFs(sequence, code), {
      initialProps: { sequence: 'ATG'.repeat(100) + 'TAA', code: 1 },
    });
    const old = currentDetection();
    act(() => result.current.setMinLength(120));
    const minimumJob = currentDetection();
    rerender({ sequence: 'ATG'.repeat(120) + 'TAA', code: 2 });
    const current = currentDetection();
    act(() => {
      old.worker.emit({ type: 'done', jobId: old.request.jobId, orfs: ORF_A });
      minimumJob.worker.emit({ type: 'done', jobId: minimumJob.request.jobId, orfs: ORF_A });
    });
    expect(result.current.status).toBe('pending');
    expect(result.current.detectedORFs).toEqual([]);
    act(() => result.current.toggleVisibility());
    act(() => current.worker.emit({ type: 'done', jobId: current.request.jobId, orfs: ORF_B }));
    expect(result.current.status).toBe('idle');
    act(() => result.current.toggleVisibility());
    const reopened = currentDetection();
    expect(reopened.request).toMatchObject({
      sequence: 'ATG'.repeat(120) + 'TAA',
      geneticCode: 2,
      minLength: 120,
    });
    act(() => reopened.worker.emit({ type: 'done', jobId: reopened.request.jobId, orfs: [] }));
    expect(result.current.status).toBe('ready-empty');
  });

  it('does not retain a cancelled pending job after batched hide and show', () => {
    const { result } = renderHook(() => useORFs('ATG'.repeat(100) + 'TAA'));
    const old = currentDetection();
    act(() => {
      result.current.toggleVisibility();
      result.current.toggleVisibility();
    });
    const current = currentDetection();
    expect(current.request.jobId).not.toBe(old.request.jobId);
    expect(result.current.isVisible).toBe(true);
    act(() => old.worker.emit({ type: 'done', jobId: old.request.jobId, orfs: ORF_A }));
    expect(result.current.status).toBe('pending');
    act(() => current.worker.emit({ type: 'done', jobId: current.request.jobId, orfs: ORF_B }));
    expect(result.current.status).toBe('ready-results');
    expect(result.current.detectedORFs).toEqual(ORF_B);
  });

  it('readmits the same minimum after cancellation and reuses a completed current cache entry', () => {
    const { result } = renderHook(() => useORFs('ATG'.repeat(100) + 'TAA'));
    const old = currentDetection();
    act(() => old.worker.emit({ type: 'cancelled', jobId: old.request.jobId }));
    act(() => result.current.setMinLength(100));
    const current = currentDetection();
    expect(current.request.jobId).not.toBe(old.request.jobId);
    act(() => current.worker.emit({ type: 'done', jobId: current.request.jobId, orfs: ORF_A }));
    const detections = current.worker.messages.filter(
      (message) => message.type === 'detect'
    ).length;
    act(() => result.current.toggleVisibility());
    act(() => result.current.toggleVisibility());
    expect(result.current.status).toBe('ready-results');
    expect(current.worker.messages.filter((message) => message.type === 'detect')).toHaveLength(
      detections
    );
  });

  it('keeps construction fallback on the real detector and reports valid zero honestly', async () => {
    workerMock.MockWorker.failConstruction = true;
    const { result } = renderHook(() => useORFs('CCC'.repeat(50)));
    await waitFor(() => expect(result.current.status).toBe('ready-empty'));
    expect(result.current.detectedORFs).toEqual([]);
    expect(result.current.error).toBeNull();
    expect(workerMock.MockWorker.instances).toHaveLength(0);
  });

  it('fences the original 5000-result quiet commit after source replacement', () => {
    vi.useFakeTimers();
    const { observations, observeDetection } = detectionObserverForTest();
    const { result, rerender } = renderHook(
      ({ sequence }) =>
        useORFs(sequence, 1, {
          observeDetection,
          observationVisible: true,
        }),
      {
        initialProps: { sequence: 'ATG'.repeat(100) + 'TAA' },
      }
    );
    const old = currentDetection();
    act(() => window.dispatchEvent(new Event('pointermove')));
    act(() =>
      old.worker.emit({
        type: 'done',
        jobId: old.request.jobId,
        orfs: Array.from({ length: 5000 }, () => ORF_A[0]),
      })
    );
    expect(result.current.status).toBe('pending');
    expect(observations[0].detected).toHaveBeenCalledExactlyOnceWith(5000);
    rerender({ sequence: 'CCC'.repeat(150) });
    expect(observations[0].retire).not.toHaveBeenCalled();
    const current = currentDetection();
    act(() => vi.advanceTimersByTime(450));
    expect(result.current.status).toBe('pending');
    expect(result.current.detectedORFs).toEqual([]);
    act(() => current.worker.emit({ type: 'done', jobId: current.request.jobId, orfs: [] }));
    expect(result.current.status).toBe('ready-empty');
    expect(observations[1].detected).toHaveBeenCalledExactlyOnceWith(0);
  });

  it.each([
    { code: 1, end: 125, length: 126 },
    { code: 2, end: 137, length: 138 },
  ])('keeps genetic code $code on the real cooperative detector', async ({ code, end, length }) => {
    workerMock.MockWorker.failConstruction = true;
    const sequence = 'ATG' + 'CCC'.repeat(40) + 'TGA' + 'CCC'.repeat(3) + 'TAA';
    const { result } = renderHook(() => useORFs(sequence, code));
    await waitFor(() => expect(result.current.status).toBe('ready-results'));
    expect(result.current.detectedORFs).toEqual([{ start: 0, end, frame: 1, strand: '+', length }]);
    expect(result.current.minLength).toBe(100);
  });

  it('cannot restore an old result after a real suspended React transition resumes', async () => {
    let blockOld = true;
    let release = () => {};
    const suspended = new Promise<void>((resolve) => {
      release = resolve;
    });
    function Wrapper({ children }: { children: ReactNode }) {
      return <Suspense fallback={null}>{children}</Suspense>;
    }
    const { result, rerender } = renderHook(
      ({ sequence }) => {
        const state = useORFs(sequence);
        if (blockOld && state.detectedORFs === ORF_A) throw suspended;
        return state;
      },
      { initialProps: { sequence: 'ATG'.repeat(100) + 'TAA' }, wrapper: Wrapper }
    );
    const old = currentDetection();
    act(() => old.worker.emit({ type: 'done', jobId: old.request.jobId, orfs: ORF_A }));
    expect(result.current.status).toBe('pending');
    rerender({ sequence: 'ATG'.repeat(120) + 'TAA' });
    const current = currentDetection();
    act(() => current.worker.emit({ type: 'done', jobId: current.request.jobId, orfs: ORF_B }));
    expect(result.current.status).toBe('ready-results');
    expect(result.current.detectedORFs).toEqual(ORF_B);
    await act(async () => {
      blockOld = false;
      release();
      await suspended;
    });
    expect(result.current.status).toBe('ready-results');
    expect(result.current.detectedORFs).toEqual(ORF_B);
  });

  it('retains a completed current job when a speculative source transition is aborted', async () => {
    const { observations, observeDetection } = detectionObserverForTest();
    const currentSequence = 'ATG'.repeat(100) + 'TAA';
    const nextSequence = 'ATG'.repeat(120) + 'TAA';
    let sawSpeculativeSource = false;
    let release = () => {};
    const suspended = new Promise<void>((resolve) => {
      release = resolve;
    });
    function Wrapper({ children }: { children: ReactNode }) {
      return <Suspense fallback={null}>{children}</Suspense>;
    }
    const { result, rerender } = renderHook(
      ({ sequence }) => {
        const state = useORFs(sequence, 1, { observeDetection, observationVisible: true });
        if (sequence === nextSequence) {
          sawSpeculativeSource = true;
          throw suspended;
        }
        return state;
      },
      { initialProps: { sequence: currentSequence }, wrapper: Wrapper }
    );
    const current = currentDetection();
    act(() => startTransition(() => rerender({ sequence: nextSequence })));
    expect(sawSpeculativeSource).toBe(true);
    act(() => current.worker.emit({ type: 'done', jobId: current.request.jobId, orfs: ORF_A }));
    rerender({ sequence: currentSequence });
    expect(result.current.status).toBe('ready-results');
    expect(result.current.detectedORFs).toEqual(ORF_A);
    await act(async () => {
      release();
      await suspended;
    });
    expect(result.current.detectedORFs).toEqual(ORF_A);
    expect(observeDetection).toHaveBeenCalledTimes(1);
    expect(observations[0].detected).toHaveBeenCalledExactlyOnceWith(1);
    expect(observations[0].retire).not.toHaveBeenCalled();
  });
});
