import type {
  DesignRegion,
  DesignSpacer,
  HomologyRegion,
  HomologyEncoding,
  HomologyTemplateBasis,
} from '../types';
import { getComposedSequence } from '../types';
import { estimateTm, calculateGcContent } from './tm-calculator';
import { GIBSON_MIN_HOMOLOGY_LENGTH, GIBSON_MAX_HOMOLOGY_LENGTH } from '../validation-constants';
import { calculateHomologyLengthForTm, generateId } from './utils';
import { extractHomologyProjection } from './homology-template-basis';

const MIN_HOMOLOGY_LENGTH = GIBSON_MIN_HOMOLOGY_LENGTH;
const MAX_HOMOLOGY_LENGTH = GIBSON_MAX_HOMOLOGY_LENGTH;

export interface JunctionInfo {
  index: number;
  position: number;
  leftRegionIndex: number;
  rightRegionIndex: number;
  spacerLength: number;
}

export function identifyJunctions(
  regions: DesignRegion[],
  topology: 'linear' | 'circular',
  spacers: DesignSpacer[] = []
): JunctionInfo[] {
  const n = regions.length;
  if (n < 2) return [];

  const junctions: JunctionInfo[] = [];
  const isCircular = topology === 'circular';

  const spacerLengthByJunction = new Map<number, number>();
  for (const spacer of spacers) {
    spacerLengthByJunction.set(spacer.junctionIndex, spacer.sequence.length);
  }

  const regionPositions: { start: number; end: number }[] = [];
  let pos = 0;
  for (let i = 0; i < regions.length; i++) {
    const region = regions[i];
    regionPositions.push({ start: pos, end: pos + region.sequence.length });
    pos += region.sequence.length;

    const spacerLen = spacerLengthByJunction.get(i) ?? 0;
    pos += spacerLen;
  }

  const numJunctions = isCircular ? n : n - 1;

  for (let i = 0; i < numJunctions; i++) {
    const leftIdx = i;
    const rightIdx = (i + 1) % n;

    const spacerLen = spacerLengthByJunction.get(i) ?? 0;
    const position = regionPositions[leftIdx].end + spacerLen;

    junctions.push({
      index: i,
      position,
      leftRegionIndex: leftIdx,
      rightRegionIndex: rightIdx,
      spacerLength: spacerLen,
    });
  }

  return junctions;
}

export function getLeftPortion(homology: HomologyRegion): string {
  const seq = homology.metadata?.sequence ?? '';
  const onLeft = homology.encoding?.onLeft ?? Math.floor(seq.length / 2);
  return seq.slice(0, onLeft);
}

export function getRightPortion(homology: HomologyRegion): string {
  const seq = homology.metadata?.sequence ?? '';
  const onLeft = homology.encoding?.onLeft ?? Math.floor(seq.length / 2);
  return seq.slice(onLeft);
}

export function getLeftJunctionIndex(
  fragmentIndex: number,
  numFragments: number,
  topology: 'linear' | 'circular'
): number | null {
  if (topology === 'linear' && fragmentIndex === 0) {
    return null;
  }

  return (fragmentIndex - 1 + numFragments) % numFragments;
}

export function getRightJunctionIndex(
  fragmentIndex: number,
  numFragments: number,
  topology: 'linear' | 'circular'
): number | null {
  if (topology === 'linear' && fragmentIndex === numFragments - 1) {
    return null;
  }
  return fragmentIndex;
}

function isRestrictionDigestRegion(region: DesignRegion | undefined): boolean {
  return region?.sourceType === 'rd' || !!region?.rdOverhangs;
}

function calculateOneSidedHomologyLengthForTm(
  composedSequence: string,
  junctionPosition: number,
  direction: 'left' | 'right',
  targetTm: number,
  minLength: number,
  maxLength: number
): number {
  const seqLen = composedSequence.length;
  let high = Math.min(maxLength, seqLen);
  if (high <= 0) return 0;

  let low = Math.min(minLength, high);
  let bestLength = low;
  let bestDiff = Infinity;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const start = direction === 'left' ? junctionPosition - mid : junctionPosition;
    const end = direction === 'left' ? junctionPosition : junctionPosition + mid;

    let homologySeq = '';
    for (let i = start; i < end; i++) {
      const idx = ((i % seqLen) + seqLen) % seqLen;
      homologySeq += composedSequence[idx];
    }

    const tm = estimateTm(homologySeq);
    const diff = Math.abs(tm - targetTm);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestLength = mid;
    }

    if (tm < targetTm) {
      low = mid + 1;
    } else if (tm > targetTm) {
      high = mid - 1;
    } else {
      break;
    }
  }

  return bestLength;
}

function getGibsonHomologyEncoding(
  length: number,
  leftRegion: DesignRegion | undefined,
  rightRegion: DesignRegion | undefined
): HomologyEncoding {
  const leftIsRd = isRestrictionDigestRegion(leftRegion);
  const rightIsRd = isRestrictionDigestRegion(rightRegion);

  if (leftIsRd && !rightIsRd) {
    return { onLeft: length, onRight: 0 };
  }

  if (!leftIsRd && rightIsRd) {
    return { onLeft: 0, onRight: length };
  }

  const onLeft = Math.floor(length / 2);
  return {
    onLeft,
    onRight: length - onLeft,
  };
}

