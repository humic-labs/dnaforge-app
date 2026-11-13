import { z } from 'zod';

import { ActionError, ActionErrorPayload, isActionError } from './errors';
import { assertValidActionName } from './naming';
import { missingRequiredCapabilities } from './capability-policy';
export { WILDCARD_CAPABILITY } from './capability-policy';

export type ActionRuntime = 'renderer' | 'sidecar';

export type ActionEffect = 'read-only' | 'mutating' | 'ui-bound' | 'external-submit';

const VALID_EFFECTS: ReadonlySet<ActionEffect> = new Set<ActionEffect>([
  'read-only',
  'mutating',
  'ui-bound',
  'external-submit',
]);

const MAX_ISSUES_IN_DETAILS = 50;

export interface ActionDescriptor<TInput = unknown, TOutput = unknown> {
  readonly name: string;

  readonly qualifiedName: string;
  readonly domain: string;
  readonly verb: string;

  readonly version: number;

  readonly description: string;
  readonly runtime: ActionRuntime;
  readonly inputSchema: z.ZodType<TInput>;
  readonly outputSchema?: z.ZodType<TOutput>;
  readonly requiredCapabilities: readonly string[];
  readonly effects: readonly ActionEffect[];
  readonly requiresWorkspace: boolean;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ActionInvocationContext {
  readonly actionId: string;
  readonly grantedCapabilities: readonly string[];
  readonly abortSignal?: AbortSignal;
}

export type ActionHandler<TInput, TOutput> = (
  input: TInput,
  ctx: ActionInvocationContext
) => Promise<TOutput> | TOutput;

export type ActionResult<TOutput> =
  | { ok: true; result: TOutput }
  | { ok: false; error: ActionErrorPayload };

export interface DefinedAction<TInput, TOutput> {
  readonly descriptor: ActionDescriptor<TInput, TOutput>;
  invoke(rawInput: unknown, ctx: ActionInvocationContext): Promise<ActionResult<TOutput>>;
}

export interface DefineActionOptions<TInputSchema extends z.ZodType, TOutput> {
  name: string;
  description: string;
  runtime: ActionRuntime;
  inputSchema: TInputSchema;
  outputSchema?: z.ZodType<TOutput>;
  requiredCapabilities?: readonly string[];
  effects: readonly ActionEffect[];
  requiresWorkspace?: boolean;
  metadata?: Readonly<Record<string, unknown>>;
  timeoutMs?: number;
  handler: ActionHandler<z.infer<TInputSchema>, TOutput>;
}

export function defineAction<TInputSchema extends z.ZodType, TOutput>(
  opts: DefineActionOptions<TInputSchema, TOutput>
): DefinedAction<z.infer<TInputSchema>, TOutput> {
  const where = `defineAction(${JSON.stringify(opts.name)})`;
  if (typeof opts.description !== 'string' || opts.description.trim().length === 0) {
    throw new Error(`${where}: description is required.`);
  }
  if (opts.runtime !== 'renderer' && opts.runtime !== 'sidecar') {
    throw new Error(
      `${where}: runtime must be "renderer" or "sidecar" (got ${JSON.stringify(opts.runtime)}).`
    );
  }
  if (!opts.inputSchema) {
    throw new Error(`${where}: inputSchema is required.`);
  }
  if (typeof opts.handler !== 'function') {
    throw new Error(`${where}: handler is required.`);
  }
  if (opts.timeoutMs !== undefined) {
    if (
      typeof opts.timeoutMs !== 'number' ||
      !Number.isFinite(opts.timeoutMs) ||
      opts.timeoutMs < 0
    ) {
      throw new Error(
        `${where}: timeoutMs must be a non-negative finite number (got ${JSON.stringify(opts.timeoutMs)}).`
      );
    }
  }
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : undefined;

  const parsed = assertValidActionName(opts.name);

  const requiredCapabilities = normalizeRequiredCapabilities(opts.requiredCapabilities, where);
  const effects = normalizeEffects(opts.effects, where);

  const descriptor: ActionDescriptor<z.infer<TInputSchema>, TOutput> = Object.freeze({
    name: opts.name,
    qualifiedName: parsed.qualifiedName,
    domain: parsed.domain,
    verb: parsed.verb,
    version: parsed.version,
    description: opts.description,
    runtime: opts.runtime,
    inputSchema: opts.inputSchema as z.ZodType<z.infer<TInputSchema>>,
    outputSchema: opts.outputSchema,
    requiredCapabilities,
    effects,
    requiresWorkspace: opts.requiresWorkspace ?? false,
    metadata: deepFreeze({ ...(opts.metadata ?? {}) }) as Readonly<Record<string, unknown>>,
  });

  const handler = opts.handler;

  const defined: DefinedAction<z.infer<TInputSchema>, TOutput> = {
    descriptor,
    async invoke(rawInput, ctx): Promise<ActionResult<TOutput>> {
      const grantedCapabilities = normalizeGrantedCapabilities(ctx.grantedCapabilities);

      const missing = missingRequiredCapabilities(
        grantedCapabilities,
        descriptor.requiredCapabilities
      );
      if (missing.length > 0) {
        return {
          ok: false,
          error: new ActionError(
            'SCOPE_DENIED',
            `Action "${descriptor.name}" requires capabilities not in the grant: ${missing.join(', ')}.`,
            {
              details: {
                required: [...descriptor.requiredCapabilities],
                missing,
              },
            }
          ).toPayload(),
        };
      }

      const parsedInput = safeParseSync(descriptor.inputSchema, rawInput);
      if (!parsedInput.success) {
        const message = parsedInput.asyncSchema
          ? `Input schema for "${descriptor.name}" requires async resolution; defineAction handlers must use synchronous schemas.`
          : `Input failed schema validation for "${descriptor.name}".`;
        return {
          ok: false,
          error: new ActionError('BAD_INPUT', message, {
            details: parsedInput.asyncSchema
              ? { reason: 'async-schema-not-supported' }
              : formatIssues(parsedInput.issues),
          }).toPayload(),
        };
      }

      const timeoutController = timeoutMs !== undefined ? new AbortController() : undefined;
      const handlerSignal = combineAbortSignals([ctx.abortSignal, timeoutController?.signal]);
      if (handlerSignal?.aborted) {
        return {
          ok: false,
          error: new ActionError(
            'EXECUTION_FAILED',
            `Action "${descriptor.name}" was aborted before execution.`,
            {
              retriable: true,
              details: { reason: 'aborted-before-execution' },
            }
          ).toPayload(),
        };
      }

      const safeCtx: ActionInvocationContext = Object.freeze({
        actionId: ctx.actionId,
        grantedCapabilities: Object.freeze([...grantedCapabilities]),
        abortSignal: handlerSignal,
      });

      let output: TOutput;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timeoutFired = false;
      try {
        if (timeoutMs !== undefined && timeoutController) {
          const handlerPromise = (async () => handler(parsedInput.data, safeCtx))();
          const timeoutPromise = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              timeoutFired = true;
              timeoutController.abort();
              reject(
                new ActionError(
                  'EXECUTION_FAILED',
                  `Action "${descriptor.name}" timed out after ${timeoutMs}ms.`,
                  { details: { reason: 'timeout', timeoutMs } }
                )
              );
            }, timeoutMs);
          });
          output = await Promise.race([handlerPromise, timeoutPromise]);
        } else {
          output = await handler(parsedInput.data, safeCtx);
        }
      } catch (err) {
        if (isActionError(err)) {
          const payload = err.toPayload();
          if (ctx.abortSignal?.aborted === true && !timeoutFired) {
            payload.details = { ...(payload.details ?? {}), aborted: true };
          }
          return { ok: false, error: payload };
        }
        const aborted = ctx.abortSignal?.aborted === true;
        return {
          ok: false,
          error: new ActionError(
            'EXECUTION_FAILED',
            err instanceof Error ? err.message : String(err),
            {
              cause: err,
              retriable: aborted,
              ...(aborted ? { details: { reason: 'aborted-during-execution' } } : {}),
            }
          ).toPayload(),
        };
      } finally {
        if (timer) clearTimeout(timer);
      }

      if (descriptor.outputSchema) {
        const parsedOutput = safeParseSync(descriptor.outputSchema, output);
        if (!parsedOutput.success) {
          const reason = parsedOutput.asyncSchema
            ? 'output-schema-async-not-supported'
            : 'output-schema-mismatch';
          const issuesField = parsedOutput.asyncSchema ? {} : formatIssues(parsedOutput.issues);
          return {
            ok: false,
            error: new ActionError(
              'EXECUTION_FAILED',
              `Handler output failed schema validation for "${descriptor.name}".`,
              {
                details: { reason, ...issuesField },
              }
            ).toPayload(),
          };
        }
        return { ok: true, result: parsedOutput.data };
      }

      return { ok: true, result: output };
    },
  };
  return Object.freeze(defined);
}

