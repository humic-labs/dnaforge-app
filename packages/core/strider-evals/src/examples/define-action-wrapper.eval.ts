import {
  defineAction,
  ActionError,
  notImplementedHandler,
  type DefinedAction,
} from '@waypoint/agent-tools';
import { z } from 'zod';
import type { ActionEvalDescriptor } from '../descriptor/action.ts';
import {
  InMemoryAuditSink,
  InMemoryProvenanceSink,
  InMemoryStore,
} from '../define-action-stub/in-memory.ts';
import type { ActionHandle } from '../define-action-stub/types.ts';
import { registerEvalDescriptor } from '../runner/register.ts';
import type { EvalEnvironment } from '../runner/types.ts';

const validateBasesAction = defineAction({
  name: 'sequence.validateBases',
  description: 'Validate a sequence payload and return its base count.',
  runtime: 'renderer',
  inputSchema: z.object({
    sequenceId: z.string().min(1),
    bases: z.string().regex(/^[ACGT]+$/),
  }),
  outputSchema: z.object({
    sequenceId: z.string(),
    length: z.number().int().nonnegative(),
  }),
  requiredCapabilities: ['sequence:write'],
  effects: ['mutating'],
  handler: (input) => ({
    sequenceId: input.sequenceId,
    length: input.bases.length,
  }),
});

const staleRevisionAction = defineAction({
  name: 'sequence.requireFreshRevision',
  description: 'Surface handler-thrown stale-state errors without rewriting them.',
  runtime: 'renderer',
  inputSchema: z.object({ sequenceId: z.string().min(1) }),
  requiredCapabilities: ['sequence:write'],
  effects: ['mutating'],
  handler: () => {
    throw new ActionError('STALE_STATE', 'live revision changed during handler execution', {
      details: { entity: 'sequence/plasmid-001' },
    });
  },
});

const plainThrowAction = defineAction({
  name: 'sequence.failPlainly',
  description: 'Map a plain handler throw onto EXECUTION_FAILED.',
  runtime: 'renderer',
  inputSchema: z.object({ sequenceId: z.string().min(1) }),
  requiredCapabilities: ['sequence:write'],
  effects: ['mutating'],
  handler: () => {
    throw new Error('polymerase crashed');
  },
});

const badOutputAction = defineAction({
  name: 'sequence.invalidOutput',
  description: 'Map output-schema mismatch onto EXECUTION_FAILED.',
  runtime: 'renderer',
  inputSchema: z.object({ sequenceId: z.string().min(1) }),
  outputSchema: z.object({
    sequenceId: z.string(),
    length: z.number(),
  }),
  requiredCapabilities: ['sequence:read'],
  effects: ['read-only'],
  handler: (input) =>
    ({
      sequenceId: input.sequenceId,
      length: 'not-a-number',
    }) as unknown as { sequenceId: string; length: number },
});

const measureDistanceAction = defineAction({
  name: 'structure.measureDistance',
  description: 'Descriptor exists before the sidecar implementation is wired.',
  runtime: 'sidecar',
  inputSchema: z.object({
    structureId: z.string().min(1),
    atomA: z.string().min(1),
    atomB: z.string().min(1),
  }),
  requiredCapabilities: ['structure:read'],
  effects: ['read-only'],
  handler: notImplementedHandler('structure.measureDistance sidecar handler is not wired'),
});

const success: ActionEvalDescriptor = {
  id: 'define-action-wrapper-success',
  kind: 'action',
  description: 'production defineAction accepts valid input and validates output shape.',
  mode: 'mock-llm',
  tags: ['B1', 'safety-coverage', 'wrapper', 'schema-validation'],
  actionName: 'sequence.validateBases',
  runtime: 'renderer',
  effects: ['mutating'],
  actionClass: 'modify',
  input: { sequenceId: 'seq-1', bases: 'ACGTACGT' },
  assertions: {
    success: { resultEquals: { sequenceId: 'seq-1', length: 8 } },
  },
};

const inputSchemaFailure: ActionEvalDescriptor = {
  id: 'define-action-wrapper-bad-input',
  kind: 'action',
  description: 'production defineAction maps input-schema failures to BAD_INPUT.',
  mode: 'mock-llm',
  tags: ['B1', 'safety-coverage', 'wrapper', 'schema-validation'],
  actionName: 'sequence.validateBases',
  runtime: 'renderer',
  effects: ['mutating'],
  actionClass: 'modify',
  input: { sequenceId: '', bases: 'ACGTN' },
  assertions: {
    failure: {
      code: 'BAD_INPUT',
      messageContains: 'Input failed schema validation',
      retriable: false,
    },
  },
};

