import { convertPlasmid } from '@waypoint/plasmid-viewer';
import type { AnnotatedSequence, Annotation } from '@waypoint/sequence-utils';
import type { DiffResult } from '../diff/sequence-diff';
import { annotatedSequenceToParsedPlasmid } from '../adapters';
import type { NativeSequenceComparisonInput } from './native-sequence-comparison';

export type SequenceComparisonInput = NativeSequenceComparisonInput & {
  readonly sourceAnnotations: {
    readonly before: readonly Annotation[];
    readonly after: readonly Annotation[];
  };
};

export function sequenceComparisonInput(input: {
  id: string;
  before: AnnotatedSequence;
  after: AnnotatedSequence;
  diff: DiffResult & { oldGapped: string; newGapped: string };
  changeRanges: ReadonlyArray<{ start: number; end: number }>;
  referenceName: string;
  referenceOrigin: number;
}): SequenceComparisonInput {
  if (input.diff.changes.length !== input.changeRanges.length) {
    throw new Error('Missing recorded change ranges');
  }
  return {
    id: input.id,
    before: convertPlasmid(annotatedSequenceToParsedPlasmid(input.before)),
    after: convertPlasmid(annotatedSequenceToParsedPlasmid(input.after)),
    oldGapped: input.diff.oldGapped,
    newGapped: input.diff.newGapped,
    sourceAnnotations: { before: input.before.annotations, after: input.after.annotations },
    referenceName: input.referenceName,
    referenceOrigin: input.referenceOrigin,
    changes: input.diff.changes.map((change, index) => ({
      kind: change.type === 'mutation' ? 'substitution' : change.type,
      ...input.changeRanges[index],
    })),
  };
}
