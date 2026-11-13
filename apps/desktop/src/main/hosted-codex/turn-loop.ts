import { isDynamicToolCallParams, PINNED_PROTOCOL_NOTIFICATIONS } from './app-server-protocol';
import { HOSTED_TOOL_DISCOVERY_NAME } from '@waypoint/hosted-ai-contract';
import { createHostedToolDiscovery } from './hosted-tool-discovery';
import type { HostedCodexToolCatalog } from './dynamic-tool-catalog';
import {
  dispatchToolCall,
  ToolDispatchError,
  type ToolApprover,
  type ToolExecutor,
} from './tool-dispatch';
import { TurnCoordinatorError, type TurnCoordinator, type TurnOutcome } from './turn-coordinator';
import type { HostedTurnFailureCode } from '../../shared/hosted-codex-ipc';
import {
  answerCodexRequestUserInput,
  type RequestAgentUserInput,
} from '../agent-sdk/agent-user-input-adapters';

export const PROGRESS_NOTIFICATIONS: ReadonlySet<string> = new Set(
  PINNED_PROTOCOL_NOTIFICATIONS.filter(
    (method) => method !== 'turn/completed' && method !== 'error'
  )
);

export const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;

export type TurnLoopCode =
  | 'refused'
  | 'unexpected_notification'
  | 'child_exited'
  | 'child_went_quiet';

export class TurnLoopError extends Error {
  constructor(
    readonly code: TurnLoopCode,
    message: string
  ) {
    super(message);
    this.name = 'TurnLoopError';
  }
}

export interface ChildNotification {
  readonly method: string;
  readonly params: unknown;
}

export interface IncomingToolRequest {
  readonly method: string;
  readonly params: unknown;
  respond(result: unknown): void;
  refuse(message: string): void;
}

export interface TurnDriver {
  send(message: string): Promise<void>;
  onNotification(listener: (notification: ChildNotification) => void): void;
  onServerRequest(listener: (request: IncomingToolRequest) => void): void;
  onExit(listener: () => void): void;
}

export interface HostedTurnResult {
  readonly outcome: TurnOutcome;
  readonly text: string;
  readonly failure?: HostedTurnFailure;
}

export type { HostedTurnFailureCode } from '../../shared/hosted-codex-ipc';

export interface HostedTurnFailure {
  readonly code: HostedTurnFailureCode;
  readonly httpStatusCode: number | null;
  readonly willRetry: boolean;
}

export interface RunHostedTurnOptions {
  readonly turn: TurnCoordinator;
  readonly driver: TurnDriver;
  readonly catalog: HostedCodexToolCatalog;
  readonly message: string;
  readonly execute: ToolExecutor;
  readonly approve: ToolApprover;
  readonly requestUserInput?: RequestAgentUserInput;
  readonly conversationId?: string | null;
  readonly signal?: AbortSignal;
  readonly onTextDelta?: (delta: string) => void;
  readonly onToolDiscovery?: (
    result: Awaited<ReturnType<ReturnType<typeof createHostedToolDiscovery>>>
  ) => void;
  readonly idleTimeoutMs?: number;
}

interface ToolCallParams {
  readonly callId: string;
  readonly name: string;
  readonly input: unknown;
}

