import type Database from 'better-sqlite3';
import { mkdir, rename } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  isNotebookPackageMetaPath,
  notebookPackagePaths,
  notebookPackageRootForMetaPath,
} from '../db/notebook-package';
import { readNotebookProjectionSource } from '../db/notebook-projection-source';
import { withNotebookPackageAuthorityLock } from '../db/notebook-package-migration';
import {
  notebookProjectionFingerprint,
  retainLegacyNotebookPage,
  type LegacyNotebookPageMutation,
  type NotebookPageRow,
  type NotebookProjectionFromFileInput,
} from '../shared/notebook-projection';
import { scopedProjectionId, workspaceScopeKey } from '../shared/workspace-scoped-identity';
import { normalizePathForBoundary, pathRelativeToBoundary } from '../shared/path-boundary';
import {
  assertNativeProjectionBinding,
  readNativeProjectionSources,
  resolveNativeProjectionSourceOwner,
  writeEntityProjectionReceiptInDb,
} from './entity-projection-receipts';
import { canonicalWorkspacePath } from './primer-artifact-files';
import { assertWorkspaceWriteAllowed } from './workspace-write-admission';
import { setCatalogFileStateInDb } from './catalog-projection-commands';
import { replaceNotebookReferenceProjectionInDb } from './notebook-reference-projection';
import { normalizeNotebookReferenceOccurrences } from '../shared/notebook-reference-occurrences';

function requireText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0');
}

export function readNotebookPageInDb(db: Database.Database, id: string): NotebookPageRow | null {
  return (
    (db.prepare('SELECT * FROM pages WHERE id=?').get(id) as NotebookPageRow | undefined) ?? null
  );
}

function projectionFingerprint(row: NotebookPageRow | null): string | null {
  return row ? notebookProjectionFingerprint(row.title, row.content) : null;
}

export function notebookPageWorkspaceRootInDb(
  db: Database.Database,
  pageId: string
): string | null {
  if (!requireText(pageId)) throw new Error('Notebook identity is invalid.');
  const bound = db
    .prepare(
      `SELECT w.path FROM catalog_entities e JOIN workspaces w ON w.id=e.workspace_id WHERE e.id=?`
    )
    .get(pageId) as { path: string } | undefined;
  if (bound) return bound.path;
  const workspaces = db.prepare('SELECT id,path,repo_uuid FROM workspaces').all() as Array<{
    id: number;
    path: string;
    repo_uuid: string | null;
  }>;
  const matches = workspaces.filter((workspace) =>
    pageId.startsWith(`${workspaceScopeKey(workspace.repo_uuid, workspace.id)}::`)
  );
  if (matches.length > 1) throw new Error('Notebook workspace identity is ambiguous.');
  return matches[0]?.path ?? null;
}

function assertLegacyNotebookPage(db: Database.Database, id: string): void {
  const binding = db
    .prepare(`SELECT 1 FROM catalog_entity_files WHERE entity_id=? LIMIT 1`)
    .get(id);
  const fileEntity = db
    .prepare(
      "SELECT 1 FROM catalog_entities WHERE id=? AND (type<>'notebook' OR storage_type='file')"
    )
    .get(id);
  const receipt = db
    .prepare(
      "SELECT 1 FROM entity_projection_sources WHERE adapter_kind='notebook' AND entity_id=? LIMIT 1"
    )
    .get(id);
  if (binding || fileEntity || receipt)
    throw new Error('File-backed notebooks require their native package authority.');
}

export function mutateLegacyNotebookPageInDb(
  db: Database.Database,
  input: LegacyNotebookPageMutation
): NotebookPageRow | null {
  const allowed =
    input?.operation === 'delete'
      ? ['operation', 'id']
      : ['operation', 'id', 'title', 'content', 'updatedAt', 'expectedProjectionFingerprint'];
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !allowed.includes(key)) ||
    !requireText(input.id) ||
    !['create', 'upsert', 'delete'].includes(input.operation)
  )
    throw new Error('Legacy notebook mutation is invalid.');
  return db.transaction(() => {
    assertLegacyNotebookPage(db, input.id);
    const workspaceRoot = notebookPageWorkspaceRootInDb(db, input.id);
    if (workspaceRoot) assertWorkspaceWriteAllowed(db, [workspaceRoot]);
    const existing = readNotebookPageInDb(db, input.id);
    if (input.operation === 'delete') return retainLegacyNotebookPage(existing);
    if (
      !requireText(input.title) ||
      !Number.isSafeInteger(input.updatedAt) ||
      input.updatedAt < 0 ||
      !input.content ||
      typeof input.content !== 'object' ||
      Array.isArray(input.content) ||
      input.content.type !== 'doc' ||
      (input.expectedProjectionFingerprint !== null &&
        !requireText(input.expectedProjectionFingerprint))
    )
      throw new Error('Legacy notebook content or revision is invalid.');
    if (projectionFingerprint(existing) !== input.expectedProjectionFingerprint)
      throw new Error('Notebook projection changed before its legacy mutation.');
    if (input.operation === 'create' && existing)
      throw new Error('Notebook projection already exists.');
    const normalized = normalizeNotebookReferenceOccurrences(input.content, {
      documentId: input.id,
    });
    const content = JSON.stringify(normalized);
    JSON.parse(content);
    db.prepare(
      `INSERT INTO pages(id,title,content,date,created_at,updated_at) VALUES(?,?,?,NULL,?,?)
       ON CONFLICT(id) DO UPDATE SET title=excluded.title,content=excluded.content,updated_at=excluded.updated_at`
    ).run(input.id, input.title, content, input.updatedAt, input.updatedAt);
    replaceNotebookReferenceProjectionInDb(db, {
      documentId: input.id,
      sourceFingerprint: notebookProjectionFingerprint(input.title, content),
      content: normalized,
    });
    return readNotebookPageInDb(db, input.id);
  })();
}

