import type { ResidueSelectionsStore, SelectedCodonsStore } from '@waypoint/workspace-editor';

const workspaceResidueSelectionStores = new Map<string, ResidueSelectionsStore>();
const workspaceResidueSelectionStoreListeners = new Set<() => void>();
let workspaceResidueSelectionStoreVersion = 0;

function emitWorkspaceResidueSelectionStoreChange(): void {
  workspaceResidueSelectionStoreVersion += 1;
  for (const listener of workspaceResidueSelectionStoreListeners) listener();
}

export function registerWorkspaceResidueSelectionsStore(
  entityId: string,
  store: ResidueSelectionsStore
): () => void {
  const previous = workspaceResidueSelectionStores.get(entityId);
  workspaceResidueSelectionStores.set(entityId, store);
  if (previous !== store) emitWorkspaceResidueSelectionStoreChange();

  return () => {
    if (workspaceResidueSelectionStores.get(entityId) === store) {
      workspaceResidueSelectionStores.delete(entityId);
      emitWorkspaceResidueSelectionStoreChange();
    }
  };
}

export function getWorkspaceResidueSelectionsStore(
  entityId: string
): ResidueSelectionsStore | null {
  return workspaceResidueSelectionStores.get(entityId) ?? null;
}

export function subscribeWorkspaceResidueSelectionsStores(listener: () => void): () => void {
  workspaceResidueSelectionStoreListeners.add(listener);
  return () => workspaceResidueSelectionStoreListeners.delete(listener);
}

export function getWorkspaceResidueSelectionsStoreVersion(): number {
  return workspaceResidueSelectionStoreVersion;
}

export function registerWorkspaceSelectedCodonsStore(
  entityId: string,
  store: SelectedCodonsStore
): () => void {
  return registerWorkspaceResidueSelectionsStore(entityId, store);
}

export function getWorkspaceSelectedCodonsStore(entityId: string): SelectedCodonsStore | null {
  return getWorkspaceResidueSelectionsStore(entityId);
}
