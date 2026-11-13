import { alignSequences } from './nw-align';

export interface SequenceChange {
  type: 'insertion' | 'deletion' | 'mutation';
  position: number;
  length: number;
  oldPosition?: number;
  oldBases?: string;
  newBases?: string;
}

export interface DiffResult {
  changes: SequenceChange[];
  insertions: number;
  deletions: number;
  mutations: number;
  insertedBp: number;
  deletedBp: number;
  oldGapped?: string;
  newGapped?: string;
}

export interface AnnotationChange {
  type: 'added' | 'removed' | 'modified';
  name: string;
  annotationType: string;
  changes?: string[];
}

export interface AnnotationDiffResult {
  changes: AnnotationChange[];
  added: number;
  removed: number;
  modified: number;
}

export { extractRawSequence } from '@waypoint/sequence-utils';

export async function computeSequenceDiff(
  oldSequence: string,
  newSequence: string
): Promise<DiffResult> {
  if (oldSequence === newSequence) {
    return { changes: [], insertions: 0, deletions: 0, mutations: 0, insertedBp: 0, deletedBp: 0 };
  }

  if (!oldSequence && newSequence) {
    return {
      changes: [
        { type: 'insertion', position: 0, length: newSequence.length, newBases: newSequence },
      ],
      insertions: 1,
      deletions: 0,
      mutations: 0,
      insertedBp: newSequence.length,
      deletedBp: 0,
    };
  }

  await new Promise((resolve) => setTimeout(resolve, 0));

  const { oldGapped, newGapped } = alignSequences(oldSequence, newSequence);

  const changes = changesFromAlignment(oldGapped, newGapped);

  return { ...summarizeChanges(changes), oldGapped, newGapped };
}

function changesFromAlignment(oldGapped: string, newGapped: string): SequenceChange[] {
  const changes: SequenceChange[] = [];
  let newPos = 0;
  let oldPos = 0;
  let i = 0;

  while (i < oldGapped.length) {
    const oldChar = oldGapped[i];
    const newChar = newGapped[i];

    if (oldChar === '-' && newChar !== '-') {
      const start = newPos;
      let bases = '';
      while (i < oldGapped.length && oldGapped[i] === '-' && newGapped[i] !== '-') {
        bases += newGapped[i];
        newPos++;
        i++;
      }
      changes.push({ type: 'insertion', position: start, length: bases.length, newBases: bases });
    } else if (oldChar !== '-' && newChar === '-') {
      const startNew = newPos;
      const startOld = oldPos;
      let bases = '';
      while (i < oldGapped.length && oldGapped[i] !== '-' && newGapped[i] === '-') {
        bases += oldGapped[i];
        oldPos++;
        i++;
      }
      changes.push({
        type: 'deletion',
        position: startNew,
        oldPosition: startOld,
        length: bases.length,
        oldBases: bases,
      });
    } else if (oldChar !== '-' && newChar !== '-' && oldChar !== newChar) {
      const start = newPos;
      let oldBases = '';
      let newBases = '';
      while (
        i < oldGapped.length &&
        oldGapped[i] !== '-' &&
        newGapped[i] !== '-' &&
        oldGapped[i] !== newGapped[i]
      ) {
        oldBases += oldGapped[i];
        newBases += newGapped[i];
        oldPos++;
        newPos++;
        i++;
      }
      changes.push({
        type: 'mutation',
        position: start,
        length: oldBases.length,
        oldBases,
        newBases,
      });
    } else {
      if (oldChar !== '-') oldPos++;
      if (newChar !== '-') newPos++;
      i++;
    }
  }

  return changes;
}

function summarizeChanges(changes: SequenceChange[]): DiffResult {
  let insertions = 0,
    deletions = 0,
    mutations = 0;
  let insertedBp = 0,
    deletedBp = 0;

  for (const c of changes) {
    switch (c.type) {
      case 'insertion':
        insertions++;
        insertedBp += c.length;
        break;
      case 'deletion':
        deletions++;
        deletedBp += c.length;
        break;
      case 'mutation':
        mutations++;
        break;
    }
  }

  return { changes, insertions, deletions, mutations, insertedBp, deletedBp };
}

interface AnnotationLike {
  name: string;
  type: string;
  start: number;
  end: number;
  direction?: number;
}

export function computeAnnotationDiff(
  oldAnnotations: AnnotationLike[],
  newAnnotations: AnnotationLike[],
  _sequenceChanges?: SequenceChange[]
): AnnotationDiffResult {
  const changes: AnnotationChange[] = [];

  const oldByName = new Map<string, AnnotationLike[]>();
  for (const ann of oldAnnotations) {
    const key = ann.name.toLowerCase();
    const existing = oldByName.get(key);
    if (existing) {
      existing.push(ann);
    } else {
      oldByName.set(key, [ann]);
    }
  }

  for (const newAnn of newAnnotations) {
    const key = newAnn.name.toLowerCase();
    const oldMatches = oldByName.get(key);

    if (!oldMatches || oldMatches.length === 0) {
      changes.push({
        type: 'added',
        name: newAnn.name,
        annotationType: newAnn.type,
      });
    } else {
      const oldAnn = oldMatches.shift() as AnnotationLike;

      const diffs: string[] = [];
      if (oldAnn.type !== newAnn.type) {
        diffs.push(`type: ${oldAnn.type} → ${newAnn.type}`);
      }
      if (
        oldAnn.direction !== undefined &&
        newAnn.direction !== undefined &&
        oldAnn.direction !== newAnn.direction
      ) {
        diffs.push('direction changed');
      }

      if (diffs.length > 0) {
        changes.push({
          type: 'modified',
          name: newAnn.name,
          annotationType: newAnn.type,
          changes: diffs,
        });
      }
    }
  }

  for (const [_key, remaining] of oldByName) {
    for (const ann of remaining) {
      changes.push({
        type: 'removed',
        name: ann.name,
        annotationType: ann.type,
      });
    }
  }

  return {
    changes,
    added: changes.filter((c) => c.type === 'added').length,
    removed: changes.filter((c) => c.type === 'removed').length,
    modified: changes.filter((c) => c.type === 'modified').length,
  };
}
