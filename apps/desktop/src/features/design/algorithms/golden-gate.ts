import { userMessage, userMessageWithValues, userMessageValue } from '@waypoint/user-messages';
import type {
  DesignRegion,
  DesignSpacer,
  DesignPrimer,
  DesignPrimerPair,
  GoldenGateJunction,
  GoldenGateEnzyme,
  GoldenGatePrimerOverhang,
} from '../types';
import { getComposedSequence, ENZYME_SPECS } from '../types';
import { LOCAL_TM_CALCULATOR, type TmCalculator } from './tm-service';
import {
  isPalindrome,
  PRIMER_PBS_MIN_LENGTH,
  GOLDENGATE_PBS_SEARCH_MAX_LENGTH,
} from '../validation-constants';
import { DEFAULT_PBS_LENGTH, reverseComplement, generateId } from './utils';
import { identifyJunctions, getLeftJunctionIndex, getRightJunctionIndex } from './junctions';

export function sizePbsLengthForTm(params: {
  template: string;
  anchor: number;
  direction: 'forward' | 'reverse';
  regionStart: number;
  regionEnd: number;
  cognateSeq: string;
  targetTm: number;
  minLength?: number;
  maxLength?: number;
  tmCalculator?: TmCalculator;
}): number {
  const { template, anchor, direction, regionStart, regionEnd, targetTm } = params;
  const tm = params.tmCalculator ?? LOCAL_TM_CALCULATOR;
  const available = direction === 'forward' ? regionEnd - anchor : anchor - regionStart;
  const maxLength = Math.min(
    params.maxLength ?? GOLDENGATE_PBS_SEARCH_MAX_LENGTH,
    Math.max(0, available)
  );
  if (maxLength <= 0) return 0;
  const minLength = Math.min(params.minLength ?? PRIMER_PBS_MIN_LENGTH, maxLength);

  let bestLength = minLength;
  let bestDiff = Infinity;
  for (let len = minLength; len <= maxLength; len++) {
    const pbs =
      direction === 'forward'
        ? template.slice(anchor, anchor + len)
        : reverseComplement(template.slice(anchor - len, anchor));
    const diff = Math.abs(tm.estimate(pbs) - targetTm);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestLength = len;
    }
  }
  return bestLength;
}

export function isGoldenGateJunctionOffsetEditable(junction: GoldenGateJunction): boolean {
  return junction.source.type === 'pcr-designed';
}

export function isGoldenGateJunctionOffsetLocked(junction: GoldenGateJunction): boolean {
  return !isGoldenGateJunctionOffsetEditable(junction);
}

function isRestrictionDigestRegion(region: DesignRegion | undefined): boolean {
  return region?.sourceType === 'rd' || !!region?.rdOverhangs;
}

const _PREFERRED_OVERHANGS = [
  'AATG',
  'GCAA',
  'TTCG',
  'AGGT',
  'CTAG',
  'TACG',
  'GCAT',
  'TCGA',
  'ACGT',
  'CGTA',
  'GATC',
  'TGCA',
];

