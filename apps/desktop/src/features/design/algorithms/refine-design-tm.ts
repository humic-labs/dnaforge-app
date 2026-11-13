import type { DesignPrimerPair } from '../types';
import type { TmMeasurement } from './tm-provider';
import type { TmResolver } from './tm-resolver';

export interface RefineTmResult {
  primers: DesignPrimerPair[];
  changed: boolean;
  verifiedCount: number;
  pendingCount: number;
}

export function primerTmSequence(
  primer: DesignPrimerPair['forward'],
  pbsSequence: string = primer.pbs.sequence
): string {
  if (primer.oligo?.orderType === 'rna') return '';
  return pbsSequence;
}

export function collectPrimerTmSequences(primers: DesignPrimerPair[]): string[] {
  const sequences: string[] = [];
  for (const pair of primers) {
    if (pair.forward?.pbs?.sequence) sequences.push(primerTmSequence(pair.forward));
    if (pair.reverse?.pbs?.sequence) sequences.push(primerTmSequence(pair.reverse));
  }
  return sequences.filter((sequence) => sequence.length > 0);
}

function applyMeasurement(
  primer: DesignPrimerPair['forward'],
  measurement: TmMeasurement | undefined
): { primer: DesignPrimerPair['forward']; changed: boolean } {
  if (!measurement || primer.oligo?.orderType === 'rna') return { primer, changed: false };
  const tmProvenance = {
    source: measurement.source,
    verified: measurement.verified,
    ...(measurement.model ? { model: measurement.model } : {}),
    ...(measurement.concNm !== undefined ? { concNm: measurement.concNm } : {}),
    ...(measurement.pending ? { pending: true } : {}),
    ...(measurement.ta !== undefined ? { ta: measurement.ta } : {}),
    ...(measurement.meta ? { meta: measurement.meta } : {}),
  };
  const changed =
    primer.tm !== measurement.tm ||
    JSON.stringify(primer.tmProvenance ?? null) !== JSON.stringify(tmProvenance);
  return {
    primer: {
      ...primer,
      tm: measurement.tm,
      tmProvenance,
    },
    changed,
  };
}

export async function refineDesignPrimerTm(
  primers: DesignPrimerPair[],
  resolver: TmResolver
): Promise<RefineTmResult> {
  if (primers.length === 0 || !resolver.canVerify) {
    return { primers, changed: false, verifiedCount: 0, pendingCount: 0 };
  }

  const measurements = await resolver.measureMany(collectPrimerTmSequences(primers));

  let changed = false;
  let verifiedCount = 0;
  let pendingCount = 0;

  const patched = primers.map((pair) => {
    const forwardSequence = primerTmSequence(pair.forward);
    const reverseSequence = primerTmSequence(pair.reverse);
    const forwardMeasurement = measurements.get(forwardSequence);
    const reverseMeasurement = measurements.get(reverseSequence);
    const forward = applyMeasurement(pair.forward, forwardMeasurement);
    const reverse = applyMeasurement(pair.reverse, reverseMeasurement);
    changed = changed || forward.changed || reverse.changed;

    for (const measurement of [forwardMeasurement, reverseMeasurement]) {
      if (!measurement) continue;
      if (measurement.verified) verifiedCount += 1;
      else if (measurement.pending) pendingCount += 1;
    }

    return { ...pair, forward: forward.primer, reverse: reverse.primer };
  });

  return { primers: patched, changed, verifiedCount, pendingCount };
}
