import { reverseComplement } from '@waypoint/sequence-utils';

export const GIBSON_MIN_HOMOLOGY_LENGTH = 15;

export const GIBSON_MAX_HOMOLOGY_LENGTH = 60;

export const GIBSON_OPTIMAL_HOMOLOGY_RANGE = { min: 15, max: 40 };

export const GIBSON_OPTIMAL_TM = 50;

export const GIBSON_OPTIMAL_GC_RANGE = { min: 30, max: 70 };

export const GOLDENGATE_DEFAULT_PCR_TM = 58;

export const PRIMER_PBS_MIN_LENGTH = 10;

export const GOLDENGATE_PBS_SEARCH_MAX_LENGTH = 60;

export function isPalindrome(sequence: string): boolean {
  return sequence === reverseComplement(sequence);
}
