import { calculatePrimerTmWithCalculator } from '../../shared/primer-tm-contract';
import type {
  PrimerTmCalculationV1,
  PrimerTmCalculationContext,
  PrimerTmCalculationService,
} from '../../shared/primer-tm-contract';
export type {
  PrimerTmCalculationV1,
  PrimerTmCalculationContext,
  PrimerTmCalculationService,
} from '../../shared/primer-tm-contract';
import { makeNebFetch } from '../design/public/algorithms/neb-tm-client';
import {
  LOCAL_TM_CALCULATOR,
  type SyncTmEstimate,
  type TmCalculator,
  type TmCalculatorConfig,
} from '../design/public/algorithms/tm-service';
import { createStoredPrimerTmCalculator } from '../junction-workbench/public/settings';

function createPrimerTmCalculator(context: PrimerTmCalculationContext = {}): TmCalculator {
  return createStoredPrimerTmCalculator(calculatorContext(context));
}

function onlineByDefault(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean'
    ? navigator.onLine
    : true;
}

function calculatorContext(context: PrimerTmCalculationContext): Pick<
  TmCalculatorConfig,
  'override' | 'nebFetch' | 'online' | 'onNebError'
> & {
  polymerase?: string | null;
} {
  return {
    override: context.override,
    polymerase: context.polymerase,
    nebFetch: makeNebFetch({ grantedCapabilities: context.grantedCapabilities }),
    online: context.online ?? onlineByDefault(),
    onNebError: context.onProviderError,
  };
}

export const primerTmCalculationService: PrimerTmCalculationService = {
  createCalculator(context = {}): TmCalculator {
    return createPrimerTmCalculator(context);
  },

  estimate(sequence, context = {}): SyncTmEstimate {
    return createPrimerTmCalculator(context).estimateWithProvenance(sequence);
  },

  async calculate(sequence, context = {}): Promise<PrimerTmCalculationV1> {
    const calculator = createPrimerTmCalculator(context);
    return calculatePrimerTmWithCalculator(calculator, sequence, context.signal);
  },

  estimateLegacyLocal(sequence): number {
    return LOCAL_TM_CALCULATOR.estimate(sequence);
  },
};

export { calculatePrimerTmWithCalculator } from '../../shared/primer-tm-contract';
