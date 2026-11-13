import type {
  DesignPrimer,
  DesignRegion,
  DesignSpacer,
  HomologyRegion,
  HomologyEncoding,
} from '../types';
import { getComposedSequence } from '../types';
import { estimateTm, calculateGcContent } from './tm-calculator';
import { LOCAL_TM_CALCULATOR, type TmCalculator } from './tm-service';
import { reverseComplement } from './utils';
import { extractHomologyProjection } from './homology-template-basis';
import { primerTmSequence } from './refine-design-tm';
import { PRIMER_PBS_MIN_LENGTH } from '../validation-constants';

export interface PrimerPbsLengthRange {
  min: number;
  max: number;
}

export function primerPbsLengthRange(
  primer: DesignPrimer,
  regions: readonly DesignRegion[],
  spacers: readonly DesignSpacer[] = []
): PrimerPbsLengthRange {
  const regionPosition = composedRegionPosition(regions, spacers, primer.fragmentIndex);
  const currentLength = Math.max(0, primer.pbs.end - primer.pbs.start);
  const availableLength = regionPosition
    ? primer.direction === 'forward'
      ? regionPosition.end - primer.pbs.start
      : primer.pbs.end - regionPosition.start
    : currentLength;
  const max = Math.max(0, Math.floor(availableLength));
  return {
    min: Math.min(PRIMER_PBS_MIN_LENGTH, max),
    max,
  };
}

export function updatePrimerPbsLength(
  primer: DesignPrimer,
  newLength: number,
  regions: DesignRegion[],
  spacers: DesignSpacer[] = [],
  tm: TmCalculator = LOCAL_TM_CALCULATOR
): DesignPrimer {
  const composedSequence = getComposedSequence(regions, spacers);
  const regionPosition = composedRegionPosition(regions, spacers, primer.fragmentIndex);
  const range = primerPbsLengthRange(primer, regions, spacers);
  const clampedLength = Math.max(range.min, Math.min(newLength, range.max));

  if (clampedLength !== newLength) {
    console.warn(
      `PBS length ${newLength}bp is outside the available ${range.min}..${range.max}bp template range, clamping`
    );
  }

  let newPbsStart: number;
  let newPbsEnd: number;

  if (primer.direction === 'forward') {
    newPbsStart = primer.pbs.start;
    const maxEnd = regionPosition?.end ?? primer.pbs.end;
    newPbsEnd = Math.min(primer.pbs.start + clampedLength, maxEnd);

    if (primer.pbs.start + clampedLength > maxEnd) {
      console.warn(`Forward PBS clamped: would exceed fragment boundary`);
    }
  } else {
    newPbsEnd = primer.pbs.end;
    const minStart = regionPosition?.start ?? primer.pbs.start;
    newPbsStart = Math.max(primer.pbs.end - clampedLength, minStart);

    if (primer.pbs.end - clampedLength < minStart) {
      console.warn(`Reverse PBS clamped: would exceed fragment boundary`);
    }
  }

  const templateSeq = composedSequence.slice(newPbsStart, newPbsEnd);

  const newPbsSeq = primer.direction === 'reverse' ? reverseComplement(templateSeq) : templateSeq;

  const overhangSeq = primer.goldenGateOverhang?.fullSequence ?? primer.overhang.sequence;

  return {
    ...primer,
    pbs: {
      start: newPbsStart,
      end: newPbsEnd,
      sequence: newPbsSeq,
    },
    sequence: overhangSeq + newPbsSeq,
    tm: tm.estimate(primerTmSequence(primer, newPbsSeq)),
    tmProvenance: undefined,
  };
}

function composedRegionPosition(
  regions: readonly DesignRegion[],
  spacers: readonly DesignSpacer[],
  fragmentIndex: number
): { start: number; end: number } | null {
  if (fragmentIndex < 0 || fragmentIndex >= regions.length) return null;
  let start = 0;
  for (let index = 0; index < fragmentIndex; index++) {
    start += regions[index].sequence.length;
    start += spacers.find((spacer) => spacer.junctionIndex === index)?.sequence.length ?? 0;
  }
  return { start, end: start + regions[fragmentIndex].sequence.length };
}

