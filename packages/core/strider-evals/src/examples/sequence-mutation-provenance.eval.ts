import type { ProvenanceEvalDescriptor } from '../descriptor/provenance.ts';
import { registerEvalDescriptor } from '../runner/register.ts';
import { buildExampleEnvironment } from './test-environment.ts';

const descriptor: ProvenanceEvalDescriptor = {
  id: 'sequence-mutate-provenance',
  kind: 'provenance',
  description:
    'sequence.mutate attaches mutation provenance to the exact variant sequence it returns.',
  mode: 'mock-llm',
  tags: ['D4', 'D12', 'safety-coverage', 'provenance'],
  actionName: 'sequence.mutate',
  input: {
    parentSequenceId: 'plasmid-001',
    variantSequenceId: 'plasmid-001-mutA',
    mutationLabel: 'A42G',
  },
  expectedProvenance: {
    derivedEntity: { kind: 'sequence', id: 'plasmid-001-mutA' },
    derivationKind: 'mutation',
    actionName: 'sequence.mutate',
    sources: [
      {
        entity: { kind: 'sequence', id: 'plasmid-001' },
        role: 'parent',
      },
    ],
    attachedAtFieldExists: true,
  },
};

registerEvalDescriptor(descriptor, () =>
  buildExampleEnvironment({
    sequences: { 'plasmid-001': { name: 'pUC19' } },
  })
);
