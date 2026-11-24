import { userMessage } from '@waypoint/user-messages';
import {
  publicAgentTraceDisplay,
  type PublicAgentTraceDisplay,
} from '../../shared/agent-trace-display';
import type { AgentTraceDisplayShape } from '../../shared/agent-runtime-ipc';
export type ProviderTraceTransport = 'codex-sdk' | 'claude-agent-sdk' | 'grok-acp';

export interface ProviderTraceVersionStamp {
  sdkVersion: string | null;
  cliVersion: string | null;
}

export type ProviderTraceDisplayKind =
  | 'assistant_text'
  | 'command'
  | 'error'
  | 'file_change'
  | 'lifecycle'
  | 'notification'
  | 'permission_denial'
  | 'reasoning'
  | 'result'
  | 'todo'
  | 'tool'
  | 'unknown'
  | 'web_search';

export type ProviderTraceDisplay = PublicAgentTraceDisplay;

export type ProviderTraceToolCallStatus = 'requested' | 'running' | 'completed' | 'failed';

export interface ProviderTraceToolCall {
  id: string;
  name: string;
  mcpServer?: string;
  status: ProviderTraceToolCallStatus;
  input?: unknown;
  output?: unknown;
}

export interface ProviderTraceEvent {
  transport: ProviderTraceTransport;
  sequence: number;
  receivedAt: string;
  providerEventType: string;
  providerItemType?: string;
  providerItemId?: string;
  raw: unknown;
  display: ProviderTraceDisplay;
  toolCalls?: ProviderTraceToolCall[];
  versions: ProviderTraceVersionStamp;
  terminal?: 'completed' | 'failed';
  diagnostic?: string;
}

export interface ProviderTraceAdapter {
  readonly transport: ProviderTraceTransport;
  adapt(raw: unknown, sequence?: number): ProviderTraceEvent;
  extractFinalText(events: ProviderTraceEvent[]): string;
}

const SECRET_KEY_PATTERN = /authorization|api[-_]?key|token|password|secret/i;
const SECRET_VALUE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/g,
  /\bsk-[A-Za-z0-9._-]+/g,
  /\bclaude-[A-Za-z0-9._-]+/g,
];
const MAX_DISPLAY_TEXT_CHARS = 2000;
const MAX_DISPLAY_STATUS_CHARS = 160;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function redactString(value: string): string {
  return SECRET_VALUE_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, '[REDACTED]'),
    value
  );
}

export function redactProviderSecrets<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => redactProviderSecrets(entry)) as T;
  }
  if (isRecord(value)) {
    const redacted: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      redacted[key] = SECRET_KEY_PATTERN.test(key) ? '[REDACTED]' : redactProviderSecrets(entry);
    }
    return redacted as T;
  }
  if (typeof value === 'string') {
    return redactString(value) as T;
  }
  return value;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function safeDisplayString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => {
        if (typeof entry === 'string') {
          return /\s/.test(entry) ? JSON.stringify(entry) : entry;
        }
        if (typeof entry === 'number' || typeof entry === 'boolean') return String(entry);
        return undefined;
      })
      .filter((entry): entry is string => Boolean(entry));
    return parts.length > 0 ? parts.join(' ') : undefined;
  }
  return undefined;
}

