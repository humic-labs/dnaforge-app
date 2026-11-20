import type { NotebookPackageFileOps } from '../db/notebook-package-migration';
import { readNotebookProjectionSource } from '../db/notebook-projection-source';
import { notebookPackageRootForMetaPath } from '../db/notebook-package';
import {
  notebookProjectionFingerprint,
  retainLegacyNotebookPage,
  type LegacyNotebookPageMutation,
  type NotebookPageRow,
  type NotebookProjectionFromFileInput,
} from '../shared/notebook-projection';
import { scopedProjectionId, workspaceScopeKey } from '../shared/workspace-scoped-identity';
import type { SettleEntityProjectionSourceInput } from '../shared/entity-projection-source';
import {
  isAbsolutePathLike,
  isSafeWorkspaceRelativePath,
  pathIsAtOrUnder,
} from '../shared/path-boundary';

interface MemoryNotebookDb {
  select<T>(sql: string, params?: Array<string | number | null>): Promise<T>;
  execute(sql: string, params?: Array<string | number | null>): Promise<unknown>;
}

export function createMemoryNotebookPageCommands(
  db: MemoryNotebookDb,
  fs: Pick<NotebookPackageFileOps, 'exists' | 'readTextFile'>
) {
  const readPage = async (id: string) =>
    (await db.select<NotebookPageRow[]>('SELECT * FROM pages WHERE id = ?', [id]))[0] ?? null;
  const fingerprint = (row: NotebookPageRow | null) =>
    row ? notebookProjectionFingerprint(row.title, row.content) : null;
  const upsert = async (id: string, title: string, content: unknown, now: number) => {
    const current = await readPage(id);
    if (current)
      await db.execute('UPDATE pages SET title = ?, content = ?, updated_at = ? WHERE id = ?', [
        title,
        JSON.stringify(content),
        now,
        id,
      ]);
    else
      await db.execute(
        'INSERT INTO pages (id, title, content, date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        [id, title, JSON.stringify(content), null, now, now]
      );
    return (await readPage(id))!;
  };
  return {
    async replaceNotebookProjection(
      input: NotebookProjectionFromFileInput
    ): Promise<NotebookPageRow> {
      const source = await readNotebookProjectionSource(fs, input.sourcePath);
      const workspaces = await db.select<
        Array<{ id: number; path: string; repo_uuid: string | null }>
      >('SELECT id, path, repo_uuid FROM workspaces');
      const workspace = input.workspaceRoot
        ? workspaces.find((workspace) => workspace.path === input.workspaceRoot)
        : null;
      if (!workspace && workspaces.some((known) => pathIsAtOrUnder(input.sourcePath, known.path)))
        throw new Error(
          'A notebook inside a registered project requires its exact workspace owner.'
        );
      const bindings = await db.select<
        Array<{ path: string; file_kind: string; workspace_id: number | null; status: string }>
      >('SELECT * FROM catalog_entity_files WHERE entity_id = ?', [input.pageId]);
      const path = notebookPackageRootForMetaPath(input.sourcePath) ?? input.sourcePath;
      const current = bindings.filter((binding) => binding.status === 'current');
      if (
        (input.workspaceRoot && !workspace) ||
        current.length !== 1 ||
        current[0].path !== path ||
        current[0].workspace_id !== (workspace?.id ?? null) ||
        current[0].file_kind !== 'waypoint-notebook' ||
        scopedProjectionId(
          workspaceScopeKey(workspace?.repo_uuid, workspace?.id),
          source.document.id
        ) !== input.pageId
      )
        throw new Error(
          'Notebook source does not match its exact current memory projection binding.'
        );
      const expected = notebookProjectionFingerprint(
        source.document.title,
        source.document.content
      );
      const existing = fingerprint(await readPage(input.pageId));
      if (
        expected !== input.sourceFingerprint ||
        (existing !== input.expectedProjectionFingerprint && existing !== expected)
      )
        throw new Error('Notebook source or projection changed before publication.');
      return upsert(input.pageId, source.document.title, source.document.content, Date.now());
    },
    async mutateLegacyNotebookPage(
      input: LegacyNotebookPageMutation
    ): Promise<NotebookPageRow | null> {
      const bindings = await db.select<Array<{ file_kind: string }>>(
        'SELECT * FROM catalog_entity_files WHERE entity_id = ?',
        [input.id]
      );
      if (bindings.some((binding) => binding.file_kind === 'waypoint-notebook'))
        throw new Error('File-backed notebooks require their package authority.');
      const existing = await readPage(input.id);
      if (input.operation === 'delete') return retainLegacyNotebookPage(existing);
      if (
        fingerprint(existing) !== input.expectedProjectionFingerprint ||
        (input.operation === 'create' && existing)
      )
        throw new Error('Notebook projection changed before its legacy mutation.');
      return upsert(input.id, input.title, input.content, input.updatedAt);
    },
    async settleEntityProjectionSource({
      key,
      fingerprint: claimed,
    }: SettleEntityProjectionSourceInput): Promise<void> {
      if (
        key.adapterKind !== 'notebook' ||
        key.projectionVersion !== 1 ||
        (key.workspaceKey === 'unbound'
          ? !isAbsolutePathLike(key.relativePath)
          : !isSafeWorkspaceRelativePath(key.relativePath))
      )
        throw new Error('This memory runtime cannot validate the requested projection source.');
      const workspaces = await db.select<
        Array<{ id: number; path: string; repo_uuid: string | null }>
      >('SELECT id, path, repo_uuid FROM workspaces');
      const matching = workspaces.filter(
        (workspace) =>
          key.workspaceKey === `scope:${workspaceScopeKey(workspace.repo_uuid, workspace.id)}` ||
          key.workspaceKey === `workspace:${workspace.id}` ||
          key.workspaceKey === `root:${workspace.path}`
      );
      if (matching.length !== 1 && key.workspaceKey !== 'unbound')
        throw new Error('Notebook source has no exact memory workspace owner.');
      const workspace = matching[0];
      const path = workspace
        ? `${workspace.path.replace(/\/+$/u, '')}/${key.relativePath}`
        : key.relativePath;
      if (!workspace && workspaces.some((known) => pathIsAtOrUnder(path, known.path)))
        throw new Error(
          'A notebook inside a registered project requires its exact workspace owner.'
        );
      const source = await readNotebookProjectionSource(fs, path);
      const row = await readPage(key.entityId);
      const bindings = await db.select<
        Array<{ path: string; file_kind: string; workspace_id: number | null; status: string }>
      >('SELECT * FROM catalog_entity_files WHERE entity_id = ?', [key.entityId]);
      const current = bindings.filter((binding) => binding.status === 'current');
      if (
        current.length !== 1 ||
        current[0].path !== (notebookPackageRootForMetaPath(path) ?? path) ||
        current[0].workspace_id !== (workspace?.id ?? null) ||
        current[0].file_kind !== 'waypoint-notebook' ||
        !row ||
        row.title !== source.document.title ||
        row.content !== JSON.stringify(source.document.content) ||
        scopedProjectionId(
          workspaceScopeKey(workspace?.repo_uuid, workspace?.id),
          source.document.id
        ) !== key.entityId ||
        claimed !== notebookProjectionFingerprint(source.document.title, source.document.content)
      )
        throw new Error('Notebook memory projection differs from its canonical file.');
      await db.execute(
        `INSERT INTO entity_projection_sources
        (adapter_kind, entity_id, workspace_key, relative_path, projection_version, synchronized_fingerprint, synchronized_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(adapter_kind, entity_id, workspace_key, relative_path, projection_version)
        DO UPDATE SET synchronized_fingerprint = excluded.synchronized_fingerprint, synchronized_at = excluded.synchronized_at`,
        [
          key.adapterKind,
          key.entityId,
          key.workspaceKey,
          key.relativePath,
          key.projectionVersion,
          claimed,
          Date.now(),
        ]
      );
    },
  };
}
