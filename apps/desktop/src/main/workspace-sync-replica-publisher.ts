import type {
  WorkspaceSyncReplicaAppliedEvent,
  WorkspaceSyncReplicaAbortedEvent,
  WorkspaceSyncReplicaLifecycleEvent,
  WorkspaceSyncReplicaPreparingEvent,
} from '../shared/workspace-sync-ipc';
import type {
  WorkspaceRendererMutationEvent,
  WorkspaceRendererMutationPreparingNotice,
} from '../shared/workspace-renderer-mutation';
import {
  WorkspaceRendererMutationPublisher,
  type WorkspaceRendererMutationPublisherDeps,
  type WorkspaceRendererMutationTarget,
} from './workspace-renderer-mutation-publisher';

export type WorkspaceSyncReplicaAppliedNotice = Omit<
  WorkspaceSyncReplicaAppliedEvent,
  'deliveryId' | 'phase' | 'mutationToken'
>;
export type WorkspaceSyncReplicaPreparingNotice = Omit<
  WorkspaceSyncReplicaPreparingEvent,
  'deliveryId' | 'phase'
>;
type WorkspaceSyncReplicaAbortedNotice = Omit<
  WorkspaceSyncReplicaAbortedEvent,
  'deliveryId' | 'phase'
>;
export type WorkspaceSyncReplicaRendererTarget = WorkspaceRendererMutationTarget;
export interface WorkspaceSyncReplicaPublisherDeps extends Omit<
  WorkspaceRendererMutationPublisherDeps,
  'send'
> {
  send(target: WorkspaceSyncReplicaRendererTarget, event: WorkspaceSyncReplicaLifecycleEvent): void;
}

function preparing(
  notice: WorkspaceSyncReplicaPreparingNotice
): WorkspaceRendererMutationPreparingNotice {
  return {
    workspaceRoot: notice.workspaceRoot,
    source: {
      kind: 'cloud-sync',
      workspaceUuid: notice.workspaceUuid,
      remoteVersionId: notice.remoteVersionId,
    },
    affectedNotebookIds: notice.affectedNotebookIds,
    affectedDesignIds: notice.affectedDesignIds,
    affectedEntityIds: [...new Set([...notice.affectedNotebookIds, ...notice.affectedDesignIds])],
  };
}

function cloudEvent(event: WorkspaceRendererMutationEvent): WorkspaceSyncReplicaLifecycleEvent {
  if (event.source.kind !== 'cloud-sync')
    throw new Error('Cloud handoff received another mutation source.');
  const base = {
    deliveryId: event.deliveryId,
    workspaceRoot: event.workspaceRoot,
    workspaceUuid: event.source.workspaceUuid,
    remoteVersionId: event.source.remoteVersionId,
  };
  if (event.phase === 'released')
    return {
      ...base,
      phase: 'aborted',
      ...(event.disposition === 'needs-recovery' ? { committed: true } : {}),
    };
  const affected = {
    affectedNotebookIds: event.affectedNotebookIds,
    affectedDesignIds: event.affectedDesignIds,
  };
  if (event.phase === 'preparing') return { ...base, ...affected, phase: 'preparing' };
  return {
    ...base,
    ...affected,
    phase: 'applied',
    mutationToken: event.mutationToken,
    changedPaths: event.changedPaths,
    deletedPaths: event.deletedPaths,
    deletedDesignIds: event.deletedDesignIds,
    ...(event.warnings ? { warnings: event.warnings } : {}),
  };
}

export class WorkspaceSyncReplicaPublisher {
  private readonly publisher: WorkspaceRendererMutationPublisher;
  constructor(deps: WorkspaceSyncReplicaPublisherDeps) {
    this.publisher = new WorkspaceRendererMutationPublisher({
      ...deps,
      send: (target, event) => deps.send(target, cloudEvent(event)),
    });
  }
  start(): void {
    this.publisher.start();
  }
  stop(): void {
    this.publisher.stop();
  }
  prepare(notice: WorkspaceSyncReplicaPreparingNotice): Promise<string | null> {
    return this.publisher.prepare(preparing(notice));
  }
  publish(id: string | null, notice: WorkspaceSyncReplicaAppliedNotice): Promise<void> {
    return this.publisher.publish(id, {
      ...preparing(notice),
      changedPaths: notice.changedPaths,
      deletedPaths: notice.deletedPaths,
      deletedDesignIds: notice.deletedDesignIds,
      deletedEntityIds: notice.deletedDesignIds,
      ...(notice.warnings ? { warnings: notice.warnings } : {}),
    });
  }
  abort(id: string | null, notice: WorkspaceSyncReplicaAbortedNotice): void {
    this.publisher.abort(
      id,
      {
        workspaceRoot: notice.workspaceRoot,
        source: {
          kind: 'cloud-sync',
          workspaceUuid: notice.workspaceUuid,
          remoteVersionId: notice.remoteVersionId,
        },
      },
      notice.committed ? 'needs-recovery' : 'unchanged'
    );
  }
}