export function computeGoldenGateJunctions(
  regions: DesignRegion[],
  topology: 'linear' | 'circular',
  spacers: DesignSpacer[] = [],
  enzyme: GoldenGateEnzyme = 'BsaI'
): GoldenGateJunction[] {
  const composedSequence = getComposedSequence(regions, spacers);
  const junctions = identifyJunctions(regions, topology, spacers);
  const usedOverhangs = new Set<string>();

  return junctions.map((junction) => {
    const leftRegion = regions[junction.leftRegionIndex];
    const rightRegion = regions[junction.rightRegionIndex];

    const leftIsRD = isRestrictionDigestRegion(leftRegion);
    const rightIsRD = isRestrictionDigestRegion(rightRegion);

    let offset: number;
    let source: GoldenGateJunction['source'];
    let overhang: string;

    let rdMismatchError: string | undefined;
    let rdSpacerError: string | undefined;
    let rdEnzymeError: string | undefined;
    let rdProductMismatchError: string | undefined;

    if (leftIsRD && rightIsRD) {
      const leftDownstream = leftRegion.rdOverhangs?.downstream ?? '';
      const rightUpstream = rightRegion.rdOverhangs?.upstream ?? '';

      if (leftDownstream !== rightUpstream) {
        overhang = leftDownstream || rightUpstream || 'NNNN';
        rdMismatchError = `Overhang mismatch: left RD ends with ${leftDownstream || '(none)'} but right RD starts with ${rightUpstream || '(none)'}`;
      } else {
        overhang = leftDownstream;
      }
      if (junction.spacerLength > 0) {
        rdSpacerError =
          'Spacer sequence between two restriction digest fragments cannot be encoded without a PCR/synthetic fragment';
      }
      offset = +2;
      source = { type: 'rd-fixed', fromRegionIndex: junction.leftRegionIndex };
    } else if (leftIsRD) {
      overhang = leftRegion.rdOverhangs?.downstream ?? 'NNNN';
      offset = 2 - junction.spacerLength;
      source = { type: 'pcr-matched-rd', matchedRegionIndex: junction.leftRegionIndex };
    } else if (rightIsRD) {
      overhang = rightRegion.rdOverhangs?.upstream ?? 'NNNN';
      offset = +2;
      source = { type: 'pcr-matched-rd', matchedRegionIndex: junction.rightRegionIndex };
    } else {
      offset = 0;
      source = { type: 'pcr-designed' };

      const seqLen = composedSequence.length;
      const overhangStart = junction.position - 2 + offset;
      let extractedOverhang = '';
      for (let i = 0; i < 4; i++) {
        const pos = (((overhangStart + i) % seqLen) + seqLen) % seqLen;
        extractedOverhang += composedSequence[pos];
      }
      overhang = extractedOverhang;
    }

    if (!rdMismatchError && (leftIsRD || rightIsRD)) {
      const mismatchRegion = [leftRegion, rightRegion].find(
        (region) =>
          isRestrictionDigestRegion(region) &&
          region.rdSourceEnzyme &&
          region.rdSourceEnzyme !== enzyme
      );
      const unknownRegion = [leftRegion, rightRegion].find(
        (region) => isRestrictionDigestRegion(region) && !region.rdSourceEnzyme
      );
      if (mismatchRegion?.rdSourceEnzyme) {
        rdEnzymeError = `RD fragment was produced by ${mismatchRegion.rdSourceEnzyme}, not selected ${enzyme}`;
      } else if (unknownRegion) {
        rdEnzymeError = `RD fragment source enzyme is not a supported Golden Gate Type IIS enzyme`;
      }
    }

    const overhangStart = junction.position - 2 + offset;
    const overhangEnd = overhangStart + 4;

    if (leftIsRD || rightIsRD) {
      let assembledWindow = '';
      for (let i = 0; i < 4; i++) {
        const position = overhangStart + i;
        if (topology === 'linear' && (position < 0 || position >= composedSequence.length)) {
          assembledWindow = '';
          break;
        }
        const normalizedPosition =
          ((position % composedSequence.length) + composedSequence.length) %
          composedSequence.length;
        assembledWindow += composedSequence[normalizedPosition];
      }
      if (assembledWindow.toUpperCase() !== overhang.toUpperCase()) {
        rdProductMismatchError = assembledWindow
          ? `Fixed RD overhang ${overhang} does not match assembled product window ${assembledWindow}`
          : `Fixed RD overhang ${overhang} falls outside the assembled product sequence`;
      }
    }

    let validationError: string | undefined;
    let isValid = true;

    if (rdMismatchError) {
      validationError = rdMismatchError;
      isValid = false;
    } else if (rdSpacerError) {
      validationError = rdSpacerError;
      isValid = false;
    } else if (rdEnzymeError) {
      validationError = rdEnzymeError;
      isValid = false;
    } else if (rdProductMismatchError) {
      validationError = rdProductMismatchError;
      isValid = false;
    } else if (usedOverhangs.has(overhang)) {
      validationError = userMessageWithValues('assembly.overhang.duplicate-overhang-value0', {
        value0: userMessageValue(overhang),
      });
      isValid = false;
    } else if (isPalindrome(overhang)) {
      validationError = userMessageWithValues(
        'assembly.overhang.palindromic-overhang-value0-risk-of-self-ligation',
        { value0: userMessageValue(overhang) }
      );
      isValid = false;
    }

    usedOverhangs.add(overhang);

    return {
      junctionIndex: junction.index,
      junctionPosition: junction.position,
      offset,
      overhangStart,
      overhangEnd,
      overhang,
      source,
      isValid,
      validationError,
    };
  });
}

