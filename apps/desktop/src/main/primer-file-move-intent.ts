import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { z } from 'zod';
import { isSafeWorkspaceRelativePath, pathIsAtOrUnder, rebasePath } from '../shared/path-boundary';
import { PRIMER_RELOCATION_SOURCE_EVENT } from '../shared/primer-artifacts/primer-source-history';
import { readBoundPrimerArtifact } from '../shared/primers/primer-artifact';
import {
  assertEnrolledPrimerPathMutationAllowed,
  assertEnrolledPrimerRelocationAllowed,
} from './primer-artifact-mutation-guard';
import { retainPrimerSourceInDb } from './primer-source-history';
import {
  discoverPrimerArtifacts,
  rebasedPrimerSource,
  restorePrimerArtifactBytes,
  type RelocatedSavedPrimer,
  type PrimerRewriteResult,
} from './relocate-primer-artifacts';
import { workspaceMoveTreeDigest } from './workspace-file-trash';
import { assertWorkspaceProjectionPathSafe } from './workspace-projection-boundary';
import {
  detectCatalogRelocationConflict,
  relocateWorkspaceFileRefsInDb,
} from './workspace-relocate';
import { assertWorkspaceWriteAllowed } from './workspace-write-admission';
import { workspaceMutationRootIdentity } from './workspace-sync-mutation-lease';
import { ScientificObjectStore } from './scientific-object-store';

export const PRIMER_FILE_MOVE_PREPARED = 'primer_file_move_prepared';
const relativePath = z.string().refine(isSafeWorkspaceRelativePath);
const change = z.object({
  path: relativePath,
  destination: relativePath,
  binding: z.object({ id: z.string(), entityId: z.string() }).nullable(),
  source: z.string(),
  nextHash: z.string().regex(/^[a-f0-9]{64}$/),
});
const intentSchema = z.object({
  version: z.literal(1),
  source: relativePath,
  destination: relativePath,
  dev: z.string(),
  ino: z.string(),
  tree: z.string().regex(/^[a-f0-9]{64}$/),
  changes: z.array(change).min(1),
  actor: z.string().optional(),
});
type Intent = z.infer<typeof intentSchema>;
type Binding = { id: string; entityId: string; path: string };
type Move = { workspaceRoot: string; oldPath: string; newPath: string; actor?: string };
type Context = {
  db: Database.Database;
  workspacePath: string;
  runDatabase: <T>(operation: () => T) => T;
};
const active = new Map<string, Intent | null>();
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const local = (root: string, path: string) => relative(root, path).split('\\').join('/');
function conflict(): never {
  throw new Error(
    'The interrupted primer move conflicts with the current files or their registry owners. All copies and the pending move have been preserved.'
  );
}

function sourceChange(
  path: string,
  binding: Binding | undefined,
  move: Move
): Intent['changes'][number] | undefined {
  const inside = pathIsAtOrUnder(path, move.oldPath);
  const nextPath = inside ? rebasePath(path, move.oldPath, move.newPath) : path;
  let raw: string;
  let next: string | null;
  try {
    assertWorkspaceProjectionPathSafe(move.workspaceRoot, path);
    raw = readFileSync(path, 'utf8');
    next = rebasedPrimerSource(raw, {
      workspaceRoot: move.workspaceRoot,
      oldAbs: move.oldPath,
      newAbs: move.newPath,
    });
  } catch {
    if (binding && inside) conflict();
    return;
  }
  if (!next) {
    if (binding && inside) conflict();
    return;
  }
  const before = local(move.workspaceRoot, path),
    after = local(move.workspaceRoot, nextPath);
  if (binding) {
    readBoundPrimerArtifact(raw, before, binding.entityId);
    readBoundPrimerArtifact(next, after, binding.entityId);
  }
  return {
    path: before,
    destination: after,
    binding: binding ? { id: binding.id, entityId: binding.entityId } : null,
    source: raw,
    nextHash: hash(next),
  };
}

