import { createHash } from 'node:crypto';

import {
  DENIED_NATIVE_TOOL_NAMES,
  type HostedCodexTool,
  type HostedCodexToolCatalog,
} from './dynamic-tool-catalog';
import {
  TurnCoordinatorError,
  type EffectResolution,
  type TurnCoordinator,
} from './turn-coordinator';

export type ToolDispatchCode =
  | 'unknown_tool'
  | 'denied_native_tool'
  | 'declined'
  | 'execution_failed'
  | 'replayed_call'
  | 'outcome_unknown'
  | 'budget_exhausted'
  | 'refused';

export class ToolDispatchError extends Error {
  constructor(
    readonly code: ToolDispatchCode,
    message: string
  ) {
    super(message);
    this.name = 'ToolDispatchError';
  }
}

export interface ToolCallRequest {
  readonly callId: string;
  readonly name: string;
  readonly input: unknown;
}

export interface ToolExecutionResult {
  readonly outcome: EffectResolution;
  readonly output: unknown;
}

export type ToolExecutor = (
  tool: HostedCodexTool,
  request: ToolCallRequest
) => Promise<ToolExecutionResult>;

export type ToolApprover = (
  tool: HostedCodexTool,
  request: ToolCallRequest
) => Promise<'approved' | 'declined'>;

export interface ToolDispatchOptions {
  readonly catalog: HostedCodexToolCatalog;
  readonly turn: TurnCoordinator;
  readonly execute: ToolExecutor;
  readonly approve: ToolApprover;
  readonly unresolvedFromRecovery?: readonly string[];
}

const completed = new WeakMap<
  TurnCoordinator,
  Map<string, { digest: string; result: ToolExecutionResult }>
>();

function callDigest(request: ToolCallRequest): string {
  return createHash('sha256')
    .update(canonicalJson({ name: request.name, input: request.input }), 'utf8')
    .digest('hex');
}

export async function dispatchToolCall(
  request: ToolCallRequest,
  options: ToolDispatchOptions
): Promise<ToolExecutionResult> {
  const { catalog, turn } = options;

  if (DENIED_NATIVE_TOOL_NAMES.has(request.name)) {
    throw new ToolDispatchError(
      'denied_native_tool',
      `"${request.name}" is a Codex-native capability and is never dispatched`
    );
  }

  const tool = catalog.tools.find((candidate) => candidate.name === request.name);
  if (!tool) {
    throw new ToolDispatchError(
      'unknown_tool',
      `"${request.name}" is not in this turn's tool catalog`
    );
  }

  if (options.unresolvedFromRecovery?.includes(request.callId)) {
    throw new ToolDispatchError(
      'outcome_unknown',
      `tool call "${request.callId}" was already in flight and its outcome is unknown`
    );
  }

  const seen = completed.get(turn) ?? new Map();
  completed.set(turn, seen);
  const digest = callDigest(request);
  const previous = seen.get(request.callId);
  if (previous) {
    if (previous.digest !== digest) {
      throw new ToolDispatchError(
        'replayed_call',
        `tool call "${request.callId}" was already used for a different request`
      );
    }
    return previous.result;
  }

  const mutating = tool.effects.includes('mutating');

  if (!mutating) {
    const decision = await options.approve(tool, request);
    if (decision === 'declined') {
      throw new ToolDispatchError('declined', `the tool requested by "${tool.name}" was declined`);
    }
  }

  const result = await (mutating
    ? dispatchMutating(tool, request, options)
    : dispatchReadOnly(tool, request, options));

  seen.set(request.callId, { digest, result });
  return result;
}

async function dispatchReadOnly(
  tool: HostedCodexTool,
  request: ToolCallRequest,
  options: ToolDispatchOptions
): Promise<ToolExecutionResult> {
  charge(() => options.turn.chargeToolCall());
  try {
    return await options.execute(tool, request);
  } catch (cause) {
    throw new ToolDispatchError('execution_failed', describe(cause));
  }
}

async function dispatchMutating(
  tool: HostedCodexTool,
  request: ToolCallRequest,
  options: ToolDispatchOptions
): Promise<ToolExecutionResult> {
  const { turn } = options;
  charge(() => turn.chargeToolCall());
  charge(() => turn.beginApproval(request.callId));

  const decision = await options.approve(tool, request);
  charge(() => turn.settleApproval(request.callId, decision));
  if (decision === 'declined') {
    throw new ToolDispatchError('declined', `the change requested by "${tool.name}" was declined`);
  }

  charge(() => turn.beginEffect(request.callId));

  let result: ToolExecutionResult;
  let failure: unknown = null;
  try {
    result = await options.execute(tool, request);
  } catch (cause) {
    failure = cause;
    result = { outcome: 'outcome_unknown', output: null };
  }

  charge(() => turn.resolveEffect(request.callId, result.outcome));
  charge(() => turn.beginObservation(request.callId));
  charge(() => turn.completeObservation(request.callId));

  if (failure !== null) throw new ToolDispatchError('execution_failed', describe(failure));
  return result;
}

function charge(action: () => void): void {
  try {
    action();
  } catch (cause) {
    if (cause instanceof TurnCoordinatorError) {
      throw new ToolDispatchError(
        cause.code === 'budget_exhausted' ? 'budget_exhausted' : 'refused',
        cause.message
      );
    }
    throw cause;
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'the tool execution failed';
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
}
