import type { AgentProviderInputLimit } from '../../../shared/agent-runtime-ipc';
import type { UserMessageKey } from '@waypoint/user-messages';
import type { ChatMessage } from './chat-types';
import type { ChatTurnSummary } from './chat-store-types';

export const PROVIDER_INPUT_REFUSALS = {
  'context-window': { reason: 'local:context_exceeded', message: 'assistant.nativeContextLimit' },
  'request-size': { reason: 'local:request_too_large', message: 'assistant.nativeRequestLimit' },
} as const satisfies Record<AgentProviderInputLimit, { reason: string; message: UserMessageKey }>;

export function isRefusedProviderInput(turn: ChatTurnSummary | undefined): boolean {
  return (
    turn?.status === 'failed' &&
    Object.values(PROVIDER_INPUT_REFUSALS).some(({ reason }) => reason === turn.terminalReason)
  );
}

export function latestRefusedUserMessage(
  messages: ChatMessage[],
  turns: Record<string, ChatTurnSummary>
): ChatMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === 'user')
      return message.turnId && isRefusedProviderInput(turns[message.turnId]) ? message : null;
  }
  return null;
}
