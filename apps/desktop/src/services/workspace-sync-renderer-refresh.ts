import type {
  WorkspaceSyncReplicaAppliedEvent,
  WorkspaceSyncReplicaLifecycleEvent,
  WorkspaceSyncReplicaPreparingEvent,
} from '../shared/workspace-sync-ipc';
import type {
  WorkspaceRendererMutationEvent,
  WorkspaceRendererMutationPreparingEvent,
} from '../shared/workspace-renderer-mutation';
import {
  prepareWorkspaceRendererMutation,
  abortWorkspaceRendererMutation,
  refreshWorkspaceRendererMutation,
  handleWorkspaceRendererMutationWithStores,
  type WorkspaceRendererMutationRefreshDeps,
} from './workspace-renderer-mutation';

export type WorkspaceSyncRendererRefreshDeps = WorkspaceRendererMutationRefreshDeps;
const preparedCloudRoots = new Map<string, { deliveryId: string; workspaceRoot: string }>();
function preparing(
  event: WorkspaceSyncReplicaPreparingEvent
): WorkspaceRendererMutationPreparingEvent {
  return {
    phase: 'preparing',
    deliveryId: event.deliveryId,
    workspaceRoot: event.workspaceRoot,
    source: {
      kind: 'cloud-sync',
      workspaceUuid: event.workspaceUuid,
      remoteVersionId: event.remoteVersionId,
    },
    affectedNotebookIds: event.affectedNotebookIds,
    affectedDesignIds: event.affectedDesignIds,
    affectedEntityIds: [...new Set([...event.affectedNotebookIds, ...event.affectedDesignIds])],
  };
}
function mutation(event: WorkspaceSyncReplicaLifecycleEvent): WorkspaceRendererMutationEvent {
  if (event.phase === 'aborted')
    return {
      phase: 'released',
      deliveryId: event.deliveryId,
      workspaceRoot: event.workspaceRoot,
      source: {
        kind: 'cloud-sync',
        workspaceUuid: event.workspaceUuid,
        remoteVersionId: event.remoteVersionId,
      },
      disposition: event.committed ? 'needs-recovery' : 'unchanged',
    };
  const base = preparing({ ...event, phase: 'preparing' });
  if (event.phase === 'preparing') return base;
  return {
    ...base,
    phase: 'applied',
    mutationToken: event.mutationToken,
    changedPaths: event.changedPaths,
    deletedPaths: event.deletedPaths,
    deletedDesignIds: event.deletedDesignIds,
    deletedEntityIds: event.deletedDesignIds,
    ...(event.warnings ? { warnings: event.warnings } : {}),
  };
}
export function prepareWorkspaceSyncReplicaInRenderer(
  event: WorkspaceSyncReplicaPreparingEvent
): void {
  prepareWorkspaceRendererMutation(preparing(event));
  preparedCloudRoots.set(event.workspaceUuid, {
    deliveryId: event.deliveryId,
    workspaceRoot: event.workspaceRoot,
  });
}
export function abortWorkspaceSyncReplicaInRenderer(event: {
  deliveryId: string;
  workspaceUuid: string;
}): void {
  const prepared = preparedCloudRoots.get(event.workspaceUuid);
  if (!prepared || prepared.deliveryId !== event.deliveryId) return;
  abortWorkspaceRendererMutation(prepared);
  preparedCloudRoots.delete(event.workspaceUuid);
}
export async function refreshWorkspaceSyncReplicaInRenderer(
  event: WorkspaceSyncReplicaAppliedEvent,
  deps: WorkspaceSyncRendererRefreshDeps
): Promise<void> {
  const applied = mutation(event);
  if (applied.phase !== 'applied') throw new Error('Expected an applied cloud mutation.');
  await refreshWorkspaceRendererMutation(applied, deps);
}
export async function handleWorkspaceSyncReplicaLifecycleWithStores(
  event: WorkspaceSyncReplicaLifecycleEvent
): Promise<void> {
  await handleWorkspaceRendererMutationWithStores(mutation(event));
  if (event.phase === 'preparing')
    preparedCloudRoots.set(event.workspaceUuid, {
      deliveryId: event.deliveryId,
      workspaceRoot: event.workspaceRoot,
    });
  else preparedCloudRoots.delete(event.workspaceUuid);
}
