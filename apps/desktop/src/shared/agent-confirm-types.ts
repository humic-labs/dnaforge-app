export interface DestructiveFileConfirmRequest {
  requestId: string;
  conversationId?: string | null;
  toolName: string;
  operation: string;
  operationMessage?: import('@waypoint/user-messages').UserMessagePayload;
  resolvedPath: string;
  command?: string;
  risk?: 'read-only' | 'mutating' | 'destructive' | 'unknown';
  riskSummary?: string;
  displayPath?: string;
  displayCommand?: string;
  rule?: import('./agent-approval').AgentApprovalRule;
}

export interface DestructiveFileConfirmResponse {
  allow: boolean;
  choice?: import('./agent-approval').AgentApprovalChoice;
}

export interface DestructiveFileConfirmCancel {
  requestId: string;
}

export type AgentInteractionProvider =
  | 'application'
  | 'claude-agent-sdk'
  | 'codex-sdk'
  | 'grok-acp'
  | 'hosted-codex';

export interface AgentUserInputOption {
  id: string;
  label: string;
  description: string;
  preview?: string;
}

export interface AgentUserInputQuestion {
  id: string;
  header: string;
  prompt: string;
  options: AgentUserInputOption[];
  multiSelect: boolean;
  allowFreeText: boolean;
  defaultOptionIds?: string[];
  secret?: boolean;
}

export interface AgentUserInputRequest {
  requestId: string;
  conversationId?: string | null;
  provider: AgentInteractionProvider;
  questions: AgentUserInputQuestion[];
  approval?: import('./agent-approval').PublicAgentApprovalCard;
}

export interface AgentUserInputAnswer {
  selectedOptionIds: string[];
  text?: string;
}

export interface AgentUserInputResponse {
  outcome: 'submitted' | 'cancelled';
  answers: Record<string, AgentUserInputAnswer>;
  reason?: AgentUserInputCancellationReason;
}

export type AgentUserInputCancellationReason =
  | 'user_cancelled'
  | 'superseded'
  | 'timeout'
  | 'turn_aborted'
  | 'renderer_unavailable'
  | 'invalid_response'
  | 'delivery_failed';

export interface AgentUserInputCancel {
  requestId: string;
}

export type AgentConfirmResponseChannel = `agent:confirm-destructive-file:response:${string}`;
export type AgentUserInputResponseChannel = `agent:user-input:response:${string}`;

export const AGENT_CONFIRM_DESTRUCTIVE_FILE_CHANNEL = 'agent:confirm-destructive-file';
export const AGENT_CONFIRM_DESTRUCTIVE_FILE_CANCEL_CHANNEL =
  'agent:confirm-destructive-file:cancel';
export const AGENT_USER_INPUT_CHANNEL = 'agent:user-input';
export const AGENT_USER_INPUT_CANCEL_CHANNEL = 'agent:user-input:cancel';

export function agentConfirmResponseChannel(requestId: string): AgentConfirmResponseChannel {
  return `${AGENT_CONFIRM_DESTRUCTIVE_FILE_CHANNEL}:response:${requestId}`;
}

export function agentUserInputResponseChannel(requestId: string): AgentUserInputResponseChannel {
  return `${AGENT_USER_INPUT_CHANNEL}:response:${requestId}`;
}
