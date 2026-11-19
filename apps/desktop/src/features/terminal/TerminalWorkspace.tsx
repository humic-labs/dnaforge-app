import { useLayoutEffect, useRef } from 'react';
import { create } from 'zustand';
import { PresentationBoundary } from '../../presentation/PresentationSurface';
import './terminal.css';

interface WorkspaceTarget {
  element: HTMLElement;
  chrome: HTMLElement;
  sidebar: HTMLElement;
  visible: boolean;
}

export const useTerminalWorkspaceTarget = create<{
  target: WorkspaceTarget | null;
  register(target: WorkspaceTarget): () => void;
}>((set) => ({
  target: null,
  register: (target) => {
    set({ target });
    return () => set((state) => (state.target === target ? { target: null } : state));
  },
}));

export function TerminalWorkspace({ active = true }: { active?: boolean }) {
  const sidebar = useRef<HTMLElement>(null);
  const chrome = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const register = useTerminalWorkspaceTarget((state) => state.register);
  useLayoutEffect(() => {
    if (sidebar.current && chrome.current && content.current)
      return register({
        sidebar: sidebar.current,
        chrome: chrome.current,
        element: content.current,
        visible: active,
      });
  }, [active, register]);
  return (
    <PresentationBoundary id="terminal-workspace" active={active}>
      <section
        aria-label="Terminal workspace"
        className="dnaforge-terminal-workspace"
        style={{ display: active ? 'flex' : 'none' }}
        data-testid="terminal-workspace"
      >
        <aside
          ref={sidebar}
          aria-label="Terminals"
          data-terminal-sidebar
          data-testid="terminal-sidebar"
        />
        <div
          role="region"
          aria-label="Selected terminal"
          className="dnaforge-terminal-workspace-main"
        >
          <div ref={chrome} className="dnaforge-terminal-editor-chrome" />
          <div ref={content} className="dnaforge-terminal-editor-target" />
        </div>
      </section>
    </PresentationBoundary>
  );
}