export function updatePrimerPbsWindow(
  primer: DesignPrimer,
  pbsStart: number,
  pbsEnd: number,
  regions: DesignRegion[],
  spacers: DesignSpacer[] = [],
  tm: TmCalculator = LOCAL_TM_CALCULATOR
): DesignPrimer {
  const composedSequence = getComposedSequence(regions, spacers);
  const boundedStart = Math.max(0, Math.min(composedSequence.length, Math.round(pbsStart)));
  const boundedEnd = Math.max(boundedStart, Math.min(composedSequence.length, Math.round(pbsEnd)));
  const templateSeq = composedSequence.slice(boundedStart, boundedEnd);
  const newPbsSeq = primer.direction === 'reverse' ? reverseComplement(templateSeq) : templateSeq;
  const overhangSeq = primer.goldenGateOverhang?.fullSequence ?? primer.overhang.sequence;

  return {
    ...primer,
    pbs: {
      start: boundedStart,
      end: boundedEnd,
      sequence: newPbsSeq,
    },
    sequence: overhangSeq + newPbsSeq,
    tm: tm.estimate(primerTmSequence(primer, newPbsSeq)),
    tmProvenance: undefined,
  };
}

export function calculateNewEncodingForOverhang(
  currentEncoding: HomologyEncoding,
  direction: 'forward' | 'reverse',
  newOverhangLength: number
): HomologyEncoding {
  const MIN_OVERHANG_LENGTH = 0;
  const MAX_OVERHANG_LENGTH = 60;

  let clampedLength = newOverhangLength;
  if (newOverhangLength < MIN_OVERHANG_LENGTH) {
    clampedLength = MIN_OVERHANG_LENGTH;
  } else if (newOverhangLength > MAX_OVERHANG_LENGTH) {
    console.warn(
      `Overhang length ${newOverhangLength}bp exceeds maximum ${MAX_OVERHANG_LENGTH}bp, clamping`
    );
    clampedLength = MAX_OVERHANG_LENGTH;
  }

  if (direction === 'forward') {
    return {
      ...currentEncoding,
      onLeft: clampedLength,
    };
  } else {
    return {
      ...currentEncoding,
      onRight: clampedLength,
    };
  }
}

export function recomputeHomologyMetadata(
  homologyRegion: HomologyRegion,
  composedSequence: string,
  oldEncoding?: HomologyEncoding
): HomologyRegion {
  const seqLen = composedSequence.length;
  const { encoding: newEncoding } = homologyRegion;
  const templateBasis = homologyRegion.templateBasis;

  if (templateBasis && newEncoding.onLeft >= 0 && newEncoding.onRight >= 0) {
    const normalizedEncoding = {
      onLeft: templateBasis.leftHomologyAllowed === false ? 0 : newEncoding.onLeft,
      onRight: templateBasis.rightHomologyAllowed === false ? 0 : newEncoding.onRight,
    };
    const projection = extractHomologyProjection(
      composedSequence,
      normalizedEncoding,
      templateBasis
    );
    return {
      ...homologyRegion,
      encoding: normalizedEncoding,
      start: projection.start,
      end: projection.end,
      metadata: {
        sequence: projection.sequence,
        tmEstimate: estimateTm(projection.sequence),
        gcContent: calculateGcContent(projection.sequence),
      },
    };
  }

  let junctionPosition: number;
  if (homologyRegion.junctionPosition !== undefined) {
    junctionPosition = homologyRegion.junctionPosition;
  } else {
    const onLeft = oldEncoding?.onLeft ?? newEncoding.onLeft;
    junctionPosition = (homologyRegion.start + onLeft) % seqLen;
    console.warn(
      'HomologyRegion missing junctionPosition, calculated from start + onLeft:',
      junctionPosition
    );
  }

  const newStart = (((junctionPosition - newEncoding.onLeft) % seqLen) + seqLen) % seqLen;

  const newEnd = (junctionPosition + newEncoding.onRight) % seqLen;

  const totalLength = Math.max(0, newEncoding.onLeft + newEncoding.onRight);

  let sequence = '';
  for (let i = 0; i < totalLength; i++) {
    const pos = (newStart + i) % seqLen;
    sequence += composedSequence[pos];
  }

  return {
    ...homologyRegion,
    start: newStart,
    end: newEnd,
    metadata: {
      sequence,
      tmEstimate: estimateTm(sequence),
      gcContent: calculateGcContent(sequence),
    },
  };
}

