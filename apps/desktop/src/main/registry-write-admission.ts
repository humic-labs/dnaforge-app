import type Database from 'better-sqlite3';
import { assertWorkspaceWriteAllowed } from './workspace-write-admission';

export function assertRegistryEntityWriteAllowed(
  db: Database.Database,
  input: { id?: string; workspaceId?: number | null }
): void {
  const current = input.id
    ? (db.prepare('SELECT workspace_id FROM lims_entity WHERE id=?').get(input.id) as
        | { workspace_id: number | null }
        | undefined)
    : undefined;
  if (current && input.workspaceId !== undefined && input.workspaceId !== current.workspace_id)
    throw new Error(
      'REGISTRY_OWNER_REQUIRES_NATIVE_LIFECYCLE: The owning project cannot change through a Registry field edit.'
    );
  const canonical = input.id
    ? (db
        .prepare(
          "SELECT workspace_id FROM catalog_entity_files WHERE entity_id=? AND status='current' UNION SELECT workspace_id FROM catalog_entities WHERE id=?"
        )
        .all(input.id, input.id) as Array<{ workspace_id: number | null }>)
    : [];
  const sourceOwners = new Set(
    canonical.flatMap((row) => (row.workspace_id === null ? [] : [row.workspace_id]))
  );
  if (
    (sourceOwners.size === 1 &&
      input.workspaceId !== undefined &&
      input.workspaceId !== [...sourceOwners][0]) ||
    sourceOwners.size > 1 ||
    (current && sourceOwners.size === 1 && current.workspace_id !== [...sourceOwners][0])
  )
    throw new Error(
      'REGISTRY_OWNER_REQUIRES_NATIVE_LIFECYCLE: Registry and canonical source ownership disagree.'
    );
  const owners = new Set([current?.workspace_id, input.workspaceId, ...sourceOwners]);
  for (const id of owners) {
    if (id == null) continue;
    const owner = db.prepare('SELECT path FROM workspaces WHERE id=?').get(id) as
      | { path: string }
      | undefined;
    if (!owner) throw new Error('WORKSPACE_MUTATION_UNKNOWN_WORKSPACE');
    assertWorkspaceWriteAllowed(db, [owner.path]);
  }
}
