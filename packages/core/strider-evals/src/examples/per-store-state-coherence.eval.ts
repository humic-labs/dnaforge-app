import type { StateCoherenceEvalDescriptor } from '../descriptor/state-coherence.ts';
import { registerEvalDescriptor } from '../runner/register.ts';
import { buildExampleEnvironment } from './test-environment.ts';

const descriptors: StateCoherenceEvalDescriptor[] = [
  {
    id: 'design-rename-state-coherence',
    kind: 'state-coherence',
    description: 'design.rename rejects stale design revisions and bumps design revision once.',
    mode: 'mock-llm',
    tags: ['D1', 'D2', 'per-store-invariants', 'safety-coverage', 'state-coherence'],
    actionName: 'design.rename',
    entity: { kind: 'design', id: 'design-001' },
    input: { designId: 'design-001', newName: 'Golden Gate v2' },
    cases: [
      {
        kind: 'stale-context',
        expectedRevision: 1,
        liveRevision: 4,
        expectedError: { code: 'STALE_STATE', messageContains: 'design-001' },
      },
      {
        kind: 'revision-bump',
        initialRevision: 10,
        expectedRevisionAfter: 11,
      },
    ],
  },
  {
    id: 'page-update-title-state-coherence',
    kind: 'state-coherence',
    description: 'page.updateTitle rejects stale page revisions and bumps page revision once.',
    mode: 'mock-llm',
    tags: ['D1', 'D2', 'per-store-invariants', 'safety-coverage', 'state-coherence'],
    actionName: 'page.updateTitle',
    entity: { kind: 'page', id: 'page-001' },
    input: { pageId: 'page-001', title: 'Experiment notes' },
    cases: [
      {
        kind: 'stale-context',
        expectedRevision: 0,
        liveRevision: 2,
        expectedError: { code: 'STALE_STATE', messageContains: 'page-001' },
      },
      {
        kind: 'revision-bump',
        initialRevision: 7,
        expectedRevisionAfter: 8,
      },
    ],
  },
  {
    id: 'structure-set-style-state-coherence',
    kind: 'state-coherence',
    description:
      'structure.setStyle rejects stale structure revisions and bumps structure revision once.',
    mode: 'mock-llm',
    tags: ['D1', 'D2', 'per-store-invariants', 'safety-coverage', 'state-coherence'],
    actionName: 'structure.setStyle',
    entity: { kind: 'structure', id: 'structure-001' },
    input: { structureId: 'structure-001', style: 'cartoon' },
    cases: [
      {
        kind: 'stale-context',
        expectedRevision: 3,
        liveRevision: 9,
        expectedError: { code: 'STALE_STATE', messageContains: 'structure-001' },
      },
      {
        kind: 'revision-bump',
        initialRevision: 12,
        expectedRevisionAfter: 13,
      },
    ],
  },
];

registerEvalDescriptor(descriptors, () =>
  buildExampleEnvironment({
    designs: { 'design-001': { name: 'Golden Gate' } },
    pages: { 'page-001': { title: 'Untitled' } },
    structures: { 'structure-001': { style: 'ball-stick' } },
  })
);
