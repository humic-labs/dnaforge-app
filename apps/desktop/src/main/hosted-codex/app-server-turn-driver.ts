import type { CodexAppServerProtocol } from '@waypoint/codex-app-server-contract';
import { HOSTED_TOOL_DISPATCH_NAME } from '@waypoint/hosted-ai-contract';
import { resolveHostedToolDispatch } from './hosted-tool-discovery';

import {
  hostedCodexCanonicalToolName,
  hostedCodexToolWireName,
  hostedCodexWireInputSchema,
  type HostedCodexToolCatalog,
} from './dynamic-tool-catalog';
import type { IncomingServerRequest } from './app-server-supervisor';
import { HOSTED_CODEX_MODEL_PROVIDER_ID } from './app-server-config';
import type { ChildNotification, IncomingToolRequest, TurnDriver } from './turn-loop';

type ProtocolJson =
  | number
  | string
  | boolean
  | null
  | ProtocolJson[]
  | { [key: string]: ProtocolJson | undefined };

export type AppServerTurnDriverCode =
  | 'turn_already_started'
  | 'malformed_thread_start'
  | 'malformed_turn_start'
  | 'tool_output_not_json';

export class AppServerTurnDriverError extends Error {
  constructor(
    readonly code: AppServerTurnDriverCode,
    message: string
  ) {
    super(message);
    this.name = 'AppServerTurnDriverError';
  }
}

export interface AppServerTurnTransport {
  request(method: string, params?: unknown): Promise<unknown>;
  onNotification(listener: (notification: ChildNotification) => void): void;
  onServerRequest(listener: (request: IncomingServerRequest) => void): void;
  onExit(listener: () => void): void;
}

export interface AppServerTurnDriver extends TurnDriver {
  readonly threadId: string | null;
  readonly turnId: string | null;
  interrupt(): Promise<void>;
}

export function createAppServerTurnDriver(options: {
  readonly transport: AppServerTurnTransport;
  readonly model: string;
  readonly cwd: string;
  readonly catalog: HostedCodexToolCatalog;
  readonly offeredCatalog?: HostedCodexToolCatalog;
  readonly developerInstructions?: string;
  readonly priorConversationContext?: string | null;
}): AppServerTurnDriver {
  let threadId: string | null = null;
  let turnId: string | null = null;
  let notificationListener: ((notification: ChildNotification) => void) | null = null;
  let serverRequestListener: ((request: IncomingToolRequest) => void) | null = null;
  let exitListener: (() => void) | null = null;

  options.transport.onNotification((notification) => {
    if (process.env.HOSTED_E2E_DIAGNOSTICS === '1') {
      console.error('[HostedCodex] App Server notification:', {
        method: notification.method,
        ...notificationShape(notification.params),
      });
    }
    notificationListener?.(notification);
  });
  options.transport.onServerRequest((request) => {
    if (process.env.HOSTED_E2E_DIAGNOSTICS === '1') {
      console.error('[HostedCodex] App Server request:', {
        method: request.method,
        ...notificationShape(request.params),
      });
    }
    const listener = serverRequestListener;
    if (!listener) {
      request.refuse('the Hosted turn has no request handler');
      return;
    }
    if (request.method !== 'item/tool/call') {
      listener(request);
      return;
    }
    let params: unknown;
    try {
      params = canonicalToolRequestParams(
        request.params,
        options.catalog,
        options.offeredCatalog ?? options.catalog
      );
    } catch {
      request.respond(
        dynamicToolResponse(false, {
          error: 'The requested action or arguments are unavailable in this Hosted turn',
        })
      );
      return;
    }
    listener({
      method: request.method,
      params,
      respond: (result) => {
        if (process.env.HOSTED_E2E_DIAGNOSTICS === '1') {
          console.error('[HostedCodex] App Server tool response: success');
        }
        request.respond(dynamicToolResponse(true, result));
      },
      refuse: (message) => {
        if (process.env.HOSTED_E2E_DIAGNOSTICS === '1') {
          console.error('[HostedCodex] App Server tool response: refused');
        }
        request.respond(dynamicToolResponse(false, { error: message }));
      },
    });
  });
  options.transport.onExit(() => exitListener?.());

  return {
    get threadId() {
      return threadId;
    },
    get turnId() {
      return turnId;
    },
    onNotification: (listener) => {
      notificationListener = listener;
    },
    onServerRequest: (listener) => {
      serverRequestListener = listener;
    },
    onExit: (listener) => {
      exitListener = listener;
    },
    send: async (message) => {
      if (threadId !== null || turnId !== null) {
        throw new AppServerTurnDriverError(
          'turn_already_started',
          'one Hosted session may start only one App Server turn'
        );
      }

      const dynamicTools = (options.offeredCatalog ?? options.catalog).tools.map((tool) => ({
        type: 'function' as const,
        name: hostedCodexToolWireName(tool.name),
        description: tool.description,
        inputSchema: readProtocolJson(hostedCodexWireInputSchema(tool.inputSchema)),
        deferLoading: false,
      }));
      const threadParams = {
        model: options.model,
        modelProvider: HOSTED_CODEX_MODEL_PROVIDER_ID,
        allowProviderModelFallback: false,
        cwd: options.cwd,
        approvalPolicy: 'never' as const,
        sandbox: 'read-only' as const,
        ephemeral: true,
        ...(options.developerInstructions
          ? { developerInstructions: options.developerInstructions }
          : {}),
        dynamicTools,
      } satisfies CodexAppServerProtocol.v2.ThreadStartParams;
      const startedThread = await options.transport.request('thread/start', threadParams);
      threadId = readNestedId(startedThread, 'thread');
      if (threadId === null) {
        throw new AppServerTurnDriverError(
          'malformed_thread_start',
          'the App Server did not return a thread identity'
        );
      }

      const turnParams = {
        threadId,
        input: [{ type: 'text' as const, text: message, text_elements: [] }],
        ...(options.priorConversationContext
          ? {
              additionalContext: {
                dnaforgeConversationHistory: {
                  kind: 'application' as const,
                  value: options.priorConversationContext,
                },
              },
            }
          : {}),
      } satisfies CodexAppServerProtocol.v2.TurnStartParams;
      const startedTurn = await options.transport.request('turn/start', turnParams);
      turnId = readNestedId(startedTurn, 'turn');
      if (turnId === null) {
        throw new AppServerTurnDriverError(
          'malformed_turn_start',
          'the App Server did not return a turn identity'
        );
      }
    },
    interrupt: async () => {
      if (threadId === null || turnId === null) return;
      const params = { threadId, turnId } satisfies CodexAppServerProtocol.v2.TurnInterruptParams;
      await options.transport.request('turn/interrupt', params);
    },
  };
}