type PrimerOverhangTail = {
  overhangSeq: string;
  spacerSeq: string | undefined;
  annealingLength: number;
};

function primerWithOverhangTail(primer: DesignPrimer, tail: PrimerOverhangTail): DesignPrimer {
  return {
    ...primer,
    overhang: {
      length: tail.annealingLength,
      sequence: tail.overhangSeq,
      tailLength: tail.overhangSeq.length,
      spacerSequence: tail.spacerSeq,
    },
    sequence: tail.overhangSeq + primer.pbs.sequence,
  };
}

function tailFromComputedOverhang(
  primer: DesignPrimer,
  homologyRegion: HomologyRegion,
  computed: { overhangSeq: string; spacerSeq: string } | null
): PrimerOverhangTail | null {
  if (!computed) return null;
  return {
    overhangSeq: computed.overhangSeq,
    spacerSeq: computed.spacerSeq || undefined,
    annealingLength: annealingLengthForPrimerTail(
      primer.direction,
      homologyRegion,
      computed.overhangSeq
    ),
  };
}

export function updatePrimerOverhangFromHomology(
  primer: DesignPrimer,
  homologyRegion: HomologyRegion,
  includeSpacer: boolean = true,
  spacerSeq: string = '',
  composedSequence?: string,
  desiredOverhangLength?: number
): DesignPrimer {
  const signedBoundaryTail = tailFromComputedOverhang(
    primer,
    homologyRegion,
    includeSpacer && composedSequence && hasSignedHomologyBoundary(homologyRegion)
      ? overhangFromSignedHomologyBoundary(primer, homologyRegion, spacerSeq, composedSequence)
      : null
  );
  if (signedBoundaryTail) return primerWithOverhangTail(primer, signedBoundaryTail);

  const customPbsEdgeTail = tailFromComputedOverhang(
    primer,
    homologyRegion,
    includeSpacer && composedSequence
      ? overhangFromCustomPbsEdge(primer, homologyRegion, spacerSeq, composedSequence)
      : null
  );
  if (customPbsEdgeTail) return primerWithOverhangTail(primer, customPbsEdgeTail);

  const computedTail =
    primer.direction === 'reverse'
      ? reversePrimerOverhangTail(homologyRegion, includeSpacer, spacerSeq, desiredOverhangLength)
      : forwardPrimerOverhangTail(
          homologyRegion,
          includeSpacer,
          spacerSeq,
          composedSequence,
          desiredOverhangLength
        );
  return primerWithOverhangTail(primer, computedTail);
}

function reversePrimerOverhangTail(
  homologyRegion: HomologyRegion,
  includeSpacer: boolean,
  spacerSeq: string,
  desiredOverhangLength?: number
): PrimerOverhangTail {
  const spacerAnneals = spacerContributesToAnnealing(homologyRegion);

  if (includeSpacer && spacerSeq) {
    const rcSpacerSeq = reverseComplement(spacerSeq);
    const onRight = homologyRegion.encoding?.onRight ?? 0;
    const spacerLen = spacerSeq.length;
    if (desiredOverhangLength !== undefined && desiredOverhangLength < spacerLen) {
      const partialRcSpacer =
        desiredOverhangLength === 0 ? '' : rcSpacerSeq.slice(-desiredOverhangLength);
      return {
        overhangSeq: partialRcSpacer,
        spacerSeq: partialRcSpacer || undefined,
        annealingLength: spacerAnneals ? partialRcSpacer.length : 0,
      };
    }
    if (onRight > 0) {
      const baseOverhangSeq = computeOverhangSequence('reverse', homologyRegion);
      return {
        overhangSeq: baseOverhangSeq + rcSpacerSeq,
        spacerSeq: rcSpacerSeq,
        annealingLength: baseOverhangSeq.length + (spacerAnneals ? rcSpacerSeq.length : 0),
      };
    }
    return {
      overhangSeq: rcSpacerSeq,
      spacerSeq: rcSpacerSeq,
      annealingLength: spacerAnneals ? rcSpacerSeq.length : 0,
    };
  }

  const baseOverhangSeq = computeOverhangSequence('reverse', homologyRegion);
  return {
    overhangSeq: baseOverhangSeq,
    spacerSeq: undefined,
    annealingLength: baseOverhangSeq.length,
  };
}