export function buildGoldenGateOverhang(
  overhangSeq: string,
  literalExtra: string,
  enzyme: GoldenGateEnzyme,
  literalSpacerLength?: number
): GoldenGatePrimerOverhang {
  const spec = ENZYME_SPECS[enzyme];
  return {
    padding5prime: spec.padding5prime,
    enzymeSite: spec.site,
    spacer: spec.spacer,
    overhang: overhangSeq,
    literalExtra,
    literalSpacerLength,
    fullSequence: spec.padding5prime + spec.site + spec.spacer + overhangSeq + literalExtra,
  };
}

type GoldenGateRegionPosition = { start: number; end: number };

type GoldenGateOverhangPlacement = {
  overhangSeq: string;
  literalExtra: string;
  pbsAnchor: number;
  goldenGateOverhang: GoldenGatePrimerOverhang | undefined;
};

type GoldenGateCognateLengths = {
  cognateOverhangLength: number;
  synthetic4bpSpacerLength: number;
};

function composeWrappedSlice(
  composedSequence: string,
  start: number,
  end: number,
  seqLen: number
): string {
  let gapSeq = '';
  for (let i = start; i < end; i++) {
    const idx = ((i % seqLen) + seqLen) % seqLen;
    gapSeq += composedSequence[idx];
  }
  return gapSeq;
}

function buildRestrictionDigestPlaceholderPair(
  fragmentIndex: number,
  leftJunctionIdx: number | null,
  rightJunctionIdx: number | null
): DesignPrimerPair {
  const placeholderPrimer = (
    direction: 'forward' | 'reverse',
    jxnIdx: number | null
  ): DesignPrimer => ({
    id: generateId(direction === 'forward' ? 'fwd' : 'rev'),
    name: `F${fragmentIndex + 1}-${direction === 'forward' ? 'fwd' : 'rev'} (RD)`,
    sequence: '',
    pbs: { start: 0, end: 0, sequence: '' },
    overhang: { length: 0, sequence: '' },
    direction,
    fragmentIndex,
    junctionIndex: jxnIdx,
    tm: 0,
  });
  return {
    forward: placeholderPrimer('forward', leftJunctionIdx),
    reverse: placeholderPrimer('reverse', rightJunctionIdx),
    fragmentIndex,
  };
}