function capDisplayText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n[truncated]`;
}

function sanitizeDisplay(
  display: AgentTraceDisplayShape,
  toolCalls?: ProviderTraceToolCall[]
): ProviderTraceDisplay {
  return publicAgentTraceDisplay(
    {
      ...display,
      title: capDisplayText(redactString(display.title), MAX_DISPLAY_STATUS_CHARS),
      status: display.status
        ? capDisplayText(redactString(display.status), MAX_DISPLAY_STATUS_CHARS)
        : undefined,
      text: display.text
        ? capDisplayText(redactString(display.text), MAX_DISPLAY_TEXT_CHARS)
        : undefined,
    },
    toolCalls
  );
}

function normalized(value: string | undefined): string {
  return value?.toLowerCase().replace(/[-\s]/g, '_') ?? '';
}

function normalizedToolIdentity(
  value: string | undefined
): { name: string; mcpServer?: string } | undefined {
  if (!value) return undefined;
  if (!value.startsWith('mcp__')) return { name: value };
  const remainder = value.slice('mcp__'.length);
  const separatorIndex = remainder.indexOf('__');
  if (separatorIndex <= 0 || separatorIndex === remainder.length - 2) {
    return { name: value };
  }
  return {
    mcpServer: remainder.slice(0, separatorIndex),
    name: remainder.slice(separatorIndex + 2),
  };
}

function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value;
  if (typeof value !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizedToolStatus(value: unknown): ProviderTraceToolCallStatus {
  const status = typeof value === 'string' ? normalized(value) : '';
  if (
    status === 'completed' ||
    status === 'succeeded' ||
    status === 'success' ||
    status === 'done'
  ) {
    return 'completed';
  }
  if (
    status === 'failed' ||
    status === 'error' ||
    status === 'cancelled' ||
    status === 'canceled'
  ) {
    return 'failed';
  }
  if (
    status === 'running' ||
    status === 'in_progress' ||
    status === 'started' ||
    status === 'pending'
  ) {
    return 'running';
  }
  return 'requested';
}

function claudeRequestedToolCalls(raw: unknown): ProviderTraceToolCall[] {
  return contentBlocks(raw)
    .filter((block) => block.type === 'tool_use' || block.type === 'server_tool_use')
    .flatMap((block) => {
      const id = asString(block.id);
      const identity = normalizedToolIdentity(asString(block.name));
      if (!id || !identity) return [];
      return [
        {
          id,
          name: identity.name,
          ...(identity.mcpServer ? { mcpServer: identity.mcpServer } : {}),
          status: 'requested' as const,
          input: block.input,
        },
      ];
    });
}

type RequestedToolIdentity = Pick<ProviderTraceToolCall, 'name' | 'mcpServer'>;

function claudeCompletedToolCalls(
  raw: unknown,
  requestedByCallId: ReadonlyMap<string, RequestedToolIdentity>
): ProviderTraceToolCall[] {
  if (!isRecord(raw)) return [];
  const topLevelResult = isRecord(raw.tool_use_result) ? raw.tool_use_result : undefined;
  return contentBlocks(raw)
    .filter((block) => block.type === 'tool_result')
    .flatMap((block) => {
      const id = asString(block.tool_use_id);
      if (!id) return [];
      const requested = requestedByCallId.get(id);
      if (!requested) return [];
      const parsedContent = parseJsonObject(block.content);
      const structuredContent = topLevelResult?.structuredContent;
      const output = structuredContent ?? parsedContent ?? block.content;
      const outputRecord = isRecord(output) ? output : undefined;
      const isError = block.is_error === true;
      const reportedStatus = normalizedToolStatus(outputRecord?.status);
      const status = isError
        ? 'failed'
        : reportedStatus === 'requested'
          ? 'completed'
          : reportedStatus;
      return [
        {
          id,
          name: requested.name,
          ...(requested.mcpServer ? { mcpServer: requested.mcpServer } : {}),
          status,
          output,
        },
      ];
    });
}

function codexMcpToolCall(item: Record<string, unknown>): ProviderTraceToolCall | null {
  const id = asString(item.id);
  const name = asString(item.tool);
  const mcpServer = asString(item.server);
  if (!id || !name || !mcpServer) return null;
  const status = normalizedToolStatus(item.status);
  const rawInput = item.arguments ?? item.input;
  const rawOutput = item.result ?? item.output ?? item.error;
  const input = parseJsonObject(rawInput) ?? rawInput;
  const output = parseJsonObject(rawOutput) ?? rawOutput;
  return {
    id,
    name,
    mcpServer,
    status,
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
  };
}

function commandTitle(status: string | undefined): string {
  switch (normalized(status)) {
    case 'in_progress':
    case 'running':
    case 'started':
    case 'pending':
      return 'Running command';
    case 'completed':
    case 'succeeded':
    case 'success':
    case 'done':
      return 'Ran command';
    case 'failed':
    case 'error':
      return 'Command failed';
    case 'cancelled':
    case 'canceled':
    case 'stopped':
      return 'Command stopped';
    default:
      return 'Command';
  }
}

function fileChangeTitle(status: string | undefined): string {
  switch (normalized(status)) {
    case 'created':
    case 'added':
      return 'Created file';
    case 'deleted':
    case 'removed':
      return 'Deleted file';
    default:
      return 'Changed file';
  }
}

function fileChangeText(item: Record<string, unknown>): string | undefined {
  return asString(item.path) ?? asString(item.file) ?? asString(item.filename);
}

function toolDisplayText(server: string | undefined, tool: string | undefined): string | undefined {
  if (server && tool) return `${server}:${tool}`;
  return tool ?? server;
}

function eventType(raw: unknown): string {
  return isRecord(raw) ? (asString(raw.type) ?? 'unknown') : 'unknown';
}

function nestedErrorMessage(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return undefined;
  return asString(value.message) ?? nestedErrorMessage(value.error);
}

function codexErrorMessage(raw: unknown, item: Record<string, unknown> | null): string | undefined {
  return (
    asString(item?.message) ??
    (isRecord(raw) ? (asString(raw.message) ?? nestedErrorMessage(raw.error)) : undefined)
  );
}

function isCodexSkillsContextBudgetDiagnostic(message: string | undefined): boolean {
  if (!message) return false;
  return /^skill descriptions were shortened to fit the (?:skills )?context budget\.?(?:\s+codex can still see every skill, but some descriptions are shorter\.\s+disable unused skills or plugins to leave more room for the rest\.)?$/i.test(
    message.trim()
  );
}

function contentBlocks(raw: unknown): Array<Record<string, unknown>> {
  if (!isRecord(raw)) return [];
  const message = raw.message;
  if (!isRecord(message) || !Array.isArray(message.content)) return [];
  return message.content.filter(isRecord);
}

abstract class BaseTraceAdapter implements ProviderTraceAdapter {
  abstract readonly transport: ProviderTraceTransport;

  protected constructor(protected readonly versions: ProviderTraceVersionStamp) {}

  abstract adapt(raw: unknown, sequence?: number): ProviderTraceEvent;

  abstract extractFinalText(events: ProviderTraceEvent[]): string;

  protected event(
    raw: unknown,
    display: AgentTraceDisplayShape,
    sequence: number,
    providerEventType: string,
    extras: Partial<ProviderTraceEvent> = {}
  ): ProviderTraceEvent {
    const sanitizedExtras = extras.toolCalls
      ? { ...extras, toolCalls: redactProviderSecrets(extras.toolCalls) }
      : extras;
    const diagnostic =
      display.text && (display.kind === 'error' || extras.terminal === 'failed')
        ? capDisplayText(redactString(display.text), MAX_DISPLAY_TEXT_CHARS)
        : undefined;
    return {
      transport: this.transport,
      sequence,
      receivedAt: new Date().toISOString(),
      providerEventType,
      raw: redactProviderSecrets(raw),
      display: sanitizeDisplay(display, sanitizedExtras.toolCalls),
      versions: this.versions,
      ...(diagnostic ? { diagnostic } : {}),
      ...sanitizedExtras,
    };
  }
}

export class CodexTraceAdapter extends BaseTraceAdapter {
  readonly transport = 'codex-sdk' as const;
  private readonly requestedMcpToolsByCallId = new Map<string, RequestedToolIdentity>();

  constructor(versions: ProviderTraceVersionStamp) {
    super(versions);
  }

  adapt(raw: unknown, sequence = 0): ProviderTraceEvent {
    const type = eventType(raw);
    const item = isRecord(raw) && isRecord(raw.item) ? raw.item : null;
    const itemType = item ? asString(item.type) : undefined;

    if (itemType === 'command_execution') {
      const status = asString(item?.status);
      return this.event(
        raw,
        {
          kind: 'command',
          title: commandTitle(status),
          status,
          text: safeDisplayString(item?.command),
        },
        sequence,
        type,
        { providerItemType: itemType, providerItemId: asString(item?.id) }
      );
    }
    if (itemType === 'agent_message') {
      return this.event(
        raw,
        {
          kind: 'assistant_text',
          title: 'Assistant',
          text: asString(item?.text),
          visibility: 'diagnostic',
        },
        sequence,
        type,
        { providerItemType: itemType, providerItemId: asString(item?.id) }
      );
    }
    if (itemType === 'reasoning') {
      return this.event(
        raw,
        {
          kind: 'reasoning',
          title: 'Thinking',
          text: asString(item?.text),
        },
        sequence,
        type,
        { providerItemType: itemType, providerItemId: asString(item?.id) }
      );
    }
    if (itemType === 'file_change') {
      const status = asString(item?.status);
      return this.event(
        raw,
        {
          kind: 'file_change',
          title: fileChangeTitle(status),
          status,
          text: item ? fileChangeText(item) : undefined,
        },
        sequence,
        type,
        { providerItemType: itemType, providerItemId: asString(item?.id) }
      );
    }
    if (itemType === 'mcp_tool_call') {
      const server = asString(item?.server);
      const tool = asString(item?.tool);
      const isDnaForgeTool = normalized(server) === 'dnaforge';
      const parsedToolCall = item ? codexMcpToolCall(item) : null;
      let toolCall: ProviderTraceToolCall | null = null;
      if (parsedToolCall) {
        const isRequest =
          parsedToolCall.status === 'requested' || parsedToolCall.status === 'running';
        if (isRequest) {
          this.requestedMcpToolsByCallId.set(parsedToolCall.id, {
            name: parsedToolCall.name,
            mcpServer: parsedToolCall.mcpServer,
          });
          toolCall = parsedToolCall;
        } else {
          const requested = this.requestedMcpToolsByCallId.get(parsedToolCall.id);
          this.requestedMcpToolsByCallId.delete(parsedToolCall.id);
          if (
            requested?.name === parsedToolCall.name &&
            requested.mcpServer === parsedToolCall.mcpServer
          ) {
            toolCall = parsedToolCall;
          }
        }
      }
      return this.event(
        raw,
        {
          kind: 'tool',
          title: isDnaForgeTool ? 'Using DNAForge tool' : 'Using MCP tool',
          status: asString(item?.status),
          text: isDnaForgeTool ? tool : toolDisplayText(server, tool),
        },
        sequence,
        type,
        {
          providerItemType: itemType,
          providerItemId: asString(item?.id),
          ...(toolCall ? { toolCalls: [toolCall] } : {}),
        }
      );
    }
    if (itemType === 'web_search') {
      return this.event(
        raw,
        { kind: 'web_search', title: 'Searching web', text: asString(item?.query) },
        sequence,
        type,
        { providerItemType: itemType, providerItemId: asString(item?.id) }
      );
    }
    if (itemType === 'todo_list') {
      return this.event(
        raw,
        { kind: 'todo', title: 'Plan', text: asString(item?.text) },
        sequence,
        type,
        {
          providerItemType: itemType,
          providerItemId: asString(item?.id),
        }
      );
    }
    const errorMessage = codexErrorMessage(raw, item);
    if (
      itemType === 'error' &&
      type !== 'turn.failed' &&
      isCodexSkillsContextBudgetDiagnostic(errorMessage)
    ) {
      return this.event(
        raw,
        {
          kind: 'lifecycle',
          title: 'Skills context adjusted',
          text: errorMessage,
          visibility: 'diagnostic',
        },
        sequence,
        type,
        {
          providerItemType: itemType,
          providerItemId: asString(item?.id),
        }
      );
    }
    if (itemType === 'error' || type === 'error' || type === 'turn.failed') {
      return this.event(
        raw,
        { kind: 'error', title: 'Error', text: errorMessage },
        sequence,
        type,
        {
          providerItemType: itemType,
          providerItemId: asString(item?.id),
          terminal: type === 'turn.failed' ? 'failed' : undefined,
        }
      );
    }
    if (type === 'turn.completed') {
      return this.event(
        raw,
        { kind: 'result', title: 'Turn completed', visibility: 'diagnostic' },
        sequence,
        type,
        {
          terminal: 'completed',
        }
      );
    }
    if (type === 'thread.started' || type === 'turn.started') {
      return this.event(
        raw,
        { kind: 'lifecycle', title: type, visibility: 'diagnostic' },
        sequence,
        type
      );
    }

    return this.event(
      raw,
      { kind: 'unknown', title: type, visibility: 'diagnostic' },
      sequence,
      type,
      {
        providerItemType: itemType,
        providerItemId: item ? asString(item.id) : undefined,
      }
    );
  }

  extractFinalText(events: ProviderTraceEvent[]): string {
    const messages = new Map<string, string>();
    let anonymousIndex = 0;
    for (const event of events) {
      if (!isRecord(event.raw) || !isRecord(event.raw.item)) continue;
      const item = event.raw.item;
      if (item.type !== 'agent_message' || typeof item.text !== 'string') continue;
      const id = typeof item.id === 'string' ? item.id : `anonymous-${anonymousIndex++}`;
      messages.set(id, item.text);
    }
    return [...messages.values()].join('\n').trim();
  }
}

export class ClaudeTraceAdapter extends BaseTraceAdapter {
  readonly transport = 'claude-agent-sdk' as const;
  private readonly requestedToolsByCallId = new Map<string, RequestedToolIdentity>();

  constructor(versions: ProviderTraceVersionStamp) {
    super(versions);
  }

  adapt(raw: unknown, sequence = 0): ProviderTraceEvent {
    const type = eventType(raw);
    const subtype = isRecord(raw) ? asString(raw.subtype) : undefined;
    const providerEventType = subtype ? `${type}.${subtype}` : type;

    if (providerEventType === 'system.permission_denied' && isRecord(raw)) {
      const toolName = asString(raw.tool_name) ?? 'Tool';
      return this.event(
        raw,
        {
          kind: 'permission_denial',
          title: `${toolName} denied`,
          status: 'denied',
          text: asString(raw.message),
        },
        sequence,
        providerEventType
      );
    }

    if (type === 'assistant') {
      const blocks = contentBlocks(raw);
      const requestedToolCalls = claudeRequestedToolCalls(raw);
      for (const call of requestedToolCalls) {
        this.requestedToolsByCallId.set(call.id, {
          name: call.name,
          mcpServer: call.mcpServer,
        });
      }
      const toolNames = blocks
        .filter((block) => block.type === 'tool_use' || block.type === 'server_tool_use')
        .map((block) => asString(block.name))
        .filter(Boolean);
      const text = blocks
        .filter((block) => block.type === 'text')
        .map((block) => asString(block.text))
        .filter(Boolean)
        .join('\n');
      const hasReasoning = blocks.some(
        (block) => block.type === 'thinking' || block.type === 'redacted_thinking'
      );

      if (toolNames.length > 0) {
        if (toolNames.length === 1 && toolNames[0] === 'EnterPlanMode') {
          return this.event(
            raw,
            {
              kind: 'lifecycle',
              title: userMessage('assistant.trace.planMode'),
              status: 'entered',
            },
            sequence,
            providerEventType,
            requestedToolCalls.length > 0 ? { toolCalls: requestedToolCalls } : {}
          );
        }
        if (toolNames.length === 1 && toolNames[0] === 'ExitPlanMode') {
          const planInput = isRecord(requestedToolCalls[0]?.input)
            ? requestedToolCalls[0].input
            : undefined;
          const planText = asString(planInput?.plan) ?? asString(planInput?.content);
          return this.event(
            raw,
            { kind: 'todo', title: 'Proposed plan', status: 'awaiting decision', text: planText },
            sequence,
            providerEventType,
            requestedToolCalls.length > 0 ? { toolCalls: requestedToolCalls } : {}
          );
        }
        if (toolNames.length === 1 && toolNames[0] === 'PushNotification') {
          const notificationInput = isRecord(requestedToolCalls[0]?.input)
            ? requestedToolCalls[0].input
            : undefined;
          return this.event(
            raw,
            {
              kind: 'notification',
              title:
                asString(notificationInput?.title) ??
                asString(notificationInput?.subtitle) ??
                'Agent notification',
              text:
                asString(notificationInput?.message) ??
                asString(notificationInput?.body) ??
                asString(notificationInput?.text),
            },
            sequence,
            providerEventType,
            requestedToolCalls.length > 0 ? { toolCalls: requestedToolCalls } : {}
          );
        }
        return this.event(
          raw,
          {
            kind: 'tool',
            title: toolNames.length === 1 ? 'Using tool' : 'Using tools',
            status: 'requested',
            text: toolNames.join(', '),
          },
          sequence,
          providerEventType,
          requestedToolCalls.length > 0 ? { toolCalls: requestedToolCalls } : {}
        );
      }
      if (text) {
        return this.event(
          raw,
          { kind: 'assistant_text', title: 'Assistant', text, visibility: 'diagnostic' },
          sequence,
          providerEventType
        );
      }
      if (hasReasoning) {
        return this.event(
          raw,
          { kind: 'reasoning', title: 'Thinking' },
          sequence,
          providerEventType
        );
      }
    }

    if (type === 'user') {
      const completedToolCalls = claudeCompletedToolCalls(raw, this.requestedToolsByCallId);
      for (const call of completedToolCalls) {
        this.requestedToolsByCallId.delete(call.id);
      }
      if (completedToolCalls.length > 0) {
        const failed = completedToolCalls.some((call) => call.status === 'failed');
        return this.event(
          raw,
          {
            kind: 'tool',
            title: failed ? 'Tool failed' : 'Used DNAForge tool',
            status: failed ? 'failed' : 'completed',
            text: completedToolCalls.map((call) => call.name).join(', '),
          },
          sequence,
          providerEventType,
          { toolCalls: completedToolCalls }
        );
      }
    }

    if (type === 'result' && isRecord(raw)) {
      const completed = subtype === 'success' && raw.is_error !== true;
      return this.event(
        raw,
        {
          kind: 'result',
          title: userMessage(completed ? 'assistant.trace.completed' : 'assistant.trace.failed'),
          status: asString(raw.terminal_reason) ?? asString(raw.stop_reason),
          text: asString(raw.result),
          visibility: 'diagnostic',
        },
        sequence,
        providerEventType,
        { terminal: completed ? 'completed' : 'failed' }
      );
    }

    if (type === 'system') {
      return this.event(
        raw,
        { kind: 'lifecycle', title: providerEventType, visibility: 'diagnostic' },
        sequence,
        providerEventType
      );
    }

    return this.event(
      raw,
      { kind: 'unknown', title: providerEventType, visibility: 'diagnostic' },
      sequence,
      providerEventType
    );
  }

  extractFinalText(events: ProviderTraceEvent[]): string {
    const assistantText: string[] = [];
    const resultText: string[] = [];

    for (const event of events) {
      if (!isRecord(event.raw)) continue;
      if (event.raw.type === 'assistant') {
        for (const block of contentBlocks(event.raw)) {
          if (block.type === 'text' && typeof block.text === 'string') {
            assistantText.push(block.text);
          }
        }
      }
      if (
        event.raw.type === 'result' &&
        event.terminal !== 'failed' &&
        event.raw.is_error !== true &&
        typeof event.raw.result === 'string' &&
        event.raw.result.trim().length > 0
      ) {
        resultText.push(event.raw.result);
      }
    }

    return (resultText.length > 0 ? resultText : assistantText).join('\n').trim();
  }
}
