import type { TmModel } from './tm-model';
import {
  TmMeasurementCache,
  TmProviderRegistry,
  createLocalTmProvider,
  mapWithConcurrency,
  type TmMeasurement,
} from './tm-provider';
import type { TmModelResolution } from './tm-service';

export interface TmResolverConfig {
  resolution: TmModelResolution;
  localFn: (sequence: string) => number;
  concNm: number;
  registry: TmProviderRegistry;
  cache?: TmMeasurementCache;
  concurrency?: number;
  onProviderError?: (error: unknown, sequence: string) => void;
  signal?: AbortSignal;
}

export interface TmResolver {
  readonly resolution: TmModelResolution;
  readonly canVerify: boolean;
  measure(sequence: string): Promise<TmMeasurement>;
  measureMany(sequences: string[]): Promise<Map<string, TmMeasurement>>;
}

const DEFAULT_CONCURRENCY = 4;

export const SHARED_TM_CACHE = new TmMeasurementCache();

export function createTmResolver(config: TmResolverConfig): TmResolver {
  const cache = config.cache ?? SHARED_TM_CACHE;
  const registry = config.registry;
  const model: TmModel = config.resolution.model;

  const authoritative = registry.providerFor(model);
  const local = createLocalTmProvider(config.localFn);
  const canVerify = authoritative !== null && authoritative.id !== 'local';

  function localMeasurement(sequence: string, pending: boolean): TmMeasurement {
    return {
      tm: config.localFn(sequence),
      source: 'local',
      verified: false,
      model,
      concNm: config.concNm,
      ...(pending ? { pending: true } : {}),
    };
  }

  async function measureOne(sequence: string): Promise<TmMeasurement> {
    const provider = authoritative ?? local;
    if (provider.id === 'local') return localMeasurement(sequence, false);

    const key = TmMeasurementCache.key({ sequence, model, concNm: config.concNm });
    const hit = cache.get(key);
    if (hit) return hit;

    if (config.signal?.aborted) throw abortError();

    try {
      return await cache.measureInFlight(key, config.signal, async (sharedSignal) => {
        const measured = await provider.measure({
          sequence,
          model,
          concNm: config.concNm,
          signal: sharedSignal,
        });
        const measurement: TmMeasurement = {
          ...measured,
          model,
          concNm: config.concNm,
        };
        cache.set(key, measurement);
        return measurement;
      });
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error;
      config.onProviderError?.(error, sequence);
      return localMeasurement(sequence, true);
    }
  }

  return {
    resolution: config.resolution,
    canVerify,
    measure: measureOne,
    measureMany: async (sequences: string[]) => {
      const out = new Map<string, TmMeasurement>();
      const unique = [...new Set(sequences.filter((sequence) => sequence.length > 0))];
      const missing: string[] = [];
      for (const sequence of unique) {
        const key = TmMeasurementCache.key({ sequence, model, concNm: config.concNm });
        const hit = cache.get(key);
        if (hit) out.set(sequence, hit);
        else missing.push(sequence);
      }

      if (missing.length > 0 && authoritative?.measureMany && model.kind !== 'local') {
        try {
          const measured = await authoritative.measureMany(
            missing.map((sequence) => ({
              sequence,
              model,
              concNm: config.concNm,
              signal: config.signal,
            }))
          );
          missing.forEach((sequence, index) => {
            const measurement = {
              ...measured[index],
              model,
              concNm: config.concNm,
            };
            cache.set(
              TmMeasurementCache.key({ sequence, model, concNm: config.concNm }),
              measurement
            );
            out.set(sequence, measurement);
          });
        } catch (error) {
          if ((error as Error).name === 'AbortError') throw error;
          for (const sequence of missing) {
            config.onProviderError?.(error, sequence);
            out.set(sequence, localMeasurement(sequence, true));
          }
        }
      } else if (missing.length > 0) {
        const measured = await mapWithConcurrency(
          missing,
          config.concurrency ?? DEFAULT_CONCURRENCY,
          measureOne
        );
        missing.forEach((sequence, index) => out.set(sequence, measured[index]));
      }
      return out;
    },
  };
}

function abortError(): Error {
  const error = new Error('Tm refinement was superseded.');
  error.name = 'AbortError';
  return error;
}
