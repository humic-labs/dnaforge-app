import type { TmModel } from './tm-model';

export type TmSource = 'neb-api' | 'neb-q5-offline' | 'local';

export interface PrimerTmProvenance {
  source: TmSource;
  tm: number;
  ta?: number;
  conc_nM: number;
  verified: boolean;
  pendingNebVerification?: boolean;

  polymerase?: string;
  prodcode?: string;
  nebApiVersion?: string;
  fetchedAt?: string;
}

export interface TmResult {
  tm: number;
  ta?: number;
  provenance: PrimerTmProvenance;
  verified: boolean;
  pendingNebVerification?: boolean;
}

export interface NebTmResponse {
  tm: number;
  ta?: number;
  nebApiVersion: string;
  fetchedAt: string;
}

export interface ComputeTmDeps {
  localFn: (seq: string) => number;

  nebFetch?: (args: {
    seq: string;
    prodcode: string;
    conc_nM: number;
    signal?: AbortSignal;
  }) => Promise<NebTmResponse>;

  online?: boolean;

  conc_nM?: number;

  onNebError?: (error: unknown) => void;

  signal?: AbortSignal;
}

const DEFAULT_CONC_NM = 250;

export async function computeTm(
  model: TmModel,
  seq: string,
  deps: ComputeTmDeps
): Promise<TmResult> {
  const conc_nM = deps.conc_nM ?? DEFAULT_CONC_NM;

  if (model.kind === 'local') {
    const tm = deps.localFn(seq);
    return {
      tm,
      provenance: { source: 'local', tm, conc_nM, verified: false },
      verified: false,
    };
  }

  const canFetch = deps.online !== false && typeof deps.nebFetch === 'function';
  if (canFetch) {
    try {
      const neb = await deps.nebFetch!({
        seq,
        prodcode: model.prodcode,
        conc_nM,
        signal: deps.signal,
      });
      return {
        tm: neb.tm,
        ta: neb.ta,
        provenance: {
          source: 'neb-api',
          tm: neb.tm,
          ta: neb.ta,
          conc_nM,
          verified: true,
          polymerase: model.polymerase,
          prodcode: model.prodcode,
          nebApiVersion: neb.nebApiVersion,
          fetchedAt: neb.fetchedAt,
        },
        verified: true,
      };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err;
      deps.onNebError?.(err);
    }
  }

  const tm = deps.localFn(seq);
  return {
    tm,
    provenance: {
      source: 'neb-q5-offline',
      tm,
      conc_nM,
      verified: false,
      pendingNebVerification: true,
      polymerase: model.polymerase,
      prodcode: model.prodcode,
    },
    verified: false,
    pendingNebVerification: true,
  };
}
