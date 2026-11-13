import type { AppScenario } from './types';
import { withChatTab } from './canvas';

type ChatMessage = NonNullable<NonNullable<AppScenario['chat']>['messages']>[number];
type ChatReference = NonNullable<NonNullable<AppScenario['chat']>['references']>[number];

export function withChatReady(scenario: AppScenario): AppScenario {
  const hasChat = scenario.canvas?.tabs?.some((t) => t.type === 'chat');
  const base = hasChat ? scenario : withChatTab(scenario);
  return {
    ...base,
    chat: {
      ...base.chat,
      provider: base.chat?.provider ?? 'anthropic',
      model: base.chat?.model ?? 'claude-sonnet-4-20250514',
    },
  };
}

export function withChatHistory(scenario: AppScenario, messages: ChatMessage[]): AppScenario {
  const chatTabs = scenario.canvas?.tabs?.filter((tab) => tab.type === 'chat') ?? [];
  const conversationId =
    scenario.chat?.conversationId ??
    (chatTabs.length === 1 ? chatTabs[0].entityId : crypto.randomUUID());

  return {
    ...scenario,
    chat: {
      ...scenario.chat,
      conversationId,
      messages,
    },
  };
}

export function withPreseededReferences(
  scenario: AppScenario,
  references: ChatReference[]
): AppScenario {
  return {
    ...scenario,
    chat: {
      ...scenario.chat,
      references,
    },
  };
}

export function withAIProvider(
  scenario: AppScenario,
  provider: string,
  model?: string
): AppScenario {
  return {
    ...scenario,
    chat: {
      ...scenario.chat,
      provider,
      ...(model ? { model } : {}),
    },
  };
}