export async function replaceNotebookProjectionFromFileInMain(
  db: Database.Database,
  input: NotebookProjectionFromFileInput,
  runDatabase: <T>(work: () => T) => T = (work) => work(),
  settlePresentation?: (row: NotebookPageRow) => void
): Promise<NotebookPageRow> {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (key) =>
        ![
          'pageId',
          'workspaceRoot',
          'sourcePath',
          'sourceFingerprint',
          'expectedProjectionFingerprint',
        ].includes(key)
    ) ||
    !requireText(input.pageId) ||
    (input.workspaceRoot !== null && !requireText(input.workspaceRoot)) ||
    !requireText(input.sourcePath) ||
    !requireText(input.sourceFingerprint) ||
    (input.expectedProjectionFingerprint !== null &&
      !requireText(input.expectedProjectionFingerprint)) ||
    (!isNotebookPackageMetaPath(input.sourcePath) &&
      !input.sourcePath.toLowerCase().endsWith('.wpnote.json'))
  )
    throw new Error('Notebook projection publication request is invalid.');
  const workspace = input.workspaceRoot
    ? (runDatabase(() =>
        db.prepare('SELECT id,path,repo_uuid FROM workspaces WHERE path=?').get(input.workspaceRoot)
      ) as { id: number; path: string; repo_uuid: string | null } | undefined)
    : null;
  if (input.workspaceRoot && !workspace)
    throw new Error('Notebook projection has no exact owning workspace.');
  const relativePath = input.workspaceRoot
    ? pathRelativeToBoundary(input.sourcePath, input.workspaceRoot)
    : input.sourcePath;
  if (!relativePath) throw new Error('Notebook projection source escapes its declared workspace.');
  const key = {
    adapterKind: 'notebook',
    entityId: input.pageId,
    workspaceKey: workspace
      ? `scope:${workspaceScopeKey(workspace.repo_uuid, workspace.id)}`
      : 'unbound',
    relativePath: relativePath.replace(/\\/gu, '/'),
    projectionVersion: 1,
  };
  const owner = runDatabase(() => resolveNativeProjectionSourceOwner(db, key));
  if (normalizePathForBoundary(owner.sourcePath) !== normalizePathForBoundary(input.sourcePath))
    throw new Error('Notebook projection source escapes its declared workspace.');
  const packageRoot = notebookPackageRootForMetaPath(input.sourcePath);
  const publish = async () => {
    const sources = await readNativeProjectionSources(owner);
    const source = await readNotebookProjectionSource(sources, input.sourcePath);
    const fingerprint = notebookProjectionFingerprint(
      source.document.title,
      source.document.content
    );
    if (
      input.sourceFingerprint !== fingerprint ||
      scopedProjectionId(
        workspaceScopeKey(workspace?.repo_uuid, workspace?.id),
        source.document.id
      ) !== input.pageId
    )
      throw new Error('Notebook source changed or does not match its exact scoped projection.');
    await sources.assertUnchanged();
    return runDatabase(() =>
      db.transaction(() => {
        const currentOwner = resolveNativeProjectionSourceOwner(db, key);
        if (
          currentOwner.sourcePath !== owner.sourcePath ||
          currentOwner.workspace?.id !== owner.workspace?.id
        )
          throw new Error('Notebook projection source owner changed before publication.');
        assertNativeProjectionBinding(
          db,
          owner,
          packageRoot ?? input.sourcePath,
          'waypoint-notebook',
          'workspace-notebook-projection'
        );
        const current = readNotebookPageInDb(db, input.pageId);
        if (
          projectionFingerprint(current) !== input.expectedProjectionFingerprint &&
          projectionFingerprint(current) !== fingerprint
        )
          throw new Error('Notebook projection changed before its file publication.');
        const now =
          (packageRoot
            ? sources.mtime(notebookPackagePaths(packageRoot).markdownPath)
            : undefined) ??
          sources.mtime(input.sourcePath) ??
          0;
        db.prepare(
          `INSERT INTO pages(id,title,content,date,created_at,updated_at) VALUES(?,?,?,NULL,?,?)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title,content=excluded.content,updated_at=excluded.updated_at`
        ).run(
          input.pageId,
          source.document.title,
          JSON.stringify(source.document.content),
          now,
          now
        );
        replaceNotebookReferenceProjectionInDb(db, {
          documentId: input.pageId,
          sourceFingerprint: fingerprint,
          content: source.document.content,
        });
        writeEntityProjectionReceiptInDb(db, key, fingerprint);
        const written = readNotebookPageInDb(db, input.pageId)!;
        settlePresentation?.(written);
        return written;
      })()
    );
  };
  return packageRoot ? withNotebookPackageAuthorityLock(packageRoot, publish) : publish();
}

