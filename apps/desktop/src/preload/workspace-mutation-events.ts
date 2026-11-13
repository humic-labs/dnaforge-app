import { rendererIpc } from '../shared/ipc-contract';
import type {
  WorkspaceRendererMutationEvent,
  WorkspaceRendererMutationEvents,
  WorkspaceRendererMutationAck,
} from '../shared/workspace-renderer-mutation';

export function createWorkspaceMutationEvents(): WorkspaceRendererMutationEvents {
  return {
    onLifecycle(callback) {
      const acknowledge = (event: WorkspaceRendererMutationEvent, error?: unknown) => {
        if (event.phase === 'released') return;
        const ack: WorkspaceRendererMutationAck =
          error === undefined
            ? { deliveryId: event.deliveryId, phase: event.phase, status: 'ok' }
            : {
                deliveryId: event.deliveryId,
                phase: event.phase,
                status: 'failed',
                error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
              };
        rendererIpc.send('workspace:mutationAck', ack);
      };
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: WorkspaceRendererMutationEvent
      ) => {
        void Promise.resolve()
          .then(() => callback(payload))
          .then(
            () => acknowledge(payload),
            (error: unknown) => acknowledge(payload, error ?? new Error('Document refresh failed'))
          );
      };
      rendererIpc.on('workspace:mutation', listener);
      return () => rendererIpc.removeListener('workspace:mutation', listener);
    },
  };
}
