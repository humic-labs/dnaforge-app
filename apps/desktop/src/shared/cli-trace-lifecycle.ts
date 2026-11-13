const TERMINAL_TRACE_STATUSES = new Set([
  'completed',
  'succeeded',
  'success',
  'done',
  'failed',
  'error',
  'cancelled',
  'canceled',
  'stopped',
]);

const ACTIVE_TRACE_STATUSES = new Set(['in_progress', 'running', 'started', 'pending']);

export interface TraceToolCallLifecycle {
  id: string;
  name: string;
  mcpServer?: string;
  status: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizedTraceStatus(event: unknown): string {
  if (!isRecord(event)) return '';
  const display = isRecord(event.display) ? event.display : null;
  const status = display?.status ?? event.terminal ?? '';
  return typeof status === 'string' ? status.toLowerCase().replace(/[-\s]/g, '_') : '';
}

export function shouldReplaceTraceLifecycle(previous: unknown, next: unknown): boolean {
  const previousStatus = normalizedTraceStatus(previous);
  const nextStatus = normalizedTraceStatus(next);
  return !(TERMINAL_TRACE_STATUSES.has(previousStatus) && ACTIVE_TRACE_STATUSES.has(nextStatus));
}

export function reconcileTraceToolCalls<T extends TraceToolCallLifecycle>(
  previous: readonly T[] | undefined,
  next: readonly T[] | undefined
): T[] | undefined {
  const toolCallsByLifecycle = new Map<string, T>();
  for (const call of [...(previous ?? []), ...(next ?? [])]) {
    toolCallsByLifecycle.set(
      `${call.id}:${call.name}:${call.mcpServer ?? ''}:${call.status}`,
      call
    );
  }
  return toolCallsByLifecycle.size > 0 ? [...toolCallsByLifecycle.values()] : undefined;
}
