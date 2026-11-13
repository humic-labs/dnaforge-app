import type { SequenceWindow } from '../../../types';
import type { BaseReader } from '../../../biology/translation';

export function createBaseReader(
  sequence: string | undefined,
  sequenceWindow: SequenceWindow | undefined,
  circular = false
): BaseReader | null {
  if (sequenceWindow && sequenceWindow.bases.length > 0) {
    const offset = sequenceWindow.startBp;
    const bases = sequenceWindow.bases;
    const len = bases.length;
    return (bp) => {
      const i = bp - offset;
      return i >= 0 && i < len ? bases[i] : undefined;
    };
  }
  if (sequence && sequence.length > 0) {
    const len = sequence.length;
    if (circular) return (bp) => sequence[((bp % len) + len) % len];
    return (bp) => (bp >= 0 && bp < len ? sequence[bp] : undefined);
  }
  return null;
}
