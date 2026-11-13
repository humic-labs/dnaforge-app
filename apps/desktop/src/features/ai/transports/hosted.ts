import type { DBChatTurnStatus } from '../../../db';

export interface HostedToolResultPart {
  type: 'tool-result' | 'tool-error';
  toolCallId: string;
  toolName: string;
  input: unknown;
  output?: unknown;
  error?: unknown;
}

type HostedStreamPart = Record<string, unknown> & { type?: unknown };

export function hostedStreamEventType(part: unknown): string {
  if (part !== null && typeof part === 'object' && !Array.isArray(part)) {
    const type = (part as HostedStreamPart).type;
    return typeof type === 'string' && type.length > 0 ? type : 'unknown';
  }
  return 'unknown';
}

export function hostedTurnEventType(status: DBChatTurnStatus): string {
  return `turn.${status}`;
}

export function jsonSafeForIpc(value: unknown): unknown {
  const seen = new WeakSet<object>();
  const serialized = JSON.stringify(value, (_key, current) => {
    if (current instanceof Error) {
      const cause = (current as Error & { cause?: unknown }).cause;
      return {
        __conversation_ledger_type: 'error',
        name: current.name,
        message: current.message,
        stack: current.stack ?? null,
        cause: cause ?? null,
      };
    }
    if (typeof current === 'bigint') {
      return { __conversation_ledger_type: 'bigint', value: current.toString() };
    }
    if (typeof current === 'function') {
      return { __conversation_ledger_type: 'function', name: current.name || null };
    }
    if (typeof current === 'symbol') {
      return { __conversation_ledger_type: 'symbol', value: String(current) };
    }
    if (typeof current === 'number' && !Number.isFinite(current)) {
      return { __conversation_ledger_type: 'non_finite_number', value: String(current) };
    }
    if (current !== null && typeof current === 'object') {
      if (seen.has(current)) return { __conversation_ledger_type: 'circular' };
      seen.add(current);
    }
    return current;
  });
  return serialized === undefined ? null : JSON.parse(serialized);
}

export async function consumeHostedStream(input: {
  stream: AsyncIterable<unknown>;
  signal: AbortSignal;
  onPart(part: unknown): void;
  onTool(part: HostedToolResultPart): Promise<void>;
  onText(delta: string): void;
}): Promise<void> {
  for await (const part of input.stream) {
    input.onPart(part);
    const eventType = hostedStreamEventType(part);
    if (eventType === 'error') {
      throw (part as HostedStreamPart).error ?? new Error('Provider stream error');
    }
    if (eventType === 'abort' && input.signal.aborted) {
      throw new Error('Stop requested');
    }
    if (isHostedToolPart(part)) {
      if ((part as { preliminary?: unknown }).preliminary === true) continue;
      await input.onTool(part);
      continue;
    }
    const delta = hostedTextDelta(part);
    if (delta) input.onText(delta);
  }
}

function hostedTextDelta(part: unknown): string | null {
  if (hostedStreamEventType(part) !== 'text-delta') return null;
  const raw = part as HostedStreamPart;
  if (typeof raw.text === 'string') return raw.text;
  if (typeof raw.delta === 'string') return raw.delta;
  return null;
}

function isHostedToolPart(value: unknown): value is HostedToolResultPart {
  if (typeof value !== 'object' || value === null) return false;
  const part = value as Record<string, unknown>;
  return (
    (part.type === 'tool-result' || part.type === 'tool-error') &&
    typeof part.toolCallId === 'string' &&
    typeof part.toolName === 'string'
  );
}
