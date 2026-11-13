import type { ReactNode } from 'react';
import { CommandScopeProvider } from '../commands/CommandScopeProvider';
import { PresentationBoundary } from '../presentation/PresentationSurface';
import { useDocumentSaveCommand } from '../shared/use-document-lifecycle';

export function DocumentSaveCommands() {
  useDocumentSaveCommand();
  return null;
}

export function WorkspaceCommandProvider({ children }: { children: ReactNode }) {
  return (
    <PresentationBoundary id="workspace" focused>
      <CommandScopeProvider>{children}</CommandScopeProvider>
    </PresentationBoundary>
  );
}
