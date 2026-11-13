import type Database from 'better-sqlite3';
import { isSafeRelativePath, WORKSPACE_SYNC_MANIFEST_MAX_FILES } from '@waypoint/share-bundle';

const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_REPLICA_PATHS = WORKSPACE_SYNC_MANIFEST_MAX_FILES * 3;

interface ReplicaIdentity {
  workspaceUuid: string;
  remoteWorkspaceId: string;
  remoteVersionId: string;
}

function recordKey(input: ReplicaIdentity): string {
  return `workspace_sync_replica_files:${encodeURIComponent(input.workspaceUuid)}:${encodeURIComponent(input.remoteWorkspaceId)}`;
}

export function validateWorkspaceSyncReplicaPaths(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_REPLICA_PATHS ||
    !value.every((path) => typeof path === 'string' && isSafeRelativePath(path))
  ) {
    throw new Error('The accepted sync version has invalid file paths.');
  }
  const paths = [...new Set(value as string[])].sort();
  if (Buffer.byteLength(JSON.stringify(paths), 'utf8') > MAX_RECORD_BYTES) {
    throw new Error('The accepted sync version file list is too large.');
  }
  return paths;
}

export function recordWorkspaceSyncReplicaFiles(
  db: Database.Database,
  input: ReplicaIdentity & { paths: readonly string[]; nowMs: number }
): void {
  const paths = validateWorkspaceSyncReplicaPaths(input.paths);
  db.prepare('INSERT OR REPLACE INTO settings(key, value, updated_at) VALUES (?, ?, ?)').run(
    recordKey(input),
    JSON.stringify({ schemaVersion: 1, remoteVersionId: input.remoteVersionId, paths }),
    input.nowMs
  );
}

export function readWorkspaceSyncReplicaFiles(
  db: Database.Database,
  input: ReplicaIdentity
): string[] | null {
  const row = db
    .prepare(
      'SELECT CASE WHEN length(value) <= ? THEN value END AS value FROM settings WHERE key = ?'
    )
    .get(MAX_RECORD_BYTES + 1024, recordKey(input)) as { value: string | null } | undefined;
  if (!row) return null;
  if (!row.value) throw new Error('The accepted sync version file list is too large.');
  const value: unknown = JSON.parse(row.value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The accepted sync version file list is invalid.');
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1)
    throw new Error('The accepted sync version file list is invalid.');
  if (record.remoteVersionId !== input.remoteVersionId) return null;
  return validateWorkspaceSyncReplicaPaths(record.paths);
}
