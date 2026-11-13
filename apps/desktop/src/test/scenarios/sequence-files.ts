import type { AnnotatedSequence, Annotation } from '@waypoint/sequence-utils';
import type { AppScenario } from './types';

export function createSequenceFixture(opts: {
  name: string;
  length: number;
  circular: boolean;
  annotations?: Annotation[];
  sequence?: string;
  id?: string;
}): AnnotatedSequence {
  const id = opts.id ?? opts.name.toLowerCase().replace(/\s+/g, '-');
  const sequence =
    opts.sequence ?? 'ATCGATCG'.repeat(Math.ceil(opts.length / 8)).slice(0, opts.length);
  return {
    id,
    name: opts.name,
    sequence,
    length: opts.length,
    annotations: opts.annotations ?? [],
    circular: opts.circular,
  };
}

export function withSequenceFile(
  scenario: AppScenario,
  input: {
    documentId: string;
    sourcePath: string;
    sequence: AnnotatedSequence;
    fileContent?: string;
  }
): AppScenario {
  return {
    ...scenario,
    sequences: { ...scenario.sequences, [input.documentId]: input.sequence },
    sequenceSources: {
      ...scenario.sequenceSources,
      [input.documentId]: {
        sourcePath: input.sourcePath,
        name: input.sequence.name,
      },
    },
    files: {
      ...scenario.files,
      ...(input.fileContent ? { [input.sourcePath]: input.fileContent } : {}),
    },
  };
}
