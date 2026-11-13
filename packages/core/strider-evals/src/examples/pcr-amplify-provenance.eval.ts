import type { ProvenanceEvalDescriptor } from '../descriptor/provenance.ts';
import { registerEvalDescriptor } from '../runner/register.ts';
import { buildExampleEnvironment } from './test-environment.ts';

const descriptor: ProvenanceEvalDescriptor = {
  id: 'pcr-amplify-provenance',
  kind: 'provenance',
  description:
    'sequence.pcrAmplify attaches a ProvenanceRecord with derivationKind=pcr listing template + 2 primers as sources (D12 — biological provenance).',
  mode: 'mock-llm',
  tags: ['B1', 'D4', 'provenance'],
  actionName: 'sequence.pcrAmplify',
  input: {
    templateSequenceId: 'plasmid-001',
    forwardPrimerId: 'primer-fwd',
    reversePrimerId: 'primer-rev',
    productId: 'pcr-product-1',
  },
  expectedProvenance: {
    derivedEntity: { kind: 'sequence', id: 'pcr-product-1' },
    derivationKind: 'pcr',
    actionName: 'sequence.pcrAmplify',
    sources: [
      {
        entity: { kind: 'sequence', id: 'plasmid-001' },
        role: 'template',
      },
      {
        entity: { kind: 'sequence', id: 'primer-fwd' },
        role: 'primer',
      },
      {
        entity: { kind: 'sequence', id: 'primer-rev' },
        role: 'primer',
      },
    ],
    attachedAtFieldExists: true,
  },
};

registerEvalDescriptor(descriptor, () =>
  buildExampleEnvironment({
    sequences: {
      'plasmid-001': { name: 'pUC19' },
    },
  })
);
