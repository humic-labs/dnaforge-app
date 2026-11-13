import type { Mutation } from '../types';
import { adjustAnnotationsForInsert, type Annotation } from '@waypoint/sequence-utils';

interface ApplyResult {
  sequence: string;
  annotations: Annotation[];
}

function shiftAnnotationsForDelete(
  annotations: Annotation[],
  deleteStart: number,
  deleteEnd: number
): Annotation[] {
  const deleteLen = deleteEnd - deleteStart;

  return annotations
    .map((ann) => {
      const annStart0 = ann.start - 1;
      const annEnd0 = ann.end - 1;
      if (annStart0 >= deleteEnd) {
        return {
          ...ann,
          start: ann.start - deleteLen,
          end: ann.end - deleteLen,
        };
      }
      if (annEnd0 < deleteStart) {
        return ann;
      }
      if (annStart0 >= deleteStart && annEnd0 < deleteEnd) {
        return null;
      }
      if (annStart0 < deleteStart && annEnd0 >= deleteStart && annEnd0 < deleteEnd) {
        return { ...ann, end: deleteStart };
      }
      if (annStart0 >= deleteStart && annStart0 < deleteEnd && annEnd0 >= deleteEnd) {
        const newStart = deleteStart + 1;
        const newEnd = ann.end - deleteLen;
        return { ...ann, start: newStart, end: newEnd };
      }
      if (annStart0 < deleteStart && annEnd0 >= deleteEnd) {
        return { ...ann, end: ann.end - deleteLen };
      }

      return ann;
    })
    .filter((ann): ann is Annotation => ann !== null && ann.end >= ann.start);
}

export function applyMutationsToSequence(
  sequence: string,
  annotations: Annotation[],
  mutations: Mutation[]
): ApplyResult {
  if (mutations.length === 0) {
    return { sequence, annotations: [...annotations] };
  }
  const sorted = [...mutations].sort((a, b) => b.position - a.position);

  let seq = sequence;
  let anns = [...annotations];

  for (const mutation of sorted) {
    const pos0 = mutation.position - 1;

    switch (mutation.type) {
      case 'substitution': {
        const len = mutation.length || mutation.alternateBase.length || 1;
        seq = seq.slice(0, pos0) + mutation.alternateBase + seq.slice(pos0 + len);
        break;
      }
      case 'insertion': {
        const insertBases = mutation.alternateBase;
        anns = adjustAnnotationsForInsert(anns, pos0, insertBases.length, seq.length);
        seq = seq.slice(0, pos0) + insertBases + seq.slice(pos0);
        break;
      }
      case 'deletion': {
        const deleteLen = mutation.length || mutation.referenceBase.length || 1;
        seq = seq.slice(0, pos0) + seq.slice(pos0 + deleteLen);
        anns = shiftAnnotationsForDelete(anns, pos0, pos0 + deleteLen);
        break;
      }
    }
  }

  return { sequence: seq, annotations: anns };
}