export function getHomologyTemplateBasis(
  junction: JunctionInfo,
  leftRegion: DesignRegion | undefined,
  rightRegion: DesignRegion | undefined
): HomologyTemplateBasis {
  const leftIsRd = isRestrictionDigestRegion(leftRegion);
  const rightIsRd = isRestrictionDigestRegion(rightRegion);
  const spacerStart = junction.position - junction.spacerLength;
  const spacerContributesToAnnealing = junction.spacerLength > 0 && !leftIsRd && !rightIsRd;
  const leftHomologyAllowed = !(rightIsRd && !leftIsRd);
  const rightHomologyAllowed = !(leftIsRd && !rightIsRd);

  return {
    leftHomologyEnd: spacerContributesToAnnealing ? junction.position : spacerStart,
    rightHomologyStart: junction.position,
    spacerLength: junction.spacerLength,
    spacerContributesToAnnealing,
    leftSpacerIncludedInHomology: spacerContributesToAnnealing,
    leftHomologyAllowed,
    rightHomologyAllowed,
  };
}

function calculateGibsonHomologyLength(
  composedSequence: string,
  junction: JunctionInfo,
  regions: DesignRegion[],
  defaultLength: number
): number {
  const leftRegion = regions[junction.leftRegionIndex];
  const rightRegion = regions[junction.rightRegionIndex];
  const leftIsRd = isRestrictionDigestRegion(leftRegion);
  const rightIsRd = isRestrictionDigestRegion(rightRegion);
  const maxLength = Math.min(MAX_HOMOLOGY_LENGTH, defaultLength * 2);

  if (leftIsRd && !rightIsRd) {
    return calculateOneSidedHomologyLengthForTm(
      composedSequence,
      junction.position - junction.spacerLength,
      'left',
      50,
      MIN_HOMOLOGY_LENGTH,
      Math.min(maxLength, leftRegion.sequence.length)
    );
  }

  if (!leftIsRd && rightIsRd) {
    return calculateOneSidedHomologyLengthForTm(
      composedSequence,
      junction.position,
      'right',
      50,
      MIN_HOMOLOGY_LENGTH,
      Math.min(maxLength, rightRegion.sequence.length)
    );
  }

  return calculateHomologyLengthForTm(
    composedSequence,
    junction.position,
    50,
    MIN_HOMOLOGY_LENGTH,
    maxLength
  );
}

export function computeHomologyRegions(
  regions: DesignRegion[],
  topology: 'linear' | 'circular',
  defaultLength: number,
  spacers: DesignSpacer[] = [],
  requestedLength?: number,
  backboneRegionId?: string,
  requestedLengthIsExplicit = true
): HomologyRegion[] {
  const composedSequence = getComposedSequence(regions, spacers);
  const junctions = identifyJunctions(regions, topology, spacers);

  return junctions.map((junction) => {
    const leftRegion = regions[junction.leftRegionIndex];
    const rightRegion = regions[junction.rightRegionIndex];
    const templateBasis = getHomologyTemplateBasis(junction, leftRegion, rightRegion);

    const computedLength = () =>
      calculateGibsonHomologyLength(composedSequence, junction, regions, defaultLength);
    let length = requestedLength ?? computedLength();
    let encoding = getGibsonHomologyEncoding(length, leftRegion, rightRegion);
    if (!isRestrictionDigestRegion(leftRegion) && !isRestrictionDigestRegion(rightRegion)) {
      if (leftRegion.id === backboneRegionId)
        Object.assign(encoding, { onLeft: length, onRight: 0 });
      else if (rightRegion.id === backboneRegionId)
        Object.assign(encoding, { onLeft: 0, onRight: length });
    }
    if (
      requestedLength !== undefined &&
      (encoding.onLeft >
        leftRegion.sequence.length +
          (templateBasis.leftSpacerIncludedInHomology ? junction.spacerLength : 0) ||
        encoding.onRight > rightRegion.sequence.length)
    ) {
      if (requestedLengthIsExplicit)
        throw new Error(
          `Junction ${junction.index + 1} cannot supply the requested ${requestedLength} bp overlap.`
        );
      length = computedLength();
      encoding = getGibsonHomologyEncoding(length, leftRegion, rightRegion);
    }

    const projection = extractHomologyProjection(composedSequence, encoding, templateBasis);

    return {
      id: generateId('homology'),
      junctionIndex: junction.index,

      junctionPosition: junction.position,

      start: projection.start,
      end: projection.end,
      encoding,
      templateBasis,
      metadata: {
        sequence: projection.sequence,
        tmEstimate: estimateTm(projection.sequence),
        gcContent: calculateGcContent(projection.sequence),
      },
    };
  });
}
