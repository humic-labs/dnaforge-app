import type { ActionEvalDescriptor } from '../descriptor/action.ts';
import { registerEvalDescriptor } from '../runner/register.ts';
import { buildExampleEnvironment } from './test-environment.ts';

const happyPath: ActionEvalDescriptor = {
  id: 'sequence-rename-success',
  kind: 'action',
  description: 'sequence.rename returns ok=true with the renamed sequence + bumped revision.',
  mode: 'mock-llm',
  tags: ['B1', 'action-shape'],
  actionName: 'sequence.rename',
  runtime: 'renderer',
  effects: ['mutating'],
  actionClass: 'modify',
  input: { sequenceId: 'plasmid-001', newName: 'pUC19-fixed' },
  assertions: {
    success: {
      resultEquals: { sequenceId: 'plasmid-001', name: 'pUC19-fixed', revision: 1 },
    },
  },
};

const invalidInput: ActionEvalDescriptor = {
  id: 'sequence-rename-bad-input',
  kind: 'action',
  description: 'sequence.rename rejects empty newName with BAD_INPUT.',
  mode: 'mock-llm',
  tags: ['B1', 'error-handling'],
  actionName: 'sequence.rename',
  runtime: 'renderer',
  effects: ['mutating'],
  actionClass: 'modify',
  input: { sequenceId: 'plasmid-001', newName: '' },
  assertions: {
    failure: { code: 'BAD_INPUT', messageContains: 'non-empty' },
  },
};

registerEvalDescriptor([happyPath, invalidInput], () =>
  buildExampleEnvironment({
    sequences: { 'plasmid-001': { name: 'pUC19' } },
  })
);
