import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { Button } from './ui';
import './ai-only-workbench.css';

export function AiOnlyOutputBoundary({
  conversation,
  children,
}: {
  conversation: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (ref.current) ref.current.inert = !conversation;
  }, [conversation]);
  return (
    <div
      ref={ref}
      className={conversation ? 'h-full' : 'ai-only-output h-full'}
      data-ai-input-region={conversation ? 'conversation' : 'output'}
    >
      {children}
    </div>
  );
}

export function AiOnlyWorkbench({
  children,
  onOpenChat,
  onNewChat,
}: {
  children: ReactNode;
  onOpenChat: () => void;
  onNewChat: () => void;
}) {
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    onOpenChat();
  }, [onOpenChat]);
  return (
    <div className="flex h-screen flex-col bg-bg text-fg" data-testid="ai-only-workbench">
      <header
        data-ai-input-region="navigation"
        className="flex items-center gap-3 bg-bg-muted px-4 py-3"
      >
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-medium">DNAForge · AI input experiment</h1>
          <p className="text-xs text-fg-muted">
            Use chat to create or change your work. Output contents are view-only in this prototype.
          </p>
        </div>
        <Button variant="appbar" onClick={onOpenChat}>
          Chat
        </Button>
        <Button variant="appbar" onClick={onNewChat}>
          New chat
        </Button>
      </header>
      <main className="min-h-0 flex-1">{children}</main>
    </div>
  );
}
