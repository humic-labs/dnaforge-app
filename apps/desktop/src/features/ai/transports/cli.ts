import {
  cliAssistantText,
  isCliTerminalFailureDiagnostic,
  isCodexAccountModelRejection,
} from '../../../shared/cli-assistant-text';
import { isReferenceCreationTool } from '../references/constants';
import type { AgentTraceEventShape } from '../../../platform';
import { isChatVisibleAgentTraceEvent } from '../trace-display';
import type { ContentBlock } from '../orchestration/chat-types';
import type { ChatMessage } from '../orchestration/chat-types';
import { getEntityReferencesByIds } from '../../../db/entity-references';
import { isHistoryReactivatableTool } from '../../../shared/tool-history-policy';
import {
  reconcileTraceToolCalls,
  shouldReplaceTraceLifecycle,
} from '../../../shared/cli-trace-lifecycle';

export interface CliTranscriptAccumulator {
  readonly blocks: ContentBlock[];
  readonly indexedItems: number;
  append(event: AgentTraceEventShape): void;
  clear(): void;
}

export function createCliTranscriptAccumulator(): CliTranscriptAccumulator {
  const blocks: ContentBlock[] = [];
  const indexes = new Map<string, number>();
  const firstSequences = new Map<string, number>();
  const keyForBlock = (block: ContentBlock): string | null => {
    if (block.type !== 'assistant_text' && block.type !== 'trace') return null;
    return block.event.providerItemId
      ? `${block.type}:${block.event.transport}:${block.event.providerItemId}`
      : null;
  };
  const sequenceForBlock = (block: ContentBlock): number => {
    const key = keyForBlock(block);
    return (
      (key ? firstSequences.get(key) : undefined) ??
      (block.type === 'assistant_text' || block.type === 'trace'
        ? block.event.sequence
        : Number.MAX_SAFE_INTEGER)
    );
  };
  const insertInProviderOrder = (block: ContentBlock): void => {
    const sequence = sequenceForBlock(block);
    const last = blocks[blocks.length - 1];
    if (!last || sequenceForBlock(last) <= sequence) {
      const index = blocks.push(block) - 1;
      const key = keyForBlock(block);
      if (key) indexes.set(key, index);
      return;
    }

    let low = 0;
    let high = blocks.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (sequenceForBlock(blocks[middle]) <= sequence) low = middle + 1;
      else high = middle;
    }
    blocks.splice(low, 0, block);
    for (let index = low; index < blocks.length; index += 1) {
      const candidate = blocks[index];
      const candidateKey = keyForBlock(candidate);
      if (candidateKey) indexes.set(candidateKey, index);
    }
  };
  return {
    blocks,
    get indexedItems() {
      return indexes.size;
    },
    append(event) {
      const assistantText = extractCliAssistantText(event);
      const block: ContentBlock = assistantText
        ? {
            type: 'assistant_text',
            id: event.providerItemId
              ? `assistant-text:${event.transport}:${event.providerItemId}`
              : `assistant-text:${event.transport}:sequence-${event.sequence}`,
            event,
            content: assistantText,
          }
        : { type: 'trace', event };
      const key = keyForBlock(block);
      if (!key) {
        insertInProviderOrder(block);
        return;
      }
      const existingIndex = indexes.get(key);
      if (existingIndex === undefined) {
        firstSequences.set(key, event.sequence);
        insertInProviderOrder(block);
        return;
      }
      const existing = blocks[existingIndex];
      if (existing.type === 'trace' && block.type === 'trace') {
        if (!shouldReplaceTraceLifecycle(existing.event, event)) return;
        const toolCalls = reconcileTraceToolCalls(existing.event.toolCalls, event.toolCalls);
        block.event = toolCalls ? { ...event, toolCalls } : event;
      }
      blocks[existingIndex] = block;
    },
    clear() {
      blocks.length = 0;
      indexes.clear();
      firstSequences.clear();
    },
  };
}

export function extractCliAssistantText(event: AgentTraceEventShape): string | null {
  return cliAssistantText(event);
}

export function isCliTranscriptTraceEvent(event: AgentTraceEventShape): boolean {
  if (
    isCliTerminalFailureDiagnostic(event) ||
    (event.display.kind === 'error' &&
      !event.toolCalls?.length &&
      isCodexAccountModelRejection(event.display.text ?? ''))
  )
    return false;
  return (
    Boolean(extractCliAssistantText(event)) ||
    Boolean(event.toolCalls?.length) ||
    isChatVisibleAgentTraceEvent(event)
  );
}

type MaterializedCliCompletion =
  | { kind: 'reference'; toolName: string; callId: string; referenceId: string; input: unknown }
  | { kind: 'history-tool'; callId: string; toolName: string; input: unknown; output: unknown };

