import { reverseComplement as sharedReverseComplement } from '@waypoint/sequence-utils';
import { GIBSON_MIN_HOMOLOGY_LENGTH, GIBSON_MAX_HOMOLOGY_LENGTH } from '../validation-constants';
import { estimateTm } from './tm-calculator';

const MIN_HOMOLOGY_LENGTH = GIBSON_MIN_HOMOLOGY_LENGTH;
const MAX_HOMOLOGY_LENGTH = GIBSON_MAX_HOMOLOGY_LENGTH;

export const DEFAULT_PBS_LENGTH = 20;

export const reverseComplement = sharedReverseComplement;

export function calculateHomologyLengthForTm(
  composedSequence: string,
  junctionPosition: number,
  targetTm: number = 50,
  minLength: number = MIN_HOMOLOGY_LENGTH,
  maxLength: number = MAX_HOMOLOGY_LENGTH
): number {
  const seqLen = composedSequence.length;

  let low = minLength;
  let high = Math.min(maxLength, seqLen);
  let bestLength = minLength;
  let bestDiff = Infinity;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const halfLeft = Math.floor(mid / 2);
    const halfRight = mid - halfLeft;

    const start = junctionPosition - halfLeft;
    const end = junctionPosition + halfRight;

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

export function generateId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).substring(2, 9)}`;
}
