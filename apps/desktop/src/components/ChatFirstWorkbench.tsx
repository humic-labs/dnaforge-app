import { useAuthStore } from '../stores/auth-store';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ActionMenu, type ActionMenuEntry } from './ActionMenu';
import { ApplicationTopBar } from './ApplicationTopBar';
import {
  ChevronRotatableIcon,
  FolderOpenIcon,
  ImportIcon,
  PlusIcon,
  ProjectRootIcon,
  SparklesIcon,
} from './icons';
import { Button } from './ui';
import { WindowsMenuBar } from './WindowsMenuBar';
import './chat-first-workbench.css';

export function ChatFirstOutputBoundary({
  conversation,
  children,
}: {
  conversation: boolean;
  children: ReactNode;
}) {
  return (
    <div className="h-full min-h-0" data-ai-input-region={conversation ? 'conversation' : 'manual'}>
      {children}
    </div>
  );
}

export function ChatFirstWorkbench({
  children,
  projectName,
  projectPickerOpen,
  onOpenProjects,
  onOpenChat,
  onBrowseFiles,
  onImport,
  documentActions,
}: {
  children: ReactNode;
  projectName: string | null;
  projectPickerOpen: boolean;
  onOpenProjects: (anchor: HTMLButtonElement) => void;
  onOpenChat: () => void;
  onBrowseFiles: () => void;
  onImport: () => void;
  documentActions: readonly ActionMenuEntry[];
}) {
  const opened = useRef(false);
  const newDocumentRef = useRef<HTMLButtonElement>(null);
  const [newDocumentOpen, setNewDocumentOpen] = useState(false);
  const desktopApi = window.electronAPI;
  const desktopPlatform = desktopApi && 'platform' in desktopApi ? desktopApi.platform : null;

  useEffect(() => {
    useAuthStore.getState().init();
  }, []);

  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    onOpenChat();
  }, [onOpenChat]);

  return (
    <div
      className="chat-first-workbench flex h-screen flex-col bg-bg text-fg"
      data-testid="chat-first-workbench"
    >
      <ApplicationTopBar
        windowControlsInset={desktopPlatform === 'darwin'}
        windowsTitleBar={desktopPlatform === 'win32'}
        menus={desktopPlatform === 'win32' ? <WindowsMenuBar /> : undefined}
        context={
          <div className="chat-first-project-control flex min-w-0 items-center gap-2 border-l border-border pl-2">
            <Button
              variant="appbar"
              aria-label={
                projectName ? `Switch project. Current project: ${projectName}` : 'Choose a project'
              }
              title={projectName ?? 'Choose a project'}
              aria-expanded={projectPickerOpen}
              data-testid="chat-first-project-picker"
              onClick={(event) => onOpenProjects(event.currentTarget)}
            >
              <ProjectRootIcon className="h-4 w-4 shrink-0 text-accent" />
              <span className="truncate">{projectName ?? 'Choose a project'}</span>
              <ChevronRotatableIcon
                expanded={projectPickerOpen}
                className="h-3 w-3 shrink-0 text-fg-muted"
              />
            </Button>
          </div>
        }
        controls={
          <>
            <Button
              variant="appbar"
              onClick={onOpenChat}
              aria-label="Focus chat"
              title="Focus chat"
            >
              <SparklesIcon size={14} className="text-accent" />
              <span className="appbar-action-label">Chat</span>
            </Button>
            <Button
              variant="appbar"
              onClick={onBrowseFiles}
              aria-label="Browse project files"
              title="Browse project files"
            >
              <FolderOpenIcon />
              <span className="appbar-action-label">Files</span>
            </Button>
            <Button
              variant="appbar"
              onClick={onImport}
              aria-label="Import file"
              title="Import file"
            >
              <ImportIcon />
              <span className="appbar-action-label">Import</span>
            </Button>
            <Button
              ref={newDocumentRef}
              variant="appbar"
              aria-label="New document"
              title="New document"
              aria-haspopup="menu"
              aria-expanded={newDocumentOpen}
              onClick={() => setNewDocumentOpen(!newDocumentOpen)}
            >
              <PlusIcon className="h-4 w-4" />
              <span className="appbar-action-label">New document</span>
            </Button>
            <ActionMenu
              open={newDocumentOpen}
              label="New document"
              anchorRef={newDocumentRef}
              entries={documentActions}
              onClose={() => setNewDocumentOpen(false)}
            />
          </>
        }
      />
      <main className="min-h-0 flex-1">{children}</main>
    </div>
  );
}
