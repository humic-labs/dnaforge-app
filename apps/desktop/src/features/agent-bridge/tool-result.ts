import { tool, type Tool, type ToolExecutionOptions } from 'ai';
import { isUserMessagePayload, type UserMessagePayload } from '@waypoint/user-messages';

export type ToolStateChange = boolean | 'unknown';
export type ToolPartialEffect = string | Readonly<Record<string, unknown>>;

export interface ToolFailure {
  readonly ok: false;
  readonly code: string;
  readonly error: string;
  readonly retriable: boolean;
  readonly stateChanged: ToolStateChange;
  readonly partialEffects: readonly ToolPartialEffect[];
  readonly details?: Readonly<Record<string, unknown>>;
  readonly userMessagePayload?: UserMessagePayload;
}

export type ToolOperationResult = { readonly ok: true } | ToolFailure;
export type ResultTool<INPUT, OUTPUT extends ToolOperationResult> = Tool<INPUT, OUTPUT> & {
  readonly resultContract: 'explicit-v1';
};

export function toolSuccess<T extends Record<string, unknown>>(data: T): T & { ok: true } {
  return { ...data, ok: true };
}

export function toolFailure(failure: Omit<ToolFailure, 'ok'>): ToolFailure {
  return { ...failure, ok: false };
}

class InvalidToolResultError extends Error {
  readonly code = 'INVALID_TOOL_RESULT';
  readonly retriable = false;
  readonly details = { stateChanged: 'unknown', stateMayHaveChanged: true };

  constructor() {
    super('Tool returned an invalid operation result; its effects are unknown.');
  }
}

export function assertToolOperationResult(value: unknown): asserts value is ToolOperationResult {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new InvalidToolResultError();
  const result = value as Record<string, unknown>;
  if (result.ok === true) return;
  if (
    result.ok !== false ||
    typeof result.code !== 'string' ||
    !result.code.trim() ||
    typeof result.error !== 'string' ||
    !result.error.trim() ||
    typeof result.retriable !== 'boolean' ||
    !(typeof result.stateChanged === 'boolean' || result.stateChanged === 'unknown') ||
    !Array.isArray(result.partialEffects) ||
    !result.partialEffects.every(
      (effect) =>
        typeof effect === 'string' ||
        (effect !== null && typeof effect === 'object' && !Array.isArray(effect))
    ) ||
    (result.userMessagePayload !== undefined && !isUserMessagePayload(result.userMessagePayload)) ||
    (result.details !== undefined &&
      (!result.details || typeof result.details !== 'object' || Array.isArray(result.details)))
  )
    throw new InvalidToolResultError();
}

export function resultTool<INPUT, OUTPUT extends ToolOperationResult>(
  definition: Tool<INPUT, OUTPUT> & {
    execute: (input: INPUT, options: ToolExecutionOptions) => Promise<OUTPUT>;
  }
): ResultTool<INPUT, OUTPUT> {
  return Object.assign(
    tool<INPUT, OUTPUT>(
      Object.assign({}, definition, {
        execute: async (input: INPUT, options: ToolExecutionOptions): Promise<OUTPUT> => {
          const result = await definition.execute(input, options);
          assertToolOperationResult(result);
          return result;
        },
      })
    ),
    { resultContract: 'explicit-v1' as const }
  );
}
