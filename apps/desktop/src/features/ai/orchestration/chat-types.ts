import type { AgentTraceEventShape } from '../../../platform';
import type { DBEntityReference } from '../../../db/entity-references';
import type { InlineTextDocument } from '../references/inline/types';
import type { AgentAttachmentManifest } from '../../../shared/agent-attachments';
import type { AgentStructuredOutputReceipt } from '../../../shared/agent-structured-output';

export interface ChatMessage {
  id: string;
  turnId?: string | null;
  role: 'user' | 'assistant' | 'tool' | 'activity';
  content: string;
  toolName?: string;
  toolCallId?: string;
  createdAt: number;
  document?: InlineTextDocument;
  referenceIds?: string[];
  attachments?: AgentAttachmentManifest[];
  structuredOutput?: AgentStructuredOutputReceipt;
}

export type ContentBlock =
  | {
      type: 'text';
      id: string;
      content: string;
      document?: InlineTextDocument;
      referenceIds?: string[];
    }
  | {
      type: 'assistant_text';
      id: string;
      event: AgentTraceEventShape;
      content: string;
      document?: InlineTextDocument;
      referenceIds?: string[];
    }
  | { type: 'tool'; message: ChatMessage }
  | { type: 'ref'; reference: DBEntityReference; message: ChatMessage }
  | { type: 'trace'; event: AgentTraceEventShape };
