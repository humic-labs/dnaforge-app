import { FASTA_KIND_DECLARATION_EVENT } from '../shared/fasta-kind';
import { randomUUID } from 'node:crypto';
import type { CatalogFileFingerprint } from '../shared/catalog-registration';
import {
  normalizeWorkspaceTimestamp,
  type WorkspaceAccess,
  type WorkspaceOwnerDiscovery,
} from '../shared/workspace-access';
import { isAbsolutePathLike } from '../shared/path-boundary';
import type Database from 'better-sqlite3';
import type {
  CatalogEntityRollbackRequest,
  CatalogFileRebindRequest,
  CatalogProjectionClearResult,
} from '../shared/catalog-registration';
import type { CatalogFileBindingRow } from '../shared/catalog-binding';
import { pathIsAtOrUnder } from '../shared/path-boundary';
import { detectCatalogRelocationConflict, rebaseCatalogFileRefsInTx } from './workspace-relocate';

export function rebindCatalogFilesInDb(db: Database.Database, input: CatalogFileRebindRequest) {
  if (
    !input ||
    typeof input.oldPath !== 'string' ||
    !input.oldPath ||
    typeof input.newPath !== 'string' ||
    !input.newPath
  )
    throw new Error('Catalog relocation paths are invalid.');
  if (input.oldPath === input.newPath) return { updated: 0, missingOldPath: false };
  return db.transaction(() => {
    const workspace = input.workspaceRoot
      ? (db.prepare('SELECT id FROM workspaces WHERE path = ?').get(input.workspaceRoot) as
          | { id: number }
          | undefined)
      : undefined;
    if (
      input.workspaceRoot &&
      (!workspace ||
        !pathIsAtOrUnder(input.oldPath, input.workspaceRoot) ||
        !pathIsAtOrUnder(input.newPath, input.workspaceRoot))
    )
      throw new Error('Catalog relocation must remain inside its workspace owner.');
    const files = (
      db.prepare('SELECT * FROM catalog_entity_files').all() as CatalogFileBindingRow[]
    ).filter((file) => pathIsAtOrUnder(file.path, input.oldPath));
    for (const file of files) {
      const entity = db
        .prepare('SELECT workspace_id FROM catalog_entities WHERE id = ?')
        .get(file.entity_id) as { workspace_id: number | null } | undefined;
      if (
        !entity ||
        entity.workspace_id !== (workspace?.id ?? null) ||
        file.workspace_id !== entity.workspace_id
      )
        throw new Error('Catalog relocation must use the exact entity workspace owner.');
    }
    if (detectCatalogRelocationConflict(db, input.oldPath, input.newPath))
      throw new Error('Catalog relocation destination belongs to another entity.');
    const result = rebaseCatalogFileRefsInTx(
      db,
      input.oldPath,
      input.newPath,
      input.workspaceRoot ?? null,
      input.actor ?? 'user',
      Date.now()
    );
    if (input.targetFileKind)
      db.prepare('UPDATE catalog_entity_files SET file_kind = ? WHERE path = ?').run(
        input.targetFileKind,
        input.newPath
      );
    return { updated: result.updated, missingOldPath: files.length === 0 };
  })();
}