export async function deleteNotebookPageInMain(
  db: Database.Database,
  pageId: string,
  runDatabase: <T>(work: () => T) => T = (work) => work()
): Promise<boolean> {
  if (!requireText(pageId)) throw new Error('Notebook identity is invalid.');
  const binding = runDatabase(() =>
    db
      .prepare(
        `SELECT f.id,f.path,w.path AS root,w.id AS workspace_id,w.repo_uuid
     FROM catalog_entity_files f JOIN workspaces w ON w.id=f.workspace_id
     WHERE f.entity_id=? AND f.file_kind='waypoint-notebook' AND f.status='current'`
      )
      .get(pageId)
  ) as
    | { id: string; path: string; root: string; workspace_id: number; repo_uuid: string | null }
    | undefined;
  if (!binding) return false;
  const sourcePath = binding.path.toLowerCase().endsWith('.wpnote.json')
    ? binding.path
    : notebookPackagePaths(binding.path).metaPath;
  const relativePath = sourcePath.slice(binding.root.replace(/\/+$/u, '').length + 1);
  const owner = runDatabase(() =>
    resolveNativeProjectionSourceOwner(db, {
      adapterKind: 'notebook',
      entityId: pageId,
      workspaceKey: `scope:${workspaceScopeKey(binding.repo_uuid, binding.workspace_id)}`,
      relativePath,
      projectionVersion: 1,
    })
  );
  const remove = async () => {
    runDatabase(() => {
      assertWorkspaceWriteAllowed(db, [binding.path]);
      assertNativeProjectionBinding(db, owner, binding.path, 'waypoint-notebook');
    });
    const sources = await readNativeProjectionSources(owner);
    const source = await readNotebookProjectionSource(sources, sourcePath);
    if (
      scopedProjectionId(
        workspaceScopeKey(binding.repo_uuid, binding.workspace_id),
        source.document.id
      ) !== pageId
    )
      throw new Error('Notebook delete source does not match its exact scoped identity.');
    await sources.assertUnchanged();
    const trashDir = join(binding.root, '.waypoint', 'trash');
    const trashPath = join(trashDir, `${basename(binding.path)}-${randomUUID()}`);
    await canonicalWorkspacePath({
      workspaceRoot: binding.root,
      path: trashPath,
      allowMissing: true,
      artifactNoun: 'notebook trash',
    });
    await mkdir(trashDir, { recursive: true });
    await canonicalWorkspacePath({
      workspaceRoot: binding.root,
      path: trashDir,
      artifactNoun: 'notebook trash',
    });
    await rename(binding.path, trashPath);
    try {
      runDatabase(() =>
        db.transaction(() => {
          assertWorkspaceWriteAllowed(db, [binding.path]);
          assertNativeProjectionBinding(db, owner, binding.path, 'waypoint-notebook');
          setCatalogFileStateInDb(db, binding.path, 'historical', 'notebook-deleted');
          db.prepare('DELETE FROM pages WHERE id=?').run(pageId);
          db.prepare(
            "DELETE FROM entity_projection_sources WHERE adapter_kind='notebook' AND entity_id=?"
          ).run(pageId);
        })()
      );
    } catch (error) {
      try {
        await rename(trashPath, binding.path);
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          'Notebook deletion and authority restoration failed.'
        );
      }
      throw error;
    }
    return true;
  };
  const packageRoot = notebookPackageRootForMetaPath(sourcePath);
  return packageRoot ? withNotebookPackageAuthorityLock(packageRoot, remove) : remove();
}
