import type {
  WorkspaceSessionAdapter,
  WorkspaceSessionController,
} from '@waypoint/domain-services';
import { isHostedWorkspaceId } from './paths';

export interface WorkspaceSelectionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

type StorageSource = () => WorkspaceSelectionStorage | null;
const browserStorage: StorageSource = () =>
  typeof window === 'undefined' ? null : window.localStorage;
const keyForAccount = (accountId: string) =>
  `dnaforge.workspace-selection.v1:${encodeURIComponent(accountId)}`;

export function withHostedWorkspaceSelection(
  adapter: WorkspaceSessionAdapter,
  storage: StorageSource = browserStorage
): WorkspaceSessionAdapter {
  return {
    ...adapter,
    async listWorkspaces() {
      const index = await adapter.listWorkspaces();
      if (!index.principal) return index;
      try {
        const workspaceId = storage()?.getItem(keyForAccount(index.principal.id));
        return workspaceId && isHostedWorkspaceId(workspaceId)
          ? { ...index, preferredWorkspaceId: workspaceId }
          : index;
      } catch {
        return index;
      }
    },
  };
}

export function persistHostedWorkspaceSelection(
  controller: Pick<WorkspaceSessionController, 'getState' | 'subscribe'>,
  storage: StorageSource = browserStorage
): () => void {
  const remember = () => {
    const state = controller.getState();
    if (
      state.phase !== 'idle' ||
      !state.principal ||
      !state.activeWorkspaceId ||
      !isHostedWorkspaceId(state.activeWorkspaceId) ||
      state.snapshot?.workspaceId !== state.activeWorkspaceId
    ) {
      return;
    }
    try {
      storage()?.setItem(keyForAccount(state.principal.id), state.activeWorkspaceId);
    } catch {}
  };
  remember();
  return controller.subscribe(remember);
}
