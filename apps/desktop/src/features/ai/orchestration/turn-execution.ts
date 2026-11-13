import type { DBChatTurnStatus } from '../../../db';
import type { ChatMessage } from './chat-types';
import type { ChatEntityReferenceIpcRow } from '../../../shared/chat-turn-ipc';

export type QueueTerminalMessage = (message: ChatMessage, referenceIds?: string[]) => void;

export type QueueProposedEntityReference = (row: ChatEntityReferenceIpcRow) => void;

export type QueueMaterializedEntityReference = (row: ChatEntityReferenceIpcRow) => void;

export type FinishChatTurn = (
  status: Exclude<DBChatTurnStatus, 'running'>,
  terminalReason: string,
  error?: string | null
) => Promise<void>;

export type TrackShadowLedgerAppend = (pending: Promise<unknown>, label: string) => void;