export function clearCatalogProjectionInDb(
  db: Database.Database,
  workspaceRoot: string
): CatalogProjectionClearResult {
  if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim())
    throw new Error('Catalog projection workspace owner is invalid.');
  return db.transaction(() => {
    const workspace = db.prepare('SELECT id FROM workspaces WHERE path = ?').get(workspaceRoot) as
      | { id: number }
      | undefined;
    const workspaceId = workspace?.id ?? null;
    if (workspaceId === null) return { workspaceId, entities: 0, files: 0, links: 0, events: 0 };
    if (
      db
        .prepare(
          'SELECT 1 FROM catalog_entity_events v JOIN catalog_entities e ON e.id=v.entity_id WHERE e.workspace_id=? AND v.event_type=? LIMIT 1'
        )
        .get(workspaceId, FASTA_KIND_DECLARATION_EVENT)
    )
      throw new Error(
        'FASTA_KIND_HISTORY_PROTECTED: Generic projection reset cannot erase native kind history.'
      );
    const result = {
      workspaceId,
      entities: (
        db
          .prepare('SELECT COUNT(*) AS count FROM catalog_entities WHERE workspace_id = ?')
          .get(workspaceId) as { count: number }
      ).count,
      files: (
        db
          .prepare('SELECT COUNT(*) AS count FROM catalog_entity_files WHERE workspace_id = ?')
          .get(workspaceId) as { count: number }
      ).count,
      links: (
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM catalog_entity_links WHERE
        source_entity_id IN (SELECT id FROM catalog_entities WHERE workspace_id = ?) OR
        target_entity_id IN (SELECT id FROM catalog_entities WHERE workspace_id = ?)`
          )
          .get(workspaceId, workspaceId) as { count: number }
      ).count,
      events: (
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM catalog_entity_events WHERE entity_id IN
        (SELECT id FROM catalog_entities WHERE workspace_id = ?)`
          )
          .get(workspaceId) as { count: number }
      ).count,
    };
    db.prepare('DELETE FROM catalog_entity_files WHERE workspace_id = ?').run(workspaceId);
    db.prepare('DELETE FROM catalog_entities WHERE workspace_id = ?').run(workspaceId);
    return result;
  })();
}

export function deleteCatalogEntityIfUnboundInDb(db: Database.Database, entityId: string): boolean {
  if (typeof entityId !== 'string' || !entityId.trim())
    throw new Error('Catalog entity identity is invalid.');
  return db.transaction(() => {
    if (db.prepare('SELECT 1 FROM catalog_entity_files WHERE entity_id = ?').get(entityId))
      return false;
    assertFastaKindHistoryRetained(db, entityId, true);
    return db.prepare('DELETE FROM catalog_entities WHERE id = ?').run(entityId).changes > 0;
  })();
}

export function deleteCatalogEntityWithExactBindingInDb(
  db: Database.Database,
  input: CatalogEntityRollbackRequest
): boolean {
  if (
    !input ||
    typeof input.entityId !== 'string' ||
    typeof input.path !== 'string' ||
    typeof input.fileKind !== 'string'
  )
    throw new Error('Catalog rollback identity is invalid.');
  return db.transaction(() => {
    const files = db
      .prepare('SELECT * FROM catalog_entity_files WHERE entity_id = ?')
      .all(input.entityId) as CatalogFileBindingRow[];
    const entity = db
      .prepare('SELECT workspace_id FROM catalog_entities WHERE id = ?')
      .get(input.entityId) as { workspace_id: number | null } | undefined;
    if (
      files.length !== 1 ||
      files[0].path !== input.path ||
      files[0].file_kind !== input.fileKind ||
      files[0].workspace_id !== entity?.workspace_id
    )
      return false;
    assertFastaKindHistoryRetained(db, input.entityId);
    return db.prepare('DELETE FROM catalog_entities WHERE id = ?').run(input.entityId).changes > 0;
  })();
}

