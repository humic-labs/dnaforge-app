import type { UserMessage } from '@waypoint/user-messages';

export type WorkspaceRendererMutationSource =
  | {
      kind: 'cloud-sync';
      workspaceUuid: string;
      remoteVersionId: string;
    }
  | {
      kind: 'document-command';
      actionId: string;
      documentId: string;
      sourcePath: string;
    };

export interface WorkspaceRendererMutationIdentity {
  workspaceRoot: string;
  source: WorkspaceRendererMutationSource;
}
export interface WorkspaceRendererMutationPreparingNotice extends WorkspaceRendererMutationIdentity {
  affectedNotebookIds: string[];
  affectedDesignIds: string[];
  affectedEntityIds: string[];
}
export interface WorkspaceRendererMutationAppliedNotice extends WorkspaceRendererMutationPreparingNotice {
  changedPaths: string[];
  deletedPaths: string[];
  deletedDesignIds: string[];
  deletedEntityIds: string[];
  warnings?: UserMessage[];
}
export type WorkspaceRendererMutationRelease = 'unchanged' | 'needs-recovery';
export type WorkspaceRendererMutationEvent =
  | (WorkspaceRendererMutationPreparingNotice & { deliveryId: string; phase: 'preparing' })
  | (WorkspaceRendererMutationAppliedNotice & {
      deliveryId: string;
      phase: 'applied';
      mutationToken: string;
    })
  | (WorkspaceRendererMutationIdentity & {
      deliveryId: string;
      phase: 'released';
      disposition: WorkspaceRendererMutationRelease;
    });
export type WorkspaceRendererMutationAck = {
  deliveryId: string;
  phase: 'preparing' | 'applied';
} & ({ status: 'ok' } | { status: 'failed'; error?: string });
export type WorkspaceRendererMutationPreparingEvent = Extract<
  WorkspaceRendererMutationEvent,
  { phase: 'preparing' }
>;
export type WorkspaceRendererMutationAppliedEvent = Extract<
  WorkspaceRendererMutationEvent,
  { phase: 'applied' }
>;

export interface WorkspaceRendererMutationEvents {
  onLifecycle(
    callback: (event: WorkspaceRendererMutationEvent) => void | Promise<void>
  ): () => void;
}
