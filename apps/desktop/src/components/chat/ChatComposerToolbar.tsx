import type { ReactNode } from 'react';
import { Button } from '../ui/controls';
import { PaperclipIcon, SendIcon } from '../icons';

interface ChatComposerToolbarProps {
  onAttach?: () => void;
  agentActions: ReactNode;
  route: ReactNode;
  children: ReactNode;
  onSend: () => void;
  sendDisabled: boolean;
  sendTitle: string;
}

export function ChatComposerToolbar({
  onAttach,
  agentActions,
  route,
  children,
  onSend,
  sendDisabled,
  sendTitle,
}: ChatComposerToolbarProps) {
  return (
    <div
      className="chat-composer-toolbar flex items-center gap-x-1.5 gap-y-1 px-3 pb-1.5 pt-0.5"
      data-testid="chat-composer-toolbar"
    >
      <div className="chat-composer-attachments mr-auto flex min-w-0 items-center gap-1">
        {onAttach && (
          <Button
            onClick={onAttach}
            variant="icon"
            title="Attach file"
            aria-label="Attach file"
            data-testid="chat-attach-button"
          >
            <PaperclipIcon />
          </Button>
        )}
        {agentActions}
      </div>
      <div className="chat-composer-route min-w-0">{route}</div>
      <div className="chat-composer-settings flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 empty:hidden">
        {children}
      </div>
      <Button
        onClick={onSend}
        disabled={sendDisabled}
        variant="icon"
        title={sendTitle}
        aria-label="Send message"
        data-testid="chat-send-button"
      >
        <SendIcon />
      </Button>
    </div>
  );
}
