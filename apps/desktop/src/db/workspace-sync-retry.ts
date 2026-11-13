import { isWorkspaceSyncDatabaseBusyError } from '../shared/workspace-sync-errors';

const MAX_FENCE_WAIT_MS = 30_000;
const INITIAL_RETRY_MS = 25;
const MAX_RETRY_MS = 250;

export async function waitForWorkspaceSyncDatabase<T>(operation: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + MAX_FENCE_WAIT_MS;
  let delayMs = INITIAL_RETRY_MS;
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      const remainingMs = deadline - Date.now();
      if (!isWorkspaceSyncDatabaseBusyError(error) || remainingMs <= 0) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(delayMs, remainingMs)));
      delayMs = Math.min(delayMs * 2, MAX_RETRY_MS);
    }
  }
}
