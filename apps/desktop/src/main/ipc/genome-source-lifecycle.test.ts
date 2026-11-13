import { describe, expect, it, vi } from 'vitest';

import { GenomeSourceLifecycle } from './genome-source-lifecycle';

interface TestSource {
  id: string;
  close(): Promise<void>;
}

function deferred<Value>(): {
  promise: Promise<Value>;
  resolve: (value: Value) => void;
} {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function createTestSource(id: string): TestSource & { close: ReturnType<typeof vi.fn> } {
  return { id, close: vi.fn(async () => undefined) };
}

describe('GenomeSourceLifecycle', () => {
  it('gives concurrent cold lookups one source owner', async () => {
    const lifecycle = new GenomeSourceLifecycle<TestSource>(8);
    const gate = deferred<TestSource>();
    const create = vi.fn(() => gate.promise);

    const first = lifecycle.withSource('same-manifest', create, async (value) => value);
    const second = lifecycle.withSource('same-manifest', create, async (value) => value);
    const source = createTestSource('only-worker');
    gate.resolve(source);

    await expect(Promise.all([first, second])).resolves.toEqual([source, source]);
    expect(create).toHaveBeenCalledTimes(1);

    await lifecycle.closeAll();
    expect(source.close).toHaveBeenCalledTimes(1);
  });

  it('bounds callers waiting on one shared source preparation', async () => {
    const lifecycle = new GenomeSourceLifecycle<TestSource>(1);
    const gate = deferred<TestSource>();
    const source = createTestSource('bounded-worker');
    const create = vi.fn(() => gate.promise);
    const admitted = Array.from({ length: 4 }, () =>
      lifecycle.withSource('same-manifest', create, async (value) => value.id)
    );
    const refused = lifecycle.withSource('same-manifest', create, async (value) => value.id);

    await expect(refused).rejects.toThrow('Genome source preparation claimant queue is full');
    gate.resolve(source);
    await expect(Promise.all(admitted)).resolves.toEqual(Array(4).fill('bounded-worker'));
    expect(create).toHaveBeenCalledTimes(1);
    await lifecycle.closeAll();
  });

  it('detaches canceled preparation callers and blocks retry until physical settlement', async () => {
    const lifecycle = new GenomeSourceLifecycle<TestSource>(1);
    const preparationGate = deferred<TestSource>();
    const closeGate = deferred<void>();
    const lateSource = createTestSource('late-worker');
    lateSource.close.mockImplementation(() => closeGate.promise);
    let preparationSignal: AbortSignal | undefined;
    const createLate = vi.fn((signal: AbortSignal) => {
      preparationSignal = signal;
      return preparationGate.promise;
    });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = lifecycle.withSource(
      'same-manifest',
      createLate,
      async (value) => value.id,
      firstController.signal
    );
    const second = lifecycle.withSource(
      'same-manifest',
      createLate,
      async (value) => value.id,
      secondController.signal
    );

    firstController.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(preparationSignal?.aborted).toBe(false);

    secondController.abort();
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    expect(preparationSignal?.aborted).toBe(true);

    const replacement = createTestSource('replacement-worker');
    const createReplacement = vi.fn(async () => replacement);
    const retry = lifecycle.withSource(
      'same-manifest',
      createReplacement,
      async (value) => value.id
    );
    await Promise.resolve();
    expect(createReplacement).not.toHaveBeenCalled();

    preparationGate.resolve(lateSource);
    await vi.waitFor(() => expect(lateSource.close).toHaveBeenCalledTimes(1));
    expect(createReplacement).not.toHaveBeenCalled();
    closeGate.resolve();

    await expect(retry).resolves.toBe('replacement-worker');
    expect(createLate).toHaveBeenCalledTimes(1);
    expect(createReplacement).toHaveBeenCalledTimes(1);
    await lifecycle.closeAll();
  });

  it('closes a source that finishes preparation after shutdown starts', async () => {
    const lifecycle = new GenomeSourceLifecycle<TestSource>(8);
    const gate = deferred<TestSource>();
    const lookup = lifecycle.withSource(
      'slow-manifest',
      () => gate.promise,
      async (value) => value
    );
    const shutdown = lifecycle.closeAll();
    const source = createTestSource('late-worker');

    gate.resolve(source);

    await expect(lookup).rejects.toMatchObject({ name: 'AbortError' });
    await shutdown;
    expect(source.close).toHaveBeenCalledTimes(1);
  });

  it('forgets a failed preparation so the same key can retry', async () => {
    const lifecycle = new GenomeSourceLifecycle<TestSource>(8);
    const source = createTestSource('retry-worker');
    const create = vi
      .fn<() => Promise<TestSource>>()
      .mockRejectedValueOnce(new Error('worker failed to open'))
      .mockResolvedValueOnce(source);

    await expect(lifecycle.withSource('manifest', create, async (value) => value)).rejects.toThrow(
      'worker failed to open'
    );
    await expect(lifecycle.withSource('manifest', create, async (value) => value)).resolves.toBe(
      source
    );
    expect(create).toHaveBeenCalledTimes(2);

    await lifecycle.closeAll();
  });

  it('queues a new source until the active owner releases the only worker slot', async () => {
    let clock = 0;
    const lifecycle = new GenomeSourceLifecycle<TestSource>(1, () => ++clock);
    const sourceA = createTestSource('worker-a');
    const sourceB = createTestSource('worker-b');
    const sourceC = createTestSource('worker-c');
    const createB = vi.fn(async () => sourceB);
    const requestStarted = deferred<void>();
    const releaseRequest = deferred<void>();

    const activeRequest = lifecycle.withSource(
      'manifest-a',
      async () => sourceA,
      async (source) => {
        requestStarted.resolve();
        await releaseRequest.promise;
        return source.id;
      }
    );
    await requestStarted.promise;

    const waitingRequest = lifecycle.withSource('manifest-b', createB, async (source) => source.id);
    await Promise.resolve();
    expect(createB).not.toHaveBeenCalled();
    expect(sourceA.close).not.toHaveBeenCalled();

    releaseRequest.resolve();
    await expect(activeRequest).resolves.toBe('worker-a');
    await expect(waitingRequest).resolves.toBe('worker-b');
    expect(createB).toHaveBeenCalledTimes(1);
    expect(sourceA.close).toHaveBeenCalledTimes(1);
    expect(sourceB.close).not.toHaveBeenCalled();

    await lifecycle.withSource(
      'manifest-c',
      async () => sourceC,
      async (source) => source.id
    );
    expect(sourceB.close).toHaveBeenCalledTimes(1);

    await lifecycle.closeAll();
    expect(sourceC.close).toHaveBeenCalledTimes(1);
  });

  it('never creates more distinct worker sources than the configured budget', async () => {
    const lifecycle = new GenomeSourceLifecycle<TestSource>(2);
    const useGates = Array.from({ length: 3 }, () => deferred<void>());
    const creates = Array.from({ length: 3 }, (_, index) =>
      vi.fn(async () => createTestSource(`worker-${index}`))
    );

    const requests = creates.map((create, index) =>
      lifecycle.withSource(`manifest-${index}`, create, async (source) => {
        await useGates[index]?.promise;
        return source.id;
      })
    );
    await vi.waitFor(() => {
      expect(creates[0]).toHaveBeenCalledTimes(1);
      expect(creates[1]).toHaveBeenCalledTimes(1);
    });
    expect(creates[2]).not.toHaveBeenCalled();

    useGates[0]?.resolve();
    await expect(requests[0]).resolves.toBe('worker-0');
    await vi.waitFor(() => expect(creates[2]).toHaveBeenCalledTimes(1));

    useGates[1]?.resolve();
    useGates[2]?.resolve();
    await expect(Promise.all(requests.slice(1))).resolves.toEqual(['worker-1', 'worker-2']);
    await lifecycle.closeAll();
  });

  it('bounds queued distinct-source admissions while every worker slot is occupied', async () => {
    const lifecycle = new GenomeSourceLifecycle<TestSource>(1);
    const firstUse = deferred<void>();
    const first = lifecycle.withSource(
      'manifest-active',
      async () => createTestSource('worker-active'),
      async (source) => {
        await firstUse.promise;
        return source.id;
      }
    );
    const queued = Array.from({ length: 4 }, (_, index) =>
      lifecycle.withSource(
        `manifest-queued-${index}`,
        async () => createTestSource(`worker-queued-${index}`),
        async (source) => source.id
      )
    );
    const refused = lifecycle.withSource(
      'manifest-refused',
      async () => createTestSource('worker-refused'),
      async (source) => source.id
    );

    await expect(refused).rejects.toThrow('Genome source capacity queue is full');
    firstUse.resolve();
    await expect(first).resolves.toBe('worker-active');
    await expect(Promise.all(queued)).resolves.toEqual([
      'worker-queued-0',
      'worker-queued-1',
      'worker-queued-2',
      'worker-queued-3',
    ]);
    await lifecycle.closeAll();
  });

  it('removes a canceled request from the source-capacity queue', async () => {
    const lifecycle = new GenomeSourceLifecycle<TestSource>(1);
    const activeUse = deferred<void>();
    const activeStarted = deferred<void>();
    const staleCreate = vi.fn(async () => createTestSource('worker-stale'));
    const currentCreate = vi.fn(async () => createTestSource('worker-current'));
    const active = lifecycle.withSource(
      'manifest-active',
      async () => createTestSource('worker-active'),
      async (source) => {
        activeStarted.resolve();
        await activeUse.promise;
        return source.id;
      }
    );
    await activeStarted.promise;

    const staleController = new AbortController();
    const stale = lifecycle.withSource(
      'manifest-stale',
      staleCreate,
      async (source) => source.id,
      staleController.signal
    );
    staleController.abort();
    await expect(stale).rejects.toMatchObject({ name: 'AbortError' });

    const current = lifecycle.withSource(
      'manifest-current',
      currentCreate,
      async (source) => source.id
    );
    activeUse.resolve();

    await expect(active).resolves.toBe('worker-active');
    await expect(current).resolves.toBe('worker-current');
    expect(staleCreate).not.toHaveBeenCalled();
    expect(currentCreate).toHaveBeenCalledTimes(1);
    await lifecycle.closeAll();
  });

  it('counts a slow eviction close against the source budget until it settles', async () => {
    const lifecycle = new GenomeSourceLifecycle<TestSource>(1);
    const closeGate = deferred<void>();
    const sourceA = createTestSource('worker-a');
    sourceA.close.mockImplementation(() => closeGate.promise);
    const sourceB = createTestSource('worker-b');
    const sourceC = createTestSource('worker-c');
    const createB = vi.fn(async () => sourceB);
    const createC = vi.fn(async () => sourceC);
    const useB = deferred<void>();

    await lifecycle.withSource(
      'manifest-a',
      async () => sourceA,
      async (source) => source.id
    );
    const requestB = lifecycle.withSource('manifest-b', createB, async (source) => {
      await useB.promise;
      return source.id;
    });
    await vi.waitFor(() => expect(sourceA.close).toHaveBeenCalledTimes(1));

    const requestC = lifecycle.withSource('manifest-c', createC, async (source) => source.id);
    await Promise.resolve();
    expect(createB).not.toHaveBeenCalled();
    expect(createC).not.toHaveBeenCalled();

    closeGate.resolve();
    await vi.waitFor(() => expect(createB).toHaveBeenCalledTimes(1));
    expect(createC).not.toHaveBeenCalled();

    useB.resolve();
    await expect(requestB).resolves.toBe('worker-b');
    await expect(requestC).resolves.toBe('worker-c');
    await lifecycle.closeAll();
  });

  it('keeps a failed close quarantined until a later close attempt succeeds', async () => {
    const lifecycle = new GenomeSourceLifecycle<TestSource>(1);
    const sourceA = createTestSource('worker-a');
    sourceA.close.mockRejectedValueOnce(new Error('terminate failed'));
    const sourceB = createTestSource('worker-b');
    const createB = vi.fn(async () => sourceB);

    await lifecycle.withSource(
      'manifest-a',
      async () => sourceA,
      async (source) => source.id
    );
    await expect(
      lifecycle.withSource('manifest-b', createB, async (source) => source.id)
    ).rejects.toThrow('terminate failed');
    expect(createB).not.toHaveBeenCalled();

    await expect(
      lifecycle.withSource('manifest-b', createB, async (source) => source.id)
    ).resolves.toBe('worker-b');
    expect(sourceA.close).toHaveBeenCalledTimes(2);
    expect(createB).toHaveBeenCalledTimes(1);
    await lifecycle.closeAll();
  });

  it('keeps ephemeral source capacity through slow close and quarantines close failure', async () => {
    const lifecycle = new GenomeSourceLifecycle<TestSource>(1);
    const closeGate = deferred<void>();
    const sourceA = createTestSource('query-worker-a');
    sourceA.close.mockImplementationOnce(() => closeGate.promise);
    const sourceB = createTestSource('query-worker-b');
    const createB = vi.fn(async () => sourceB);

    const first = lifecycle.withEphemeralSource(
      'query-a',
      async () => sourceA,
      async (source) => source.id
    );
    await vi.waitFor(() => expect(sourceA.close).toHaveBeenCalledTimes(1));
    const second = lifecycle.withEphemeralSource('query-b', createB, async (source) => source.id);
    await Promise.resolve();
    expect(createB).not.toHaveBeenCalled();

    closeGate.resolve();
    await expect(first).resolves.toBe('query-worker-a');
    await expect(second).resolves.toBe('query-worker-b');
    expect(sourceB.close).toHaveBeenCalledTimes(1);

    const sourceC = createTestSource('query-worker-c');
    sourceC.close.mockRejectedValueOnce(new Error('query terminate failed'));
    await expect(
      lifecycle.withEphemeralSource(
        'query-c',
        async () => sourceC,
        async (source) => source.id
      )
    ).rejects.toThrow('query terminate failed');

    const sourceD = createTestSource('query-worker-d');
    await expect(
      lifecycle.withEphemeralSource(
        'query-d',
        async () => sourceD,
        async (source) => source.id
      )
    ).resolves.toBe('query-worker-d');
    expect(sourceC.close).toHaveBeenCalledTimes(2);
    await lifecycle.closeAll();
  });

  it('surfaces shutdown close failures and retains their owners for a retry', async () => {
    const lifecycle = new GenomeSourceLifecycle<TestSource>(1);
    const source = createTestSource('worker-a');
    source.close.mockRejectedValueOnce(new Error('terminate failed'));

    await lifecycle.withSource(
      'manifest-a',
      async () => source,
      async (value) => value.id
    );
    await expect(lifecycle.closeAll()).rejects.toThrow('One or more genome sources failed');
    expect(source.close).toHaveBeenCalledTimes(1);

    await expect(lifecycle.closeAll()).resolves.toBeUndefined();
    expect(source.close).toHaveBeenCalledTimes(2);
  });

  it('hands off capacity after cancellation during a slow eviction close', async () => {
    const lifecycle = new GenomeSourceLifecycle<TestSource>(1);
    const closeGate = deferred<void>();
    const sourceA = createTestSource('worker-a');
    sourceA.close.mockImplementation(() => closeGate.promise);
    const staleCreate = vi.fn(async () => createTestSource('worker-stale'));
    const currentCreate = vi.fn(async () => createTestSource('worker-current'));

    await lifecycle.withSource(
      'manifest-a',
      async () => sourceA,
      async (source) => source.id
    );
    const staleController = new AbortController();
    const stale = lifecycle.withSource(
      'manifest-stale',
      staleCreate,
      async (source) => source.id,
      staleController.signal
    );
    await vi.waitFor(() => expect(sourceA.close).toHaveBeenCalledTimes(1));
    const current = lifecycle.withSource(
      'manifest-current',
      currentCreate,
      async (source) => source.id
    );

    staleController.abort();
    const rejectedStale = expect(stale).rejects.toMatchObject({ name: 'AbortError' });
    closeGate.resolve();

    await rejectedStale;
    await expect(current).resolves.toBe('worker-current');
    expect(staleCreate).not.toHaveBeenCalled();
    expect(currentCreate).toHaveBeenCalledTimes(1);
    await lifecycle.closeAll();
  });

  it('waits for an in-flight eviction and prevents replacement after closeAll', async () => {
    const lifecycle = new GenomeSourceLifecycle<TestSource>(1);
    const closeGate = deferred<void>();
    const sourceA = createTestSource('worker-a');
    sourceA.close.mockImplementation(() => closeGate.promise);
    const createB = vi.fn(async () => createTestSource('worker-b'));

    await lifecycle.withSource(
      'manifest-a',
      async () => sourceA,
      async (source) => source.id
    );
    const requestB = lifecycle.withSource('manifest-b', createB, async (source) => source.id);
    await vi.waitFor(() => expect(sourceA.close).toHaveBeenCalledTimes(1));

    let shutdownSettled = false;
    const shutdown = lifecycle.closeAll().then(() => {
      shutdownSettled = true;
    });
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);

    const rejectedRequest = expect(requestB).rejects.toMatchObject({ name: 'AbortError' });
    closeGate.resolve();
    await Promise.all([shutdown, rejectedRequest]);
    expect(createB).not.toHaveBeenCalled();
    expect(shutdownSettled).toBe(true);
  });

  it('shares one close barrier and rejects new admission until shutdown settles', async () => {
    const lifecycle = new GenomeSourceLifecycle<TestSource>(2);
    const closeGate = deferred<void>();
    const source = createTestSource('worker-a');
    source.close.mockImplementation(() => closeGate.promise);
    await lifecycle.withSource(
      'manifest-a',
      async () => source,
      async (value) => value.id
    );

    const firstShutdown = lifecycle.closeAll();
    const secondShutdown = lifecycle.closeAll();
    expect(secondShutdown).toBe(firstShutdown);
    const createDuringShutdown = vi.fn(async () => createTestSource('worker-b'));
    await expect(
      lifecycle.withSource('manifest-b', createDuringShutdown, async (value) => value.id)
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(createDuringShutdown).not.toHaveBeenCalled();

    closeGate.resolve();
    await expect(firstShutdown).resolves.toBeUndefined();
    const replacement = createTestSource('worker-c');
    await expect(
      lifecycle.withSource(
        'manifest-c',
        async () => replacement,
        async (value) => value.id
      )
    ).resolves.toBe('worker-c');
    await lifecycle.closeAll();
  });
});
