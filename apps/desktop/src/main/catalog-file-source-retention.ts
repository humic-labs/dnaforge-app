import { retainTablePackage } from './retain-table-package';
import type Database from 'better-sqlite3';
import { lstat, readFile } from 'node:fs/promises';
import { parseNotebookPackageDocument } from '../db/notebook-package';
import { scopedProjectionId, workspaceScopeKey, stripWorkspaceScope } from '../shared/workspace-scoped-identity';
import { retainNotebookPackage } from './retain-notebook-package';
import { retainSequencePackage } from './retain-sequence-package';
import { savedFileWorkspace } from './saved-file-publication';
import { basename, dirname, isAbsolute } from 'node:path';
import { isPathInsideBoundary } from '../shared/path-boundary';
import { isForgePackageMetaPath } from '../shared/forge-package-path';
import { inferCatalogFileKind } from '../shared/catalog-file-kind';
import { assertWorkspaceProjectionPathSafe } from './workspace-projection-boundary';
import { stageExistingFileSource, stageRetainedSourceBinding } from './saved-file-sources';

type Binding = {
  path: string;
  fileKind?: string | null;
  workspaceRoot?: string | null;
  status?: string | null;
  contentHash?: string | null;
  expectedPackageEntityId?: string;
};
export async function stageCatalogFileSource(
  db: Database.Database,
  input: Binding,
  assertCurrent?: () => void
) {
  if ((input.status && input.status !== 'current') || input.fileKind === 'folder') return;
  if (!isAbsolute(input.path))
    throw new Error('Catalog file retention requires an absolute file location.');
  if (input.workspaceRoot) assertWorkspaceProjectionPathSafe(input.workspaceRoot, input.path);
  const leaf = await lstat(input.path).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return null;
    throw e;
  });
  if (!leaf) return;
  if (leaf.isSymbolicLink()) throw new Error('A saved file binding cannot follow a symbolic link.');
  const kind = input.fileKind ?? inferCatalogFileKind(input.path);
  if (leaf.isDirectory()) {
    if (kind === 'directory' || kind === 'file') return;
    return stageExistingFileSource(db, input.path);
  }
  const verified = input.contentHash?.match(/^(?:sha256:)?([a-f0-9]{64})$/)?.[1];
  const marker = isForgePackageMetaPath(input.path, basename(input.path));
  if (
    marker &&
    [
      'dnaforge-table',
      'waypoint-sequence',
      'waypoint-notebook',
      'waypoint-protocol',
      'waypoint-protocol-run',
    ].includes(kind)
  ) {
    const root = dirname(dirname(input.path));
    if (
      input.workspaceRoot &&
      (!isPathInsideBoundary(root, input.workspaceRoot) || root === input.workspaceRoot)
    )
      return;
    if (verified) {
      const { hashWorkspaceSyncFileOnDisk } = await import('./workspace-sync-blob-cache');
      if ((await hashWorkspaceSyncFileOnDisk(input.path)).sha256 !== verified)
        throw new Error('The bound package marker changed before its source could be retained.');
    }
    if (input.workspaceRoot && (kind === 'waypoint-notebook' || kind === 'waypoint-sequence' || kind === 'dnaforge-table')) {
      const workspace = savedFileWorkspace(db, input.workspaceRoot);
      if (!workspace) throw new Error('The saved package is missing its owning project.');
      const source = { workspaceRoot: input.workspaceRoot, packageRoot: root };
      let entityId: string;
      const expectedId = input.expectedPackageEntityId === undefined ? undefined : stripWorkspaceScope(input.expectedPackageEntityId);
      if (kind === 'waypoint-notebook') {
        const document = parseNotebookPackageDocument(await readFile(input.path, 'utf8'));
        if (expectedId !== undefined && document.id !== expectedId) throw new Error('The notebook has a different saved identity.');
        await retainNotebookPackage(db, source, document.id, 'published', assertCurrent);
        entityId = scopedProjectionId(
          workspaceScopeKey(workspace.repo_uuid, workspace.id),
          document.id
        );
      } else if (kind === 'dnaforge-table') entityId = await retainTablePackage(db, source, expectedId, assertCurrent);
      else entityId = await retainSequencePackage(db, source, expectedId, assertCurrent);
      return stageRetainedSourceBinding(db, { entityId, workspaceId: workspace.id }, root);
    }
    return stageExistingFileSource(db, root);
  }
  return stageExistingFileSource(db, input.path, verified);
}

export async function withCatalogFileSource<T extends { workspace_id: number | null }>(
  db: Database.Database,
  input: Binding,
  run: () => T,
  entityId: (row: T) => string,
  assertCurrent: () => void
): Promise<T> {
  const stage = await stageCatalogFileSource(db, input, assertCurrent);
  assertCurrent();
  return db.transaction(() => {
    const row = run();
    stage?.({ workspaceId: row.workspace_id, entityId: entityId(row) });
    return row;
  })();
}