export async function runHostedTurn(options: RunHostedTurnOptions): Promise<HostedTurnResult> {
  const { turn, driver } = options;
  const discoverTools = createHostedToolDiscovery(options.catalog);
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

  refuseThrough(() => turn.beginProviderStep());

  type SettledTurn = { readonly outcome: TurnOutcome; readonly failure?: HostedTurnFailure };
  let settle: ((result: SettledTurn | TurnLoopError) => void) | null = null;
  const ended = new Promise<SettledTurn | TurnLoopError>((resolve) => {
    settle = resolve;
  });
  const finish = (value: SettledTurn | TurnLoopError): void => {
    const resolve = settle;
    settle = null;
    resolve?.(value);
  };

  const pending: Promise<void>[] = [];
  let text = '';

  driver.onNotification((notification) => {
    if (settle === null) return;
    heardFromChild();
    switch (notification.method) {
      case 'turn/completed': {
        const terminal = readTerminalOutcome(notification.params);
        if (terminal === null) {
          finish(
            new TurnLoopError(
              'unexpected_notification',
              'the App Server sent turn/completed without a known terminal status'
            )
          );
          return;
        }
        const failure = terminal === 'failed' ? readTerminalFailure(notification.params) : null;
        finish({
          outcome: turn.stopRequested ? 'stopped' : terminal,
          ...(failure ? { failure } : {}),
        });
        return;
      }
      case 'error': {
        const failure = readErrorNotificationFailure(notification.params);
        if (failure?.willRetry) return;
        finish({
          outcome: 'failed',
          ...(failure ? { failure } : {}),
        });
        return;
      }
      case 'item/agentMessage/delta': {
        const delta = readTextDelta(notification.params);
        if (delta === null) {
          finish(
            new TurnLoopError(
              'unexpected_notification',
              'the App Server sent an agent-message delta without text'
            )
          );
          return;
        }
        text += delta;
        options.onTextDelta?.(delta);
        return;
      }
      default:
        if (PROGRESS_NOTIFICATIONS.has(notification.method)) return;
        finish(
          new TurnLoopError(
            'unexpected_notification',
            `the App Server sent "${notification.method}", which this build does not model`
          )
        );
    }
  });

  driver.onServerRequest((request) => {
    heardFromChild();
    if (settle === null) {
      request.refuse('the turn is over');
      return;
    }
    if (request.method === 'item/tool/requestUserInput') {
      if (!options.requestUserInput) {
        request.refuse('this Hosted turn has no question surface');
        return;
      }
      owed += 1;
      heardFromChild();
      const work = answerCodexRequestUserInput({
        params: request.params as Parameters<typeof answerCodexRequestUserInput>[0]['params'],
        conversationId: options.conversationId ?? null,
        signal: options.signal ?? new AbortController().signal,
        requestUserInput: options.requestUserInput,
        provider: 'hosted-codex',
      })
        .then((response) => request.respond(response))
        .catch((cause: unknown) =>
          request.refuse(cause instanceof Error ? cause.message : 'the question failed')
        )
        .finally(() => {
          owed -= 1;
          heardFromChild();
        });
      pending.push(work);
      return;
    }
    if (request.method !== 'item/tool/call') {
      request.refuse('this runtime does not answer that request');
      return;
    }
    if (!isDynamicToolCallParams(request.params)) {
      request.refuse('malformed tool call');
      return;
    }
    const params = request.params;
    owed += 1;
    heardFromChild();
    pending.push(
      handleToolCall(
        { callId: params.callId, name: params.tool, input: params.arguments },
        options,
        request,
        finish,
        discoverTools
      ).finally(() => {
        owed -= 1;
        heardFromChild();
      })
    );
  });

  driver.onExit(() => {
    if (settle === null) return;
    if (turn.stopRequested) {
      finish({ outcome: 'stopped' });
      return;
    }
    finish(
      new TurnLoopError(
        'child_exited',
        'the App Server stopped before reporting a terminal turn outcome'
      )
    );
  });

  let idle: ReturnType<typeof setTimeout> | null = null;
  let owed = 0;
  const heardFromChild = (): void => {
    if (settle === null) return;
    if (idle !== null) {
      clearTimeout(idle);
      idle = null;
    }
    if (owed > 0) return;
    idle = setTimeout(() => {
      finish(
        new TurnLoopError(
          'child_went_quiet',
          `the App Server said nothing for ${idleTimeoutMs}ms and the turn was abandoned`
        )
      );
    }, idleTimeoutMs);
    if (typeof idle === 'object' && 'unref' in idle) idle.unref();
  };
  heardFromChild();

  let settled: SettledTurn | TurnLoopError;
  try {
    await driver.send(options.message);
    settled = await ended;
  } finally {
    if (idle !== null) clearTimeout(idle);
  }

  await Promise.allSettled(pending);

  if (settled instanceof TurnLoopError) {
    refuseThrough(() => turn.finish('failed'));
    throw settled;
  }

  const finalOutcome = turn.stopRequested ? 'stopped' : settled.outcome;
  refuseThrough(() => turn.finish(finalOutcome));
  return {
    outcome: turn.outcome ?? finalOutcome,
    text,
    ...(settled.failure ? { failure: settled.failure } : {}),
  };
}

const STRING_FAILURE_CODES: Readonly<Record<string, HostedTurnFailureCode>> = Object.freeze({
  contextWindowExceeded: 'context_window_exceeded',
  sessionBudgetExceeded: 'session_budget_exceeded',
  usageLimitExceeded: 'usage_limit_exceeded',
  serverOverloaded: 'server_overloaded',
  cyberPolicy: 'policy_blocked',
  misalignmentPolicyViolation: 'policy_blocked',
  internalServerError: 'internal_server_error',
  unauthorized: 'unauthorized',
  badRequest: 'bad_request',
  threadRollbackFailed: 'thread_rollback_failed',
  sandboxError: 'sandbox_error',
  other: 'other',
});

