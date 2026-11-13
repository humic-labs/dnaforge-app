import type Database from 'better-sqlite3';
import type { SettleEntityProjectionSourceInput } from '../../shared/entity-projection-source';

export function settleProjectionSourceForTest(
  db: Database.Database,
  { key, fingerprint }: SettleEntityProjectionSourceInput
): void {
  db.prepare(
    `INSERT INTO entity_projection_sources
    (adapter_kind,entity_id,workspace_key,relative_path,projection_version,synchronized_fingerprint,synchronized_at)
    VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(adapter_kind,entity_id,workspace_key,relative_path,projection_version)
    DO UPDATE SET synchronized_fingerprint=excluded.synchronized_fingerprint,synchronized_at=excluded.synchronized_at`
  ).run(
    key.adapterKind,
    key.entityId,
    key.workspaceKey,
    key.relativePath,
    key.projectionVersion,
    fingerprint,
    Date.now()
  );
}
