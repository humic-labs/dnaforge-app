import type {
  DesignRegion,
  DesignSpacer,
  HomologyRegion,
  DesignPrimer,
  DesignPrimerPair,
} from '../types';
import { getComposedSequence } from '../types';
import { LOCAL_TM_CALCULATOR, type TmCalculator } from './tm-service';
import { DEFAULT_PBS_LENGTH, reverseComplement, generateId } from './utils';
import {
  getLeftPortion,
  getRightPortion,
  getLeftJunctionIndex,
  getRightJunctionIndex,
} from './junctions';
import { forwardSpacerIsSeparateCargo, spacerContributesToAnnealing } from './recompute';
import { isPcrTemplateRegion } from '../restriction-digest';

export function computePrimers(
  regions: DesignRegion[],
  homologyRegions: HomologyRegion[],
  topology: 'linear' | 'circular',
  spacers: DesignSpacer[] = [],

  tm: TmCalculator = LOCAL_TM_CALCULATOR,
  targetPcrTm?: number
): DesignPrimerPair[] {
  const composedSequence = getComposedSequence(regions, spacers);
  const numFragments = regions.length;

  const homologyMap = new Map<number, HomologyRegion>();
  for (const hr of homologyRegions) {
    homologyMap.set(hr.junctionIndex, hr);
  }

  const spacerLengthByJunction = new Map<number, number>();
  const spacerSeqByJunction = new Map<number, string>();
  for (const spacer of spacers) {
    spacerLengthByJunction.set(spacer.junctionIndex, spacer.sequence.length);
    spacerSeqByJunction.set(spacer.junctionIndex, spacer.sequence);
  }

  const regionPositions: { start: number; end: number }[] = [];
  let pos = 0;
  for (let i = 0; i < regions.length; i++) {
    const region = regions[i];
    regionPositions.push({ start: pos, end: pos + region.sequence.length });
    pos += region.sequence.length;

    pos += spacerLengthByJunction.get(i) ?? 0;
  }

  return regions.flatMap((region, fragmentIndex) => {
    if (!isPcrTemplateRegion(region)) {
      return [];
    }

    const regionPos = regionPositions[fragmentIndex];

    const leftJunctionIdx = getLeftJunctionIndex(fragmentIndex, numFragments, topology);
    const rightJunctionIdx = getRightJunctionIndex(fragmentIndex, numFragments, topology);

    const leftHomology =
      leftJunctionIdx !== null ? (homologyMap.get(leftJunctionIdx) ?? null) : null;
    const rightHomology =
      rightJunctionIdx !== null ? (homologyMap.get(rightJunctionIdx) ?? null) : null;

    const leftSpacerSeq =
      leftJunctionIdx !== null ? (spacerSeqByJunction.get(leftJunctionIdx) ?? '') : '';
    const rightSpacerSeq =
      rightJunctionIdx !== null ? (spacerSeqByJunction.get(rightJunctionIdx) ?? '') : '';

    const fwdHomologySeq = leftHomology ? getLeftPortion(leftHomology) : '';
    const fwdSpacerIsCargo =
      leftHomology !== null && forwardSpacerIsSeparateCargo(leftHomology, leftSpacerSeq);
    const fwdOverhangSeq = fwdSpacerIsCargo ? fwdHomologySeq + leftSpacerSeq : fwdHomologySeq;

    const leftOnLeft = leftHomology?.encoding?.onLeft ?? 0;
    const leftSpacerInOverhang = Math.min(leftSpacerSeq.length, leftOnLeft);

    const fwdSpacerInOverhang = fwdSpacerIsCargo
      ? leftSpacerSeq
      : leftSpacerInOverhang > 0
        ? leftSpacerSeq.slice(-leftSpacerInOverhang)
        : '';
    const fwdAnnealingLength = fwdSpacerIsCargo ? fwdHomologySeq.length : fwdOverhangSeq.length;

    const fwdPbsStart = regionPos.start;
    const fwdPbsEnd = Math.min(
      regionPos.start + selectPbsLength(region.sequence, 'forward', tm, targetPcrTm),
      regionPos.end
    );
    const fwdPbsSeq = composedSequence.slice(fwdPbsStart, fwdPbsEnd);

    const forwardPrimer: DesignPrimer = {
      id: generateId('fwd'),
      name: `F${fragmentIndex + 1}-fwd`,
      sequence: fwdOverhangSeq + fwdPbsSeq,
      pbs: {
        start: fwdPbsStart,
        end: fwdPbsEnd,
        sequence: fwdPbsSeq,
      },
      overhang: {
        length: fwdAnnealingLength,
        sequence: fwdOverhangSeq,
        tailLength: fwdOverhangSeq.length,

        spacerSequence: fwdSpacerInOverhang || undefined,
      },
      direction: 'forward',
      fragmentIndex,
      junctionIndex: leftJunctionIdx,
      tm: tm.estimate(fwdPbsSeq),
    };

    const revOverhangTemplate = rightHomology ? getRightPortion(rightHomology) : '';

    const revOverhangWithSpacerTemplate = rightSpacerSeq + revOverhangTemplate;
    const revOverhangSeq = reverseComplement(revOverhangWithSpacerTemplate);
    const revAnnealingLength =
      revOverhangTemplate.length +
      (rightHomology && spacerContributesToAnnealing(rightHomology) ? rightSpacerSeq.length : 0);

    const revPbsEnd = regionPos.end;
    const revPbsStart = Math.max(
      regionPos.end - selectPbsLength(region.sequence, 'reverse', tm, targetPcrTm),
      regionPos.start
    );
    const revPbsTemplate = composedSequence.slice(revPbsStart, revPbsEnd);
    const revPbsSeq = reverseComplement(revPbsTemplate);

    const reversePrimer: DesignPrimer = {
      id: generateId('rev'),
      name: `F${fragmentIndex + 1}-rev`,
      sequence: revOverhangSeq + revPbsSeq,
      pbs: {
        start: revPbsStart,
        end: revPbsEnd,
        sequence: revPbsSeq,
      },
      overhang: {
        length: revAnnealingLength,
        sequence: revOverhangSeq,
        tailLength: revOverhangSeq.length,

        spacerSequence: rightSpacerSeq ? reverseComplement(rightSpacerSeq) : undefined,
      },
      direction: 'reverse',
      fragmentIndex,
      junctionIndex: rightJunctionIdx,
      tm: tm.estimate(revPbsSeq),
    };

    return [
      {
        forward: forwardPrimer,
        reverse: reversePrimer,
        fragmentIndex,
      },
    ];
  });
}

export function recomputePrimers(
  regions: DesignRegion[],
  homologyRegions: HomologyRegion[],
  topology: 'linear' | 'circular',
  spacers: DesignSpacer[] = [],
  tm: TmCalculator = LOCAL_TM_CALCULATOR,
  targetPcrTm?: number
): DesignPrimerPair[] {
  return computePrimers(regions, homologyRegions, topology, spacers, tm, targetPcrTm);
}

function selectPbsLength(
  template: string,
  direction: 'forward' | 'reverse',
  tm: TmCalculator,
  targetTm: number | undefined
): number {
  if (targetTm === undefined) return DEFAULT_PBS_LENGTH;
  const maximum = Math.min(60, template.length);
  let bestLength = Math.min(10, maximum);
  let bestDistance = Infinity;
  for (let length = bestLength; length <= maximum; length++) {
    const sequence =
      direction === 'forward'
        ? template.slice(0, length)
        : reverseComplement(template.slice(-length));
    const distance = Math.abs(tm.estimate(sequence) - targetTm);
    if (distance < bestDistance) {
      bestLength = length;
      bestDistance = distance;
    }
  }
  return bestLength;
}