function forwardPrimerOverhangTail(
  homologyRegion: HomologyRegion,
  includeSpacer: boolean,
  spacerSeq: string,
  composedSequence: string | undefined,
  desiredOverhangLength?: number
): PrimerOverhangTail {
  const spacerIsSeparateCargo = forwardSpacerIsSeparateCargo(homologyRegion, spacerSeq);

  if (includeSpacer && spacerSeq && spacerIsSeparateCargo) {
    const spacerLen = spacerSeq.length;
    if (desiredOverhangLength !== undefined && desiredOverhangLength < spacerLen) {
      const partialSpacer =
        desiredOverhangLength === 0 ? '' : spacerSeq.slice(-desiredOverhangLength);
      return {
        overhangSeq: partialSpacer,
        spacerSeq: partialSpacer || undefined,
        annealingLength: 0,
      };
    }
    const baseOverhangSeq = computeOverhangSequence('forward', homologyRegion);
    return {
      overhangSeq: baseOverhangSeq + spacerSeq,
      spacerSeq,
      annealingLength: baseOverhangSeq.length,
    };
  }

  if (includeSpacer && spacerSeq) {
    const spacerLen = spacerSeq.length;
    if (desiredOverhangLength !== undefined && desiredOverhangLength < spacerLen) {
      const partialSpacer =
        desiredOverhangLength === 0 ? '' : spacerSeq.slice(-desiredOverhangLength);
      return {
        overhangSeq: partialSpacer,
        spacerSeq: partialSpacer || undefined,
        annealingLength: partialSpacer.length,
      };
    }
    const baseOverhangSeq = computeOverhangSequence('forward', homologyRegion);
    const onLeft = homologyRegion.encoding?.onLeft ?? 0;
    const spacerInOverhang = Math.min(spacerLen, onLeft);
    return {
      overhangSeq: baseOverhangSeq,
      spacerSeq: spacerInOverhang > 0 ? spacerSeq.slice(-spacerInOverhang) : undefined,
      annealingLength: baseOverhangSeq.length,
    };
  }

  if (!includeSpacer && spacerSeq && composedSequence) {
    const junctionPos = homologyRegion.junctionPosition;
    const overhangSeq =
      junctionPos === undefined
        ? computeOverhangSequence('forward', homologyRegion)
        : forwardOverhangExcludingSpacer(homologyRegion, spacerSeq, composedSequence, junctionPos);
    return {
      overhangSeq,
      spacerSeq: undefined,
      annealingLength: overhangSeq.length,
    };
  }

  const baseOverhangSeq = computeOverhangSequence('forward', homologyRegion);
  return {
    overhangSeq: baseOverhangSeq,
    spacerSeq: undefined,
    annealingLength: baseOverhangSeq.length,
  };
}

function forwardOverhangExcludingSpacer(
  homologyRegion: HomologyRegion,
  spacerSeq: string,
  composedSequence: string,
  junctionPos: number
): string {
  const spacerLen = spacerSeq.length;
  const onLeft = homologyRegion.encoding?.onLeft ?? 0;
  const seqLen = composedSequence.length;
  const spacerStart = (((junctionPos - spacerLen) % seqLen) + seqLen) % seqLen;
  let upstream = '';
  for (let i = 0; i < onLeft; i++) {
    const pos = (((spacerStart - onLeft + i) % seqLen) + seqLen) % seqLen;
    upstream += composedSequence[pos];
  }
  return upstream;
}

export function spacerContributesToAnnealing(homologyRegion: HomologyRegion): boolean {
  return homologyRegion.templateBasis?.spacerContributesToAnnealing ?? true;
}

export function forwardSpacerIsSeparateCargo(
  homologyRegion: HomologyRegion,
  spacerSeqOrLength: string | number
): boolean {
  const spacerLength =
    typeof spacerSeqOrLength === 'number' ? spacerSeqOrLength : spacerSeqOrLength.length;
  return spacerLength > 0 && homologyRegion.templateBasis?.leftSpacerIncludedInHomology === false;
}

function annealingLengthForPrimerTail(
  direction: 'forward' | 'reverse',
  homologyRegion: HomologyRegion,
  overhangSeq: string
): number {
  const baseLength =
    direction === 'forward'
      ? Math.max(0, homologyRegion.encoding.onLeft)
      : Math.max(0, homologyRegion.encoding.onRight);
  if (!spacerContributesToAnnealing(homologyRegion)) {
    return Math.min(baseLength, overhangSeq.length);
  }
  return overhangSeq.length;
}

