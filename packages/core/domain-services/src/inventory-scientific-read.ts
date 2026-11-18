import type { InventoryScientificWork } from './inventory-scientific-types';
import type { InventoryState } from './inventory-types';

export interface InventoryScientificContextIdentity {
  readonly projectId: string;
  readonly workspaceScope: string;
  readonly kind: 'notebook-page' | 'protocol-run';
  readonly entityId: string;
}

export function inventoryScientificWorksForContext(
  state: Pick<InventoryState, 'scientificWorks'>,
  identity: InventoryScientificContextIdentity
): readonly InventoryScientificWork[] {
  return Object.values(state.scientificWorks)
    .filter((work) => {
      const context = work.context;
      return (
        context.projectId === identity.projectId &&
        context.workspaceScope === identity.workspaceScope &&
        context.kind === identity.kind &&
        (context.kind === 'notebook-page' ? context.pageId : context.entityId) === identity.entityId
      );
    })
    .sort(
      (left, right) => left.at - right.at || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    )
    .map((work) => structuredClone(work));
}
