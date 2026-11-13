import type { DesignPrimerPair } from '../types';
import { primerTmSequence } from './refine-design-tm';
import type { TmCalculator } from './tm-service';

export function recomputeDesignPrimerTms(
  primers: readonly DesignPrimerPair[],
  calculator: TmCalculator
): DesignPrimerPair[] {
  return primers.map((pair) => ({
    ...pair,
    forward: {
      ...pair.forward,
      tm:
        pair.forward.oligo?.orderType === 'rna'
          ? undefined
          : calculator.estimate(primerTmSequence(pair.forward)),
      tmProvenance: undefined,
    },
    reverse: {
      ...pair.reverse,
      tm:
        pair.reverse.oligo?.orderType === 'rna'
          ? undefined
          : calculator.estimate(primerTmSequence(pair.reverse)),
      tmProvenance: undefined,
    },
  }));
}
