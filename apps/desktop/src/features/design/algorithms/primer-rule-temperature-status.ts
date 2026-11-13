import type { SequenceDesign } from '../types';
import { getRegionEffectiveSequence } from '../restriction-digest';
import { reverseComplement } from './utils';
import type { TmCalculator } from './tm-service';

export function primerRuleTemperatureStatus(
  design: Pick<
    SequenceDesign,
    'regions' | 'spacers' | 'assemblyMethod' | 'designPrimers' | 'primerDesignConstraints'
  >,
  tm: TmCalculator
) {
  const constraints = design.primerDesignConstraints;
  const primers = design.designPrimers.flatMap((pair) => [pair.forward, pair.reverse]);
  if (!constraints || primers.length === 0) return null;
  const sequences = design.regions.map((region) =>
    getRegionEffectiveSequence(region, design.assemblyMethod)
  );
  const starts: number[] = [];
  let position = 0;
  for (let index = 0; index < sequences.length; index++) {
    starts.push(position);
    position += sequences[index].length;
    position +=
      design.spacers.find((spacer) => spacer.junctionIndex === index)?.sequence.length ?? 0;
  }
  let unreachable = 0;
  const achieved: number[] = [];
  for (const primer of primers) {
    const sequence = sequences[primer.fragmentIndex];
    const available =
      primer.direction === 'forward'
        ? sequence.slice(primer.pbs.start - starts[primer.fragmentIndex])
        : sequence.slice(0, primer.pbs.end - starts[primer.fragmentIndex]);
    const maximum = Math.min(60, available.length);
    const temperatures: number[] = [];
    for (let length = Math.min(10, maximum); length <= maximum; length++) {
      temperatures.push(
        tm.estimate(
          primer.direction === 'forward'
            ? available.slice(0, length)
            : reverseComplement(available.slice(-length))
        )
      );
    }
    if (
      constraints.targetPcrTm < Math.min(...temperatures) ||
      constraints.targetPcrTm > Math.max(...temperatures)
    )
      unreachable++;
    achieved.push(tm.estimate(primer.pbs.sequence));
  }
  return {
    target: constraints.targetPcrTm,
    minimum: Math.min(...achieved),
    maximum: Math.max(...achieved),
    unreachable,
    primerCount: primers.length,
  };
}