export function notImplementedHandler<TInput, TOutput>(
  message?: string
): ActionHandler<TInput, TOutput> {
  return () => {
    throw new ActionError('NOT_IMPLEMENTED', message ?? 'Action handler not yet implemented.');
  };
}

function combineAbortSignals(
  signals: readonly (AbortSignal | undefined)[]
): AbortSignal | undefined {
  const real = signals.filter((s): s is AbortSignal => s !== undefined);
  if (real.length === 0) return undefined;
  if (real.length === 1) return real[0];
  const controller = new AbortController();
  for (const sig of real) {
    if (sig.aborted) {
      controller.abort(sig.reason);
      return controller.signal;
    }
  }
  for (const sig of real) {
    sig.addEventListener(
      'abort',
      () => {
        if (!controller.signal.aborted) controller.abort(sig.reason);
      },
      { once: true }
    );
  }
  return controller.signal;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value as object)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function normalizeGrantedCapabilities(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

function normalizeRequiredCapabilities(
  value: readonly string[] | undefined,
  where: string
): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) {
    throw new Error(`${where}: requiredCapabilities must be an array of strings.`);
  }
  const cleaned: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new Error(
        `${where}: requiredCapabilities contained a non-string or empty entry ` +
          `(${JSON.stringify(entry)}). Sparse-array holes and undefined entries are ` +
          `rejected so SCOPE_DENIED can't be tricked.`
      );
    }
    cleaned.push(entry);
  }
  return Object.freeze(cleaned);
}

