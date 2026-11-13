import type { HoveredResidueStore } from './hovered-residue-store';

const _registry = new Map<string, HoveredResidueStore>();

export function registerWorkspaceResidueStore(
  entityId: string,
  store: HoveredResidueStore
): () => void {
  _registry.set(entityId, store);
  return () => {
    if (_registry.get(entityId) === store) {
      _registry.delete(entityId);
    }
  };
}

export function getWorkspaceResidueStore(entityId: string): HoveredResidueStore | null {
  return _registry.get(entityId) ?? null;
}
