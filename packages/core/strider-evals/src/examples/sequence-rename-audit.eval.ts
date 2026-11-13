import type { AuditEvalDescriptor } from '../descriptor/audit.ts';
import { registerEvalDescriptor } from '../runner/register.ts';
import { buildExampleEnvironment } from './test-environment.ts';

const descriptor: AuditEvalDescriptor = {
  id: 'sequence-rename-audit-v2',
  kind: 'audit',
  description:
    'sequence.rename writes an audit entry with before/after state, session id, scope, and affected entity (audit v2 — codex BLOCKER 6).',
  mode: 'mock-llm',
  tags: ['B1', 'D3', 'audit-v2'],
  actionName: 'sequence.rename',
  input: { sequenceId: 'plasmid-001', newName: 'pUC19-fixed' },
  expectedAudit: {
    actionName: 'sequence.rename',
    status: 'ok',
    scopeIncludes: ['mutating'],
    sessionIdMatchesPattern: '^session-[a-z0-9-]+$',
    affectedEntities: [{ kind: 'sequence', id: 'plasmid-001' }],
    expectStateMutated: true,
  },
};

registerEvalDescriptor(descriptor, () =>
  buildExampleEnvironment({
    sequences: { 'plasmid-001': { name: 'pUC19' } },
  })
);
