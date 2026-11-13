import {
  userMessage,
  userMessageWithValues,
  userMessageValue,
  type UserMessage,
} from '@waypoint/user-messages';
import type { AgentCliModelReasoningEffort, AgentCliModelPersonality } from './agent-runtime-ipc';

export function validateModelSelection(
  models: readonly {
    id: string;
    displayName: string;
    reasoningEfforts: readonly AgentCliModelReasoningEffort[];
    serviceTiers?: readonly { id: string; label: string }[];
    supportsPersonality?: boolean;
    isDefault?: boolean;
  }[],
  model: string | null | undefined,
  reasoningEffort: AgentCliModelReasoningEffort | null | undefined,
  serviceTier: string | null | undefined,
  personality?: AgentCliModelPersonality | null
): UserMessage | null {
  if (models.length === 0) return userMessage('assistant.modelsUnavailable');
  const selected = model
    ? models.find((candidate) => candidate.id === model)
    : models.find((candidate) => candidate.isDefault);
  if (!selected) {
    return model
      ? userMessageWithValues('assistant.modelUnavailable', { model: userMessageValue(model) })
      : null;
  }
  if (reasoningEffort && !selected.reasoningEfforts.includes(reasoningEffort)) {
    return userMessageWithValues('assistant.reasoningUnavailable', {
      model: userMessageValue(selected.displayName),
      effort: userMessageValue(reasoningEffort),
    });
  }
  if (
    serviceTier &&
    !(selected.serviceTiers ?? []).some((candidate) => candidate.id === serviceTier)
  ) {
    return userMessageWithValues('assistant.tierUnavailable', {
      model: userMessageValue(selected.displayName),
      tier: userMessageValue(serviceTier),
    });
  }
  if (personality && !selected.supportsPersonality) {
    return userMessageWithValues('assistant.personalityUnavailable', {
      model: userMessageValue(selected.displayName),
    });
  }
  return null;
}
