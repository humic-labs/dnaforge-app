import {
  applySavedPrimerMoveProjections,
  type RelocatedSavedPrimer,
} from './relocate-primer-artifacts';
import { statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  normalizePathForBoundary,
  pathIsAtOrUnder,
  rebasePath,
  stripTrailingSep,
} from '../shared/path-boundary';
import {
  findCatalogRelocationConflict,
  planCatalogFileRelocation,
  type CatalogRelocationFile,
  type CatalogRelocationEntity,
} from '../shared/catalog-relocation';
import { relocateLimsEntityFileRefsInDb } from './lims-engine-core';

export interface IndexedRebaseCounts {
  indexedFilesMoved: number;
  staleIndexedFilesMerged: number;
  primerBindingsRepointed: number;
}

export function rebaseIndexedFilesRefsInTx(
  db: Database.Database,
  oldAbs: string,
  newAbs: string,
  now: number
): IndexedRebaseCounts {
  const counts: IndexedRebaseCounts = {
    indexedFilesMoved: 0,
    staleIndexedFilesMerged: 0,
    primerBindingsRepointed: 0,
  };

  const rows = db.prepare(`SELECT id, path FROM indexed_files`).all() as Array<{
    id: number;
    path: string;
  }>;
  const movers = rows
    .filter((r) => pathIsAtOrUnder(r.path, oldAbs))
    .map((r) => ({ id: r.id, path: r.path, newRowPath: rebasePath(r.path, oldAbs, newAbs) }));
  if (movers.length === 0) return counts;

  const moverIds = new Set(movers.map((m) => m.id));
  const key = (p: string): string => normalizePathForBoundary(p);

  const groups = new Map<string, typeof movers>();
  for (const m of movers) {
    const k = key(m.newRowPath);
    const bucket = groups.get(k);
    if (bucket) bucket.push(m);
    else groups.set(k, [m]);
  }

  const targetKeys = new Set(groups.keys());
  const preExistingByKey = new Map<string, number[]>();
  for (const r of rows) {
    if (moverIds.has(r.id)) continue;
    const k = key(r.path);
    if (!targetKeys.has(k)) continue;
    const bucket = preExistingByKey.get(k);
    if (bucket) bucket.push(r.id);
    else preExistingByKey.set(k, [r.id]);
  }

  const seqByFile = db.prepare(`SELECT id FROM sequences WHERE file_id = ? ORDER BY id`);
  const reparentSeqs = db.prepare(`UPDATE sequences SET file_id = ? WHERE file_id = ?`);
  const repointBindings = db.prepare(
    `UPDATE OR IGNORE primer_bindings SET sequence_id = ?, updated_at = ? WHERE sequence_id = ?`
  );
  const deleteSeqsByFile = db.prepare(`DELETE FROM sequences WHERE file_id = ?`);
  const deleteFile = db.prepare(`DELETE FROM indexed_files WHERE id = ?`);
  const updateFile = db.prepare(
    `UPDATE indexed_files SET path = ?, name = ?, extension = ? WHERE id = ?`
  );

  for (const [k, groupMovers] of groups) {
    const canonical = Math.min(...groupMovers.map((m) => m.id));
    const canonicalMover = groupMovers.find((m) => m.id === canonical)!;
    const staleFileIds = [
      ...groupMovers.filter((m) => m.id !== canonical).map((m) => m.id),
      ...(preExistingByKey.get(k) ?? []),
    ];

    let moverSeqId: number | null =
      (seqByFile.all(canonical) as Array<{ id: number }>)[0]?.id ?? null;
    if (moverSeqId == null) {
      for (const staleId of staleFileIds) {
        const donorSeqs = seqByFile.all(staleId) as Array<{ id: number }>;
        if (donorSeqs.length > 0) {
          reparentSeqs.run(canonical, staleId);
          moverSeqId = donorSeqs[0].id;
          break;
        }
      }
    }

    for (const staleId of staleFileIds) {
      const staleSeqs = seqByFile.all(staleId) as Array<{ id: number }>;
      for (const s of staleSeqs) {
        if (moverSeqId != null && s.id !== moverSeqId) {
          const res = repointBindings.run(moverSeqId, now, s.id);
          counts.primerBindingsRepointed += res.changes;
        }
      }
      deleteSeqsByFile.run(staleId);
      deleteFile.run(staleId);
      counts.staleIndexedFilesMerged += 1;
    }

    const { newRowPath } = canonicalMover;
    updateFile.run(
      newRowPath,
      basename(newRowPath),
      extname(newRowPath).replace(/^\./, ''),
      canonical
    );
    counts.indexedFilesMoved += 1;
  }

  return counts;
}

function statForCatalogSync(path: string): { sizeBytes: number | null; modifiedAt: number | null } {
  try {
    const s = statSync(path);
    return { sizeBytes: s.size, modifiedAt: Math.round(s.mtimeMs) };
  } catch {
    return { sizeBytes: null, modifiedAt: null };
  }
}

export function detectCatalogRelocationConflict(
  db: Database.Database,
  oldPath: string,
  newPath: string
): string | null {
  const files = db
    .prepare('SELECT id, entity_id, path FROM catalog_entity_files')
    .all() as CatalogRelocationFile[];
  const entityByLocator = db.prepare('SELECT id FROM catalog_entities WHERE locator = ?');
  return findCatalogRelocationConflict(
    files,
    (locator) => entityByLocator.get(locator) as { id: string } | undefined,
    oldPath,
    newPath
  );
}

