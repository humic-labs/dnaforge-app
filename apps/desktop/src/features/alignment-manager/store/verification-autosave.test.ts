// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  markLoadedVerificationState,
  startVerificationAutosave,
  stopVerificationAutosave,
} from './verification-autosave';

type Listener = (cur: Record<string, unknown>, prev: Record<string, unknown>) => void;

function makeFakeStore() {
  const saveSidecar = vi.fn();
  const state = {
    staleReferences: {} as Record<string, boolean>,
    saveSidecar,
    verificationState: {} as Record<string, unknown>,
  };
  let listener: Listener | null = null;
  const unsubscribe = vi.fn();
  const subscribe = vi.fn((_selector: unknown, l: Listener) => {
    listener = l;
    return unsubscribe;
  });
  const store = { subscribe, getState: () => state };
  return {
    store: store as unknown as Parameters<typeof startVerificationAutosave>[0],
    subscribe,
    saveSidecar,
    unsubscribe,
    state,
    fire: (cur: Record<string, unknown>, prev: Record<string, unknown> = {}) =>
      listener?.(cur, prev),
  };
}

describe('verification autosave', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    stopVerificationAutosave();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('debounces a sidecar save 2s after a verificationState change', () => {
    const f = makeFakeStore();
    startVerificationAutosave(f.store);

    f.fire({ '/ref.gb': { v: 1 } });
    expect(f.saveSidecar).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1999);
    expect(f.saveSidecar).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(f.saveSidecar).toHaveBeenCalledWith('/ref.gb', { onlyIfCurrent: true });
  });

  it('skips save for a stale reference  corruption guard)', () => {
    const f = makeFakeStore();
    f.state.staleReferences['/ref.gb'] = true;
    startVerificationAutosave(f.store);

    f.fire({ '/ref.gb': { v: 1 } });
    vi.advanceTimersByTime(5000);
    expect(f.saveSidecar).not.toHaveBeenCalled();
  });

  it('discards an already queued save if the reference becomes stale before it fires', () => {
    const f = makeFakeStore();
    startVerificationAutosave(f.store);
    f.fire({ '/ref.gb': { v: 1 } });
    vi.advanceTimersByTime(1000);
    f.state.staleReferences['/ref.gb'] = true;
    vi.advanceTimersByTime(1000);
    expect(f.saveSidecar).not.toHaveBeenCalled();
  });

  it('coalesces rapid changes to the same path into a single save', () => {
    const f = makeFakeStore();
    startVerificationAutosave(f.store);

    f.fire({ '/ref.gb': { v: 1 } });
    vi.advanceTimersByTime(1000);
    f.fire({ '/ref.gb': { v: 2 } }, { '/ref.gb': { v: 1 } });
    vi.advanceTimersByTime(1999);
    expect(f.saveSidecar).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(f.saveSidecar).toHaveBeenCalledTimes(1);
  });

  it('only schedules for paths whose state actually changed', () => {
    const f = makeFakeStore();
    startVerificationAutosave(f.store);

    const shared = { v: 1 };
    f.fire({ '/a': { v: 1 }, '/b': shared }, { '/b': shared });
    vi.advanceTimersByTime(2000);
    expect(f.saveSidecar).toHaveBeenCalledTimes(1);
    expect(f.saveSidecar).toHaveBeenCalledWith('/a', { onlyIfCurrent: true });
  });

  it('does not save state that was just loaded from disk', () => {
    const f = makeFakeStore();
    startVerificationAutosave(f.store);
    const loaded = { v: 1 };
    markLoadedVerificationState(loaded);

    f.fire({ '/ref.gb': loaded });
    vi.advanceTimersByTime(5000);
    expect(f.saveSidecar).not.toHaveBeenCalled();

    f.fire({ '/ref.gb': { v: 2 } }, { '/ref.gb': loaded });
    vi.advanceTimersByTime(2000);
    expect(f.saveSidecar).toHaveBeenCalledWith('/ref.gb', { onlyIfCurrent: true });
  });

  it('waits while the reference has unsettled edits, then drops the save if it went stale', () => {
    const f = makeFakeStore();
    let editing = true;
    startVerificationAutosave(f.store, () => editing);

    f.fire({ '/ref.gb': { v: 1 } });
    vi.advanceTimersByTime(6000);
    expect(f.saveSidecar).not.toHaveBeenCalled();

    f.state.staleReferences['/ref.gb'] = true;
    editing = false;
    vi.advanceTimersByTime(2000);
    expect(f.saveSidecar).not.toHaveBeenCalled();
  });

  it('saves once the reference edits settle without making it stale', () => {
    const f = makeFakeStore();
    let editing = true;
    startVerificationAutosave(f.store, () => editing);

    f.fire({ '/ref.gb': { v: 1 } });
    vi.advanceTimersByTime(4000);
    editing = false;
    vi.advanceTimersByTime(2000);
    expect(f.saveSidecar).toHaveBeenCalledTimes(1);
    expect(f.saveSidecar).toHaveBeenCalledWith('/ref.gb', { onlyIfCurrent: true });
  });

  it('stop() clears pending timers and unsubscribes', () => {
    const f = makeFakeStore();
    startVerificationAutosave(f.store);

    f.fire({ '/ref.gb': { v: 1 } });
    stopVerificationAutosave();
    vi.advanceTimersByTime(5000);
    expect(f.saveSidecar).not.toHaveBeenCalled();
    expect(f.unsubscribe).toHaveBeenCalled();
  });

  it('start is idempotent — a second call does not re-subscribe', () => {
    const f = makeFakeStore();
    startVerificationAutosave(f.store);
    startVerificationAutosave(f.store);
    expect(f.subscribe).toHaveBeenCalledTimes(1);
  });
});
