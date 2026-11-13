import { makeNebBatchFetch, makeNebFetch } from './neb-tm-client';
import { calculateTmNN } from './tm-calculator';
import { DEFAULT_PRIMER_CONC_NM } from './tm-model';
import type { TmConditions, TmModel } from './tm-model';
import { createTmCalculator } from './tm-service';
import { TmProviderRegistry, createLocalTmProvider, createNebTmProvider } from './tm-provider';
import { createTmResolver, type TmResolver } from './tm-resolver';
import { refineDesignPrimerTm, type RefineTmResult } from './refine-design-tm';
import type { DesignPrimerPair } from '../types';

let registry: TmProviderRegistry | null = null;

export function getTmProviderRegistry(): TmProviderRegistry {
  if (!registry) {
    registry = new TmProviderRegistry()
      .register(createLocalTmProvider((sequence) => calculateTmNN(sequence)))
      .register(createNebTmProvider(makeNebFetch({}), makeNebBatchFetch({})));
  }
  return registry;
}

export function setTmProviderRegistry(next: TmProviderRegistry | null): void {
  registry = next;
}

export function createDesignTmResolver(
  polymerase: string | null | undefined,
  options: {
    concNm?: number;
    signal?: AbortSignal;
    userSetting?: TmModel | null;
    userSettingIsExplicit?: boolean;
    conditions?: TmConditions;
  } = {}
): TmResolver {
  const calculator = createTmCalculator({
    reaction: { polymerase: polymerase ?? null },
    userSetting: options.userSetting,
    userSettingIsExplicit: options.userSettingIsExplicit,
    conditions: options.conditions,
    concNm: options.concNm,
  });
  return createTmResolver({
    resolution: calculator.resolution,
    localFn: calculator.estimate,
    concNm: options.concNm ?? DEFAULT_PRIMER_CONC_NM,
    registry: getTmProviderRegistry(),
    signal: options.signal,
    onProviderError: (error) => {
      console.warn('[tm] provider failed, using local estimate', error);
    },
  });
}

export async function refinePrimersForPolymerase(
  primers: DesignPrimerPair[],
  polymerase: string | null | undefined,
  options: {
    concNm?: number;
    signal?: AbortSignal;
    userSetting?: TmModel | null;
    userSettingIsExplicit?: boolean;
    conditions?: TmConditions;
  } = {}
): Promise<RefineTmResult & { attempted: boolean }> {
  const resolver = createDesignTmResolver(polymerase, options);
  if (!resolver.canVerify || primers.length === 0) {
    return { primers, changed: false, verifiedCount: 0, pendingCount: 0, attempted: false };
  }
  const result = await refineDesignPrimerTm(primers, resolver);
  return { ...result, attempted: true };
}