function resolveForwardGoldenGateOverhangPlacement(params: {
  leftJunction: GoldenGateJunction | undefined | null;
  leftJunctionIdx: number | null;
  regionPos: GoldenGateRegionPosition;
  seqLen: number;
  composedSequence: string;
  spacerLengthByJunction: Map<number, number>;
  enzyme: GoldenGateEnzyme;
}): GoldenGateOverhangPlacement {
  const {
    leftJunction,
    leftJunctionIdx,
    regionPos,
    seqLen,
    composedSequence,
    spacerLengthByJunction,
    enzyme,
  } = params;
  if (!leftJunction) {
    return {
      overhangSeq: '',
      literalExtra: '',
      pbsAnchor: regionPos.start,
      goldenGateOverhang: undefined,
    };
  }
  const { overhang, overhangStart, overhangEnd } = leftJunction;
  const junctionPos = leftJunction.junctionPosition;
  const isOriginSpanning = junctionPos >= seqLen && regionPos.start === 0;
  let literalExtra = '';
  let pbsStart = regionPos.start;
  if (isOriginSpanning) {
    if (overhangEnd > seqLen) {
      literalExtra = '';
      pbsStart = overhangEnd % seqLen;
    } else {
      let gapSeq = '';
      for (let i = overhangEnd; i < seqLen; i++) {
        gapSeq += composedSequence[i];
      }
      literalExtra = gapSeq;
      pbsStart = 0;
    }
  } else if (overhangEnd <= junctionPos) {
    literalExtra = composeWrappedSlice(composedSequence, overhangEnd, junctionPos, seqLen);
    pbsStart = junctionPos;
  } else if (overhangStart < junctionPos) {
    literalExtra = '';
    pbsStart = junctionPos + (overhangEnd - junctionPos);
  } else {
    literalExtra = '';
    pbsStart = overhangEnd;
  }

  let literalSpacerLen = 0;
  if (literalExtra.length > 0 && leftJunctionIdx !== null) {
    const spacerLen = spacerLengthByJunction.get(leftJunctionIdx) ?? 0;
    if (spacerLen > 0) {
      literalSpacerLen = Math.min(spacerLen, literalExtra.length);
    }
  }
  return {
    overhangSeq: overhang,
    literalExtra,
    pbsAnchor: pbsStart,
    goldenGateOverhang: buildGoldenGateOverhang(
      overhang,
      literalExtra,
      enzyme,
      literalSpacerLen > 0 ? literalSpacerLen : undefined
    ),
  };
}

function computeForwardGoldenGateCognateLengths(params: {
  leftJunction: GoldenGateJunction | undefined | null;
  leftJunctionIdx: number | null;
  regionPos: GoldenGateRegionPosition;
  seqLen: number;
  spacerLengthByJunction: Map<number, number>;
}): GoldenGateCognateLengths {
  const { leftJunction, leftJunctionIdx, regionPos, seqLen, spacerLengthByJunction } = params;
  if (!leftJunction) {
    return { cognateOverhangLength: 0, synthetic4bpSpacerLength: 0 };
  }
  const { overhangStart, overhangEnd, junctionPosition } = leftJunction;
  const isOriginSpanning = junctionPosition >= seqLen && regionPos.start === 0;
  const leftSpacerLen =
    leftJunctionIdx !== null ? (spacerLengthByJunction.get(leftJunctionIdx) ?? 0) : 0;
  let cognateOverhangLength = 0;
  let synthetic4bpSpacerLength = 0;
  if (isOriginSpanning) {
    if (overhangEnd > seqLen) {
      cognateOverhangLength = Math.min(4, overhangEnd % seqLen);
    }
  } else if (overhangStart >= junctionPosition) {
    cognateOverhangLength = 4;
  } else if (overhangEnd > junctionPosition) {
    cognateOverhangLength = Math.min(4, overhangEnd - junctionPosition);
  }
  if (leftSpacerLen > 0 && overhangStart < junctionPosition) {
    const syntheticEnd = Math.min(overhangEnd, junctionPosition);
    const spacerStart = junctionPosition - leftSpacerLen;
    const intersectStart = Math.max(overhangStart, spacerStart);
    const intersectEnd = Math.min(syntheticEnd, junctionPosition);
    if (intersectEnd > intersectStart) {
      synthetic4bpSpacerLength = intersectEnd - intersectStart;
    }
  }
  return { cognateOverhangLength, synthetic4bpSpacerLength };
}

