import { useEffect } from 'react';
import { useWorkspaceStore } from '../stores/workspaceStore';
import type { WorkspaceActivationOptions } from '../features/workspace-session/desktop-selection';
export { WORKSPACE_PATH_KEY } from '../features/workspace-session/desktop-selection';

export interface WorkspaceState {
  path: string | null;
  loading: boolean;
  error: string | null;
}
export interface UseWorkspaceReturn extends WorkspaceState {
  selectWorkspace: () => Promise<string | null>;
  setWorkspacePath: (path: string, options?: WorkspaceActivationOptions) => Promise<void>;
  clearWorkspace: () => Promise<void>;
  refresh: () => Promise<void>;
}

export function useWorkspace(): UseWorkspaceReturn {
  const state = useWorkspaceStore((state) => state.workspaceSelection);
  const commands = useWorkspaceStore.getState();
  useEffect(() => {
    void commands.initializeWorkspaceSelection();
  }, [commands.initializeWorkspaceSelection]);
  return {
    path: state.path,
    loading: state.phase === 'uninitialized' || state.phase === 'restoring',
    error: state.error,
    selectWorkspace: commands.selectWorkspaceDirectory,
    setWorkspacePath: commands.activateWorkspace,
    clearWorkspace: commands.clearWorkspaceSelection,
    refresh: commands.refreshWorkspaceSelection,
  };
}
