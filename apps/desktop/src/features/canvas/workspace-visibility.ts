import { createContext, useContext } from 'react';

export const WorkspaceVisibilityContext = createContext(true);

export function useWorkspaceVisibility(): boolean {
  return useContext(WorkspaceVisibilityContext);
}