function normalizeEffects(
  value: readonly ActionEffect[] | undefined,
  where: string
): readonly ActionEffect[] {
  if (value === undefined) {
    throw new Error(
      `${where}: effects is required (one of: ${[...VALID_EFFECTS].join(', ')}). ` +
        `There is no safe default — a write action whose author forgot the field ` +
        `would be silently labeled read-only and bypass audit/confirmation gates.`
    );
  }
  if (!Array.isArray(value)) {
    throw new Error(`${where}: effects must be an array.`);
  }
  if (value.length === 0) {
    throw new Error(
      `${where}: effects must list at least one of: ${[...VALID_EFFECTS].join(', ')}. ` +
        `An empty array is not "read-only by default" — declare it explicitly.`
    );
  }
  const cleaned: ActionEffect[] = [];
  for (const entry of value) {
    if (!VALID_EFFECTS.has(entry)) {
      throw new Error(
        `${where}: effects contained an unknown entry ${JSON.stringify(entry)}. ` +
          `Must be one of: ${[...VALID_EFFECTS].join(', ')}.`
      );
    }
    cleaned.push(entry);
  }
  return Object.freeze(cleaned);
}

interface FormattedZodIssue {
  path: string;
  code: string;
  message: string;
}

function formatZodIssue(issue: z.ZodIssue): FormattedZodIssue {
  return {
    path: issue.path.map((segment) => String(segment)).join('.'),
    code: issue.code,
    message: issue.message,
  };
}

function formatIssues(issues: readonly z.ZodIssue[]): Record<string, unknown> {
  if (issues.length <= MAX_ISSUES_IN_DETAILS) {
    return { issues: issues.map(formatZodIssue) };
  }
  return {
    issues: issues.slice(0, MAX_ISSUES_IN_DETAILS).map(formatZodIssue),
    truncatedIssueCount: issues.length - MAX_ISSUES_IN_DETAILS,
  };
}

function safeParseSync<T>(
  schema: z.ZodType<T>,
  value: unknown
):
  | { success: true; data: T }
  | { success: false; issues: readonly z.ZodIssue[]; asyncSchema: boolean } {
  try {
    const parsed = schema.safeParse(value);
    if (parsed.success) return { success: true, data: parsed.data };
    return { success: false, issues: parsed.error.issues, asyncSchema: false };
  } catch {
    return { success: false, issues: [], asyncSchema: true };
  }
}
