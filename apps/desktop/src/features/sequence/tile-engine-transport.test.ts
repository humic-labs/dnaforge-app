// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import type { TileTransport, TileTransportPriority } from '@waypoint/genome-renderer';
import {
  buildAssembly,
  createAlignmentTileSource,
  globalRangeToSegments,
  maxReadAlignmentLevel,
  TileCache,
  TileCoordinator,
} from '@waypoint/genome-renderer';
import { limitConcurrency } from './tile-engine-transport';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function coverageRequest(
  tileIndex: number,
  priority: TileTransportPriority
): Parameters<TileTransport>[0] {
  return {
    kind: 'coverage-assembly',
    level: 6,
    tileIndex,
    body: { bamPath: '/fake.bam', segments: [] },
    priority,
  };
}

function alignmentRequest(
  tileIndex: number,
  priority: TileTransportPriority
): Parameters<TileTransport>[0] {
  return {
    kind: 'alignment',
    level: 0,
    tileIndex,
    body: { bamPath: '/fake.bam', segments: [] },
    priority,
  };
}

function okCoverage(): Awaited<ReturnType<TileTransport>> {
  return {
    ok: true,
    status: 200,
    body: {
      bins: [1],
      binSize: 64,
      maxDepth: 1,
    },
  };
}

async function settleTilePromises(): Promise<void> {
  for (let i = 0; i < 80; i++) await Promise.resolve();
}

function currentReadBandHarness() {
  const assembly = buildAssembly('remote-read-band', 'remote read band', [
    { id: 'chr16', displayName: 'chr16', length: 200_000, cytobands: [] },
  ]);
  const held: Array<{
    req: Parameters<TileTransport>[0];
    rawSignal: AbortSignal;
    resolve: () => void;
  }> = [];
  const consumers: Array<{ req: Parameters<TileTransport>[0]; signal: AbortSignal }> = [];
  let releaseAll = false;
  let rawActive = 0;
  let peakRawActive = 0;
  const response = (): Awaited<ReturnType<TileTransport>> => ({
    ok: true,
    status: 200,
    body: { reads: [], count: 0 },
  });
  const limited = limitConcurrency((req, rawSignal) => {
    rawActive += 1;
    peakRawActive = Math.max(peakRawActive, rawActive);
    const result =
      req.priority?.purpose === 'coarser' && !releaseAll
        ? new Promise<Awaited<ReturnType<TileTransport>>>((resolve) =>
            held.push({ req, rawSignal, resolve: () => resolve(response()) })
          )
        : Promise.resolve(response());
    return result.finally(() => {
      rawActive -= 1;
    });
  }, 8);
  const source = createAlignmentTileSource(
    { bamPath: '/remote-read-band.cram' },
    {
      transport: (req, signal) => {
        consumers.push({ req, signal });
        return limited(req, signal);
      },
    },
    'bounded-network'
  );
  const cache = new TileCache({ maxEntries: 512, maxBytes: 201_326_592 });
  const coordinator = new TileCoordinator({ assembly, sources: [source], cache });
  return {
    cache,
    coordinator,
    source,
    held,
    consumers,
    peakRawActive: () => peakRawActive,
    commit: (start: number) =>
      coordinator.setViewport({ globalStart: start, globalEnd: start + 2_000, viewportPx: 2_204 }),
    release: () => {
      releaseAll = true;
      for (const request of held) request.resolve();
    },
  };
}