export async function preparePrimerFileMove(
  db: Database.Database,
  move: Move
): Promise<string | null> {
  const rows = db
    .prepare(
      `SELECT f.id,f.entity_id AS entityId,f.path FROM catalog_entity_files f
    JOIN catalog_entities e ON e.id=f.entity_id JOIN workspaces w ON w.id=f.workspace_id
    WHERE w.path=? AND f.status='current' AND (f.file_kind='primer-artifact' OR e.type='primer')`
    )
    .all(move.workspaceRoot) as Binding[];
  const byPath = new Set<string>();
  const changes: Intent['changes'] = [];
  for (const row of rows) {
    if (byPath.has(row.path)) conflict();
    byPath.add(row.path);
    const item = sourceChange(row.path, row, move);
    if (item) changes.push(item);
  }
  const anchor = changes[0]?.binding;
  if (!anchor) return null;
  for (const path of discoverPrimerArtifacts(move.workspaceRoot)) {
    if (byPath.has(path)) continue;
    const item = sourceChange(path, undefined, move);
    if (item) changes.push(item);
  }
  const stat = lstatSync(move.oldPath, { bigint: true });
  const intent = intentSchema.parse({
    version: 1,
    source: local(move.workspaceRoot, move.oldPath),
    destination: local(move.workspaceRoot, move.newPath),
    dev: String(stat.dev),
    ino: String(stat.ino),
    tree: await workspaceMoveTreeDigest(move.oldPath),
    changes,
    actor: move.actor,
  });
  const id = randomUUID();
  db.transaction(() => {
    assertMoveAuthority(db, move, intent);
    for (const item of changes)
      if (item.binding)
        retainPrimerSourceInDb(
          db,
          item.binding.entityId,
          item.path,
          item.source,
          PRIMER_RELOCATION_SOURCE_EVENT
        );
    db.prepare(
      'INSERT INTO catalog_entity_events(id,entity_id,event_type,actor,summary,payload,created_at) VALUES(?,?,?,?,?,?,?)'
    ).run(
      id,
      anchor.entityId,
      PRIMER_FILE_MOVE_PREPARED,
      move.actor ?? 'user',
      'Prepared primer file move',
      JSON.stringify(intent),
      Date.now()
    );
    const work = db
      .prepare(
        'INSERT INTO native_catalog_publication_outbox(operation_id,workspace_id) SELECT ?,id FROM workspaces WHERE path=?'
      )
      .run(id, move.workspaceRoot);
    if (work.changes !== 1) conflict();
  })();
  active.set(id, intent);
  return id;
}

function assertMoveAuthority(db: Database.Database, move: Move, intent: Intent) {
  const { workspaceRoot: root, oldPath, newPath } = move;
  if (oldPath === newPath || pathIsAtOrUnder(newPath, oldPath) || pathIsAtOrUnder(oldPath, newPath))
    conflict();
  assertWorkspaceWriteAllowed(db, [root]);
  assertWorkspaceProjectionPathSafe(root, oldPath);
  assertWorkspaceProjectionPathSafe(root, newPath);
  assertEnrolledPrimerRelocationAllowed(db, move);
  if (detectCatalogRelocationConflict(db, oldPath, newPath)) conflict();
  const binding =
    db.prepare(`SELECT f.id FROM catalog_entity_files f JOIN workspaces w ON f.workspace_id=w.id
    WHERE w.path=? AND f.path=? AND f.status='current' AND f.entity_id=?`);
  for (const item of intent.changes) {
    const path = join(root, item.path),
      dest = join(root, item.destination);
    const expected = pathIsAtOrUnder(path, oldPath) ? rebasePath(path, oldPath, newPath) : path;
    if (dest !== expected) conflict();
    assertWorkspaceProjectionPathSafe(root, path);
    assertWorkspaceProjectionPathSafe(root, dest);
    assertEnrolledPrimerPathMutationAllowed(db, [path, dest]);
    if (item.binding && binding.pluck().get(root, path, item.binding.entityId) !== item.binding.id)
      conflict();
  }
}

export function finishPrimerFileMoveInTx(db: Database.Database, id: string | null): void {
  if (!id) return;
  if (!db.inTransaction) throw new Error('Completing a primer move requires a transaction.');
  const deleted = db
    .prepare('DELETE FROM native_catalog_publication_outbox WHERE operation_id=?')
    .run(id);
  if (deleted.changes !== 1) conflict();
}

export function releasePrimerMove(id: string | null): void {
  if (id) active.delete(id);
}

function inspectPrimerMoveSources(intent: Intent, move: Move, old: boolean) {
  const { workspaceRoot: root, oldPath, newPath } = move;
  const location = old ? oldPath : newPath;
  const expectedHashes = new Map<string, { prior: string; next: string }>();
  const writes = new Map<string, string>(),
    hashes = new Map<string, string>();
  const saved = new Map<string, RelocatedSavedPrimer>();
  for (const item of intent.changes) {
    const path = join(root, old ? item.path : item.destination);
    const before = hash(item.source);
    const next = rebasedPrimerSource(item.source, {
      workspaceRoot: root,
      oldAbs: oldPath,
      newAbs: newPath,
    });
    if (!next || hash(next) !== item.nextHash) conflict();
    const current = hash(readFileSync(path, 'utf8'));
    if (current !== before && (old || current !== item.nextHash)) conflict();
    if (pathIsAtOrUnder(path, location))
      expectedHashes.set(local(location, path), { prior: before, next: item.nextHash });
    if (!old && current === before) {
      writes.set(path, next);
      hashes.set(path, before);
    }
    if (item.binding) {
      readBoundPrimerArtifact(item.source, item.path, item.binding.entityId);
      const primer = readBoundPrimerArtifact(next, item.destination, item.binding.entityId);
      saved.set(item.binding.entityId, {
        content: next,
        relativePath: item.destination,
        sha256: item.nextHash,
        bytes: Buffer.byteLength(next),
        bindings: primer.bindings,
      });
    }
  }
  if (!saved.size) conflict();
  return { writes, hashes, saved, expectedHashes };
}

