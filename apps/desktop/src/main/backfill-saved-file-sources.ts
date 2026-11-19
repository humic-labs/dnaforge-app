import { assertCommittedDatabaseReadAllowed } from './workspace-sync-database-fence';
import type Database from 'better-sqlite3';
import { lstat, readFile } from 'node:fs/promises';
import { join, dirname, isAbsolute } from 'node:path';
import { stripWorkspaceScope } from '../shared/workspace-scoped-identity';
import { isPathInsideBoundary } from '../shared/path-boundary';
import { parseTrackViewDocument, TRACK_VIEW_SUFFIX } from '../shared/track-view';
import {
  parseMolecularDocument,
  MOLECULAR_DOCUMENT_SUFFIX,
  MOLECULAR_DOCUMENT_MAX_BYTES,
  validateMolecularDocumentCoordinates,
} from '../shared/molecular-document';
import { workspaceSyncBlobPath, hashWorkspaceSyncFileOnDisk } from './workspace-sync-blob-cache';
import { captureSavedFileMembers } from './saved-file-sources';
import { assertWorkspaceProjectionPathSafe } from './workspace-projection-boundary';
import { stageCatalogFileSource } from './catalog-file-source-retention';

export async function backfillSavedFileSources(
  db: Database.Database,
  input: { workspaceId: number | null; entityId?: string; assertCurrent(): void }
): Promise<{ retained: number; unavailable: number }> {
  const totals = { retained: 0, unavailable: 0 };
  const page =
    db.prepare(`SELECT f.rowid AS seq,f.id,f.path,f.entity_id AS entityId,f.content_hash AS hash,f.file_kind AS fileKind,
    f.status,f.updated_at AS updatedAt,w.path AS root FROM catalog_entity_files f LEFT JOIN workspaces w ON w.id=f.workspace_id
    WHERE f.workspace_id IS ? AND (? IS NULL OR f.entity_id=?) AND f.status IN ('current','missing','historical') AND f.rowid>?
    AND NOT EXISTS(SELECT 1 FROM retained_file_source_revisions r WHERE r.workspace_id IS f.workspace_id AND r.entity_id=f.entity_id AND r.status='committed' AND (
      f.content_hash IS NULL OR
      json_extract(r.manifest_json,'$.members[0].sha256')=CASE WHEN f.content_hash GLOB 'sha256:*' THEN substr(f.content_hash,8) ELSE f.content_hash END
      OR (json_extract(r.manifest_json,'$.members[0].kind')='directory' AND f.status='current')))
    AND f.file_kind!='folder' ORDER BY f.rowid LIMIT 40`);
  type Row = {
    seq: number;
    id: string;
    path: string;
    entityId: string;
    hash: string | null;
    fileKind: string;
    status: string;
    updatedAt:number;
    root: string | null;
  };
  let after = 0;
  for (;;) {
    input.assertCurrent();
    const rows = page.all(
      input.workspaceId,
      input.entityId ?? null,
      input.entityId ?? null,
      after
    ) as Row[];
    if (!rows.length) return totals;
    for (const row of rows) {
      after = row.seq;
      try {
        const assertSame = () => {
          input.assertCurrent();
          if (
            !db
              .prepare(
                'SELECT 1 FROM catalog_entity_files WHERE id=? AND entity_id=? AND workspace_id IS ? AND path=? AND status=? AND content_hash IS ?'
              )
              .get(row.id, row.entityId, input.workspaceId, row.path, row.status, row.hash)
          )
            throw new Error('File owner changed during source retention.');
        };
        assertSame();
        if (row.root && !isPathInsideBoundary(row.path, row.root)) {
          totals.unavailable++;
          continue;
        }
        if (row.root) assertWorkspaceProjectionPathSafe(row.root, row.path);
        const verified = row.hash?.match(/^(?:sha256:)?([a-f0-9]{64})$/)?.[1];
        const historicalAt = row.status==='historical' ? row.updatedAt : undefined;
        const packageKind=['waypoint-sequence','waypoint-notebook','waypoint-protocol','waypoint-protocol-run','dnaforge-table'].includes(row.fileKind);
        if (row.status === 'current' || (historicalAt!==undefined && verified && !packageKind)) {
          const leaf = await lstat(row.path).catch((e: NodeJS.ErrnoException) => {
            if (e.code === 'ENOENT') return null;
            throw e;
          });
          if (leaf?.isFile()) {
            let evidence = verified;
            if (!evidence && row.fileKind==='waypoint-entity' && row.root) {
              const {readCheckedEntityArtifactSnapshot}=await import('./entity-artifact-mutations');
              const checked=await readCheckedEntityArtifactSnapshot({db, entityId:row.entityId, runDatabase: work => { assertSame(); return work(); }});
              if(checked.owner.workspaceId!==input.workspaceId || join(checked.owner.workspacePath,checked.owner.relativePath)!==row.path) throw new Error('Former Registry file has a different owner.');
              evidence=checked.sha256;
            }
            if (!evidence && packageKind && row.status==='current' && row.root && !['waypoint-protocol','waypoint-protocol-run'].includes(row.fileKind)) {
              const stage=await stageCatalogFileSource(db,{path:row.path,fileKind:row.fileKind,workspaceRoot:row.root,expectedPackageEntityId:row.entityId},assertSame);
              assertSame();
              if(stage) {
                stage({entityId:row.entityId,workspaceId:input.workspaceId});
                totals.retained++;
                continue;
              }
            }

            if (
              !evidence &&
              ((row.path.endsWith(TRACK_VIEW_SUFFIX) && leaf.size <= 4 * 1024 * 1024) ||
                (row.path.endsWith(MOLECULAR_DOCUMENT_SUFFIX) &&
                  leaf.size <= MOLECULAR_DOCUMENT_MAX_BYTES))
            ) {
              const text = await readFile(row.path, 'utf8');
              if (row.path.endsWith(TRACK_VIEW_SUFFIX)) {
                if (parseTrackViewDocument(text).id !== row.entityId) {
                  totals.unavailable++;
                  continue;
                }
              } else {
                const doc = parseMolecularDocument(text);
                if (doc.id !== stripWorkspaceScope(row.entityId)) {
                  totals.unavailable++;
                  continue;
                }
                await validateMolecularDocumentCoordinates(doc);
              }
              const { createHash } = await import('node:crypto');
              evidence = createHash('sha256').update(text).digest('hex');
            }
            if (evidence && (await hashWorkspaceSyncFileOnDisk(row.path)).sha256 === evidence) {
              const stage = await stageCatalogFileSource(
                db,
                {
                  path: row.path,
                  fileKind: row.fileKind,
                  contentHash: evidence,
                  workspaceRoot: row.root,
                },
                assertSame
              );
              assertSame();
              if (stage) {
                stage({ entityId: row.entityId, workspaceId: input.workspaceId,historicalAt });
                totals.retained++;
                continue;
              }
            }
          }
        }
        if (
          verified &&
          isAbsolute(db.name) &&
          !packageKind
        ) {
          const blob = await workspaceSyncBlobPath(
            verified,
            join(dirname(db.name), 'workspace-sync', 'blobs')
          );
          const stat = await lstat(blob).catch((e: NodeJS.ErrnoException) => {
            if (e.code === 'ENOENT') return null;
            throw e;
          });
          if (stat?.isFile()) {
            await captureSavedFileMembers(
              db,
              {
                workspaceId: input.workspaceId,
                entityId: row.entityId,historicalAt,
                path: row.path,
                members: [{ relativePath: '', sourcePath: blob, expectedSha256: verified }],
              },
              assertSame
            );
            totals.retained++;
            continue;
          }
        }
        totals.unavailable++;
      } catch {
        input.assertCurrent();
        totals.unavailable++;
      }
    }
  }
}