const scopeDenied: ActionEvalDescriptor = {
  id: 'define-action-wrapper-scope-denied',
  kind: 'action',
  description: 'production defineAction rejects calls outside granted capabilities.',
  mode: 'mock-llm',
  tags: ['B1', 'safety-coverage', 'wrapper', 'scope-enforcement'],
  actionName: 'sequence.validateBases',
  runtime: 'renderer',
  effects: ['mutating'],
  actionClass: 'modify',
  input: { sequenceId: 'seq-1', bases: 'ACGT' },
  assertions: {
    failure: {
      code: 'SCOPE_DENIED',
      messageContains: 'requires capabilities',
      retriable: false,
    },
  },
};

const stalePassThrough: ActionEvalDescriptor = {
  id: 'define-action-wrapper-stale-state-pass-through',
  kind: 'action',
  description: 'production defineAction preserves handler-thrown STALE_STATE semantics.',
  mode: 'mock-llm',
  tags: ['B1', 'safety-coverage', 'wrapper', 'error-semantics'],
  actionName: 'sequence.requireFreshRevision',
  runtime: 'renderer',
  effects: ['mutating'],
  actionClass: 'modify',
  input: { sequenceId: 'plasmid-001' },
  assertions: {
    failure: {
      code: 'STALE_STATE',
      messageContains: 'live revision changed',
      retriable: true,
    },
  },
};

const executionFailure: ActionEvalDescriptor = {
  id: 'define-action-wrapper-execution-failed',
  kind: 'action',
  description: 'production defineAction maps plain handler throws to EXECUTION_FAILED.',
  mode: 'mock-llm',
  tags: ['B1', 'safety-coverage', 'wrapper', 'error-semantics'],
  actionName: 'sequence.failPlainly',
  runtime: 'renderer',
  effects: ['mutating'],
  actionClass: 'modify',
  input: { sequenceId: 'plasmid-001' },
  assertions: {
    failure: {
      code: 'EXECUTION_FAILED',
      messageContains: 'polymerase crashed',
      retriable: false,
    },
  },
};

const outputSchemaFailure: ActionEvalDescriptor = {
  id: 'define-action-wrapper-output-schema-failed',
  kind: 'action',
  description: 'production defineAction maps output-schema mismatches to EXECUTION_FAILED.',
  mode: 'mock-llm',
  tags: ['B1', 'safety-coverage', 'wrapper', 'schema-validation'],
  actionName: 'sequence.invalidOutput',
  runtime: 'renderer',
  effects: ['read-only'],
  actionClass: 'read',
  input: { sequenceId: 'seq-1' },
  assertions: {
    failure: {
      code: 'EXECUTION_FAILED',
      messageContains: 'Handler output failed schema validation',
      retriable: false,
    },
  },
};

const notImplemented: ActionEvalDescriptor = {
  id: 'define-action-wrapper-not-implemented',
  kind: 'action',
  description: 'production defineAction preserves NOT_IMPLEMENTED from placeholder handlers.',
  mode: 'mock-llm',
  tags: ['B1', 'safety-coverage', 'wrapper', 'error-semantics'],
  actionName: 'structure.measureDistance',
  runtime: 'sidecar',
  effects: ['read-only'],
  actionClass: 'read',
  input: { structureId: '1abc', atomA: 'A:10:CA', atomB: 'A:42:CA' },
  assertions: {
    failure: {
      code: 'NOT_IMPLEMENTED',
      messageContains: 'not wired',
      retriable: false,
    },
  },
};

registerEvalDescriptor(
  [
    success,
    inputSchemaFailure,
    stalePassThrough,
    executionFailure,
    outputSchemaFailure,
    notImplemented,
  ],
  () => buildWrapperEnvironment(['sequence:read', 'sequence:write', 'structure:read'])
);

registerEvalDescriptor(scopeDenied, () => buildWrapperEnvironment(['sequence:read']));

function buildWrapperEnvironment(grantedCapabilities: readonly string[]): EvalEnvironment {
  const registry = new Map<string, ActionHandle<unknown, unknown>>();
  for (const action of [
    validateBasesAction,
    staleRevisionAction,
    plainThrowAction,
    badOutputAction,
    measureDistanceAction,
  ]) {
    registry.set(
      action.descriptor.name,
      adaptProductionAction(
        action as unknown as DefinedAction<unknown, unknown>,
        grantedCapabilities
      )
    );
  }

  return {
    store: new InMemoryStore(),
    audit: new InMemoryAuditSink(),
    provenance: new InMemoryProvenanceSink(),
    resolveAction: (name) => registry.get(name),
  };
}

function adaptProductionAction<TInput, TOutput>(
  action: DefinedAction<TInput, TOutput>,
  grantedCapabilities: readonly string[]
): ActionHandle<unknown, unknown> {
  return (raw, options) =>
    action.invoke(raw, {
      actionId: options.sessionId,
      grantedCapabilities,
    });
}