function resolveReverseGoldenGateOverhangPlacement(params: {
  rightJunction: GoldenGateJunction | undefined | null;
  rightJunctionIdx: number | null;
  regionPos: GoldenGateRegionPosition;
  seqLen: number;
  composedSequence: string;
  spacerLengthByJunction: Map<number, number>;
  enzyme: GoldenGateEnzyme;
}): GoldenGateOverhangPlacement {
  const {
    rightJunction,
    rightJunctionIdx,
    regionPos,
    seqLen,
    composedSequence,
    spacerLengthByJunction,
    enzyme,
  } = params;
  if (!rightJunction) {
    return {
      overhangSeq: '',
      literalExtra: '',
      pbsAnchor: regionPos.end,
      goldenGateOverhang: undefined,
    };
  }
  const overhangSeq = reverseComplement(rightJunction.overhang);
  let literalExtra = '';
  let pbsEnd = regionPos.end;
  if (rightJunction.overhangStart >= regionPos.end) {
    literalExtra = reverseComplement(
      composeWrappedSlice(composedSequence, regionPos.end, rightJunction.overhangStart, seqLen)
    );
    pbsEnd = regionPos.end;
  } else {
    literalExtra = '';
    pbsEnd = rightJunction.overhangStart;
  }
  let literalSpacerLen = 0;
  if (literalExtra.length > 0 && rightJunctionIdx !== null) {
    const spacerLen = spacerLengthByJunction.get(rightJunctionIdx) ?? 0;
    if (spacerLen > 0) {
      literalSpacerLen = Math.min(spacerLen, literalExtra.length);
    }
  }
  return {
    overhangSeq,
    literalExtra,
    pbsAnchor: pbsEnd,
    goldenGateOverhang: buildGoldenGateOverhang(
      overhangSeq,
      literalExtra,
      enzyme,
      literalSpacerLen > 0 ? literalSpacerLen : undefined
    ),
  };
}

function computeReverseGoldenGateCognateLengths(params: {
  rightJunction: GoldenGateJunction | undefined | null;
  rightJunctionIdx: number | null;
  regionPos: GoldenGateRegionPosition;
  spacerLengthByJunction: Map<number, number>;
}): GoldenGateCognateLengths {
  const { rightJunction, rightJunctionIdx, regionPos, spacerLengthByJunction } = params;
  if (!rightJunction) {
    return { cognateOverhangLength: 0, synthetic4bpSpacerLength: 0 };
  }
  const { overhangStart, overhangEnd, junctionPosition } = rightJunction;
  const rightSpacerLen =
    rightJunctionIdx !== null ? (spacerLengthByJunction.get(rightJunctionIdx) ?? 0) : 0;
  const fragmentEnd = regionPos.end;
  let cognateOverhangLength = 0;
  let synthetic4bpSpacerLength = 0;
  if (overhangEnd <= fragmentEnd) {
    cognateOverhangLength = 4;
  } else if (overhangStart < fragmentEnd) {
    cognateOverhangLength = Math.min(4, fragmentEnd - overhangStart);
  }
  if (rightSpacerLen > 0) {
    const intersectStart = Math.max(overhangStart, regionPos.end);
    const intersectEnd = Math.min(overhangEnd, junctionPosition);
    if (intersectEnd > intersectStart) {
      synthetic4bpSpacerLength = intersectEnd - intersectStart;
    }
  }
  return { cognateOverhangLength, synthetic4bpSpacerLength };
}

