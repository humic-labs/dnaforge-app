import { useLayoutEffect, useRef } from 'react';
import { useTerminalEditorTargets } from './terminal-placement';
import './terminal.css';

export function TerminalEditorTab({
  groupId,
  active,
  visible,
  onFocus,
}: {
  groupId: string;
  active: boolean;
  visible: boolean;
  onFocus(): void;
}) {
  const target = useRef<HTMLDivElement>(null);
  const chrome = useRef<HTMLDivElement>(null);
  const register = useTerminalEditorTargets((state) => state.register);
  useLayoutEffect(() => {
    if (target.current && chrome.current)
      return register(groupId, {
        element: target.current,
        chrome: chrome.current,
        active,
        visible,
        focus: onFocus,
      });
  }, [groupId, active, visible, onFocus, register]);
  return (
    <section
      className="dnaforge-terminal-editor bg-bg text-fg"
      aria-label="Terminal editor"
      data-testid="terminal-editor"
    >
      <div ref={chrome} className="dnaforge-terminal-editor-chrome" />
      <div ref={target} className="dnaforge-terminal-editor-target" />
    </section>
  );
}
