import { useCallback } from 'react';

export function TerminalPaneTarget({
  id,
  onTarget,
}: {
  id: string;
  onTarget(id: string, element: HTMLDivElement | null): void;
}) {
  const attach = useCallback(
    (element: HTMLDivElement | null) => onTarget(id, element),
    [id, onTarget]
  );
  return <div ref={attach} className="dnaforge-terminal-pane-target" />;
}