export function ensureWorkspaceOwnerInDb(
  db: Database.Database,
  root: string,
  access?: WorkspaceAccess,
  discovery?: WorkspaceOwnerDiscovery
): number {
  if (
    typeof root !== 'string' ||
    !isAbsolutePathLike(root) ||
    !root.trim() ||
    root.includes('\0') ||
    (access !== undefined && access !== 'writable' && access !== 'reference')
  )
    throw new Error('Workspace identity or access classification is invalid.');
  if (
    discovery !== undefined &&
    (!discovery ||
      typeof discovery !== 'object' ||
      Array.isArray(discovery) ||
      Object.keys(discovery).some((key) => !['name', 'recordOpen'].includes(key)) ||
      (discovery.name !== undefined &&
        (typeof discovery.name !== 'string' ||
          !discovery.name.trim() ||
          discovery.name.includes('\0'))) ||
      (discovery.recordOpen !== undefined && typeof discovery.recordOpen !== 'boolean'))
  )
    throw new Error('Workspace discovery metadata is invalid.');
  return db.transaction(() => {
    const existing = db.prepare('SELECT * FROM workspaces WHERE path = ?').get(root) as
      | {
          id: number;
          access_mode: WorkspaceAccess;
          created_at: number;
          last_opened_at: number | null;
          archived_at: number | null;
          trashed_at: number | null;
        }
      | undefined;
    if (existing) {
      if (discovery?.recordOpen && (existing.archived_at !== null || existing.trashed_at !== null))
        throw new Error('Restore the owning project before opening it.');
      for (const column of ['created_at', 'last_opened_at', 'archived_at', 'trashed_at'] as const) {
        const value = existing[column];
        const normalized = normalizeWorkspaceTimestamp(value);
        if (value != null && normalized !== value)
          db.prepare(`UPDATE workspaces SET ${column} = ? WHERE id = ? AND ${column} = ?`).run(
            normalized,
            existing.id,
            value
          );
      }
      if (access === 'writable' && existing.access_mode === 'reference')
        throw new Error(
          'A reference workspace cannot acquire write authority through discovery. Import an editable copy.'
        );
      if (access === 'reference')
        db.prepare("UPDATE workspaces SET access_mode = 'reference' WHERE id = ?").run(existing.id);
      if (discovery?.recordOpen)
        db.prepare('UPDATE workspaces SET last_opened_at = ? WHERE id = ?').run(
          Date.now(),
          existing.id
        );
      return existing.id;
    }
    const now = Date.now();
    const name =
      root
        .replace(/[\\/]+$/, '')
        .split(/[\\/]/)
        .pop() || 'Project';
    return Number(
      db
        .prepare(
          'INSERT INTO workspaces(name,path,created_at,last_opened_at,access_mode) VALUES(?,?,?,?,?)'
        )
        .run(discovery?.name ?? name, root, now, now, access ?? 'writable').lastInsertRowid
    );
  })();
}

export function setCatalogFileStateInDb(
  db: Database.Database,
  path: string,
  state: 'missing' | 'historical',
  reason: string
): CatalogFileBindingRow | null {
  if (
    typeof path !== 'string' ||
    !path ||
    !['missing', 'historical'].includes(state) ||
    typeof reason !== 'string'
  )
    throw new Error('Catalog file state request is invalid.');
  return db.transaction(() => {
    const file = db.prepare('SELECT * FROM catalog_entity_files WHERE path = ?').get(path) as
      | CatalogFileBindingRow
      | undefined;
    if (!file || (state === 'missing' && file.status !== 'current' && file.status !== 'missing'))
      return file ?? null;
    const eventType = state === 'missing' ? 'file_missing' : 'file_historical';
    if (file.status === state) {
      const last = db
        .prepare(
          `SELECT json_extract(payload,'$.reason') AS reason FROM catalog_entity_events
           WHERE entity_id=? AND event_type=? AND json_extract(payload,'$.path')=?
           ORDER BY created_at DESC, rowid DESC LIMIT 1`
        )
        .get(file.entity_id, eventType, path) as { reason: string | null } | undefined;
      if (!last || last.reason === reason) return file;
    }
    const now = Date.now();
    if (file.status !== state)
      db.prepare(
        'UPDATE catalog_entity_files SET status=?,missing_since=?,updated_at=? WHERE id=?'
      ).run(state, state === 'missing' ? now : file.missing_since, now, file.id);
    db.prepare(
      'INSERT INTO catalog_entity_events(id,entity_id,event_type,actor,summary,payload,created_at) VALUES(?,?,?,?,?,?,?)'
    ).run(
      randomUUID(),
      file.entity_id,
      state === 'missing' ? 'file_missing' : 'file_historical',
      'user',
      state === 'missing'
        ? 'Catalog file binding is missing on disk'
        : 'Catalog file binding is historical',
      JSON.stringify({ path, reason, fileKind: file.file_kind }),
      now
    );
    return db
      .prepare('SELECT * FROM catalog_entity_files WHERE id = ?')
      .get(file.id) as CatalogFileBindingRow;
  })();
}

