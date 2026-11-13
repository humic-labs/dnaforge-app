// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TmMeasurementCache,
  TmProviderRegistry,
  createLocalTmProvider,
  createNebTmProvider,
  mapWithConcurrency,
  type TmProvider,
} from './tm-provider';
import { createTmResolver } from './tm-resolver';
import {
  refineDesignPrimerTm,
  collectPrimerTmSequences,
  primerTmSequence,
} from './refine-design-tm';
import { resolveTmModelWithSource } from './tm-service';
import type { DesignPrimerPair } from '../types';

const LOCAL_FN = (sequence: string) => 50 + sequence.length / 10;
const Q5_RESOLUTION = resolveTmModelWithSource({ reaction: { polymerase: 'q5' } });
const LOCAL_RESOLUTION = resolveTmModelWithSource({});

function nebProvider(
  impl?: () => Promise<{ tm: number; ta?: number; nebApiVersion: string; fetchedAt: string }>
) {
  const fetchFn = vi.fn(
    impl ?? (async () => ({ tm: 68.4, ta: 70, nebApiVersion: 'v1', fetchedAt: 'now' }))
  );
  return { provider: createNebTmProvider(fetchFn), fetchFn };
}

function registryWithNeb(impl?: Parameters<typeof nebProvider>[0]) {
  const { provider, fetchFn } = nebProvider(impl);
  const registry = new TmProviderRegistry()
    .register(createLocalTmProvider(LOCAL_FN))
    .register(provider);
  return { registry, fetchFn };
}

describe('TmProviderRegistry — adding an endpoint must not touch callers', () => {
  it('routes a model to the provider that claims it', () => {
    const { registry } = registryWithNeb();
    expect(registry.providerFor(Q5_RESOLUTION.model)?.id).toBe('neb');
    expect(registry.providerFor(LOCAL_RESOLUTION.model)?.id).toBe('local');
  });

  it('accepts a brand-new provider without any change to the resolver', async () => {
    const vendorX: TmProvider = {
      id: 'vendor-x',
      supports: (model) => model.kind === 'neb',
      measure: async () => ({ tm: 99, source: 'vendor-x', verified: true }),
    };
    const registry = new TmProviderRegistry()
      .register(createLocalTmProvider(LOCAL_FN))
      .register(vendorX);

    const resolver = createTmResolver({
      resolution: Q5_RESOLUTION,
      localFn: LOCAL_FN,
      concNm: 500,
      registry,
      cache: new TmMeasurementCache(),
    });
    const measurement = await resolver.measure('ATGCATGCATGC');
    expect(measurement.source).toBe('vendor-x');
    expect(measurement.tm).toBe(99);
  });

  it('lets a later registration override the same id', () => {
    const registry = new TmProviderRegistry()
      .register({
        id: 'neb',
        supports: () => true,
        measure: async () => ({ tm: 1, source: 'neb', verified: true }),
      })
      .register({
        id: 'neb',
        supports: () => true,
        measure: async () => ({ tm: 2, source: 'neb', verified: true }),
      });
    expect(registry.ids).toEqual(['neb']);
  });
});

