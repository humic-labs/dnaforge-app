import type { EntityNavigationTarget } from '../shared/entity-navigation';
import { openWorkTask } from '../features/work/public/work';
import {
  presentResolvedReference,
  type ReferenceNavigationOptions,
} from '../features/ai/public/navigate-to-reference';
import {
  dispatchReferenceEvent,
  referenceIntent,
  type ReferenceIntent,
} from '../features/page/public/reference-workflow';
import {
  mountOwner,
  mountReferenceOwners,
  resolveEntityNavigationTarget,
} from './entity-navigation-resolution';

export {
  referenceEntityIdentity,
  referenceNavigationLinks,
  resolveEntityProjectRoot,
  resolveEntityNavigationTarget,
  resolveReferenceNavigation,
} from './entity-navigation-resolution';

function presentEntityEvent(detail: { entityType: string; entityId: string; owningRoot?: string }) {
  return new Promise<{ entityId: string }>((resolve, reject) => {
    const tracked = referenceIntent({});
    const intent: ReferenceIntent = {
      get finished() {
        return tracked.finished;
      },
      finish(disposition) {
        if (tracked.finished) return;
        tracked.finish(disposition);
        if (
          disposition.kind === 'registry_record' ||
          (disposition.kind === 'document' && disposition.result.status === 'presented')
        )
          resolve({ entityId: detail.entityId });
        else reject(new Error('The entity could not be presented.'));
      },
    };
    dispatchReferenceEvent(detail, intent);
  });
}

export async function openEntityNavigationTarget(
  target: EntityNavigationTarget,
  options?: ReferenceNavigationOptions
) {
  const resolved = await resolveEntityNavigationTarget(target);
  const root =
    resolved.kind === 'reference'
      ? resolved.reference.workspace_root_path
      : resolved.kind === 'catalog' || resolved.kind === 'work-task'
        ? resolved.root
        : null;
  if (root) await mountOwner(root);
  if (resolved.kind === 'work-task') {
    if (!openWorkTask({ workspaceRoot: resolved.root, taskId: resolved.taskId }))
      throw new Error('Finish the current task edit before opening another task.');
    return { entityId: resolved.taskId };
  }
  if (resolved.kind === 'reference') {
    await mountReferenceOwners(resolved.reference);
    return presentResolvedReference(resolved.reference, options);
  }
  return presentEntityEvent({
    entityType: resolved.kind === 'catalog' ? 'native-catalog-exact' : 'registry-entity',
    entityId: resolved.entityId,
    ...(resolved.kind === 'catalog' ? { owningRoot: resolved.root } : {}),
  });
}
