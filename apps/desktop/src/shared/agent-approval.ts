import {
  renderUserMessagePayload,
  type UserMessagePayload,
  userMessagePayload,
  userMessageValue,
  userEntityLabel,
  toUserMessage,
  toOptionalUserMessage,
  type UserMessage,
} from '@waypoint/user-messages';
export const AGENT_APPROVAL_CHOICES = ['once', 'chat', 'always', 'deny', 'stop'] as const;
export type AgentApprovalChoice = (typeof AGENT_APPROVAL_CHOICES)[number];

export const AGENT_APPROVAL_CHOICE_LABELS: Record<AgentApprovalChoice, string> = {
  once: 'Allow once',
  chat: 'Allow for this chat',
  always: 'Always allow',
  deny: 'Deny',
  stop: 'Stop turn',
};

export const AGENT_APPROVAL_CHOICE_DESCRIPTIONS: Record<AgentApprovalChoice, string> = {
  once: 'Allow this request only.',
  chat: 'Allow matching requests until this chat ends.',
  always: 'Add to your always-allowed list for every chat and project.',
  deny: 'Tell the agent no. It keeps working.',
  stop: 'Refuse and stop the agent’s turn.',
};

export const AGENT_APPROVAL_QUESTION_ID = 'approval';

export function isAgentApprovalChoice(value: unknown): value is AgentApprovalChoice {
  return (AGENT_APPROVAL_CHOICES as readonly unknown[]).includes(value);
}

export function approvalChoiceAllows(choice: AgentApprovalChoice): boolean {
  return choice === 'once' || choice === 'chat' || choice === 'always';
}

export interface AgentApprovalPath {
  display: string;
  full: string;
}

export interface AgentApprovalRule {
  key: string;
  label: string;
  catalogMessage?: UserMessagePayload;
}

export interface AgentApprovalCard {
  kind: 'command' | 'file' | 'permission';
  title: string;
  detail: string | null;
  command: string | null;
  paths: AgentApprovalPath[];
  rule: AgentApprovalRule;
}

export type PublicAgentApprovalCard = Omit<AgentApprovalCard, 'title' | 'detail' | 'rule'> & {
  title: UserMessage;
  detail: UserMessage | null;
  rule: Omit<AgentApprovalRule, 'label'> & { label: UserMessage };
};

export function publicAgentApprovalCard(card: AgentApprovalCard): PublicAgentApprovalCard {
  return {
    ...card,
    title: toUserMessage(
      card.title,
      card.kind === 'command'
        ? 'assistant.approval.command'
        : card.kind === 'file'
          ? 'assistant.approval.file'
          : 'assistant.approval.permission'
    ),
    detail: toOptionalUserMessage(card.detail, 'assistant.approval.detail'),
    rule: publicAgentApprovalRule(card.rule),
  };
}

export function publicAgentApprovalRule(
  rule: AgentApprovalRule
): Omit<AgentApprovalRule, 'label'> & { label: UserMessage } {
  let catalogMessage = rule.catalogMessage;
  if (!catalogMessage && rule.key.startsWith('command:')) {
    catalogMessage = userMessagePayload('approval.commandScope', {
      programs: userMessageValue(rule.key.slice(8).split('+').join(' + ')),
    });
  }
  if (!catalogMessage && rule.key.startsWith('write:') && rule.label.startsWith('changes in ')) {
    catalogMessage = userMessagePayload('approval.writeScope', {
      folder: userMessageValue(userEntityLabel(rule.label.slice(11))),
    });
  }
  return {
    ...rule,
    catalogMessage,
    label: catalogMessage
      ? renderUserMessagePayload(catalogMessage)
      : toUserMessage(rule.label, 'assistant.approval.rule'),
  };
}
