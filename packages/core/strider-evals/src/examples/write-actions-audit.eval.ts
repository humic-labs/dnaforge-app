import type { AuditEvalDescriptor } from '../descriptor/audit.ts';
import { registerEvalDescriptor } from '../runner/register.ts';
import { buildExampleEnvironment } from './test-environment.ts';

const descriptors: AuditEvalDescriptor[] = [
  {
    id: 'design-rename-audit-v2',
    kind: 'audit',
    description: 'design.rename writes audit v2 before/after state and affected design entity.',
    mode: 'mock-llm',
    tags: ['D3', 'safety-coverage', 'audit-v2'],
    actionName: 'design.rename',
    input: { designId: 'design-001', newName: 'Golden Gate v2' },
    expectedAudit: {
      actionName: 'design.rename',
      status: 'ok',
      scopeIncludes: ['mutating'],
      sessionIdMatchesPattern: '^session-[a-z0-9-]+$',
      affectedEntities: [{ kind: 'design', id: 'design-001' }],
      expectStateMutated: true,
      beforeStateIncludes: {
        'design/design-001': { revision: 0, value: { name: 'Golden Gate' } },
      },
      afterStateIncludes: {
        'design/design-001': { revision: 1, value: { name: 'Golden Gate v2' } },
      },
    },
  },
  {
    id: 'page-update-title-audit-v2',
    kind: 'audit',
    description: 'page.updateTitle writes audit v2 before/after state and affected page entity.',
    mode: 'mock-llm',
    tags: ['D3', 'safety-coverage', 'audit-v2'],
    actionName: 'page.updateTitle',
    input: { pageId: 'page-001', title: 'Experiment notes' },
    expectedAudit: {
      actionName: 'page.updateTitle',
      status: 'ok',
      scopeIncludes: ['mutating'],
      sessionIdMatchesPattern: '^session-[a-z0-9-]+$',
      affectedEntities: [{ kind: 'page', id: 'page-001' }],
      expectStateMutated: true,
      beforeStateIncludes: {
        'page/page-001': { revision: 0, value: { title: 'Untitled' } },
      },
      afterStateIncludes: {
        'page/page-001': { revision: 1, value: { title: 'Experiment notes' } },
      },
    },
  },
  {
    id: 'structure-set-style-audit-v2',
    kind: 'audit',
    description:
      'structure.setStyle writes audit v2 before/after state, ui-bound scope, and affected structure entity.',
    mode: 'mock-llm',
    tags: ['D3', 'safety-coverage', 'audit-v2'],
    actionName: 'structure.setStyle',
    input: { structureId: 'structure-001', style: 'cartoon' },
    expectedAudit: {
      actionName: 'structure.setStyle',
      status: 'ok',
      scopeIncludes: ['mutating', 'ui-bound'],
      sessionIdMatchesPattern: '^session-[a-z0-9-]+$',
      affectedEntities: [{ kind: 'structure', id: 'structure-001' }],
      expectStateMutated: true,
      beforeStateIncludes: {
        'structure/structure-001': { revision: 0, value: { style: 'ball-stick' } },
      },
      afterStateIncludes: {
        'structure/structure-001': { revision: 1, value: { style: 'cartoon' } },
      },
    },
  },
  {
    id: 'sequence-rename-bad-input-audit-v2',
    kind: 'audit',
    description:
      'sequence.rename writes an error audit entry for a rejected write attempt without mutating state.',
    mode: 'mock-llm',
    tags: ['D3', 'safety-coverage', 'audit-v2', 'error-semantics'],
    actionName: 'sequence.rename',
    input: { sequenceId: 'plasmid-001', newName: '' },
    expectedAudit: {
      actionName: 'sequence.rename',
      status: 'error',
      scopeIncludes: ['mutating'],
      sessionIdMatchesPattern: '^session-[a-z0-9-]+$',
      affectedEntities: [],
      expectStateMutated: false,
      expectedError: { code: 'BAD_INPUT', messageContains: 'non-empty' },
    },
  },
];

registerEvalDescriptor(descriptors, () =>
  buildExampleEnvironment({
    sequences: { 'plasmid-001': { name: 'pUC19' } },
    designs: { 'design-001': { name: 'Golden Gate' } },
    pages: { 'page-001': { title: 'Untitled' } },
    structures: { 'structure-001': { style: 'ball-stick' } },
  })
);
