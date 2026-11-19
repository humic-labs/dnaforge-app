import type { MissingFileBinding } from './migration-paths';
import type Database from 'better-sqlite3';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { ScientificObjectStore, hasAcceptedScientificWorkspace } from '../scientific-object-store';
import { scientificWorkspaceIdForRoot } from '../scientific-workspace-identity';
import { FORGE_PACKAGE_MARKER_DIR } from '../../db/forge-package';
import { assertKnownWorkspaceContentWritable } from '../workspace-content-write-access';
import {
  assertSharedProjectContentWritable,
  SharedProjectViewOnlyError,
} from '../shared-project-write-access';

export function canAutomaticallyMigrateWorkspace(db: Database.Database, root: string): boolean {
  const workspaceId = scientificWorkspaceIdForRoot(db, root);
  if (workspaceId === null) return false;
  const workspace = db
    .prepare('SELECT path, access_mode FROM workspaces WHERE id = ?')
    .get(workspaceId) as { path: string; access_mode: string };
  if (workspace.access_mode !== 'writable') return false;
  try {
    assertSharedProjectContentWritable(db, workspace.path);
    return true;
  } catch (error) {
    if (error instanceof SharedProjectViewOnlyError) return false;
    throw error;
  }
}

export function captureSequenceMigrationAdmission(
  db: Database.Database,
  root: string,
  options: { requireWritable?: boolean } = {}
) {
  if (options.requireWritable) assertKnownWorkspaceContentWritable(db, root);
  const workspaceId = scientificWorkspaceIdForRoot(db, root);
  const store =
    workspaceId !== null && hasAcceptedScientificWorkspace(db, workspaceId)
      ? new ScientificObjectStore(db, workspaceId)
      : null;
  const catalog = store?.catalog();
  const acceptedIds = new Set<string>(catalog?.entries.map((entry) => entry.resourceId));
  const protectedPaths = new Set<string>();
  const activeAcceptedPaths = new Set<string>();
  const protect = (path: string, paths = protectedPaths) => {
    const absolute = resolve(path);
    const fromRoot = relative(root, absolute);
    if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) return;
    paths.add(absolute);
    if (dirname(absolute).endsWith(`${sep}${FORGE_PACKAGE_MARKER_DIR}`))
      paths.add(dirname(dirname(absolute)));
  };
  for (const slot of catalog?.entries ?? []) {
    const path = slot.tombstone ? slot.lastPath : slot.path;
    if (path) protect(join(root, path));
    if (!slot.tombstone && slot.path) protect(join(root, slot.path), activeAcceptedPaths);
  }
  if (acceptedIds.size > 0) {
    const bindings = db.prepare('SELECT entity_id, path FROM catalog_entity_files').all() as Array<{
      entity_id: string;
      path: string;
    }>;
    for (const binding of bindings) if (acceptedIds.has(binding.entity_id)) protect(binding.path);
  }
  return {
    workspaceId,
    enrolled: acceptedIds.size > 0,
    protectedEntityIds: acceptedIds,
    protectedPaths: [...protectedPaths],
    activeAcceptedPaths: [...activeAcceptedPaths],
    getMissingFileBindings: () =>
      db
        .prepare(
          `SELECT path, size_bytes AS sizeBytes, content_hash AS contentHash
         FROM catalog_entity_files
        WHERE workspace_id = ? AND status = 'missing' AND content_hash IS NOT NULL`
        )
        .all(workspaceId) as MissingFileBinding[],
    assertCurrent: () => {
      if (options.requireWritable) assertKnownWorkspaceContentWritable(db, root);
      if (
        scientificWorkspaceIdForRoot(db, root) !== workspaceId ||
        (workspaceId !== null &&
          hasAcceptedScientificWorkspace(db, workspaceId) !== (store !== null)) ||
        (store && store.catalog().head !== catalog?.head)
      )
        throw new Error('The accepted project changed during entity migration. Reconcile again.');
    },
  };
}
