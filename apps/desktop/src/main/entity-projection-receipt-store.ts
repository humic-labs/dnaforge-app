import type Database from 'better-sqlite3';
import type { EntityProjectionSourceKey } from '../shared/entity-projection-source';

export function writeEntityProjectionReceiptInDb(
  db: Database.Database,
  key: EntityProjectionSourceKey,
  fingerprint: string
): void {
  db.prepare(
    `INSERT INTO entity_projection_sources
     (adapter_kind,entity_id,workspace_key,relative_path,projection_version,synchronized_fingerprint,synchronized_at)
     VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(adapter_kind,entity_id,workspace_key,relative_path,projection_version)
     DO UPDATE SET synchronized_fingerprint=excluded.synchronized_fingerprint,
                   synchronized_at=excluded.synchronized_at
     WHERE entity_projection_sources.synchronized_fingerprint<>excluded.synchronized_fingerprint`
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
