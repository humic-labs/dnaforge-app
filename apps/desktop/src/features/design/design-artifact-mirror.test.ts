import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => {
  let writeImpl: () => Promise<unknown> = () =>
    Promise.resolve({ path: '/workspace/draft.wpdesign.json' });
  const writeDesignArtifactSnapshot = vi.fn(() => writeImpl());
  const writePackageAssemblyWorkingCopySnapshot = vi.fn(() => Promise.resolve(null));
  const unsubscribe = vi.fn();
  let listener: ((state: unknown, prev: unknown) => void) | null = null;
  let currentDesigns: Record<string, unknown> = {};
  const subscribe = vi.fn((l: (state: unknown, prev: unknown) => void) => {
    listener = l;
    return unsubscribe;
  });
  return {
    writeDesignArtifactSnapshot,
    writePackageAssemblyWorkingCopySnapshot,
    unsubscribe,
    subscribe,
    getState: () => ({ designs: currentDesigns }),
    setWriteImpl: (impl: () => Promise<unknown>) => {
      writeImpl = impl;
    },
    resetWriteImpl: () => {
      writeImpl = () => Promise.resolve({ path: '/workspace/draft.wpdesign.json' });
    },
    fire: (
      designs: Record<string, unknown>,
      prevDesigns: Record<string, unknown> = {},
      draftDesignIds: Record<string, true> = {}
    ) => {
      currentDesigns = designs;
      listener?.({ designs, draftDesignIds }, { designs: prevDesigns });
    },
    setDesigns: (designs: Record<string, unknown>) => {
      currentDesigns = designs;
    },
  };
});

vi.mock('./store', () => ({
  useDesignStore: { subscribe: h.subscribe, getState: h.getState },
}));
vi.mock('../../db/workspace-artifacts', () => ({
  writeDesignArtifactSnapshot: h.writeDesignArtifactSnapshot,
}));
vi.mock('../../db/sequence-package-working-copy-storage', () => ({
  writePackageAssemblyWorkingCopySnapshot: h.writePackageAssemblyWorkingCopySnapshot,
}));

import {
  hasPendingDesignArtifactMirror,
  resumeDesignArtifactMirrors,
  resumeDesignArtifactMirror,
  retireDesignArtifactMirror,
  startDesignArtifactMirroring,
  stopDesignArtifactMirroring,
  suspendDesignArtifactMirrors,
} from './design-artifact-mirror';
import {
  acceptDesignArtifact,
  confirmDesignArtifactPublication,
  useDesignRecoveryStore,
} from './design-recovery';
import { packageAssemblyWorkingCopyDesignId } from './package-working-copy-identity';

const design = (id: string, name = id) => ({ id, name }) as never;