function hasSignedHomologyBoundary(homologyRegion: HomologyRegion): boolean {
  const onLeft = homologyRegion.encoding?.onLeft ?? 0;
  const onRight = homologyRegion.encoding?.onRight ?? 0;
  return onLeft < 0 || onRight < 0;
}

function overhangFromSignedHomologyBoundary(
  primer: DesignPrimer,
  homologyRegion: HomologyRegion,
  spacerSeq: string,
  composedSequence: string
): { overhangSeq: string; spacerSeq: string } | null {
  const seqLen = composedSequence.length;
  if (seqLen === 0 || homologyRegion.junctionPosition === undefined) return null;

  const spacerLength = spacerSeq.length;
  const productOrigin = normalizePosition(homologyRegion.junctionPosition - spacerLength, seqLen);
  const productStartBioCol = spacerLength - (homologyRegion.encoding?.onLeft ?? 0);
  const productEndBioCol = spacerLength + (homologyRegion.encoding?.onRight ?? 0);

  if (primer.direction === 'forward') {
    const templateStartBioCol = productStartBioCol;
    const templateEndBioCol = signedBioColFromProductOrigin(
      primer.pbs.start,
      productOrigin,
      seqLen
    );
    if (templateEndBioCol <= templateStartBioCol) {
      return { overhangSeq: '', spacerSeq: '' };
    }
    const templateStart = normalizePosition(productOrigin + templateStartBioCol, seqLen);
    const templateEnd = normalizePosition(productOrigin + templateEndBioCol, seqLen);
    const template = circularSliceForward(composedSequence, templateStart, templateEnd);
    const spacerTemplate = spacerTemplateForRange(
      composedSequence,
      templateStart,
      templateEnd,
      homologyRegion.junctionPosition,
      spacerLength
    );
    return { overhangSeq: template, spacerSeq: spacerTemplate };
  }

  const templateStartBioCol = signedBioColFromProductOrigin(primer.pbs.end, productOrigin, seqLen);
  const templateEndBioCol = productEndBioCol;
  if (templateEndBioCol <= templateStartBioCol) {
    return { overhangSeq: '', spacerSeq: '' };
  }
  const templateStart = normalizePosition(productOrigin + templateStartBioCol, seqLen);
  const templateEnd = normalizePosition(productOrigin + templateEndBioCol, seqLen);
  const template = circularSliceForward(composedSequence, templateStart, templateEnd);
  const spacerTemplate = spacerTemplateForRange(
    composedSequence,
    templateStart,
    templateEnd,
    homologyRegion.junctionPosition,
    spacerLength
  );
  return {
    overhangSeq: reverseComplement(template),
    spacerSeq: spacerTemplate ? reverseComplement(spacerTemplate) : '',
  };
}

function overhangFromCustomPbsEdge(
  primer: DesignPrimer,
  homologyRegion: HomologyRegion,
  spacerSeq: string,
  composedSequence: string
): { overhangSeq: string; spacerSeq: string } | null {
  const seqLen = composedSequence.length;
  if (seqLen === 0 || homologyRegion.junctionPosition === undefined) return null;

  const junctionPosition = normalizePosition(homologyRegion.junctionPosition, seqLen);
  const spacerLength = spacerSeq.length;
  if (primer.direction === 'forward') {
    const defaultPbsStart = junctionPosition;
    const pbsStart = normalizePosition(primer.pbs.start, seqLen);
    if (pbsStart === defaultPbsStart) return null;
    const templateStart = normalizePosition(homologyRegion.start, seqLen);
    const template = circularSliceForward(composedSequence, templateStart, pbsStart);
    const spacerTemplate = spacerTemplateForRange(
      composedSequence,
      templateStart,
      pbsStart,
      junctionPosition,
      spacerLength
    );
    return { overhangSeq: template, spacerSeq: spacerTemplate };
  }

  const defaultPbsEnd = normalizePosition(junctionPosition - spacerLength, seqLen);
  const pbsEnd = normalizePosition(primer.pbs.end, seqLen);
  if (pbsEnd === defaultPbsEnd) return null;
  const templateEnd = normalizePosition(homologyRegion.end, seqLen);
  const template = circularSliceForward(composedSequence, pbsEnd, templateEnd);
  const spacerTemplate = spacerTemplateForRange(
    composedSequence,
    pbsEnd,
    templateEnd,
    junctionPosition,
    spacerLength
  );
  return {
    overhangSeq: reverseComplement(template),
    spacerSeq: spacerTemplate ? reverseComplement(spacerTemplate) : '',
  };
}