const OBJECT_FAILURE_CODES: Readonly<Record<string, HostedTurnFailureCode>> = Object.freeze({
  httpConnectionFailed: 'http_connection_failed',
  responseStreamConnectionFailed: 'response_stream_connection_failed',
  responseStreamDisconnected: 'response_stream_disconnected',
  responseTooManyFailedAttempts: 'response_too_many_failed_attempts',
  activeTurnNotSteerable: 'active_turn_not_steerable',
});

function readCodexErrorInfo(value: unknown): {
  readonly code: HostedTurnFailureCode;
  readonly httpStatusCode: number | null;
} {
  if (typeof value === 'string') {
    return { code: STRING_FAILURE_CODES[value] ?? 'other', httpStatusCode: null };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { code: 'other', httpStatusCode: null };
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length !== 1) return { code: 'other', httpStatusCode: null };
  const [key, details] = entries[0] ?? [];
  const code = key ? OBJECT_FAILURE_CODES[key] : undefined;
  if (!code) return { code: 'other', httpStatusCode: null };
  const detailRecord =
    details && typeof details === 'object' && !Array.isArray(details)
      ? (details as Record<string, unknown>)
      : null;
  const status = detailRecord?.httpStatusCode;
  return {
    code,
    httpStatusCode:
      typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
        ? status
        : null,
  };
}

function readTurnError(value: unknown, willRetry: boolean): HostedTurnFailure | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const error = value as Record<string, unknown>;
  const typed = readCodexErrorInfo(error.codexErrorInfo);
  return { ...typed, willRetry };
}

function readErrorNotificationFailure(value: unknown): HostedTurnFailure | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const notification = value as Record<string, unknown>;
  return readTurnError(notification.error, notification.willRetry === true);
}

function readTerminalFailure(value: unknown): HostedTurnFailure | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const turn = (value as Record<string, unknown>).turn;
  if (!turn || typeof turn !== 'object' || Array.isArray(turn)) return null;
  return readTurnError((turn as Record<string, unknown>).error, false);
}

function readTerminalOutcome(value: unknown): TurnOutcome | null {
  if (value === null || typeof value !== 'object') return null;
  const turn = (value as Record<string, unknown>).turn;
  if (turn === null || typeof turn !== 'object') return null;
  switch ((turn as Record<string, unknown>).status) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'interrupted':
      return 'stopped';
    default:
      return null;
  }
}

function readTextDelta(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null;
  const delta = (value as Record<string, unknown>).delta;
  return typeof delta === 'string' ? delta : null;
}

async function handleToolCall(
  call: ToolCallParams,
  options: RunHostedTurnOptions,
  incoming: IncomingToolRequest,
  finish: (value: TurnLoopError) => void,
  discoverTools: ReturnType<typeof createHostedToolDiscovery>
): Promise<void> {
  if (call.name === HOSTED_TOOL_DISCOVERY_NAME) {
    if (options.turn.stopRequested || options.signal?.aborted) {
      incoming.refuse('stopped');
      return;
    }
    try {
      const result = await discoverTools(call.input, options.signal);
      if (options.turn.stopRequested || options.signal?.aborted) incoming.refuse('stopped');
      else {
        options.onToolDiscovery?.(result);
        incoming.respond(result);
      }
    } catch {
      incoming.refuse(
        options.turn.stopRequested || options.signal?.aborted
          ? 'stopped'
          : 'invalid_discovery_arguments'
      );
    }
    return;
  }
  const request = { callId: call.callId, name: call.name, input: call.input };
  try {
    const result = await dispatchToolCall(request, {
      catalog: options.catalog,
      turn: options.turn,
      execute: options.execute,
      approve: options.approve,
    });
    incoming.respond(result.output);
  } catch (cause) {
    if (cause instanceof ToolDispatchError || cause instanceof TurnCoordinatorError) {
      incoming.refuse(cause.code);
      return;
    }
    incoming.refuse('the tool call failed');
    finish(new TurnLoopError('refused', describe(cause)));
  }
}

function refuseThrough(action: () => void): void {
  try {
    action();
  } catch (cause) {
    if (cause instanceof TurnCoordinatorError) {
      throw new TurnLoopError('refused', `${cause.code}: ${cause.message}`);
    }
    throw cause;
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'the turn failed';
}
