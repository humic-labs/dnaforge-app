import type { HoveredCodonStore } from '@waypoint/workspace-editor';

const workspaceCodonStores = new Map<string, HoveredCodonStore>();

export function registerWorkspaceCodonStore(
  entityId: string,
  store: HoveredCodonStore
): () => void {
  workspaceCodonStores.set(entityId, store);
  return () => {
    if (workspaceCodonStores.get(entityId) === store) {
      workspaceCodonStores.delete(entityId);
    }
  };
}

export function getWorkspaceCodonStore(entityId: string): HoveredCodonStore | null {
  return workspaceCodonStores.get(entityId) ?? null;
}
