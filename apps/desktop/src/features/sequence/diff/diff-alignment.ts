import { alignSequences } from './nw-align';
export type { GappedAlignment } from './nw-align';

export function diffToGappedAlignment(
  oldSequence: string,
  newSequence: string
): { oldGapped: string; newGapped: string } {
  return alignSequences(oldSequence, newSequence);
}
