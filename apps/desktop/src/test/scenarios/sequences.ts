import type { AnnotatedSequence, Annotation } from '@waypoint/sequence-utils';
import { MINI_PLASMID, PUC19, GFP_LINEAR, PUC19_GENBANK, GFP_FASTA } from '../fixtures/sequences';
import { withSequenceTab } from './canvas';
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

export function withPUC19(scenario: AppScenario): AppScenario {
  const documentId = 'fixture:sequence:puc19';
  return withSequenceFile(
    withSequenceTab(scenario, {
      documentId,
      sourcePath: '/workspace/pUC19.gb',
      label: 'pUC19',
    }),
    {
      documentId,
      sourcePath: '/workspace/pUC19.gb',
      sequence: PUC19,
      fileContent: PUC19_GENBANK,
    }
  );
}

export function withGFP(scenario: AppScenario): AppScenario {
  const documentId = 'fixture:sequence:gfp';
  return withSequenceFile(
    withSequenceTab(scenario, {
      documentId,
      sourcePath: '/workspace/gfp.fasta',
      label: 'GFP',
    }),
    {
      documentId,
      sourcePath: '/workspace/gfp.fasta',
      sequence: GFP_LINEAR,
      fileContent: GFP_FASTA,
    }
  );
}

export function withMiniPlasmid(scenario: AppScenario): AppScenario {
  const documentId = 'fixture:sequence:mini-plasmid';
  return withSequenceFile(
    withSequenceTab(scenario, {
      documentId,
      sourcePath: '/workspace/mini.gb',
      label: 'Mini Plasmid',
    }),
    {
      documentId,
      sourcePath: '/workspace/mini.gb',
      sequence: MINI_PLASMID,
    }
  );
}

export { MINI_PLASMID, PUC19, GFP_LINEAR, PUC19_GENBANK, GFP_FASTA };
