import { memo } from 'react';

import { ReferenceChip } from './ReferenceChip';
import { MarkdownMessage } from './MarkdownMessage';
import type { DBEntityReference } from '../../db/entity-references';
import { extractMessageReferences } from '../../features/ai/references/extract-message-references';
import type {
  InlineReferencePart,
  InlineTextDocument,
} from '../../features/ai/references/inline/types';
import { reprojectInlineTextDocument } from '../../features/ai/references/inline/document';
import { sanitizeAssistantArtifactMetadata } from '../../features/ai/orchestration/assistant-artifact-prose';
export { sanitizeAssistantArtifactMetadata };

export { extractMessageReferences } from '../../features/ai/references/extract-message-references';

export interface FormattedMessageProps {
  content: string;
  role?: 'assistant' | 'user';
  streaming?: boolean;
  references?: Map<string, DBEntityReference>;
  onReferenceClick?: (reference: DBEntityReference, options?: { snapshotIndex: number }) => void;
  onReferenceReveal?: (reference: DBEntityReference) => void;
  referenceResolution?: ReadonlyMap<string, ReferenceResolutionStatus>;
  referenceQueryState?: 'unavailable';
  referenceIds?: string[];
  document?: InlineTextDocument;
  renderInlineReference?: (part: InlineReferencePart) => React.ReactNode;
}

export type ReferenceResolutionStatus = 'loading' | 'resolved' | 'absent' | 'unavailable';

type ReferenceAttachment =
  | { id: string; status: 'resolved'; reference: DBEntityReference }
  | { id: string; status: 'loading' | 'unavailable' };

function ReferenceAttachmentsRow({
  attachments,
  onReferenceClick,
  onReferenceReveal,
}: {
  attachments: ReferenceAttachment[];
  onReferenceClick?: (reference: DBEntityReference, options?: { snapshotIndex: number }) => void;
  onReferenceReveal?: (reference: DBEntityReference) => void;
}) {
  return (
    <div
      className="mb-1.5 flex flex-wrap items-center gap-1"
      data-testid="message-attachments"
      aria-label={`${attachments.length} attached ${
        attachments.length === 1 ? 'reference' : 'references'
      }`}
    >
      {attachments.map((attachment) => {
        if (attachment.status === 'resolved') {
          return (
            <ReferenceChip
              key={attachment.id}
              reference={attachment.reference}
              onClick={onReferenceClick}
              onReveal={onReferenceReveal}
              phase="sent"
            />
          );
        }
        if (attachment.status === 'unavailable') {
          return (
            <span
              key={attachment.id}
              data-testid={`ref-chip-unavailable-${attachment.id}`}
              className="inline-flex items-center rounded-full border border-border bg-bg-muted px-2 py-px text-xs font-medium leading-tight text-fg-muted"
              role="status"
              title="Reference lookup failed after three attempts"
            >
              Reference unavailable
            </span>
          );
        }
        return (
          <span
            key={attachment.id}
            data-testid={`ref-chip-loading-${attachment.id}`}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-bg-muted px-2 py-1"
            role="status"
            aria-label="Loading reference"
          >
            <span
              className="h-2.5 w-20 animate-pulse rounded-full bg-bg-subtle"
              aria-hidden="true"
            />
          </span>
        );
      })}
    </div>
  );
}

function FormattedMessageComponent({
  content,
  role = 'assistant',
  streaming = false,
  references,
  onReferenceClick,
  onReferenceReveal,
  referenceResolution,
  referenceQueryState,
  referenceIds,
  document,
  renderInlineReference,
}: FormattedMessageProps) {
  const visibleContent =
    role === 'assistant' ? sanitizeAssistantArtifactMetadata(content) : content;
  const { prose, referenceIds: legacyTokenIds } = extractMessageReferences(visibleContent);
  const displayDocument =
    document && document.source !== prose
      ? reprojectInlineTextDocument(document, prose, { streaming })
      : document;

  const inlineReferenceIds = new Set(
    (displayDocument?.parts ?? []).flatMap((part) =>
      part.state.status === 'resolved' && part.state.referenceId ? [part.state.referenceId] : []
    )
  );
  const carriedIds = (referenceIds ?? legacyTokenIds).filter((id) => !inlineReferenceIds.has(id));

  const attachments = carriedIds.flatMap<ReferenceAttachment>((id): ReferenceAttachment[] => {
    const reference = references?.get(id);
    if (reference) {
      return [{ id, status: 'resolved' as const, reference }];
    }
    const status =
      referenceResolution?.get(id) ??
      (referenceQueryState === 'unavailable' ? 'unavailable' : 'loading');
    if (status === 'absent') return [];
    return [{ id, status: status === 'unavailable' ? 'unavailable' : 'loading' }];
  });
  if (referenceQueryState === 'unavailable' && carriedIds.length === 0) {
    attachments.push({ id: 'message-query', status: 'unavailable' });
  }

  const hasProse = prose.trim().length > 0;

  return (
    <>
      {attachments.length > 0 && (
        <ReferenceAttachmentsRow
          attachments={attachments}
          onReferenceClick={onReferenceClick}
          onReferenceReveal={onReferenceReveal}
        />
      )}
      {hasProse &&
        (role === 'user' ? (
          <span className="block min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
            {prose}
          </span>
        ) : (
          <MarkdownMessage
            content={prose}
            streaming={streaming}
            document={displayDocument}
            renderInlineReference={renderInlineReference}
          />
        ))}
    </>
  );
}

export const FormattedMessage = memo(FormattedMessageComponent);
FormattedMessage.displayName = 'FormattedMessage';

export function formatTimeAgo(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}
