import { validatePreparedEntityReferenceRow } from './entity-reference-ipc';
import type { ChatEntityReferenceIpcRow } from './entity-reference-types';
import type { AgentAttachmentManifest } from './agent-attachments';

export type { ChatEntityReferenceIpcRow } from './entity-reference-types';

export const NATIVE_REPLY_UNAVAILABLE =
  'The assistant finished, but the full reply could not be recovered after restart.';

export type ChatTurnIpcStatus =
  | 'running'
  | 'completed'
  | 'stopped'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface ChatTurnIpcRow {
  id: string;
  conversation_id: string;
  route_kind: string;
  host_id: string;
  provider: string | null;
  model: string | null;
  transport: string | null;
  authority_profile_id: string | null;
  permission_mode: string | null;
  route_snapshot_json: string;
  status: ChatTurnIpcStatus;
  terminal_reason: string | null;
  error: string | null;
  started_at: number;
  completed_at: number | null;
}

export interface ChatMessageIpcRow {
  id: string;
  conversation_id: string;
  turn_id?: string | null;
  role: 'user' | 'assistant' | 'tool' | 'activity';
  content: string;
  tool_name: string | null;
  tool_call_id: string | null;
  created_at: number;
}

export interface CreateChatTurnWithUserMessageRequest {
  turn: ChatTurnIpcRow;
  message: ChatMessageIpcRow;
  reference_ids?: string[];
  attachment_manifests?: AgentAttachmentManifest[];
}

export type ChatTurnTerminalIpcStatus = Exclude<ChatTurnIpcStatus, 'running'>;

export interface TerminalChatMessageIpc {
  message: ChatMessageIpcRow;
  reference_ids: string[];
}

export interface CommitChatTurnTerminalStateRequest {
  turn_id: string;
  conversation_id: string;
  status: ChatTurnTerminalIpcStatus;
  terminal_reason: string;
  error: string | null;
  completed_at: number;
  messages: TerminalChatMessageIpc[];
  proposed_entity_references?: ChatEntityReferenceIpcRow[];
}

export interface CommitChatTurnTerminalStateResult {
  committed: boolean;
}

export function validateTerminalReferenceProposals(
  input: CommitChatTurnTerminalStateRequest
): void {
  const proposedRows = input.proposed_entity_references ?? [];
  const proposedIds = new Set<string>();
  const usedReferenceIds = new Set<string>();

  for (const entry of input.messages) {
    const messageReferenceIds = new Set(entry.reference_ids);
    if (messageReferenceIds.size !== entry.reference_ids.length) {
      throw new Error('A terminal message cannot contain duplicate reference joins.');
    }
    entry.reference_ids.forEach((referenceId) => usedReferenceIds.add(referenceId));
  }
  for (const row of proposedRows) {
    validatePreparedEntityReferenceRow(row);
    if (proposedIds.has(row.id)) {
      throw new Error('Duplicate proposed entity reference ID.');
    }
    if (row.source !== 'ai' || row.status !== 'created') {
      throw new Error('Proposed entity references must be AI-created rows.');
    }
    if (row.locator.startsWith('git://') && !row.workspace_root_path) {
      throw new Error('Filesystem-backed proposed references require an immutable workspace root.');
    }
    proposedIds.add(row.id);
  }
  for (const proposedId of proposedIds) {
    if (!usedReferenceIds.has(proposedId)) {
      throw new Error('Every proposed entity reference must be referenced by a terminal message.');
    }
  }
}
