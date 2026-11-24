import type { AssistantSendRouteResolution } from '../assistant-send-route';
import type { UserMessage } from '@waypoint/user-messages';
import type { HistoryObservation } from '../../../shared/chat-history-telemetry';
import type { DBChatTurnStatus } from '../../../db';
import type { DBEntityReference } from '../../../db/entity-references';
import type { AgentCapabilitySelection } from '../../../shared/agent-capability-controls';
import type { AgentAttachmentManifest } from '../../../shared/agent-attachments';
import type { AssistantRouteSelection, AssistantTurnRouteSnapshot } from '../assistant-routes';
import type { CliModelSettings } from '../settings';
import type { ChatMessage, ContentBlock } from './chat-types';
export interface ConversationSummary {
  id: string;
  title: string;
  workspacePath: string | null;
  pinned: boolean;
  provider: string | null;
  model: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ChatTurnSummary {
  id: string;
  conversationId: string;
  routeKind: string;
  hostId: string;
  provider: string | null;
  model: string | null;
  transport: string | null;
  authorityProfileId: string | null;
  permissionMode: string | null;
  routeSnapshotJson: string;
  status: DBChatTurnStatus;
  terminalReason: string | null;
  error: string | null;
  startedAt: number;
  completedAt: number | null;
}

export interface PendingChatMessage {
  conversationId?: string | null;
  content: string;
}

export type ChatComposerDraftAttachment = AgentAttachmentManifest;

export interface ChatComposerDraft {
  text: string;
  attachments: ChatComposerDraftAttachment[];
  references: DBEntityReference[];
}

export interface PendingChatDraft {
  conversationId?: string | null;
  text?: string;
  references: DBEntityReference[];
}

export interface PendingAskAiPicker {
  contextKind?: 'selection' | 'view';
  reference: DBEntityReference;
  chatWorkspacePath: string | null;
  seedText?: string;
  anchor?: { x: number; y: number };
  sourcePanelId?: string;
}

export interface AskAiInlineChat {
  conversationId: string;
  workspacePath: string | null;
  anchor?: { x: number; y: number };
  sourcePanelId?: string;
}

export interface QueuedChatMessage {
  routeFallback?: Extract<AssistantSendRouteResolution, { status: 'fallback' }>;
  id: string;
  content: string;
  workspacePath: string | null;
  referenceIds: string[];
  displayInThreadWhilePending?: boolean;
  attachments?: AgentAttachmentManifest[];
  routeSelection: AssistantRouteSelection;
  routeSnapshot: AssistantTurnRouteSnapshot;
  cliModelSettings?: CliModelSettings;
  capabilitySelection?: AgentCapabilitySelection;
  createdAt: number;
}

export interface ConversationState {
  messages: ChatMessage[];
  turns: Record<string, ChatTurnSummary>;
  permissions?: import('../../../shared/agent-permissions').AgentPermissions;
  activeTurnId: string | null;
  streamingBlocks: ContentBlock[];
  isLoading: boolean;
  isStreaming: boolean;
  error: UserMessage | null;
  queuedMessages: QueuedChatMessage[];
}

export function createEmptyConversationState(): ConversationState {
  return {
    messages: [],
    turns: {},
    activeTurnId: null,
    streamingBlocks: [],
    isLoading: false,
    isStreaming: false,
    error: null,
    queuedMessages: [],
  };
}

export const EMPTY_CONV_STATE: ConversationState = createEmptyConversationState();

export interface ConversationHistoryReadState {
  status: 'idle' | 'loading' | 'ready' | 'error';

  hasLoaded: boolean;
}

export interface ChatState {
  messages: ChatMessage[];
  turns: Record<string, ChatTurnSummary>;
  activeTurnId: string | null;
  conversations: ConversationSummary[];
  conversationHistoryRead: ConversationHistoryReadState;
  currentConversationId: string | null;
  isLoading: boolean;
  isStreaming: boolean;
  streamingBlocks: ContentBlock[];
  error: UserMessage | null;
  queuedMessages: QueuedChatMessage[];
  pendingMessage: PendingChatMessage | null;
  pendingDraft: PendingChatDraft | null;
  composerDrafts: Map<string, ChatComposerDraft>;
  pendingAskAiPicker: PendingAskAiPicker | null;
  askAiInlineChat: AskAiInlineChat | null;
  _convStates: Map<string, ConversationState>;
}

export interface ChatActions {
  sendMessage: (
    content: string,
    workspacePath: string | null,
    conversationId?: string | null,
    referenceIds?: string[],
    options?: ChatSendOptions
  ) => Promise<'accepted' | 'rejected'>;
  stopGeneration: (conversationId?: string | null) => void;
  advanceQueueThrough: (targetMessageId: string, conversationId?: string | null) => void;
  loadConversations: (history?: HistoryObservation) => Promise<void>;
  switchConversation: (
    id: string,
    options?: {
      sourceConversationId?: string | null;
      workspacePath?: string | null;
      history?: HistoryObservation;
    }
  ) => Promise<'applied' | 'available' | 'stale'>;
  hydrateConversation: (id: string, history?: HistoryObservation) => Promise<void>;
  deleteConversation: (id: string, history?: HistoryObservation) => Promise<string | null>;
  newConversation: (
    workspacePath: string | null,
    options?: {
      force?: boolean;
      sourceConversationId?: string | null;
      history?: HistoryObservation;
    }
  ) => Promise<string>;
  renameConversation: (id: string, title: string, history?: HistoryObservation) => Promise<void>;
  togglePin: (id: string, history?: HistoryObservation) => Promise<void>;
  setPendingMessage: (message: PendingChatMessage | string | null) => void;
  setPendingDraft: (draft: PendingChatDraft | null) => void;
  setComposerDraft: (conversationId: string, draft: ChatComposerDraft | null) => void;
  setPendingAskAiPicker: (picker: PendingAskAiPicker | null) => void;
  setAskAiInlineChat: (inline: AskAiInlineChat | null) => void;
  setError: (error: UserMessage | null, conversationId?: string | null) => void;
}

export interface ChatSendOptions {
  readonly attachments?: readonly AgentAttachmentManifest[];
  readonly capabilitySelection?: AgentCapabilitySelection;
  readonly claimIfUnowned?: boolean;
  readonly onStarted?: (conversationId: string) => void;
  readonly activateConversation?: boolean;
  readonly onNotStarted?: (error: UserMessage) => void;
}
