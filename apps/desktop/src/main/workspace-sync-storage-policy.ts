import type Database from 'better-sqlite3';
import {
  parseWorkspaceSyncStoragePolicy,
  type WorkspaceSyncStoragePolicy,
} from '@waypoint/share-bundle';
import { DesktopSyncClientError, type DesktopSyncClient } from './desktop-sync-client';
import type { WorkspaceSyncEnableOptions } from '../shared/workspace-sync-ipc';

export async function readWorkspaceSyncStoragePolicy(
  client: DesktopSyncClient,
  remoteWorkspaceId: string,
  expectedAccountId: string,
  signal?: AbortSignal
): Promise<WorkspaceSyncStoragePolicy> {
  const value = await client.requestJson(
    `/api/desktop-sync/workspaces/${encodeURIComponent(remoteWorkspaceId)}/storage-policy`,
    { method: 'GET', expectedAccountId, signal, maxResponseBytes: 4096 }
  );
  try {
    return parseWorkspaceSyncStoragePolicy(value);
  } catch {
    throw new DesktopSyncClientError('BAD_RESPONSE', 'Storage policy is unavailable.', {
      retryable: true,
      terminal: false,
    });
  }
}

export async function readWorkspaceSyncCapturePolicy(
  db: Database.Database,
  input: {
    remoteWorkspaceId: string;
    expectedAccountId: string;
    readPolicy: () => Promise<WorkspaceSyncStoragePolicy>;
    runDatabase?: <T>(operation: () => T) => Promise<T>;
  }
): Promise<WorkspaceSyncStoragePolicy> {
  const key = `workspace_sync_storage_policy:${encodeURIComponent(input.expectedAccountId)}:${encodeURIComponent(input.remoteWorkspaceId)}`;
  const runDatabase = input.runDatabase ?? (async <T>(operation: () => T) => operation());
  try {
    const policy = parseWorkspaceSyncStoragePolicy(await input.readPolicy());
    await runDatabase(() =>
      db
        .prepare('INSERT OR REPLACE INTO settings(key, value, updated_at) VALUES (?, ?, ?)')
        .run(key, JSON.stringify(policy), Date.now())
    );
    return policy;
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
    if (code === 'NETWORK' || code === 'SERVER') {
      const row = await runDatabase(
        () =>
          db
            .prepare(
              'SELECT CASE WHEN length(value) <= 4096 THEN value END AS value FROM settings WHERE key = ?'
            )
            .get(key) as { value: string | null } | undefined
      );
      if (row?.value) {
        try {
          return parseWorkspaceSyncStoragePolicy(JSON.parse(row.value));
        } catch {
          await runDatabase(() => db.prepare('DELETE FROM settings WHERE key = ?').run(key));
        }
      }
    } else {
      await runDatabase(() => db.prepare('DELETE FROM settings WHERE key = ?').run(key));
    }
    throw error;
  }
}

export async function readWorkspaceSyncPreviewPolicy(
  db: Database.Database,
  client: DesktopSyncClient,
  workspaceUuid: string,
  expectedAccountId: string,
  options: WorkspaceSyncEnableOptions = {}
): Promise<WorkspaceSyncStoragePolicy> {
  const binding = db
    .prepare(
      'SELECT remote_workspace_id, owner_account_id FROM workspace_sync_bindings WHERE workspace_uuid = ?'
    )
    .get(workspaceUuid) as
    | {
        remote_workspace_id: string | null;
        owner_account_id: string;
      }
    | undefined;
  if (binding?.remote_workspace_id) {
    if (binding.owner_account_id !== expectedAccountId)
      throw new DesktopSyncClientError(
        'ACCOUNT_CHANGED',
        'This project belongs to a different signed-in account.',
        { retryable: false, terminal: true }
      );
    return readWorkspaceSyncCapturePolicy(db, {
      remoteWorkspaceId: binding.remote_workspace_id,
      expectedAccountId,
      readPolicy: () =>
        readWorkspaceSyncStoragePolicy(client, binding.remote_workspace_id!, expectedAccountId),
    });
  }
  const query =
    options.owner?.kind === 'org' ? `?orgId=${encodeURIComponent(options.owner.orgId)}` : '';
  const value = await client.requestJson(`/api/desktop-sync/account/storage-policy${query}`, {
    method: 'GET',
    expectedAccountId,
    maxResponseBytes: 4096,
  });
  try {
    return parseWorkspaceSyncStoragePolicy(value);
  } catch {
    throw new DesktopSyncClientError('BAD_RESPONSE', 'Storage policy is unavailable.', {
      retryable: true,
      terminal: false,
    });
  }
}