describe('design artifact mirroring', () => {
  beforeEach(() => {
    localStorage.clear();
    useDesignRecoveryStore.setState({ records: {} });
    h.fire({});
    vi.useFakeTimers();
    h.subscribe.mockClear();
    h.unsubscribe.mockClear();
    h.writeDesignArtifactSnapshot.mockClear();
    h.writePackageAssemblyWorkingCopySnapshot.mockClear();
    h.resetWriteImpl();
  });
  afterEach(() => {
    stopDesignArtifactMirroring();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('debounces an artifact snapshot 250ms after a design change', () => {
    startDesignArtifactMirroring();
    h.fire({ d1: design('d1') });
    expect(h.writeDesignArtifactSnapshot).not.toHaveBeenCalled();
    vi.advanceTimersByTime(249);
    expect(h.writeDesignArtifactSnapshot).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(h.writeDesignArtifactSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ designId: 'd1' })
    );
  });

  it('keeps transient drafts out of automatic artifact writes and durable recovery', () => {
    startDesignArtifactMirroring();
    h.fire({ d1: design('d1') }, {}, { d1: true });
    vi.advanceTimersByTime(1000);
    expect(h.writeDesignArtifactSnapshot).not.toHaveBeenCalled();
    expect(useDesignRecoveryStore.getState().records.d1).toBeUndefined();
    expect(hasPendingDesignArtifactMirror(['d1'])).toBe(false);
  });

  it('only schedules for designs whose reference actually changed', () => {
    startDesignArtifactMirroring();
    const shared = design('d2');

    h.fire({ d1: design('d1'), d2: shared }, { d2: shared });
    vi.advanceTimersByTime(250);
    expect(h.writeDesignArtifactSnapshot).toHaveBeenCalledTimes(1);
    expect(h.writeDesignArtifactSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ designId: 'd1' })
    );
  });

  it('coalesces rapid changes to the same design into a single snapshot', () => {
    startDesignArtifactMirroring();
    h.fire({ d1: design('d1', 'v1') });
    vi.advanceTimersByTime(100);
    h.fire({ d1: design('d1', 'v2') }, { d1: design('d1', 'v1') });
    vi.advanceTimersByTime(249);
    expect(h.writeDesignArtifactSnapshot).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(h.writeDesignArtifactSnapshot).toHaveBeenCalledTimes(1);
  });

  it('retries the latest design after another workspace mutation temporarily owns the lease', async () => {
    let attempt = 0;
    h.setWriteImpl(() => {
      attempt += 1;
      if (attempt === 1) {
        return Promise.reject(
          new Error('WORKSPACE_SYNC_MUTATION_BUSY: another workspace mutation is active.')
        );
      }
      return Promise.resolve();
    });
    startDesignArtifactMirroring();
    h.fire({ d1: design('d1', 'latest') });

    await vi.advanceTimersByTimeAsync(250);
    expect(h.writeDesignArtifactSnapshot).toHaveBeenCalledTimes(1);
    expect(hasPendingDesignArtifactMirror(['d1'])).toBe(true);

    await vi.advanceTimersByTimeAsync(250);
    expect(h.writeDesignArtifactSnapshot).toHaveBeenCalledTimes(2);
    expect(h.writeDesignArtifactSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({ designId: 'd1', name: 'latest' })
    );
  });

  it('reports pending local design work before its debounce writes the artifact', () => {
    startDesignArtifactMirroring();
    h.fire({ d1: design('d1') });

    expect(hasPendingDesignArtifactMirror(['d1'])).toBe(true);
    expect(hasPendingDesignArtifactMirror(['unrelated'])).toBe(false);

    vi.advanceTimersByTime(250);
    expect(hasPendingDesignArtifactMirror(['d1'])).toBe(true);
  });

  it('serializes a held write and leaves newer edits pending until their own confirmation', async () => {
    let release!: (value: unknown) => void;
    h.setWriteImpl(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    startDesignArtifactMirroring();
    h.fire({ d1: design('d1', 'B') });
    await vi.advanceTimersByTimeAsync(250);
    h.fire({ d1: design('d1', 'C') }, { d1: design('d1', 'B') });
    await vi.advanceTimersByTimeAsync(500);
    expect(h.writeDesignArtifactSnapshot).toHaveBeenCalledTimes(1);
    release({ path: '/workspace/d1.wpdesign.json' });
    await vi.advanceTimersByTimeAsync(0);
    expect(hasPendingDesignArtifactMirror(['d1'])).toBe(true);
    expect(useDesignRecoveryStore.getState().records.d1.design.name).toBe('C');
    h.resetWriteImpl();
    await vi.advanceTimersByTimeAsync(250);
    expect(h.writeDesignArtifactSnapshot).toHaveBeenCalledTimes(2);
    expect(h.writeDesignArtifactSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: 'C' })
    );
    expect(hasPendingDesignArtifactMirror(['d1'])).toBe(false);
  });

  it('bounds retries despite repeated edits and does not treat a missing binding as saved', async () => {
    h.setWriteImpl(() => Promise.reject(new Error('EACCES')));
    startDesignArtifactMirroring();
    h.fire({ d1: design('d1') });
    await vi.advanceTimersByTimeAsync(250);
    for (let edit = 0; edit < 100; edit += 1) {
      h.fire({ d1: design('d1', String(edit)) });
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(h.writeDesignArtifactSnapshot.mock.calls.length).toBeLessThanOrEqual(7);
    h.setWriteImpl(() => Promise.resolve(null));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hasPendingDesignArtifactMirror(['d1'])).toBe(true);
    expect(useDesignRecoveryStore.getState().records.d1.status).toBe('unbound');
  });

  it('retains an ordinary failed save and automatically retries the latest revision', async () => {
    h.setWriteImpl(() => Promise.reject(new Error('EACCES: workspace is read-only')));
    startDesignArtifactMirroring();
    h.fire({ d1: design('d1', 'unsaved edit') });
    await vi.advanceTimersByTimeAsync(250);
    expect(hasPendingDesignArtifactMirror(['d1'])).toBe(true);
    h.setWriteImpl(() => Promise.resolve({ path: '/workspace/d1.wpdesign.json' }));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.writeDesignArtifactSnapshot).toHaveBeenCalledTimes(2);
    expect(hasPendingDesignArtifactMirror(['d1'])).toBe(false);
  });

  it('suppresses remote hydration echoes and can reschedule the local value after abort', () => {
    startDesignArtifactMirroring();
    suspendDesignArtifactMirrors(['d1']);
    h.fire({ d1: design('d1', 'remote') });

    vi.advanceTimersByTime(1_000);
    expect(h.writeDesignArtifactSnapshot).not.toHaveBeenCalled();

    resumeDesignArtifactMirrors(['d1'], { scheduleLatest: false });
    vi.advanceTimersByTime(1_000);
    expect(h.writeDesignArtifactSnapshot).not.toHaveBeenCalled();

    suspendDesignArtifactMirrors(['d1']);
    resumeDesignArtifactMirrors(['d1'], { scheduleLatest: true });
    vi.advanceTimersByTime(250);
    expect(h.writeDesignArtifactSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ designId: 'd1', name: 'remote' })
    );
  });

  it('stop() clears pending timers and unsubscribes', () => {
    startDesignArtifactMirroring();
    h.fire({ d1: design('d1') });
    stopDesignArtifactMirroring();
    vi.advanceTimersByTime(1000);
    expect(h.writeDesignArtifactSnapshot).not.toHaveBeenCalled();
    expect(h.unsubscribe).toHaveBeenCalled();
  });

  it('does not resurrect a busy retry after mirroring stops', async () => {
    let rejectWrite!: (error: Error) => void;
    h.setWriteImpl(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectWrite = reject;
        })
    );
    startDesignArtifactMirroring();
    h.fire({ d1: design('d1') });
    await vi.advanceTimersByTimeAsync(250);

    stopDesignArtifactMirroring();
    rejectWrite(new Error('WORKSPACE_SYNC_MUTATION_BUSY: another workspace mutation is active.'));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(h.writeDesignArtifactSnapshot).toHaveBeenCalledTimes(1);
  });

  it('start is idempotent — a second call does not re-subscribe', () => {
    startDesignArtifactMirroring();
    startDesignArtifactMirroring();
    expect(h.subscribe).toHaveBeenCalledTimes(1);
  });

  it('targeted retirement cancels a pending write and blocks later scheduling for that design', async () => {
    startDesignArtifactMirroring();
    h.fire({ d1: design('d1') });

    await retireDesignArtifactMirror('d1');
    vi.advanceTimersByTime(1_000);
    expect(h.writeDesignArtifactSnapshot).not.toHaveBeenCalled();

    h.fire({ d1: design('d1', 'after-retirement') }, { d1: design('d1') });
    vi.advanceTimersByTime(1_000);
    expect(h.writeDesignArtifactSnapshot).not.toHaveBeenCalled();
  });

  it('targeted retirement drains a mirror write whose debounce callback already fired', async () => {
    let releaseWrite!: () => void;
    h.setWriteImpl(
      () =>
        new Promise<void>((resolve) => {
          releaseWrite = resolve;
        })
    );
    startDesignArtifactMirroring();
    h.fire({ d1: design('d1') });
    vi.advanceTimersByTime(250);
    expect(h.writeDesignArtifactSnapshot).toHaveBeenCalledTimes(1);

    let retirementSettled = false;
    const retirement = retireDesignArtifactMirror('d1').then(() => {
      retirementSettled = true;
    });
    await Promise.resolve();
    expect(retirementSettled).toBe(false);

    releaseWrite();
    await retirement;
    expect(retirementSettled).toBe(true);
  });

  it('resume schedules the latest design snapshot after a failed maturation rollback', async () => {
    startDesignArtifactMirroring();
    h.fire({ d1: design('d1', 'latest') });
    await retireDesignArtifactMirror('d1');

    resumeDesignArtifactMirror('d1');
    vi.advanceTimersByTime(250);

    expect(h.writeDesignArtifactSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ designId: 'd1', name: 'latest' })
    );
  });

  it('does not treat designs already in the store at start as unpublished work', async () => {
    h.setDesigns({ d1: design('d1', 'already there') });
    startDesignArtifactMirroring();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.writeDesignArtifactSnapshot).not.toHaveBeenCalled();
    expect(hasPendingDesignArtifactMirror(['d1'])).toBe(false);
  });

  it('keeps the exact unpublished revision after an ordinary write failure', async () => {
    h.setWriteImpl(() => Promise.reject(new Error('EACCES: workspace is read-only')));
    startDesignArtifactMirroring();
    h.fire({ d1: design('d1', 'unsaved edit') });
    await vi.advanceTimersByTimeAsync(250);
    expect(useDesignRecoveryStore.getState().records.d1).toMatchObject({
      pending: true,
      status: 'delayed',
      design: { name: 'unsaved edit' },
    });
    expect(hasPendingDesignArtifactMirror(['d1'])).toBe(true);
  });

  it('keeps a newer edit pending when it arrives during a held write', async () => {
    let releaseWrite!: () => void;
    h.setWriteImpl(
      () =>
        new Promise((resolve) => {
          releaseWrite = () => resolve({ path: '/workspace/d1.wpdesign.json' });
        })
    );
    startDesignArtifactMirroring();
    h.fire({ d1: design('d1', 'v1') });
    await vi.advanceTimersByTimeAsync(250);
    h.fire({ d1: design('d1', 'v2') }, { d1: design('d1', 'v1') });
    releaseWrite();
    await Promise.resolve();
    await Promise.resolve();
    expect(hasPendingDesignArtifactMirror(['d1'])).toBe(true);
    expect(useDesignRecoveryStore.getState().records.d1.design).toMatchObject({ name: 'v2' });
    h.setWriteImpl(() => Promise.resolve({ path: '/workspace/d1.wpdesign.json' }));
    await vi.advanceTimersByTimeAsync(250);
    expect(h.writeDesignArtifactSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: 'v2' })
    );
    expect(hasPendingDesignArtifactMirror(['d1'])).toBe(false);
  });

  it('keeps unpublished work when the workspace binding is missing', async () => {
    h.setWriteImpl(() => Promise.resolve(null));
    startDesignArtifactMirroring();
    h.fire({ d1: design('d1', 'unbound') });
    await vi.advanceTimersByTimeAsync(250);
    expect(hasPendingDesignArtifactMirror(['d1'])).toBe(true);
    expect(useDesignRecoveryStore.getState().records.d1.status).toBe('unbound');
  });

  it('saves newer draft content when initial artifact creation finishes after an unbound attempt', async () => {
    const original = design('d1', 'new artifact');
    acceptDesignArtifact(original);
    h.setWriteImpl(() => Promise.resolve(null));
    startDesignArtifactMirroring();
    h.fire({ d1: design('d1', 'newer working copy') });
    await vi.advanceTimersByTimeAsync(250);
    expect(useDesignRecoveryStore.getState().records.d1.status).toBe('unbound');

    h.setWriteImpl(() => Promise.resolve({ path: '/workspace/d1.wpdesign.json' }));
    confirmDesignArtifactPublication(original);
    await vi.advanceTimersByTimeAsync(250);

    expect(h.writeDesignArtifactSnapshot).toHaveBeenCalledTimes(2);
    expect(h.writeDesignArtifactSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: 'newer working copy' })
    );
    expect(hasPendingDesignArtifactMirror(['d1'])).toBe(false);
  });

  it('does not let an older unbound response delay a newly bound artifact', async () => {
    const original = design('d1', 'new artifact');
    acceptDesignArtifact(original);
    let finishUnbound!: () => void;
    h.setWriteImpl(
      () =>
        new Promise((resolve) => {
          finishUnbound = () => resolve(null);
        })
    );
    startDesignArtifactMirroring();
    h.fire({ d1: design('d1', 'newer working copy') });
    await vi.advanceTimersByTimeAsync(250);

    h.setWriteImpl(() => Promise.resolve({ path: '/workspace/d1.wpdesign.json' }));
    confirmDesignArtifactPublication(original);
    finishUnbound();
    await vi.advanceTimersByTimeAsync(250);

    expect(h.writeDesignArtifactSnapshot).toHaveBeenCalledTimes(2);
    expect(hasPendingDesignArtifactMirror(['d1'])).toBe(false);
  });

  it('never writes a loose design artifact if a package-owned working copy is unbound', async () => {
    const ownedId = await packageAssemblyWorkingCopyDesignId('package-1', 'accepted-1');
    startDesignArtifactMirroring();
    h.fire({
      [ownedId]: {
        ...design(ownedId),
        constructId: 'package-1',
        parentAcceptedAssemblyVersionId: 'accepted-1',
      },
    });
    await vi.advanceTimersByTimeAsync(250);
    expect(h.writePackageAssemblyWorkingCopySnapshot).toHaveBeenCalledTimes(1);
    expect(h.writeDesignArtifactSnapshot).not.toHaveBeenCalled();
    expect(useDesignRecoveryStore.getState().records[ownedId]).toMatchObject({
      pending: true,
      status: 'unbound',
    });
  });

  it('continues saving an ordinary design with a construct ID as a loose design artifact', async () => {
    startDesignArtifactMirroring();
    h.fire({ d1: { ...design('d1'), constructId: 'construct-1' } });
    await vi.advanceTimersByTimeAsync(250);
    expect(h.writePackageAssemblyWorkingCopySnapshot).not.toHaveBeenCalled();
    expect(h.writeDesignArtifactSnapshot).toHaveBeenCalledTimes(1);
  });

  it('does not retire a draft merely because it left the in-memory store', async () => {
    startDesignArtifactMirroring();
    h.fire({ d1: design('d1', 'keep') });
    h.fire({}, { d1: design('d1', 'keep') });
    expect(useDesignRecoveryStore.getState().records.d1?.retired).not.toBe(true);
    expect(hasPendingDesignArtifactMirror(['d1'])).toBe(true);
  });

  it('refuses retirement when the recovery record cannot be made durable', async () => {
    startDesignArtifactMirroring();
    h.fire({ d1: design('d1', 'keep') });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full');
    });
    await expect(retireDesignArtifactMirror('d1')).rejects.toThrow(/could not be saved/);
    expect(useDesignRecoveryStore.getState().records.d1.retired).not.toBe(true);
  });
});
