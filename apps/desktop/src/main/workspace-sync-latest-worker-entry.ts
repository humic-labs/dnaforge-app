import { preferCurrentThread } from './thread-scheduling.cjs';
import { parentPort } from 'node:worker_threads';

import { parseAndValidateDesktopSyncLatestResponse } from './workspace-sync-latest-worker-job';

preferCurrentThread('userInitiated');

export type WorkspaceSyncLatestWorkerResponse =
  | Readonly<{
      type: 'result';
      latest: ReturnType<typeof parseAndValidateDesktopSyncLatestResponse>;
    }>
  | Readonly<{ type: 'error'; error: { name: string; message: string } }>;

if (!parentPort) throw new Error('Workspace sync latest worker started without a parent port.');

parentPort.once('message', (bytes: Uint8Array) => {
  try {
    post({ type: 'result', latest: parseAndValidateDesktopSyncLatestResponse(bytes) });
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    post({ type: 'error', error: { name: normalized.name, message: normalized.message } });
  }
});

function post(response: WorkspaceSyncLatestWorkerResponse): void {
  parentPort?.postMessage(response);
}