function spacerTemplateForRange(
  composedSequence: string,
  rangeStart: number,
  rangeEnd: number,
  junctionPosition: number,
  spacerLength: number
): string {
  if (spacerLength <= 0 || composedSequence.length === 0) return '';
  const seqLen = composedSequence.length;
  const spacerStart = normalizePosition(junctionPosition - spacerLength, seqLen);
  const spacerEnd = normalizePosition(junctionPosition, seqLen);
  let result = '';
  for (const position of circularPositions(rangeStart, rangeEnd, seqLen)) {
    if (positionInCircularRange(position, spacerStart, spacerEnd, seqLen)) {
      result += composedSequence[position] ?? '';
    }
  }
  return result;
}

function circularSliceForward(sequence: string, start: number, end: number): string {
  let result = '';
  for (const position of circularPositions(start, end, sequence.length)) {
    result += sequence[position] ?? '';
  }
  return result;
}

function circularPositions(start: number, end: number, length: number): number[] {
  if (length <= 0) return [];
  const normalizedStart = normalizePosition(start, length);
  const normalizedEnd = normalizePosition(end, length);
  const positions: number[] = [];
  let position = normalizedStart;
  while (position !== normalizedEnd && positions.length < length) {
    positions.push(position);
    position = (position + 1) % length;
  }
  return positions;
}

function positionInCircularRange(
  position: number,
  start: number,
  end: number,
  length: number
): boolean {
  const normalized = normalizePosition(position, length);
  const normalizedStart = normalizePosition(start, length);
  const normalizedEnd = normalizePosition(end, length);
  if (normalizedStart === normalizedEnd) return false;
  if (normalizedStart < normalizedEnd) {
    return normalized >= normalizedStart && normalized < normalizedEnd;
  }
  return normalized >= normalizedStart || normalized < normalizedEnd;
}

function normalizePosition(position: number, length: number): number {
  return ((Math.round(position) % length) + length) % length;
}

function signedBioColFromProductOrigin(
  position: number,
  productOrigin: number,
  sequenceLength: number
): number {
  if (sequenceLength <= 0) return 0;
  const forwardDelta = normalizePosition(position - productOrigin, sequenceLength);
  return forwardDelta > sequenceLength / 2 ? forwardDelta - sequenceLength : forwardDelta;
}

export function computeOverhangSequence(
  direction: 'forward' | 'reverse',
  homologyRegion: HomologyRegion
): string {
  const seq = homologyRegion.metadata?.sequence ?? '';
  const onLeft = Math.max(0, Math.min(seq.length, homologyRegion.encoding?.onLeft ?? 0));

  if (direction === 'forward') {
    const result = seq.slice(0, onLeft);
    return result;
  } else {
    const rightPortion = seq.slice(onLeft);
    const result = reverseComplement(rightPortion);
    return result;
  }
}

export function computePbsSequence(
  direction: 'forward' | 'reverse',
  pbsStart: number,
  pbsEnd: number,
  composedSequence: string
): string {
  const template = composedSequence.slice(pbsStart, pbsEnd);
  if (direction === 'forward') {
    return template;
  } else {
    return reverseComplement(template);
  }
}

export function computePrimerDisplay(
  primer: DesignPrimer,
  homologyRegion: HomologyRegion | null,
  composedSequence: string
): {
  overhangSequence: string;
  pbsSequence: string;
  fullSequence: string;
  tm: number;
} {
  const overhangSequence = homologyRegion
    ? computeOverhangSequence(primer.direction, homologyRegion)
    : '';

  const pbsSequence = computePbsSequence(
    primer.direction,
    primer.pbs.start,
    primer.pbs.end,
    composedSequence
  );

  const fullSequence = overhangSequence + pbsSequence;

  const tm = estimateTm(pbsSequence);

  return {
    overhangSequence,
    pbsSequence,
    fullSequence,
    tm,
  };
}
