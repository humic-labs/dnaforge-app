import type { AgentTraceEventShape, AgentTraceToolCallShape } from '../../platform';
import { publicAgentTraceDisplay } from '../../shared/agent-trace-display';

export interface ProjectedTraceItem<T> {
  key: string;
  source: T;
  event: AgentTraceEventShape | null;
}

const ACTIVE_TOOL_STATUSES = new Set<AgentTraceToolCallShape['status']>(['requested', 'running']);
const TERMINAL_TOOL_STATUSES = new Set<AgentTraceToolCallShape['status']>(['completed', 'failed']);

function shouldReplaceToolCall(
  previous: AgentTraceToolCallShape,
  next: AgentTraceToolCallShape
): boolean {
  return !(TERMINAL_TOOL_STATUSES.has(previous.status) && ACTIVE_TOOL_STATUSES.has(next.status));
}

function eventForToolCall(
  event: AgentTraceEventShape,
  call: AgentTraceToolCallShape
): AgentTraceEventShape {
  return {
    ...event,
    display: publicAgentTraceDisplay(
      {
        ...event.display,
        kind: 'tool',
        status: call.status,
      },
      [call]
    ),
    toolCalls: [call],
  };
}

export function projectTraceItems<T>(
  items: readonly T[],
  eventForItem: (item: T) => AgentTraceEventShape | null,
  keyForItem: (item: T, index: number) => string,
  completedToolCallIdForItem?: (item: T) => string | null
): ProjectedTraceItem<T>[] {
  const projected: ProjectedTraceItem<T>[] = [];
  const toolCallIndexes = new Map<string, number>();
  const toolCalls = new Map<string, AgentTraceToolCallShape>();
  const completedItemsByToolCallId = new Map<string, T>();

  if (completedToolCallIdForItem) {
    for (const item of items) {
      const toolCallId = completedToolCallIdForItem(item);
      if (toolCallId) completedItemsByToolCallId.set(toolCallId, item);
    }
  }

  items.forEach((item, itemIndex) => {
    const event = eventForItem(item);
    const completedToolCallId = completedToolCallIdForItem?.(item) ?? null;
    if (completedToolCallId) {
      if (toolCallIndexes.has(completedToolCallId)) return;
      toolCallIndexes.set(completedToolCallId, projected.length);
      projected.push({
        key: `tool-call:${completedToolCallId}`,
        source: item,
        event: null,
      });
      return;
    }
    if (!event?.toolCalls?.length) {
      projected.push({ key: keyForItem(item, itemIndex), source: item, event });
      return;
    }

    for (const nextCall of event.toolCalls) {
      const toolCallKey = nextCall.id;
      const existingIndex = toolCallIndexes.get(toolCallKey);
      const previousCall = toolCalls.get(toolCallKey);
      const completedItem = completedItemsByToolCallId.get(toolCallKey);
      if (existingIndex !== undefined && completedItem) {
        projected[existingIndex] = {
          key: `tool-call:${toolCallKey}`,
          source: completedItem,
          event: null,
        };
        continue;
      }
      if (existingIndex !== undefined && previousCall) {
        if (!shouldReplaceToolCall(previousCall, nextCall)) continue;
        const mergedCall = { ...previousCall, ...nextCall };
        toolCalls.set(toolCallKey, mergedCall);
        projected[existingIndex] = {
          key: `tool-call:${toolCallKey}`,
          source: completedItem ?? item,
          event: completedItem ? null : eventForToolCall(event, mergedCall),
        };
        continue;
      }

      const projectedIndex = projected.length;
      toolCallIndexes.set(toolCallKey, projectedIndex);
      toolCalls.set(toolCallKey, nextCall);
      projected.push({
        key: `tool-call:${toolCallKey}`,
        source: completedItem ?? item,
        event: completedItem ? null : eventForToolCall(event, nextCall),
      });
    }
  });

  return projected;
}