export function rebaseCatalogFileRefsInTx(
  db: Database.Database,
  oldAbs: string,
  newAbs: string,
  workspaceRoot: string | null,
  actor: string,
  now: number
): { updated: number; touchedEntityIds: string[] } {
  const rows = db
    .prepare(
      `SELECT id, entity_id, path, file_kind, size_bytes, modified_at FROM catalog_entity_files`
    )
    .all() as CatalogRelocationFile[];
  const matched = rows
    .filter((f) => pathIsAtOrUnder(f.path, oldAbs))
    .sort((a, b) => a.path.length - b.path.length);
  if (matched.length === 0) return { updated: 0, touchedEntityIds: [] };

  const updateFile = db.prepare(
    `UPDATE catalog_entity_files
     SET path = ?, relative_path = ?, file_kind = ?, size_bytes = ?, modified_at = ?,
         last_seen_at = ?, updated_at = ?
     WHERE id = ?`
  );
  const getEntity = db.prepare(
    `SELECT id, type, name, locator, metadata FROM catalog_entities WHERE id = ?`
  );
  const updateEntity = db.prepare(
    `UPDATE catalog_entities SET name = ?, locator = ?, metadata = ?, updated_at = ? WHERE id = ?`
  );
  const insertEvent = db.prepare(
    `INSERT INTO catalog_entity_events (id, entity_id, event_type, actor, summary, payload, created_at)
     VALUES (?, ?, 'path_moved', ?, 'Catalog file binding moved', ?, ?)`
  );

  let updated = 0;
  const touchedEntityIds = new Set<string>();
  for (const file of matched) {
    const movedPath = rebasePath(file.path, oldAbs, newAbs);
    const entity = getEntity.get(file.entity_id) as CatalogRelocationEntity | undefined;
    const planned = planCatalogFileRelocation(
      file,
      entity,
      {
        oldPath: oldAbs,
        newPath: newAbs,
        workspaceRoot,
        now,
      },
      statForCatalogSync(movedPath)
    );
    updateFile.run(
      planned.file.path,
      planned.file.relative_path,
      planned.file.file_kind,
      planned.file.size_bytes,
      planned.file.modified_at,
      now,
      now,
      file.id
    );
    if (entity && planned.entity) {
      updateEntity.run(
        planned.entity.name,
        planned.entity.locator,
        planned.entity.metadata,
        now,
        entity.id
      );
    }
    if (entity) {
      insertEvent.run(randomUUID(), entity.id, actor, planned.eventPayload, now);
    }
    if (entity) touchedEntityIds.add(entity.id);
    updated += 1;
  }
  return { updated, touchedEntityIds: [...touchedEntityIds] };
}

export function assertNoStaleFileLocators(
  db: Database.Database,
  oldAbs: string,
  touchedEntityIds: readonly string[]
): void {
  if (touchedEntityIds.length === 0) return;
  const get = db.prepare(`SELECT id, locator FROM catalog_entities WHERE id = ?`);
  const stale: string[] = [];
  for (const id of touchedEntityIds) {
    const row = get.get(id) as { id: string; locator: string } | undefined;
    if (!row?.locator?.startsWith('file://')) continue;
    const located = row.locator.slice('file://'.length);
    if (pathIsAtOrUnder(located, oldAbs)) stale.push(`${row.id} -> ${row.locator}`);
  }
  if (stale.length > 0) {
    throw new Error(
      `RELOCATE_STALE_LOCATOR: the move was rolled back because ${stale.length} registry ` +
        `entit${stale.length === 1 ? 'y' : 'ies'} would have been left pointing at the vacated ` +
        `path "${oldAbs}". This is a bug in the rebase, not in your workspace. ` +
        `Offending: ${stale.join(', ')}`
    );
  }
}

export interface RelocateCounts {
  catalog: { updated: number };
  indexed: IndexedRebaseCounts;
  lims: { rebasedEntityIds: string[]; workspaceIds: Array<number | null> };
}

export function relocateWorkspaceFileRefsInDb(
  db: Database.Database,
  input: {
    workspaceRoot: string | null;
    oldPath: string;
    newPath: string;
    actor?: string;
    savedPrimers?: ReadonlyMap<string, RelocatedSavedPrimer>;
  }
): RelocateCounts {
  const oldAbs = stripTrailingSep(input.oldPath);
  const newAbs = stripTrailingSep(input.newPath);
  const empty: RelocateCounts = {
    catalog: { updated: 0 },
    indexed: { indexedFilesMoved: 0, staleIndexedFilesMerged: 0, primerBindingsRepointed: 0 },
    lims: { rebasedEntityIds: [], workspaceIds: [] },
  };
  if (oldAbs === newAbs) return empty;
  const wsRoot = input.workspaceRoot ? stripTrailingSep(input.workspaceRoot) : null;
  const now = Date.now();
  const catalog = rebaseCatalogFileRefsInTx(db, oldAbs, newAbs, wsRoot, input.actor ?? 'user', now);
  const indexed = rebaseIndexedFilesRefsInTx(db, oldAbs, newAbs, now);
  const lims = relocateLimsEntityFileRefsInDb(db, {
    workspaceRoot: wsRoot ?? '',
    oldPath: oldAbs,
    newPath: newAbs,
    actor: input.actor,
    savedPrimers: input.savedPrimers,
  });
  if (input.savedPrimers) applySavedPrimerMoveProjections(db, input.savedPrimers);
  assertNoStaleFileLocators(db, oldAbs, catalog.touchedEntityIds);
  return { catalog: { updated: catalog.updated }, indexed, lims };
}
