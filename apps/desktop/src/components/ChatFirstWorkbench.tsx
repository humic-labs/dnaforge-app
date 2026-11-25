import { useAuthStore } from '../stores/auth-store';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ActionMenu, type ActionMenuEntry } from './ActionMenu';
import { Button } from './ui';
import './chat-first-workbench.css';

export function ChatFirstOutputBoundary({
  conversation,
  children,
}: {
  conversation: boolean;
  children: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  if (conversation) {
    return (
      <div className="h-full" data-ai-input-region="conversation">
        {children}
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className="flex shrink-0 items-center justify-end bg-bg-muted px-2 py-1"
        data-ai-input-region="navigation"
      >
        <Button
          variant="appbar"
          data-testid="output-edit-toggle"
          aria-pressed={editing}
          onClick={() => setEditing(!editing)}
        >
          {editing ? 'Done editing' : 'Edit'}
        </Button>
      </div>
      <div
        className={`min-h-0 flex-1 ${editing ? '' : 'chat-first-output'}`}
        data-ai-input-region={editing ? 'manual' : 'output'}
      >
        {children}
      </div>
    </div>
  );
}

export function ChatFirstWorkbench({
  children,
  onOpenChat,
  onNewChat,
  actions = [],
}: {
  children: ReactNode;
  onOpenChat: () => void;
  onNewChat: () => void;
  actions?: readonly ActionMenuEntry[];
}) {
  const opened = useRef(false);
  const addRef = useRef<HTMLButtonElement>(null);
  const [addOpen, setAddOpen] = useState(false);
  useEffect(() => {
    useAuthStore.getState().init();
  }, []);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    onOpenChat();
  }, [onOpenChat]);
  return (
    <div className="flex h-screen flex-col bg-bg text-fg" data-testid="chat-first-workbench">
      <header
        data-ai-input-region="navigation"
        className="flex items-center gap-3 bg-bg-muted px-4 py-3"
      >
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-medium">DNAForge · Chat-first experiment</h1>
          <p className="text-xs text-fg-muted">
            Start with chat. Inspect results directly, or choose Edit for a quick correction.
          </p>
        </div>
        <div data-ai-input-region="manual">
          <Button
            ref={addRef}
            variant="appbar"
            aria-haspopup="menu"
            aria-expanded={addOpen}
            onClick={() => setAddOpen(!addOpen)}
          >
            Add
          </Button>
          <ActionMenu
            open={addOpen}
            label="Add to project"
            anchorRef={addRef}
            entries={actions}
            onClose={() => setAddOpen(false)}
          />
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