const migrations = new WeakMap<Database.Database, Set<number | null>>();
export function scheduleSavedSourceMigration(
  db: Database.Database,
  workspaceId: number | null
): void {
  let running = migrations.get(db);
  if (!running) {
    running = new Set();
    migrations.set(db, running);
  }
  if (running.has(workspaceId)) return;
  running.add(workspaceId);
  const assertCurrent = () => {
    if (!db.open) throw new Error('The library closed during file source migration.');
    assertCommittedDatabaseReadAllowed(db);
    if (
      workspaceId !== null &&
      !db
        .prepare(
          'SELECT 1 FROM workspaces WHERE id=? AND archived_at IS NULL AND trashed_at IS NULL'
        )
        .get(workspaceId)
    )
      throw new Error('The project is no longer active.');
  };
  setImmediate(() => {
    const run = async () => {
      assertCurrent();
      const { recoverPendingSavedFileSources } = await import('./saved-file-sources');
      await recoverPendingSavedFileSources(db, { workspaceId, assertCurrent });
      await backfillSavedFileSources(db, { workspaceId, assertCurrent });
    };
    void run()
      .catch((error) => {
        if (db.open)
          console.warn(
            '[File sources] Source migration remains pending.',
            error instanceof Error ? error.message : String(error)
          );
      })
      .finally(() => running.delete(workspaceId));
  }).unref();
}