function computeGoldenGatePrimerPairForFragment(params: {
  region: DesignRegion;
  fragmentIndex: number;
  regionPos: GoldenGateRegionPosition;
  numFragments: number;
  topology: 'linear' | 'circular';
  junctionMap: Map<number, GoldenGateJunction>;
  spacerLengthByJunction: Map<number, number>;
  composedSequence: string;
  seqLen: number;
  enzyme: GoldenGateEnzyme;
  targetPcrTm: number | undefined;
  tm: TmCalculator;
}): DesignPrimerPair {
  const {
    region,
    fragmentIndex,
    regionPos,
    numFragments,
    topology,
    junctionMap,
    spacerLengthByJunction,
    composedSequence,
    seqLen,
    enzyme,
    targetPcrTm,
    tm,
  } = params;
  const leftJunctionIdx = getLeftJunctionIndex(fragmentIndex, numFragments, topology);
  const rightJunctionIdx = getRightJunctionIndex(fragmentIndex, numFragments, topology);
  const leftJunction = leftJunctionIdx !== null ? junctionMap.get(leftJunctionIdx) : null;
  const rightJunction = rightJunctionIdx !== null ? junctionMap.get(rightJunctionIdx) : null;
  if (isRestrictionDigestRegion(region)) {
    return buildRestrictionDigestPlaceholderPair(fragmentIndex, leftJunctionIdx, rightJunctionIdx);
  }

  const forwardPlacement = resolveForwardGoldenGateOverhangPlacement({
    leftJunction,
    leftJunctionIdx,
    regionPos,
    seqLen,
    composedSequence,
    spacerLengthByJunction,
    enzyme,
  });
  const clampedFwdPbsStart = Math.max(
    regionPos.start,
    Math.min(forwardPlacement.pbsAnchor, regionPos.end - 1)
  );
  if (clampedFwdPbsStart !== forwardPlacement.pbsAnchor) {
    console.warn(
      `Forward PBS start clamped from ${forwardPlacement.pbsAnchor} to ${clampedFwdPbsStart} for fragment ${fragmentIndex}`
    );
  }
  const forwardCognate = computeForwardGoldenGateCognateLengths({
    leftJunction,
    leftJunctionIdx,
    regionPos,
    seqLen,
    spacerLengthByJunction,
  });
  const fwdCognateOverhangSeq =
    forwardCognate.cognateOverhangLength > 0
      ? forwardPlacement.overhangSeq.slice(-forwardCognate.cognateOverhangLength)
      : '';
  const fwdPbsLength =
    targetPcrTm !== undefined
      ? sizePbsLengthForTm({
          template: composedSequence,
          anchor: clampedFwdPbsStart,
          direction: 'forward',
          regionStart: regionPos.start,
          regionEnd: regionPos.end,
          cognateSeq: fwdCognateOverhangSeq,
          targetTm: targetPcrTm,
          tmCalculator: tm,
        })
      : DEFAULT_PBS_LENGTH;
  const fwdPbsEnd = Math.min(clampedFwdPbsStart + fwdPbsLength, regionPos.end);
  const fwdPbsSeq = composedSequence.slice(clampedFwdPbsStart, fwdPbsEnd);
  const forwardPrimer: DesignPrimer = {
    id: generateId('fwd'),
    name: `F${fragmentIndex + 1}-fwd`,
    sequence: (forwardPlacement.goldenGateOverhang?.fullSequence ?? '') + fwdPbsSeq,
    pbs: {
      start: clampedFwdPbsStart,
      end: fwdPbsEnd,
      sequence: fwdPbsSeq,
    },
    overhang: {
      length: forwardPlacement.overhangSeq.length,
      sequence: forwardPlacement.overhangSeq,
    },
    goldenGateOverhang: forwardPlacement.goldenGateOverhang,
    direction: 'forward',
    fragmentIndex,
    junctionIndex: leftJunctionIdx,
    tm: tm.estimate(fwdPbsSeq),
    cognate4bpLength: forwardCognate.cognateOverhangLength,
    synthetic4bpSpacerLength:
      forwardCognate.synthetic4bpSpacerLength > 0
        ? forwardCognate.synthetic4bpSpacerLength
        : undefined,
  };

  const reversePlacement = resolveReverseGoldenGateOverhangPlacement({
    rightJunction,
    rightJunctionIdx,
    regionPos,
    seqLen,
    composedSequence,
    spacerLengthByJunction,
    enzyme,
  });
  const clampedRevPbsEnd = Math.max(
    regionPos.start + 1,
    Math.min(reversePlacement.pbsAnchor, regionPos.end)
  );
  if (clampedRevPbsEnd !== reversePlacement.pbsAnchor) {
    console.warn(
      `Reverse PBS end clamped from ${reversePlacement.pbsAnchor} to ${clampedRevPbsEnd} for fragment ${fragmentIndex}`
    );
  }
  const reverseCognate = computeReverseGoldenGateCognateLengths({
    rightJunction,
    rightJunctionIdx,
    regionPos,
    spacerLengthByJunction,
  });
  const revCognateOverhangSeq =
    reverseCognate.cognateOverhangLength > 0
      ? reversePlacement.overhangSeq.slice(-reverseCognate.cognateOverhangLength)
      : '';
  const revPbsLength =
    targetPcrTm !== undefined
      ? sizePbsLengthForTm({
          template: composedSequence,
          anchor: clampedRevPbsEnd,
          direction: 'reverse',
          regionStart: regionPos.start,
          regionEnd: regionPos.end,
          cognateSeq: revCognateOverhangSeq,
          targetTm: targetPcrTm,
          tmCalculator: tm,
        })
      : DEFAULT_PBS_LENGTH;
  const revPbsStart = Math.max(clampedRevPbsEnd - revPbsLength, regionPos.start);
  const revPbsSeq = reverseComplement(composedSequence.slice(revPbsStart, clampedRevPbsEnd));
  const reversePrimer: DesignPrimer = {
    id: generateId('rev'),
    name: `F${fragmentIndex + 1}-rev`,
    sequence: (reversePlacement.goldenGateOverhang?.fullSequence ?? '') + revPbsSeq,
    pbs: {
      start: revPbsStart,
      end: clampedRevPbsEnd,
      sequence: revPbsSeq,
    },
    overhang: {
      length: reversePlacement.overhangSeq.length,
      sequence: reversePlacement.overhangSeq,
    },
    goldenGateOverhang: reversePlacement.goldenGateOverhang,
    direction: 'reverse',
    fragmentIndex,
    junctionIndex: rightJunctionIdx,
    tm: tm.estimate(revPbsSeq),
    cognate4bpLength: reverseCognate.cognateOverhangLength,
    synthetic4bpSpacerLength:
      reverseCognate.synthetic4bpSpacerLength > 0
        ? reverseCognate.synthetic4bpSpacerLength
        : undefined,
  };

  return {
    forward: forwardPrimer,
    reverse: reversePrimer,
    fragmentIndex,
  };
}