function applyMoveWrites(
  writes: Map<string, string>,
  hashes: Map<string, string>,
  newPath: string
): string[] {
  return restorePrimerArtifactBytes(writes, hashes, (path) =>
    pathIsAtOrUnder(path, newPath) ? dirname(newPath) : dirname(path)
  );
}

export function rewritePreparedPrimerMove(
  db: Database.Database,
  id: string,
  move: Move
): PrimerRewriteResult {
  const intent = active.get(id);
  if (!intent) conflict();
  assertMoveAuthority(db, move, intent);
  const { writes, hashes, saved } = inspectPrimerMoveSources(intent, move, false);
  if (writes.size !== intent.changes.length) conflict();
  const failedPaths = applyMoveWrites(writes, hashes, move.newPath);
  const failed = new Set(failedPaths);
  const originalBytes = new Map<string, string>(),
    writtenHashes = new Map<string, string>();
  for (const item of intent.changes) {
    const path = join(move.workspaceRoot, item.destination);
    if (!failed.has(path)) {
      originalBytes.set(path, item.source);
      writtenHashes.set(path, item.nextHash);
    }
  }
  return { rewritten: originalBytes.size, originalBytes, writtenHashes, failedPaths, saved };
}

export async function recoverPrimerFileMoves(input: Context): Promise<void> {
  const { db, workspacePath, runDatabase } = input;
  const physicalRoot = workspaceMutationRootIdentity(workspacePath);
  const pending = runDatabase(
    () =>
      db
        .prepare(
          `SELECT o.operation_id AS id,e.payload,w.path AS root,w.id AS workspaceId FROM native_catalog_publication_outbox o
    JOIN catalog_entity_events e ON e.id=o.operation_id AND e.event_type=? JOIN workspaces w ON w.id=o.workspace_id
    ORDER BY e.created_at,e.id`
        )
        .all(PRIMER_FILE_MOVE_PREPARED) as {
        id: string;
        payload: string;
        root: string;
        workspaceId: number;
      }[]
  );
  for (const { id, payload, root, workspaceId } of pending) {
    if (workspaceMutationRootIdentity(root) !== physicalRoot) continue;
    if (active.has(id)) throw new Error('The primer move is still in progress.');
    active.set(id, null);
    try {
      const intent = intentSchema.parse(JSON.parse(payload));
      const oldPath = join(root, intent.source),
        newPath = join(root, intent.destination);
      const move = { workspaceRoot: root, oldPath, newPath, actor: intent.actor };
      const validate = () => {
        assertMoveAuthority(db, move, intent);
        const catalog = new ScientificObjectStore(db, workspaceId).catalog();
        if (
          catalog.head &&
          catalog.entries.some(
            (entry) =>
              !entry.tombstone &&
              entry.path &&
              [
                intent.source,
                intent.destination,
                ...intent.changes.flatMap((item) => [item.path, item.destination]),
              ].some((path) => pathIsAtOrUnder(entry.path!, path))
          )
        )
          conflict();
      };
      runDatabase(validate);
      const old = lstatSync(oldPath, { bigint: true, throwIfNoEntry: false });
      const dest = lstatSync(newPath, { bigint: true, throwIfNoEntry: false });
      if (!!old === !!dest) conflict();
      const actual = old ?? dest!;
      const location = old ? oldPath : newPath;
      const { writes, hashes, saved, expectedHashes } = inspectPrimerMoveSources(
        intent,
        move,
        !!old
      );
      const rewrittenRoot =
        !old &&
        actual.isFile() &&
        expectedHashes.get('')?.next === hash(readFileSync(location, 'utf8'));
      if (
        !old &&
        String(actual.dev) === intent.dev &&
        String(actual.ino) !== intent.ino &&
        !rewrittenRoot
      )
        conflict();
      const digest = await workspaceMoveTreeDigest(location, (name, sha) => {
        const expected = expectedHashes.get(name);
        return expected && expected.next === sha ? expected.prior : sha;
      });
      if (digest !== intent.tree) conflict();
      runDatabase(() => {
        validate();
        if (lstatSync(old ? newPath : oldPath, { throwIfNoEntry: false })) conflict();
        if (writes.size && applyMoveWrites(writes, hashes, newPath).length) conflict();
        for (const item of intent.changes) {
          const path = join(root, old ? item.path : item.destination);
          if (hash(readFileSync(path, 'utf8')) !== (old ? hash(item.source) : item.nextHash))
            conflict();
        }
        db.transaction(() => {
          if (!old) relocateWorkspaceFileRefsInDb(db, { ...move, savedPrimers: saved });
          finishPrimerFileMoveInTx(db, id);
        })();
      });
    } finally {
      active.delete(id);
    }
  }
}