function notificationShape(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const turn =
    record.turn !== null && typeof record.turn === 'object' && !Array.isArray(record.turn)
      ? (record.turn as Record<string, unknown>)
      : null;
  const item =
    record.item !== null && typeof record.item === 'object' && !Array.isArray(record.item)
      ? (record.item as Record<string, unknown>)
      : null;
  return {
    ...(typeof record.callId === 'string' ? { callId: record.callId } : {}),
    ...(typeof record.tool === 'string' ? { tool: record.tool } : {}),
    ...(typeof turn?.status === 'string' ? { turnStatus: turn.status } : {}),
    ...(typeof item?.type === 'string' ? { itemType: item.type } : {}),
    ...(typeof item?.status === 'string' ? { itemStatus: item.status } : {}),
  };
}

function canonicalToolRequestParams(
  value: unknown,
  catalog: HostedCodexToolCatalog,
  offered: HostedCodexToolCatalog
): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const params = value as Record<string, unknown>;
  if (typeof params.tool !== 'string') return value;
  const canonical = hostedCodexCanonicalToolName(offered.tools, params.tool);
  if (canonical === HOSTED_TOOL_DISPATCH_NAME) {
    const resolved = resolveHostedToolDispatch(catalog, params.arguments);
    return { ...params, tool: resolved.tool.name, arguments: resolved.input };
  }
  return canonical === null ? value : { ...params, tool: canonical };
}

function readNestedId(value: unknown, key: 'thread' | 'turn'): string | null {
  if (value === null || typeof value !== 'object') return null;
  const nested = (value as Record<string, unknown>)[key];
  if (nested === null || typeof nested !== 'object') return null;
  const id = (nested as Record<string, unknown>).id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function dynamicToolResponse(
  success: boolean,
  value: unknown
): CodexAppServerProtocol.v2.DynamicToolCallResponse {
  return {
    success,
    contentItems: [{ type: 'inputText', text: encodeToolOutput(value) }],
  };
}

function encodeToolOutput(value: unknown): string {
  try {
    const encoded = JSON.stringify(value ?? null);
    if (encoded === undefined) throw new Error('not JSON');
    return encoded;
  } catch (cause) {
    throw new AppServerTurnDriverError(
      'tool_output_not_json',
      `the renderer tool returned a value the App Server cannot read: ${
        cause instanceof Error ? cause.message : 'not JSON'
      }`
    );
  }
}

function readProtocolJson(value: unknown, seen: Set<object> = new Set()): ProtocolJson {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new AppServerTurnDriverError('tool_output_not_json', 'tool schema contains a cycle');
    }
    seen.add(value);
    const result = value.map((entry) => readProtocolJson(entry, seen));
    seen.delete(value);
    return result;
  }
  if (typeof value === 'object') {
    if (seen.has(value)) {
      throw new AppServerTurnDriverError('tool_output_not_json', 'tool schema contains a cycle');
    }
    seen.add(value);
    const result: Record<string, ProtocolJson> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) result[key] = readProtocolJson(entry, seen);
    }
    seen.delete(value);
    return result;
  }
  throw new AppServerTurnDriverError(
    'tool_output_not_json',
    'tool schema contains a value outside JSON'
  );
}