export function refreshCatalogFileFingerprintsInDb(
  db: Database.Database,
  files: readonly CatalogFileFingerprint[]
): void {
  if (!Array.isArray(files)) throw new Error('Catalog fingerprints must be an array.');
  db.transaction(() => {
    const update =
      db.prepare(`UPDATE catalog_entity_files SET sequence_fingerprint=CASE WHEN content_hash IS ? THEN sequence_fingerprint END,content_hash=?,size_bytes=?,modified_at=COALESCE(?,modified_at),last_seen_at=?,updated_at=?
      WHERE id=? AND entity_id=? AND workspace_id IS ? AND path=? AND object_uuid=? AND file_kind=? AND status='current'`);
    const now = Date.now();
    for (const file of files) {
      const result = update.run(
        file.content_hash,
        file.content_hash,
        file.size_bytes,
        file.modified_at,
        now,
        now,
        file.id,
        file.entity_id,
        file.workspace_id,
        file.path,
        file.object_uuid,
        file.file_kind
      );
      if (result.changes !== 1)
        throw new Error(
          'Native sequence binding changed during Git discovery. Retry workspace reconciliation.'
        );
    }
  })();
}

export function releaseMissingCatalogFilePathInDb(
  db: Database.Database,
  file: CatalogFileBindingRow,
  replacementEntityId: string
): void {
  if (
    !file ||
    file.status !== 'missing' ||
    typeof replacementEntityId !== 'string' ||
    !replacementEntityId ||
    file.entity_id === replacementEntityId
  )
    throw new Error('Only a missing file binding can release its path for another entity.');
  db.transaction(() => {
    const removed = db
      .prepare(
        `DELETE FROM catalog_entity_files WHERE id=? AND entity_id=? AND path=? AND status='missing' AND object_uuid IS ? AND content_hash IS ?`
      )
      .run(file.id, file.entity_id, file.path, file.object_uuid, file.content_hash);
    if (removed.changes !== 1)
      throw new Error('Catalog file ownership changed before its missing path could be released.');
    db.prepare(
      'INSERT INTO catalog_entity_events(id,entity_id,event_type,actor,summary,payload,created_at) VALUES(?,?,?,?,?,?,?)'
    ).run(
      randomUUID(),
      file.entity_id,
      'file_path_reuse',
      'user',
      'Preserved missing file identity before filename reuse',
      JSON.stringify({ previousFile: file, replacementEntityId }),
      Date.now()
    );
  })();
}

function assertFastaKindHistoryRetained(
  db: Database.Database,
  entityId: string,
  unpublishedRegistration = false
): void {
  if (
    db
      .prepare(
        "SELECT 1 FROM catalog_entity_events AS declaration WHERE declaration.entity_id=? AND declaration.event_type=? AND (?=0 OR (CASE WHEN json_valid(declaration.payload) THEN json_extract(declaration.payload,'$.operation') END) IS NOT 'registration' OR EXISTS(SELECT 1 FROM catalog_entity_events AS publication WHERE publication.entity_id=declaration.entity_id AND publication.event_type='file_path_reuse')) LIMIT 1"
      )
      .get(entityId, FASTA_KIND_DECLARATION_EVENT, unpublishedRegistration ? 1 : 0)
  )
    throw new Error(
      'FASTA_KIND_HISTORY_PROTECTED: Catalog rollback cannot erase published native kind history.'
    );
}