export function computeGoldenGatePrimers(
  regions: DesignRegion[],
  junctions: GoldenGateJunction[],
  topology: 'linear' | 'circular',
  enzyme: GoldenGateEnzyme,
  spacers: DesignSpacer[] = [],
  targetPcrTm?: number,
  tm: TmCalculator = LOCAL_TM_CALCULATOR
): DesignPrimerPair[] {
  const composedSequence = getComposedSequence(regions, spacers);
  const seqLen = composedSequence.length;
  const numFragments = regions.length;

  const junctionMap = new Map<number, GoldenGateJunction>();
  for (const jxn of junctions) {
    junctionMap.set(jxn.junctionIndex, jxn);
  }

  const spacerLengthByJunction = new Map<number, number>();
  for (const spacer of spacers) {
    spacerLengthByJunction.set(spacer.junctionIndex, spacer.sequence.length);
  }

  const regionPositions: GoldenGateRegionPosition[] = [];
  let pos = 0;
  for (let i = 0; i < regions.length; i++) {
    const region = regions[i];
    regionPositions.push({ start: pos, end: pos + region.sequence.length });
    pos += region.sequence.length;
    pos += spacerLengthByJunction.get(i) ?? 0;
  }

  return regions.flatMap((region, fragmentIndex) =>
    region.isPlaceholder || region.sequence.length === 0
      ? []
      : [
          computeGoldenGatePrimerPairForFragment({
            region,
            fragmentIndex,
            regionPos: regionPositions[fragmentIndex],
            numFragments,
            topology,
            junctionMap,
            spacerLengthByJunction,
            composedSequence,
            seqLen,
            enzyme,
            targetPcrTm,
            tm,
          }),
        ]
  );
}
