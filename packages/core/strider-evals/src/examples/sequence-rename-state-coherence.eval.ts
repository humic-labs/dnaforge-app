import type { StateCoherenceEvalDescriptor } from '../descriptor/state-coherence.ts';
import { registerEvalDescriptor } from '../runner/register.ts';
import { buildExampleEnvironment } from './test-environment.ts';

const descriptor: StateCoherenceEvalDescriptor = {
  id: 'sequence-rename-state-coherence',
  kind: 'state-coherence',
  description:
    'sequence.rename rejects stale expectedRevision, and bumps the entity revision by exactly one on success.',
  mode: 'mock-llm',
  tags: ['B1', 'D2', 'optimistic-concurrency'],
  actionName: 'sequence.rename',
  entity: { kind: 'sequence', id: 'plasmid-001' },
  input: { sequenceId: 'plasmid-001', newName: 'pUC19-fixed' },
  cases: [
    {
      kind: 'stale-context',
      expectedRevision: 0,
      liveRevision: 3,
      expectedError: {
        code: 'STALE_STATE',
        messageContains: 'plasmid-001',
      },
    },
    {
      kind: 'revision-bump',
      initialRevision: 5,
      expectedRevisionAfter: 6,
    },
  ],
};

registerEvalDescriptor(descriptor, () =>
  buildExampleEnvironment({
    sequences: { 'plasmid-001': { name: 'pUC19' } },
  })
);
