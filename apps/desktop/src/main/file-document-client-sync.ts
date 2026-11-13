import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import { sendRendererIpc } from '../shared/ipc-contract';

import type {
  FileDocumentClientFlushAck,
  FileDocumentFlushPurpose,
} from '../shared/file-document-client-sync';

export type FileDocumentClientReadinessReader = (
  target: WebContents
) => { shellReady: boolean; loadId: string } | null | undefined;
export function createFileDocumentClientSync(
  getTarget: () => WebContents | null,
  getReadiness: FileDocumentClientReadinessReader
) {
  let pending: {
    senderId: number;
    loadId: string;
    requestId: string;
    purpose: FileDocumentFlushPurpose;
    promise: Promise<void>;
    resolve(): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  return {
    hasLiveTarget(): boolean {
      const target = getTarget();
      return !!target && !target.isDestroyed();
    },
    flush(purpose: FileDocumentFlushPurpose = 'synchronize'): Promise<void> {
      const target = getTarget();
      const readiness = target && !target.isDestroyed() ? getReadiness(target) : null;
      if (!target || !readiness)
        throw new Error(
          'FILE_DOCUMENT_CLIENT_NOT_READY: The editing client has not reached its native synchronization boundary.'
        );
      if (!readiness.shellReady) {
        if (pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error('FILE_DOCUMENT_CLIENT_CHANGED'));
          pending = null;
        }
        return Promise.resolve();
      }
      if (pending && pending.senderId === target.id && pending.loadId === readiness.loadId) {
        if (pending.purpose === purpose) return pending.promise;
        return pending.promise.catch(() => {}).then(() => this.flush(purpose));
      }
      if (pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error('FILE_DOCUMENT_CLIENT_CHANGED'));
        pending = null;
      }
      const requestId = randomUUID();
      let resolve!: () => void, reject!: (error: Error) => void;
      const promise = new Promise<void>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      const timer = setTimeout(() => {
        if (pending?.requestId !== requestId) return;
        pending = null;
        reject(
          new Error(
            'FILE_DOCUMENT_CLIENT_SYNC_TIMEOUT: The editing client did not acknowledge its pending transactions.'
          )
        );
      }, 5000);
      pending = {
        senderId: target.id,
        loadId: readiness.loadId,
        requestId,
        purpose,
        promise,
        resolve,
        reject,
        timer,
      };
      sendRendererIpc(target, 'fs:fileDocumentFlush', {
        requestId,
        loadId: readiness.loadId,
        purpose,
      });
      return promise;
    },
    acknowledge(sender: WebContents, ack: FileDocumentClientFlushAck): boolean {
      const active = pending;
      if (
        !active ||
        sender.isDestroyed() ||
        sender.id !== active.senderId ||
        ack?.requestId !== active.requestId ||
        ack?.loadId !== active.loadId ||
        (ack.purpose ?? 'synchronize') !== active.purpose ||
        getReadiness(sender)?.loadId !== active.loadId
      )
        return false;
      clearTimeout(active.timer);
      pending = null;
      if (ack.success === true) active.resolve();
      else
        active.reject(
          new Error(
            `FILE_DOCUMENT_CLIENT_UNSYNCHRONIZED: ${typeof ack.error === 'string' ? ack.error.slice(0, 1000) : 'An editing client could not settle its pending transactions.'}`
          )
        );
      return true;
    },
    close(): void {
      if (pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error('FILE_DOCUMENT_CLIENT_GONE'));
        pending = null;
      }
    },
  };
}
