import { useDesignStore } from '../design/public/store';
import { usePageStore } from '../page/public/store';
import { useSequenceStore } from '../sequence/public/store';
import { useStructureDrawerStore } from '../structure-drawer/public/state/use-structure-drawer-store';

export interface DomainStateSnapshot {
  store_revisions: Record<string, number>;

  workspace_path: string | null;

  captured_at: string;
}

interface RevisionedStoreLike {
  getState(): unknown;
}

const REVISIONED_STORES: ReadonlyArray<readonly [string, RevisionedStoreLike]> = [
  ['sequence', useSequenceStore],
  ['design', useDesignStore],
  ['page', usePageStore],
  ['structureDrawer', useStructureDrawerStore],
];

function readRevision(store: RevisionedStoreLike): number | null {
  try {
    const state = store.getState() as { revision?: unknown };
    if (typeof state?.revision === 'number' && Number.isFinite(state.revision)) {
      return state.revision;
    }
    return null;
  } catch {
    return null;
  }
}

export function captureDomainStateSnapshot(workspacePath: string | null): DomainStateSnapshot {
  const store_revisions: Record<string, number> = {};
  for (const [name, store] of REVISIONED_STORES) {
    const revision = readRevision(store);
    if (revision !== null) {
      store_revisions[name] = revision;
    }
  }
  return {
    store_revisions,
    workspace_path: workspacePath,
    captured_at: new Date().toISOString(),
  };
}