describe('tile-engine transport scheduling', () => {
  it('starts current surfaces in a free slot while older margin work remains active', async () => {
    const older = deferred<Awaited<ReturnType<TileTransport>>>();
    const started: number[] = [];
    const limited = limitConcurrency((req) => {
      started.push(req.tileIndex);
      return req.tileIndex === 0 ? older.promise : Promise.resolve(okCoverage());
    }, 2);
    const signal = new AbortController().signal;
    const pending = [
      limited(
        alignmentRequest(0, {
          purpose: 'current',
          epoch: 1,
          core: false,
          marginDistanceTiles: 1,
        }),
        signal
      ),
    ];
    try {
      await settleTilePromises();
      expect(started).toEqual([0]);
      pending.push(
        limited(
          coverageRequest(1, {
            purpose: 'current',
            epoch: 2,
            core: true,
            marginDistanceTiles: 0,
          }),
          signal
        ),
        limited(
          alignmentRequest(2, {
            purpose: 'current',
            epoch: 2,
            core: true,
            marginDistanceTiles: 0,
          }),
          signal
        )
      );
      await settleTilePromises();
      expect(started).toContain(1);
      expect(started).toContain(2);
    } finally {
      older.resolve(okCoverage());
      await Promise.all(pending);
    }
  });

  describe('native remote required read scheduling', () => {
    function harness(optIn = true, initialLevel = 0) {
      const started: Array<{
        req: Parameters<TileTransport>[0];
        signal: AbortSignal;
        result: ReturnType<typeof deferred<Awaited<ReturnType<TileTransport>>>>;
      }> = [];
      const pending: Array<ReturnType<TileTransport>> = [];
      let level = initialLevel;
      let releaseAll = false;
      let active = 0;
      let peak = 0;
      const limited = limitConcurrency(
        (req, signal) => {
          active += 1;
          peak = Math.max(peak, active);
          const result = deferred<Awaited<ReturnType<TileTransport>>>();
          started.push({ req, signal, result });
          if (releaseAll) result.resolve(okCoverage());
          return result.promise.finally(() => {
            active -= 1;
          });
        },
        8,
        {
          canAbortActive: (req) => req.kind === 'alignment',
          currentReadAlignmentLevel: optIn ? () => level : undefined,
        }
      );
      return {
        started,
        setLevel: (next: number) => {
          level = next;
        },
        peak: () => peak,
        submit: (req: Parameters<TileTransport>[0], signal = new AbortController().signal) => {
          const result = limited(req, signal);
          void result.catch(() => undefined);
          pending.push(result);
          return result;
        },
        finish: async () => {
          releaseAll = true;
          for (const item of started) item.result.resolve(okCoverage());
          await Promise.allSettled(pending);
        },
      };
    }
    function request(
      index: number,
      level = 0,
      core = true,
      purpose: TileTransportPriority['purpose'] = 'current',
      epoch = 7,
      source = '/remote.cram'
    ) {
      return {
        ...alignmentRequest(index, { purpose, epoch, core, marginDistanceTiles: core ? 0 : 1 }),
        level,
        body: { bamPath: source },
      };
    }

    it('defers same-source coarse current cores and future reads until all five required reads settle', async () => {
      const h = harness();
      try {
        h.submit(request(20, 1));
        h.submit(request(21, 2, false, 'coarser'));
        h.submit(request(22, 0, false, 'adjacent-finer'));
        for (const index of [9, 10, 11, 12, 13])
          h.submit(request(index, 0, index > 9 && index < 13));
        await settleTilePromises();
        expect(h.started.map(({ req }) => req.tileIndex).sort((a, b) => a - b)).toEqual([
          9, 10, 11, 12, 13,
        ]);
        for (const item of h.started.filter(({ req }) => req.priority?.core))
          item.result.resolve(okCoverage());
        await settleTilePromises();
        expect(h.started).toHaveLength(5);
        for (const item of h.started) item.result.resolve(okCoverage());
        await settleTilePromises();
        expect(h.started.map(({ req }) => req.tileIndex)).toEqual(
          expect.arrayContaining([20, 21, 22])
        );
        expect(h.peak()).toBeLessThanOrEqual(8);
      } finally {
        await h.finish();
      }
    });

    it('keeps cancelled required raw work and its live collar sibling ahead of optional reads until settlement', async () => {
      const h = harness();
      const cancelled = new AbortController();
      try {
        const core = h.submit(request(10), cancelled.signal);
        h.submit(request(9, 0, false));
        h.submit(request(20, 1));
        await settleTilePromises();
        expect(h.started).toHaveLength(2);
        cancelled.abort();
        await settleTilePromises();
        expect(h.started[0]?.signal.aborted).toBe(true);
        expect(h.started[1]?.signal.aborted).toBe(false);
        expect(h.started).toHaveLength(2);
        h.started[0]!.result.resolve(okCoverage());
        await expect(core).rejects.toMatchObject({ name: 'AbortError' });
        await settleTilePromises();
        expect(h.started).toHaveLength(2);
        h.started[1]!.result.resolve(okCoverage());
        await settleTilePromises();
        expect(h.started.at(-1)?.req.tileIndex).toBe(20);
      } finally {
        await h.finish();
      }
    });

    it('does not block other sources, epochs, or coverage floors behind a required read', async () => {
      const h = harness();
      try {
        h.submit(request(10));
        h.submit(request(20, 1, true, 'current', 7, '/other.cram'));
        h.submit(request(21, 1, true, 'current', 8));
        h.submit({
          ...coverageRequest(22, {
            purpose: 'current',
            epoch: 7,
            core: true,
            marginDistanceTiles: 0,
          }),
          body: { bamPath: '/remote.cram', segments: [] },
        });
        await settleTilePromises();
        expect(h.started.map(({ req }) => req.tileIndex)).toEqual(
          expect.arrayContaining([10, 20, 21, 22])
        );
      } finally {
        await h.finish();
      }
    });

    it('removes an aborted queued required blocker before pumping optional work', async () => {
      const h = harness();
      const cancelled = new AbortController();
      try {
        for (let index = 0; index < 8; index++)
          h.submit(
            coverageRequest(index, {
              purpose: 'current',
              epoch: 7,
              core: true,
              marginDistanceTiles: 0,
            })
          );
        await settleTilePromises();
        const required = h.submit(request(10), cancelled.signal);
        h.submit(request(20, 1));
        cancelled.abort();
        await expect(required).rejects.toMatchObject({ name: 'AbortError' });
        h.started[0]!.result.resolve(okCoverage());
        await settleTilePromises();
        expect(h.started.at(-1)?.req.tileIndex).toBe(20);
        expect(h.started.some(({ req }) => req.kind === 'alignment' && req.tileIndex === 10)).toBe(
          false
        );
        expect(h.peak()).toBeLessThanOrEqual(8);
      } finally {
        await h.finish();
      }
    });

    it('uses the live required level instead of retaining an old-level gate', async () => {
      const h = harness();
      try {
        h.submit(request(10));
        await settleTilePromises();
        h.setLevel(1);
        h.submit(request(11, 1));
        h.submit(request(20, 2));
        await settleTilePromises();
        expect(h.started.map(({ req }) => req.tileIndex)).toEqual([10, 11]);
        h.started[1]!.result.resolve(okCoverage());
        await settleTilePromises();
        expect(h.started.at(-1)?.req.tileIndex).toBe(20);
        expect(h.started[0]!.signal.aborted).toBe(false);
      } finally {
        await h.finish();
      }
    });

    it.each([
      { name: 'local/default scheduling', optIn: false, level: 0, purpose: 'current' as const },
      {
        name: 'broad remote scheduling',
        optIn: true,
        level: maxReadAlignmentLevel() + 1,
        purpose: 'current' as const,
      },
      {
        name: 'directional pan lead without required current work',
        optIn: true,
        level: 0,
        purpose: 'pan-lead' as const,
      },
    ])('preserves $name', async ({ optIn, level, purpose }) => {
      const h = harness(optIn, level);
      try {
        h.submit(request(10, level, true, purpose));
        h.submit(request(20, level + 1));
        await settleTilePromises();
        expect(h.started).toHaveLength(2);
      } finally {
        await h.finish();
      }
    });
  });

  it('cancels an admitted cancellable alignment request without cancelling its sibling', async () => {
    const raw: Array<{
      signal: AbortSignal;
      result: ReturnType<typeof deferred<Awaited<ReturnType<TileTransport>>>>;
    }> = [];
    const transport = limitConcurrency(
      (_request, signal) => {
        const result = deferred<Awaited<ReturnType<TileTransport>>>();
        raw.push({ signal, result });
        return result.promise;
      },
      2,
      { canAbortActive: (request) => request.kind === 'alignment' }
    );
    const priority: TileTransportPriority = {
      purpose: 'current',
      epoch: 1,
      core: true,
      marginDistanceTiles: 0,
    };
    const oldView = new AbortController();
    const old = transport(alignmentRequest(0, priority), oldView.signal).catch(
      (error: Error) => error.name
    );
    const sibling = transport(alignmentRequest(1, priority), new AbortController().signal);
    await settleTilePromises();
    oldView.abort();
    expect(raw[0]!.signal.aborted).toBe(true);
    expect(raw[1]!.signal.aborted).toBe(false);
    const next = transport(alignmentRequest(2, priority), new AbortController().signal);
    await settleTilePromises();
    expect(raw).toHaveLength(2);
    raw[0]!.result.reject(new DOMException('Reaped', 'AbortError'));
    await settleTilePromises();
    expect(await old).toBe('AbortError');
    expect(raw).toHaveLength(3);
    raw[1]!.result.resolve(okCoverage());
    raw[2]!.result.resolve(okCoverage());
    await expect(sibling).resolves.toMatchObject({ status: 200 });
    await expect(next).resolves.toMatchObject({ status: 200 });
  });

  it('keeps noncancellable coverage running when cancellation is enabled only for alignment', async () => {
    const result = deferred<Awaited<ReturnType<TileTransport>>>();
    let rawSignal: AbortSignal | null = null;
    const transport = limitConcurrency(
      (_request, signal) => {
        rawSignal = signal;
        return result.promise;
      },
      1,
      { canAbortActive: (request) => request.kind === 'alignment' }
    );
    const viewport = new AbortController();
    const outcome = transport(
      { kind: 'coverage-assembly', level: 6, tileIndex: 0, body: {} },
      viewport.signal
    ).catch((error: Error) => error.name);
    await settleTilePromises();
    viewport.abort();
    expect(rawSignal!.aborted).toBe(false);
    result.resolve(okCoverage());
    expect(await outcome).toBe('AbortError');
  });

  it('rejects expired queued work when raw completion pumps before an overdue timer', async () => {
    vi.useFakeTimers();
    const held = deferred<Awaited<ReturnType<TileTransport>>>();
    try {
      const started: number[] = [];
      const transport = limitConcurrency((req) => {
        started.push(req.tileIndex);
        return req.tileIndex === 0 ? held.promise : Promise.resolve(okCoverage());
      }, 1);
      const priority: TileTransportPriority = {
        purpose: 'current',
        epoch: 1,
        core: true,
        marginDistanceTiles: 0,
      };
      const active = transport(alignmentRequest(0, priority), new AbortController().signal);
      await settleTilePromises();
      const source = createAlignmentTileSource(
        { bamPath: '/remote-read-band.bam' },
        { transport, timeoutMs: 50 },
        'bounded-network'
      );
      const assembly = buildAssembly('queued-read', 'queued read', [
        { id: 'chr1', displayName: 'chr1', length: 10_000, cytobands: [] },
      ]);
      const expired = source.fetchTile(
        0,
        1,
        globalRangeToSegments(assembly, 1_024, 2_048),
        new AbortController().signal,
        { priority }
      );
      await settleTilePromises();
      vi.setSystemTime(Date.now() + 60);
      const fresh = transport(alignmentRequest(2, priority), new AbortController().signal);
      held.resolve(okCoverage());
      await active;
      await fresh;
      await settleTilePromises();
      expect(started).toEqual([0, 2]);
      expect(await expired).toMatchObject({ state: 'error', errorReason: 'timeout' });
    } finally {
      held.resolve(okCoverage());
      await settleTilePromises();
      vi.useRealTimers();
    }
  });

  it('never dispatches a tile that expired while queued behind an active raw read', async () => {
    vi.useFakeTimers();
    const held = deferred<Awaited<ReturnType<TileTransport>>>();
    try {
      const started: number[] = [];
      const rawSignals: AbortSignal[] = [];
      const transport = limitConcurrency((req, signal) => {
        started.push(req.tileIndex);
        rawSignals.push(signal);
        return req.tileIndex === 0 ? held.promise : Promise.resolve(okCoverage());
      }, 1);
      const priority: TileTransportPriority = {
        purpose: 'current',
        epoch: 1,
        core: true,
        marginDistanceTiles: 0,
      };
      const active = transport(alignmentRequest(0, priority), new AbortController().signal);
      await settleTilePromises();
      const source = createAlignmentTileSource(
        { bamPath: '/remote-read-band.bam' },
        { transport, timeoutMs: 50 },
        'bounded-network'
      );
      const assembly = buildAssembly('queued-read', 'queued read', [
        { id: 'chr1', displayName: 'chr1', length: 10_000, cytobands: [] },
      ]);
      const expired = source.fetchTile(
        0,
        1,
        globalRangeToSegments(assembly, 1_024, 2_048),
        new AbortController().signal,
        { priority }
      );
      await vi.advanceTimersByTimeAsync(50);
      expect(await expired).toMatchObject({ state: 'error', errorReason: 'timeout' });
      expect(started).toEqual([0]);
      expect(rawSignals[0]?.aborted).toBe(false);

      const fresh = transport(alignmentRequest(2, priority), new AbortController().signal);
      held.resolve(okCoverage());
      await active;
      await fresh;
      await settleTilePromises();
      expect(started).toEqual([0, 2]);
    } finally {
      held.resolve(okCoverage());
      await settleTilePromises();
      vi.useRealTimers();
    }
  });

  it('settles a fresh bounded-network five-tile read band before coarse warmup', async () => {
    const h = currentReadBandHarness();
    try {
      h.commit(50_000);
      await settleTilePromises();
      for (const index of [47, 48, 49, 50, 51]) {
        expect(h.cache.peek({ sourceId: h.source.id, level: 0, index })?.state).toBe('ready');
      }
    } finally {
      h.release();
      await settleTilePromises();
    }
  });

  it('settles the required current read-band neighbor while obsolete coarse reads retain six slots', async () => {
    const h = currentReadBandHarness();
    try {
      h.commit(10_000);
      await settleTilePromises();
      expect(h.held).toHaveLength(2);
      h.commit(30_000);
      await settleTilePromises();
      expect(h.held).toHaveLength(6);
      h.commit(50_000);
      await settleTilePromises();

      expect(
        h.held.every(({ req }) => h.consumers.find((c) => c.req === req)?.signal.aborted)
      ).toBe(true);
      expect(h.held.every(({ rawSignal }) => !rawSignal.aborted)).toBe(true);
      expect(h.peakRawActive()).toBeLessThanOrEqual(8);
      for (const index of [48, 49, 50]) {
        expect(
          h.cache.peek({ sourceId: h.source.id, level: 0, index })?.state,
          'current visible reads have settled'
        ).toBe('ready');
      }
      expect(
        h.consumers.find(
          (c) => c.req.level === 0 && c.req.tileIndex === 47 && c.req.priority?.epoch === 3
        )?.req.priority
      ).toMatchObject({ purpose: 'current', core: false, marginDistanceTiles: 1 });
      for (const index of [47, 51]) {
        expect
          .soft(
            h.cache.peek({ sourceId: h.source.id, level: 0, index })?.state,
            `required read-band neighbor ${index} must settle using spare raw capacity`
          )
          .toBe('ready');
      }
    } finally {
      h.release();
      await settleTilePromises();
    }
  });

  it.each([
    {
      name: 'guide-only current alignment',
      level: maxReadAlignmentLevel() + 1,
      purpose: 'current' as const,
      margin: 1,
    },
    {
      name: 'distant current alignment',
      level: maxReadAlignmentLevel(),
      purpose: 'current' as const,
      margin: 2,
    },
    { name: 'coarse alignment', level: 0, purpose: 'coarser' as const, margin: 1 },
    { name: 'adjacent alignment', level: 0, purpose: 'adjacent-finer' as const, margin: 1 },
  ])('retains the optional-work cap for $name', async ({ level, purpose, margin }) => {
    const held = deferred<Awaited<ReturnType<TileTransport>>>();
    const started: number[] = [];
    const limited = limitConcurrency((req) => {
      started.push(req.tileIndex);
      return held.promise;
    }, 8);
    const requests = Array.from({ length: 8 }, (_, index) =>
      limited(
        {
          ...alignmentRequest(index, {
            purpose,
            epoch: 10,
            core: false,
            marginDistanceTiles: margin,
          }),
          level,
        },
        new AbortController().signal
      )
    );
    await settleTilePromises();
    try {
      expect(started).toHaveLength(2);
    } finally {
      held.resolve(okCoverage());
      await Promise.allSettled(requests);
    }
  });

  it('starts current read cores ahead of queued required neighbors', async () => {
    const first = deferred<Awaited<ReturnType<TileTransport>>>();
    const started: number[] = [];
    const limited = limitConcurrency((req) => {
      started.push(req.tileIndex);
      return req.tileIndex === 1 ? first.promise : Promise.resolve(okCoverage());
    }, 1);
    const predecessor = limited(
      alignmentRequest(1, { purpose: 'current', epoch: 1, core: true, marginDistanceTiles: 0 }),
      new AbortController().signal
    );
    await settleTilePromises();
    const neighbor = limited(
      alignmentRequest(2, { purpose: 'current', epoch: 2, core: false, marginDistanceTiles: 1 }),
      new AbortController().signal
    );
    const core = limited(
      alignmentRequest(3, { purpose: 'current', epoch: 2, core: true, marginDistanceTiles: 0 }),
      new AbortController().signal
    );
    first.resolve(okCoverage());
    await Promise.all([predecessor, neighbor, core]);
    expect(started).toEqual([1, 3, 2]);
  });

  it('does not let old adjacent coverage occupy every active slot before newer current work', async () => {
    const active = deferred<Awaited<ReturnType<TileTransport>>>();
    const started: Array<{ tileIndex: number; purpose: string | undefined }> = [];
    const limited = limitConcurrency((req) => {
      started.push({ tileIndex: req.tileIndex, purpose: req.priority?.purpose });
      return active.promise;
    }, 8);
    const adjacent = Array.from({ length: 8 }, (_, index) =>
      limited(
        coverageRequest(index, {
          purpose: 'adjacent-finer',
          epoch: 1,
          core: false,
          marginDistanceTiles: 0,
        }),
        new AbortController().signal
      )
    );
    await Promise.resolve();

    expect(
      started.length,
      'old-camera adjacent coverage is speculative and must leave active capacity reserved'
    ).toBeLessThanOrEqual(2);

    const current = limited(
      coverageRequest(99, {
        purpose: 'current',
        epoch: 2,
        core: true,
        marginDistanceTiles: 0,
      }),
      new AbortController().signal
    );
    await Promise.resolve();
    expect(started).toContainEqual({ tileIndex: 99, purpose: 'current' });

    active.resolve(okCoverage());
    await current;
    await Promise.allSettled(adjacent);
  });

  it('starts the alignment tiles ahead of a side-scroll even when speculative slots are full', async () => {
    const active = deferred<Awaited<ReturnType<TileTransport>>>();
    const started: Array<{ tileIndex: number; purpose: string | undefined }> = [];
    const limited = limitConcurrency((req) => {
      started.push({ tileIndex: req.tileIndex, purpose: req.priority?.purpose });
      return active.promise;
    }, 8);
    const adjacent = Array.from({ length: 8 }, (_, index) =>
      limited(
        coverageRequest(index, {
          purpose: 'adjacent-finer',
          epoch: 1,
          core: false,
          marginDistanceTiles: 0,
        }),
        new AbortController().signal
      )
    );
    await Promise.resolve();
    expect(started.length).toBeLessThanOrEqual(2);

    const lead = limited(
      alignmentRequest(40, {
        purpose: 'pan-lead',
        epoch: 2,
        core: true,
        marginDistanceTiles: 0,
      }),
      new AbortController().signal
    );
    await Promise.resolve();
    expect(started).toContainEqual({ tileIndex: 40, purpose: 'pan-lead' });

    active.resolve(okCoverage());
    await lead;
    await Promise.allSettled(adjacent);
  });

  it('reserves active slots for visible current-core tiles over non-core current margins', async () => {
    const marginActive = deferred<Awaited<ReturnType<TileTransport>>>();
    const coreActive = deferred<Awaited<ReturnType<TileTransport>>>();
    const started: Array<{
      tileIndex: number;
      core: boolean | undefined;
      marginDistanceTiles: number | undefined;
    }> = [];
    const limited = limitConcurrency((req) => {
      started.push({
        tileIndex: req.tileIndex,
        core: req.priority?.core,
        marginDistanceTiles: req.priority?.marginDistanceTiles,
      });
      return req.priority?.core === true ? coreActive.promise : marginActive.promise;
    }, 4);

    const marginRequests = Array.from({ length: 8 }, (_, i) =>
      limited(
        coverageRequest(i + 1, {
          purpose: 'current',
          epoch: 10,
          core: false,
          marginDistanceTiles: i + 1,
        }),
        new AbortController().signal
      )
    );

    await Promise.resolve();
    expect(
      started,
      'non-core current margins are pan prefetch, not visible truth; they must not fill all active slots'
    ).toEqual([{ tileIndex: 1, core: false, marginDistanceTiles: 1 }]);

    const visibleCore = limited(
      coverageRequest(99, {
        purpose: 'current',
        epoch: 11,
        core: true,
        marginDistanceTiles: 0,
      }),
      new AbortController().signal
    );

    await Promise.resolve();
    expect(started).toEqual([
      { tileIndex: 1, core: false, marginDistanceTiles: 1 },
      { tileIndex: 99, core: true, marginDistanceTiles: 0 },
    ]);

    marginActive.resolve(okCoverage());
    coreActive.resolve(okCoverage());
    await visibleCore;
    await Promise.allSettled(marginRequests);
  });
});