describe('createTmResolver', () => {
  let cache: TmMeasurementCache;
  beforeEach(() => {
    cache = new TmMeasurementCache();
  });

  it('does not claim it can verify a local model', () => {
    const { registry } = registryWithNeb();
    const resolver = createTmResolver({
      resolution: LOCAL_RESOLUTION,
      localFn: LOCAL_FN,
      concNm: 500,
      registry,
      cache,
    });
    expect(resolver.canVerify).toBe(false);
  });

  it('returns an authoritative measurement for a NEB model', async () => {
    const { registry, fetchFn } = registryWithNeb();
    const resolver = createTmResolver({
      resolution: Q5_RESOLUTION,
      localFn: LOCAL_FN,
      concNm: 500,
      registry,
      cache,
    });
    expect(resolver.canVerify).toBe(true);
    const measurement = await resolver.measure('ATGCATGCATGC');
    expect(measurement).toMatchObject({ tm: 68.4, source: 'neb', verified: true });
    expect(fetchFn).toHaveBeenCalledWith({
      seq: 'ATGCATGCATGC',
      prodcode: 'q5-0',
      conc_nM: 500,
      signal: expect.any(AbortSignal),
    });
  });

  it('degrades to the local estimate instead of throwing when the provider fails', async () => {
    const onProviderError = vi.fn();
    const { registry } = registryWithNeb(async () => {
      throw new Error('sidecar down');
    });
    const resolver = createTmResolver({
      resolution: Q5_RESOLUTION,
      localFn: LOCAL_FN,
      concNm: 500,
      registry,
      cache,
      onProviderError,
    });

    const measurement = await resolver.measure('ATGCATGCATGC');
    expect(measurement.verified).toBe(false);
    expect(measurement.pending).toBe(true);
    expect(measurement.tm).toBeCloseTo(LOCAL_FN('ATGCATGCATGC'), 6);
    expect(onProviderError).toHaveBeenCalled();
  });

  it('never caches an unverified fallback — a blip must not pin the session', async () => {
    let fail = true;
    const { registry } = registryWithNeb(async () => {
      if (fail) throw new Error('blip');
      return { tm: 68.4, nebApiVersion: 'v1', fetchedAt: 'now' };
    });
    const resolver = createTmResolver({
      resolution: Q5_RESOLUTION,
      localFn: LOCAL_FN,
      concNm: 500,
      registry,
      cache,
    });

    expect((await resolver.measure('ATGC')).verified).toBe(false);
    expect(cache.size).toBe(0);
    fail = false;
    expect((await resolver.measure('ATGC')).verified).toBe(true);
    expect(cache.size).toBe(1);
  });

  it('dedupes identical sequences into one upstream call', async () => {
    const { registry, fetchFn } = registryWithNeb();
    const resolver = createTmResolver({
      resolution: Q5_RESOLUTION,
      localFn: LOCAL_FN,
      concNm: 500,
      registry,
      cache,
    });

    const result = await resolver.measureMany(['AAAA', 'AAAA', 'TTTT', 'AAAA']);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(result.get('AAAA')?.tm).toBe(68.4);
    expect(result.get('TTTT')?.tm).toBe(68.4);
  });

  it('serves a repeat draft from cache with zero upstream calls', async () => {
    const { registry, fetchFn } = registryWithNeb();
    const make = () =>
      createTmResolver({
        resolution: Q5_RESOLUTION,
        localFn: LOCAL_FN,
        concNm: 500,
        registry,
        cache,
      });

    await make().measureMany(['AAAA', 'TTTT']);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    await make().measureMany(['AAAA', 'TTTT']);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('single-flights identical measurements across concurrent resolvers', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { registry, fetchFn } = registryWithNeb(async () => {
      await gate;
      return { tm: 68.4, nebApiVersion: 'v1', fetchedAt: 'now' };
    });
    const make = () =>
      createTmResolver({
        resolution: Q5_RESOLUTION,
        localFn: LOCAL_FN,
        concNm: 500,
        registry,
        cache,
      });

    const first = make().measure('AAAACCCC');
    const second = make().measure('AAAACCCC');
    expect(fetchFn).toHaveBeenCalledTimes(1);

    release();
    const measurements = await Promise.all([first, second]);
    expect(measurements.every((measurement) => measurement.verified)).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('aborts an obsolete upstream request when its last subscriber moves on', async () => {
    let upstreamSignal: AbortSignal | undefined;
    const fetchFn = vi.fn(
      async (args: { seq: string; prodcode: string; conc_nM: number; signal?: AbortSignal }) => {
        upstreamSignal = args.signal;
        return await new Promise<{
          tm: number;
          nebApiVersion: string;
          fetchedAt: string;
        }>((_resolve, reject) => {
          args.signal?.addEventListener(
            'abort',
            () => {
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true }
          );
        });
      }
    );
    const registry = new TmProviderRegistry()
      .register(createLocalTmProvider(LOCAL_FN))
      .register(createNebTmProvider(fetchFn));
    const controller = new AbortController();
    const resolver = createTmResolver({
      resolution: Q5_RESOLUTION,
      localFn: LOCAL_FN,
      concNm: 500,
      registry,
      cache,
      signal: controller.signal,
    });

    const pending = resolver.measure('AAAACCCC');
    await vi.waitFor(() => expect(upstreamSignal).toBeDefined());
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(upstreamSignal?.aborted).toBe(true);
  });

  it('keeps shared upstream work alive while another current subscriber still needs it', async () => {
    let release!: () => void;
    let upstreamSignal: AbortSignal | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchFn = vi.fn(
      async (args: { seq: string; prodcode: string; conc_nM: number; signal?: AbortSignal }) => {
        upstreamSignal = args.signal;
        await gate;
        return { tm: 68.4, nebApiVersion: 'v1', fetchedAt: 'now' };
      }
    );
    const registry = new TmProviderRegistry()
      .register(createLocalTmProvider(LOCAL_FN))
      .register(createNebTmProvider(fetchFn));
    const firstController = new AbortController();
    const secondController = new AbortController();
    const make = (signal: AbortSignal) =>
      createTmResolver({
        resolution: Q5_RESOLUTION,
        localFn: LOCAL_FN,
        concNm: 500,
        registry,
        cache,
        signal,
      });

    const first = make(firstController.signal).measure('AAAACCCC');
    const second = make(secondController.signal).measure('AAAACCCC');
    firstController.abort();

    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(upstreamSignal?.aborted).toBe(false);
    release();
    await expect(second).resolves.toMatchObject({ verified: true, tm: 68.4 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('bounds in-flight requests', async () => {
    let inFlight = 0;
    let peak = 0;
    const { registry } = registryWithNeb(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return { tm: 60, nebApiVersion: 'v1', fetchedAt: 'now' };
    });
    const resolver = createTmResolver({
      resolution: Q5_RESOLUTION,
      localFn: LOCAL_FN,
      concNm: 500,
      registry,
      cache,
      concurrency: 2,
    });

    await resolver.measureMany(Array.from({ length: 10 }, (_, i) => `SEQ${i}`));
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe('mapWithConcurrency', () => {
  it('preserves order regardless of completion order', async () => {
    const result = await mapWithConcurrency([30, 10, 20], 3, async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms / 10));
      return ms;
    });
    expect(result).toEqual([30, 10, 20]);
  });

  it('handles an empty list', async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });
});

describe('refineDesignPrimerTm', () => {
  function pair(fragmentIndex: number, fwd: string, rev: string): DesignPrimerPair {
    const primer = (id: string, pbs: string) => ({
      id,
      name: id,
      sequence: pbs,
      pbs: { start: 0, end: pbs.length, sequence: pbs },
      overhang: { length: 0, sequence: '' },
      direction: 'forward' as const,
      fragmentIndex,
      junctionIndex: 0,
      tm: 50,
    });
    return {
      forward: primer(`f${fragmentIndex}`, fwd),
      reverse: { ...primer(`r${fragmentIndex}`, rev), direction: 'reverse' as const },
      fragmentIndex,
    } as unknown as DesignPrimerPair;
  }

  const PRIMERS = [pair(0, 'AAAACCCC', 'TTTTGGGG'), pair(1, 'AAAACCCC', 'CCCCAAAA')];

  it('collects every PBS sequence that needs a Tm', () => {
    expect(collectPrimerTmSequences(PRIMERS)).toEqual([
      'AAAACCCC',
      'TTTTGGGG',
      'AAAACCCC',
      'CCCCAAAA',
    ]);
  });

  it('measures the PBS only, ignoring Golden Gate cognate bases', async () => {
    const goldenGatePrimer = {
      ...PRIMERS[0].forward,
      overhang: { length: 4, sequence: 'AACG' },
      cognate4bpLength: 2,
    };
    const goldenGatePair = [{ ...PRIMERS[0], forward: goldenGatePrimer }];
    const { registry, fetchFn } = registryWithNeb();
    const resolver = createTmResolver({
      resolution: Q5_RESOLUTION,
      localFn: LOCAL_FN,
      concNm: 500,
      registry,
      cache: new TmMeasurementCache(),
    });

    expect(primerTmSequence(goldenGatePrimer)).toBe('AAAACCCC');
    expect(collectPrimerTmSequences(goldenGatePair)).toEqual(['AAAACCCC', 'TTTTGGGG']);
    await refineDesignPrimerTm(goldenGatePair, resolver);
    expect(fetchFn).toHaveBeenCalledWith({
      seq: 'AAAACCCC',
      prodcode: 'q5-0',
      conc_nM: 500,
      signal: expect.any(AbortSignal),
    });
  });

  it('submits every unique primer in one NEB batch when the provider can', async () => {
    const batchFetch = vi.fn(async ({ seqs }: { seqs: string[] }) =>
      seqs.map((seq) => ({ tm: seq.length, nebApiVersion: 'v1', fetchedAt: 'now' }))
    );
    const batched = createNebTmProvider(
      async () => ({ tm: 1, nebApiVersion: 'v1', fetchedAt: 'now' }),
      batchFetch
    );
    const registry = new TmProviderRegistry()
      .register(createLocalTmProvider(LOCAL_FN))
      .register(batched);
    const resolver = createTmResolver({
      resolution: Q5_RESOLUTION,
      localFn: LOCAL_FN,
      concNm: 500,
      registry,
      cache: new TmMeasurementCache(),
    });

    const result = await refineDesignPrimerTm(PRIMERS, resolver);
    expect(batchFetch).toHaveBeenCalledTimes(1);
    expect(batchFetch.mock.calls[0][0].seqs).toEqual(['AAAACCCC', 'TTTTGGGG', 'CCCCAAAA']);
    expect(result.verifiedCount).toBe(4);
  });

  it('patches in authoritative values and records provenance', async () => {
    const { registry } = registryWithNeb();
    const resolver = createTmResolver({
      resolution: Q5_RESOLUTION,
      localFn: LOCAL_FN,
      concNm: 500,
      registry,
      cache: new TmMeasurementCache(),
    });

    const result = await refineDesignPrimerTm(PRIMERS, resolver);
    expect(result.changed).toBe(true);
    expect(result.verifiedCount).toBe(4);
    expect(result.primers[0].forward.tm).toBe(68.4);
    expect(result.primers[0].forward.tmProvenance).toMatchObject({
      source: 'neb',
      verified: true,
    });
  });

  it('persists authoritative provenance even when the numeric Tm is unchanged', async () => {
    const { registry } = registryWithNeb(async () => ({
      tm: 50,
      ta: 62,
      nebApiVersion: 'v1',
      fetchedAt: 'now',
    }));
    const cache = new TmMeasurementCache();
    const resolver = () =>
      createTmResolver({
        resolution: Q5_RESOLUTION,
        localFn: LOCAL_FN,
        concNm: 500,
        registry,
        cache,
      });

    const once = await refineDesignPrimerTm(PRIMERS, resolver());
    expect(once.changed).toBe(true);
    expect(once.primers[0].forward.tm).toBe(50);
    expect(once.primers[0].forward.tmProvenance).toMatchObject({
      source: 'neb',
      verified: true,
      ta: 62,
    });

    const twice = await refineDesignPrimerTm(once.primers, resolver());
    expect(twice.changed).toBe(false);
  });

  it('is a no-op when the model cannot be verified', async () => {
    const { registry, fetchFn } = registryWithNeb();
    const resolver = createTmResolver({
      resolution: LOCAL_RESOLUTION,
      localFn: LOCAL_FN,
      concNm: 500,
      registry,
      cache: new TmMeasurementCache(),
    });

    const result = await refineDesignPrimerTm(PRIMERS, resolver);
    expect(result.changed).toBe(false);
    expect(result.primers).toBe(PRIMERS);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('is idempotent — refining twice changes nothing the second time', async () => {
    const { registry } = registryWithNeb();
    const cache = new TmMeasurementCache();
    const resolver = () =>
      createTmResolver({
        resolution: Q5_RESOLUTION,
        localFn: LOCAL_FN,
        concNm: 500,
        registry,
        cache,
      });

    const once = await refineDesignPrimerTm(PRIMERS, resolver());
    const twice = await refineDesignPrimerTm(once.primers, resolver());
    expect(twice.changed).toBe(false);
  });

  it('keeps the local number and flags it pending when the provider is down', async () => {
    const { registry } = registryWithNeb(async () => {
      throw new Error('offline');
    });
    const resolver = createTmResolver({
      resolution: Q5_RESOLUTION,
      localFn: LOCAL_FN,
      concNm: 500,
      registry,
      cache: new TmMeasurementCache(),
    });

    const result = await refineDesignPrimerTm(PRIMERS, resolver);
    expect(result.verifiedCount).toBe(0);
    expect(result.pendingCount).toBe(4);
    expect(result.primers[0].forward.tmProvenance).toMatchObject({
      verified: false,
      pending: true,
    });
  });
});
