import { isReferenceCreationTool } from '../references/constants';
import type { ChatMessage } from './chat-types';

const MIN_SUBSTANTIVE_FINAL_ANSWER_LENGTH = 20;
export const EMPTY_RESPONSE_FALLBACK = "I couldn't generate a response.";

function completedReferenceId(message: ChatMessage): string | null {
  if (message.role !== 'tool' || !isReferenceCreationTool(message.toolName)) return null;
  try {
    const parsed: unknown = JSON.parse(message.content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const output = record.output;
    if (record.isError === true || (output as { ok?: unknown } | null)?.ok === false) return null;
    const referenceData = record.referenceData;
    if (!output || typeof output !== 'object' || Array.isArray(output)) return null;
    if (!referenceData || typeof referenceData !== 'object' || Array.isArray(referenceData)) {
      return null;
    }
    const referenceId = (output as Record<string, unknown>).referenceId;
    const materializedId = (referenceData as Record<string, unknown>).id;
    return typeof referenceId === 'string' && materializedId === referenceId ? referenceId : null;
  } catch {
    return null;
  }
}

export function referenceCompletionFallback(
  messages: ChatMessage[],
  assistantText: string
): string | null {
  const normalizedText = assistantText.trim();
  if (
    normalizedText.length >= MIN_SUBSTANTIVE_FINAL_ANSWER_LENGTH &&
    normalizedText !== EMPTY_RESPONSE_FALLBACK
  ) {
    return null;
  }

  const completedReferenceIds = new Set(
    messages.map(completedReferenceId).filter((value): value is string => value !== null)
  );
  if (completedReferenceIds.size === 1) return 'Created the requested clickable reference.';
  if (completedReferenceIds.size > 1) return 'Created the requested clickable references.';
  return normalizedText ? null : EMPTY_RESPONSE_FALLBACK;
}
