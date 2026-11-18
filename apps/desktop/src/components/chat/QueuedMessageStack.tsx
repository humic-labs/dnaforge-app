import type { DBEntityReference } from '../../db/entity-references';
import type { QueuedChatMessage } from '../../features/ai/orchestration/chat-store-types';
import { ChevronRightIcon, HistoryIcon } from '../icons';
import { FormattedMessage, type ReferenceResolutionStatus } from './MessageFormatting';

interface QueuedMessageStackProps {
  messages: QueuedChatMessage[];
  referenceMap: Map<string, DBEntityReference>;
  referenceResolution: ReadonlyMap<string, ReferenceResolutionStatus>;
  onReferenceClick: (reference: DBEntityReference, options?: { snapshotIndex: number }) => void;
  onReferenceReveal: (reference: DBEntityReference) => void;
  onAdvanceThrough: (targetMessageId: string) => void;
  onMessageElementChange: (messageId: string, element: HTMLDivElement | null) => void;
}

export function QueuedMessageStack({
  messages,
  referenceMap,
  referenceResolution,
  onReferenceClick,
  onReferenceReveal,
  onAdvanceThrough,
  onMessageElementChange,
}: QueuedMessageStackProps) {
  return (
    <div
      data-testid="queued-chat-stack"
      aria-label={`${messages.length} queued ${messages.length === 1 ? 'message' : 'messages'}`}
      className="mx-4 flex flex-col"
    >
      {messages.map((message, index) => {
        const positionLabel = `message ${index + 1} of ${messages.length}`;
        return (
          <div
            key={message.id}
            ref={(element) => onMessageElementChange(message.id, element)}
            className={`relative w-full border border-b-0 border-border-hover/70 bg-bg-muted/70 px-4 py-2 pr-20 text-sm text-fg dark:border-border-hover/80 dark:bg-bg-muted ${
              index === 0 ? 'rounded-t-2xl' : ''
            }`}
            data-testid="queued-chat-message"
            data-queue-position={index + 1}
          >
            <div
              data-testid="queued-chat-controls"
              className="absolute right-3 top-2.5 flex items-center gap-1"
            >
              <span
                role="status"
                aria-label={`Queued ${positionLabel}`}
                title={`Queued ${positionLabel}`}
                data-testid="queued-chat-indicator"
                className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-bg text-fg-muted"
              >
                <HistoryIcon size={12} />
              </span>
              <button
                type="button"
                aria-label={`Advance queue through ${positionLabel}`}
                title="Advance queue through this message"
                data-testid="advance-queued-message"
                className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-bg text-fg-muted transition-colors  wp-interactive "
                onClick={() => onAdvanceThrough(message.id)}
              >
                <ChevronRightIcon size={12} />
              </button>
            </div>
            <FormattedMessage
              content={message.content}
              role="user"
              references={referenceMap}
              referenceIds={message.referenceIds}
              referenceResolution={referenceResolution}
              onReferenceClick={onReferenceClick}
              onReferenceReveal={onReferenceReveal}
            />
          </div>
        );
      })}
    </div>
  );
}
