import type { IpcMainEvent, WebContents } from 'electron';
import type { WorkspaceRendererMutationPreparingNotice } from '../shared/workspace-renderer-mutation';
import { mainIpc, sendRendererIpc } from '../shared/ipc-contract';
import type {
  NativeAnnotationDocument,
  NativeAnnotationDocumentBarrier,
} from './managed-annotation-document-command';
import { WorkspaceRendererMutationPublisher } from './workspace-renderer-mutation-publisher';
import { getShellReadiness } from './ipc/shell-readiness';

export function createNativeDocumentRendererPublisher(
  getTarget: () => WebContents | null
): WorkspaceRendererMutationPublisher {
  return new WorkspaceRendererMutationPublisher({
    getTarget() {
      const contents = getTarget();
      if (!contents || contents.isDestroyed()) return null;
      const readiness = getShellReadiness(contents);
      return readiness?.shellReady
        ? {
            id: contents.id,
            generation: readiness.loadId,
            isDestroyed: () => contents.isDestroyed(),
          }
        : null;
    },
    send(target, event) {
      const current = getTarget();
      if (!current || current.isDestroyed() || current.id !== target.id) {
        throw new Error('The document editing client is no longer connected.');
      }
      sendRendererIpc(current, 'workspace:mutation', event);
    },
    subscribeAck(listener) {
      const handler = (event: IpcMainEvent, ack: unknown) => listener(event.sender.id, ack);
      mainIpc.on('workspace:mutationAck', handler);
      return () => mainIpc.removeListener('workspace:mutationAck', handler);
    },
    reloadTarget(target) {
      const current = getTarget();
      if (current && !current.isDestroyed() && current.id === target.id) current.reload();
    },
  });
}

export function createNativeDocumentMutationBarrier(
  publisher: WorkspaceRendererMutationPublisher,
  actionId: string
): (document: NativeAnnotationDocument) => Promise<NativeAnnotationDocumentBarrier> {
  return async (input) => {
    const document = { ...input };
    const notice: WorkspaceRendererMutationPreparingNotice = {
      workspaceRoot: document.workspaceRoot,
      source: {
        kind: 'document-command',
        actionId,
        documentId: document.documentId,
        sourcePath: document.sourcePath,
      },
      affectedNotebookIds: [],
      affectedDesignIds: [],
      affectedEntityIds: [document.documentId],
    };
    const id = await publisher.prepare(notice);
    if (!id) throw new Error('No connected editing client acknowledged document protection.');
    let settled = false;
    return {
      assertCurrent() {
        if (settled) throw new Error('The document editing barrier was already released.');
        publisher.assertPrepared(id, notice);
      },
      async finish() {
        if (settled) throw new Error('The document editing barrier was already released.');
        await publisher.publish(id, {
          ...notice,
          changedPaths: [document.sourcePath],
          deletedPaths: [],
          deletedDesignIds: [],
          deletedEntityIds: [],
        });
        settled = true;
        return 'refreshed';
      },
      abort(disposition) {
        if (settled) return;
        settled = true;
        publisher.abort(id, notice, disposition);
      },
    };
  };
}
