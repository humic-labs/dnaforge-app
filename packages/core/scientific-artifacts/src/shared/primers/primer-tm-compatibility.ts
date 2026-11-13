import { LOCAL_TM_CALCULATOR } from './tm/tm-service';
import type { TmModel } from './tm/tm-model';
import type { TmModelSource } from './tm/tm-service';
import type { PrimerTmProvenance } from './tm/compute-tm';

export interface PrimerTmCalculationV1 {
  model: TmModel;
  source: TmModelSource;
  reason: string;
  valueC: number;
  status: 'verified' | 'local' | 'fallback';
  provider: PrimerTmProvenance;
}

export function estimateLegacyPrimerTm(sequence: string): number {
  return LOCAL_TM_CALCULATOR.estimate(sequence);
}
