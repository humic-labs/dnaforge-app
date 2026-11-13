import type Database from 'better-sqlite3';
import { join } from 'node:path';
import type { NativeWorkspaceManifest } from '../shared/native-workspace-manifest';

export function nativeLimsEndpointPresent(
  db: Database.Database,
  workspace: { id: number; path: string },
  portable: NativeWorkspaceManifest['entities'][number] | undefined,
  id: string
): boolean {
  const row = db.prepare('SELECT workspace_id FROM lims_entity WHERE id=?').get(id) as
    | { workspace_id: number | null }
    | undefined;
  if (row) {
    if (row.workspace_id !== workspace.id)
      throw new Error('Native relationship endpoint belongs to another workspace.');
    return true;
  }
  if (portable && 'placement' in portable && portable.placement.kind === 'file') {
    const missing = db
      .prepare(
        `SELECT 1 FROM catalog_entities c
      JOIN catalog_entity_files f ON f.entity_id=c.id
      WHERE c.id=? AND c.workspace_id=? AND f.workspace_id=? AND f.path=? AND f.status='missing'`
      )
      .get(id, workspace.id, workspace.id, join(workspace.path, portable.placement.relativePath));
    if (missing) return false;
  }
  throw new Error('Native relationship endpoint is not in this workspace.');
}
