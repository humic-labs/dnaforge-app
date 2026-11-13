import { toUserMessage } from '@waypoint/user-messages';
import type { ClipboardEvent, RefObject, KeyboardEvent, ReactNode } from 'react';
import { PaperclipIcon, SendIcon } from '../icons';
import { FilePill, type AttachedFile } from '../chat';
import { ReferenceChip } from './ReferenceChip';
import type { DBEntityReference } from '../../db/entity-references';
import { CHAT_COMPOSER_SURFACE_CLASS } from './composer-controls';

const DEFAULT_SUGGESTIONS = [
  'Design an inducible E. coli expression construct',
  'Build a yeast fluorescent reporter with the YTK kit',
];

export interface EmptyStateChatComposerProps {
  input: string;
  onInputChange: (value: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onPaste?: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onSend: () => void;
  sendDisabled: boolean;
  sendTitle: string;
  isLoading: boolean;
  inputRef: RefObject<HTMLTextAreaElement>;
  error?: string | null;
  placeholder?: string;
  greetingTitle?: string;
  greetingSubtitle?: string;
  suggestions?: string[];
  onSuggestionClick: (suggestion: string) => void;
  renderAssistantRouteSelector: () => ReactNode;
  renderModelControls: () => ReactNode;
  renderRunningRouteStatus: () => ReactNode;
  renderRouteConfigurationPrompt: () => ReactNode;
  renderRouteCheckingStatus: () => ReactNode;
  renderComputeConnectPrompt?: () => ReactNode;
  attachedFiles?: AttachedFile[];
  onRemoveFile?: (id: string) => void;
  onAttachFile?: () => void;
  renderAgentActionsControl?: () => ReactNode;
  composeReferences?: DBEntityReference[];
  onReferenceClick?: (reference: DBEntityReference) => void;
  onReferenceReveal?: (reference: DBEntityReference) => void;
  onRemoveComposeReference?: (id: string) => void;
  isDragOver?: boolean;
  hideInput?: boolean;
}

export function EmptyStateChatComposer({
  input,
  onInputChange,
  onKeyDown,
  onPaste,
  onSend,
  sendDisabled,
  sendTitle,
  inputRef,
  error,
  placeholder = 'Ask AI anything...',
  greetingTitle = 'What can I help with?',
  greetingSubtitle,
  suggestions = DEFAULT_SUGGESTIONS,
  onSuggestionClick,
  renderAssistantRouteSelector,
  renderModelControls,
  renderRunningRouteStatus,
  renderRouteConfigurationPrompt,
  renderRouteCheckingStatus,
  renderComputeConnectPrompt,
  attachedFiles = [],
  onRemoveFile,
  onAttachFile,
  renderAgentActionsControl,
  composeReferences = [],
  onReferenceClick,
  onReferenceReveal,
  onRemoveComposeReference,
  isDragOver = false,
  hideInput = false,
}: EmptyStateChatComposerProps) {
  return (
    <div className="w-full">
      <div className="text-center mb-6">
        <h2 className="text-xl font-semibold text-fg mb-1">{greetingTitle}</h2>
        {greetingSubtitle && <p className="text-sm text-fg-muted">{greetingSubtitle}</p>}
      </div>

      {error && (
        <div
          data-testid="ai-error"
          className="mb-4 px-3 py-1.5 rounded-lg bg-error/10 border border-error/20"
        >
          <p className="whitespace-pre-line text-xs leading-relaxed text-error">
            {toUserMessage(error, 'assistant.failed')}
          </p>
        </div>
      )}

      {!hideInput && (
        <div
          data-testid="chat-composer"
          data-chat-composer-dirty={
            input.trim().length > 0 || attachedFiles.length > 0 || composeReferences.length > 0
          }
          className={`
            ${CHAT_COMPOSER_SURFACE_CLASS}
            focus-within:ring-2 focus-within:ring-accent/50 focus-within:border-accent/30
            mb-4
            ${isDragOver ? 'ring-2 ring-accent border-accent/50 bg-accent/5' : ''}
          `}
        >
          {(attachedFiles.length > 0 || composeReferences.length > 0) && (
            <div className="flex flex-wrap gap-1 px-3 pt-3">
              {attachedFiles.map((file) => (
                <FilePill key={file.id} file={file} onRemove={() => onRemoveFile?.(file.id)} />
              ))}
              {composeReferences.map((ref) => (
                <ReferenceChip
                  key={ref.id}
                  reference={ref}
                  onClick={onReferenceClick}
                  onReveal={onReferenceReveal}
                  phase="draft"
                  onRemove={() => onRemoveComposeReference?.(ref.id)}
                />
              ))}
            </div>
          )}
          <div className="px-4 pt-2.5" data-testid="chat-composer-input-row">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => {
                onInputChange(e.target.value);
                e.target.style.height = 'auto';
                e.target.style.height = Math.min(e.target.scrollHeight, 180) + 'px';
              }}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              placeholder={attachedFiles.length > 0 ? 'Add a message or just send...' : placeholder}
              rows={2}
              data-testid="ai-input"
              className="block w-full min-h-[52px] bg-transparent text-sm text-fg placeholder:text-fg-muted
                         focus:outline-none disabled:opacity-50 resize-none overflow-y-auto"
              style={{ maxHeight: '180px' }}
            />
          </div>
          <div
            className="flex items-center justify-between gap-2 px-3 pb-1.5 pt-0.5"
            data-testid="chat-composer-toolbar"
          >
            <div className="flex items-center gap-1">
              {onAttachFile && (
                <button
                  onClick={onAttachFile}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-bg-muted hover:text-accent disabled:opacity-30 [&_svg]:stroke-[2.25]"
                  title="Attach file"
                  aria-label="Attach file"
                  data-testid="chat-attach-button"
                >
                  <PaperclipIcon />
                </button>
              )}
              {renderAgentActionsControl?.()}
            </div>
            <div className="ml-auto flex min-w-0 flex-nowrap items-center justify-end gap-1.5">
              {renderAssistantRouteSelector()}
              {renderModelControls()}
              {renderRunningRouteStatus()}
              {renderRouteConfigurationPrompt()}
              {renderRouteCheckingStatus()}
              {renderComputeConnectPrompt?.()}
              <button
                onClick={onSend}
                disabled={sendDisabled}
                className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-accent hover:text-accent-fg disabled:opacity-30 [&_svg]:stroke-[2.25]"
                title={sendTitle}
                aria-label="Send message"
                data-testid="chat-send-button"
              >
                <SendIcon />
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-center gap-2">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion}
            onClick={() => onSuggestionClick(suggestion)}
            className="px-3 py-1.5 rounded-full border border-border bg-bg text-xs font-medium text-fg-muted
                       hover:bg-bg-muted hover:text-fg hover:border-accent/30 transition-colors"
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}
