import type { TmModel } from './primer-thermodynamics/tm-model';
import type { PrimerTmProvenance } from './primer-thermodynamics/compute-tm';
import type {
  TmModelSource,
  TmCalculator,
  SyncTmEstimate,
} from './primer-thermodynamics/tm-service';
export interface PrimerTmCalculationV1 {
  model: TmModel;
  source: TmModelSource;
  reason: string;
  valueC: number;
  status: 'verified' | 'local' | 'fallback';
  provider: PrimerTmProvenance;
}

export interface PrimerTmCalculationContext {
  override?: TmModel;
  polymerase?: string | null;
  online?: boolean;
  onProviderError?: (error: unknown) => void;
  signal?: AbortSignal;
  grantedCapabilities?: readonly string[];
}

export interface PrimerTmCalculationService {
  createCalculator(context?: PrimerTmCalculationContext): TmCalculator;
  estimate(sequence: string, context?: PrimerTmCalculationContext): SyncTmEstimate;
  calculate(sequence: string, context?: PrimerTmCalculationContext): Promise<PrimerTmCalculationV1>;
  estimateLegacyLocal(sequence: string): number;
}

export async function calculatePrimerTmWithCalculator(
  calculator: TmCalculator,
  sequence: string,
  signal?: AbortSignal
): Promise<PrimerTmCalculationV1> {
  const result = await calculator.compute(sequence, { signal });
  return {
    model: calculator.resolution.model,
    source: calculator.resolution.source,
    reason: calculator.resolution.reason,
    valueC: result.tm,
    status: result.verified ? 'verified' : result.pendingNebVerification ? 'fallback' : 'local',
    provider: result.provenance,
  };
}