export async function materializeCliToolBlocks(
  blocks: ContentBlock[],
  turnId?: string | null
): Promise<ContentBlock[]> {
  const requestsByCallId = new Map<string, { name: string; mcpServer: string; input: unknown }>();
  const completionsByBlock = new Map<number, MaterializedCliCompletion[]>();
  const seenCompletions = new Set<string>();

  blocks.forEach((block, blockIndex) => {
    if (block.type !== 'trace') return;
    for (const call of block.event.toolCalls ?? []) {
      const name = canonicalCliToolName(call.name);
      if (call.mcpServer !== 'dnaforge') continue;
      if (call.status === 'requested' || call.status === 'running') {
        const prior = requestsByCallId.get(call.id);
        requestsByCallId.set(call.id, {
          name,
          mcpServer: call.mcpServer,
          input: call.input ?? prior?.input ?? {},
        });
        continue;
      }
      if (call.status === 'failed') {
        requestsByCallId.delete(call.id);
        continue;
      }
      const request = requestsByCallId.get(call.id);
      requestsByCallId.delete(call.id);
      if (request && (request.name !== name || request.mcpServer !== call.mcpServer)) continue;
      const input = call.input ?? request?.input ?? null;
      const completionKey = `${name}:${call.id}`;
      if (seenCompletions.has(completionKey)) continue;
      const entries = completionsByBlock.get(blockIndex) ?? [];

      if (isReferenceCreationTool(name)) {
        if (!request) continue;
        const referenceId = findReferenceId(call.output);
        if (!referenceId) continue;
        entries.push({ kind: 'reference', toolName: name, callId: call.id, referenceId, input });
      } else if (isHistoryReactivatableTool(name)) {
        entries.push({
          kind: 'history-tool',
          callId: call.id,
          toolName: name,
          input,
          output: call.output ?? null,
        });
      } else {
        continue;
      }

      seenCompletions.add(completionKey);
      completionsByBlock.set(blockIndex, entries);
    }
  });

  const referenceIds = [
    ...new Set(
      [...completionsByBlock.values()].flatMap((entries) =>
        entries.flatMap((entry) => (entry.kind === 'reference' ? [entry.referenceId] : []))
      )
    ),
  ];

  let referencesById = new Map<
    string,
    Awaited<ReturnType<typeof getEntityReferencesByIds>>[number]
  >();
  if (referenceIds.length > 0) {
    try {
      const references = await getEntityReferencesByIds(referenceIds);
      referencesById = new Map(references.map((reference) => [reference.id, reference]));
    } catch (error) {
      console.warn('[Chat] Failed to load completed CLI create_reference rows:', error);
    }
  }
  let createdAtOffset = 0;

  return blocks.flatMap((block, blockIndex): ContentBlock[] => {
    const completions = completionsByBlock.get(blockIndex) ?? [];
    const materializedBlocks = completions.flatMap((completion): ContentBlock[] => {
      if (completion.kind === 'history-tool') {
        const message: ChatMessage = {
          id: crypto.randomUUID(),
          turnId: turnId ?? null,
          role: 'tool',
          toolName: completion.toolName,
          toolCallId: completion.callId,
          content: JSON.stringify({
            input: completion.input,
            output: completion.output,
            isError: false,
          }),
          createdAt: Date.now() + createdAtOffset++,
        };
        return [{ type: 'tool', message }];
      }

      const reference = referencesById.get(completion.referenceId);
      if (!reference) return [];
      const message: ChatMessage = {
        id: crypto.randomUUID(),
        turnId: turnId ?? null,
        role: 'tool',
        toolName: completion.toolName,
        toolCallId: completion.callId,
        content: JSON.stringify({
          input: completion.input,
          output: { referenceId: completion.referenceId },
          isError: false,
          referenceData: reference,
        }),
        createdAt: Date.now() + createdAtOffset++,
      };
      return [{ type: 'ref', reference, message }];
    });
    return [block, ...materializedBlocks];
  });
}

export function findReferenceId(value: unknown, depth = 0): string | null {
  if (depth > 8 || !isRecord(value)) return null;
  if (value.ok === false || value.isError === true) return null;
  if (
    typeof value.referenceId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.referenceId)
  ) {
    return value.referenceId;
  }
  for (const nested of Object.values(value)) {
    const found = findReferenceId(nested, depth + 1);
    if (found) return found;
  }
  return null;
}

function canonicalCliToolName(name: string): string {
  const dnaforgePrefix = 'mcp__dnaforge__';
  return name.startsWith(dnaforgePrefix) ? name.slice(dnaforgePrefix.length) : name;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
