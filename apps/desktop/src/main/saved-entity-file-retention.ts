import type Database from 'better-sqlite3';
import { isAbsolute, join, resolve } from 'node:path';
import { lstat, readdir } from 'node:fs/promises';
import { isSavedEntityMember } from '../shared/catalog-file-kind';
import { retainedEntityMessage } from '../shared/workspace-file-trash';
import { nativeWorkspaceEntityPhysicalRoot } from '../shared/native-workspace-manifest';
import { pathIsAtOrUnder } from '../shared/path-boundary';
import { readCatalogManifestSource, type CatalogSourceOwner } from './catalog-source-authority';
import { ScientificObjectStore } from './scientific-object-store';
import {
  findKnownWorkspaceRoot,
  workspaceMutationRootIdentity,
} from './workspace-sync-mutation-lease';

function overlaps(a: string, b: string): boolean {
  return pathIsAtOrUnder(a, b) || pathIsAtOrUnder(b, a);
}

export function workspaceEntityOwnsPath(
  db: Database.Database,
  root: string | null,
  path: string
): boolean {
  const target = workspaceMutationRootIdentity(path);
  const canonicalRoot = root && workspaceMutationRootIdentity(root);
  const owners = canonicalRoot
    ? (
        db.prepare('SELECT * FROM workspaces WHERE path IS NOT NULL').all() as CatalogSourceOwner[]
      ).filter((owner) => workspaceMutationRootIdentity(owner.path) === canonicalRoot)
    : [];
  if (canonicalRoot && owners.length !== 1)
    throw new Error('RETENTION_OWNER_UNKNOWN: The project owner could not be verified.');
  const owner: CatalogSourceOwner | undefined = owners[0];
  const workspaceId = owner?.id ?? null;
  const owns = (candidate: string, folder = false) => {
    const physical = workspaceMutationRootIdentity(candidate);
    return folder ? pathIsAtOrUnder(physical, target) : overlaps(target, physical);
  };
  const bindings = db
    .prepare(
      `SELECT f.path, f.workspace_id, f.relative_path, e.type FROM catalog_entity_files f
       JOIN catalog_entities e ON e.id = f.entity_id WHERE (@id IS NULL OR f.workspace_id = @id OR f.workspace_id IS NULL)
     UNION ALL SELECT substr(locator, 8), workspace_id, NULL, type FROM catalog_entities
       WHERE (@id IS NULL OR workspace_id = @id OR workspace_id IS NULL) AND locator LIKE 'file://%'
     UNION ALL SELECT json_extract(origin_details, '$.artifactPath'), workspace_id, NULL, 'primer'
       FROM primers WHERE (@id IS NULL OR workspace_id = @id) AND json_type(origin_details, '$.artifactPath') = 'text'
     UNION ALL SELECT NULL, workspace_id, json_extract(fields, '$.artifact.relativePath'), kind
       FROM lims_entity WHERE (@id IS NULL OR workspace_id = @id) AND json_type(fields, '$.artifact.relativePath') = 'text'
     UNION ALL SELECT json_extract(fields, '$.sequence.relPath'), json_extract(fields, '$.sequence.workspaceId'), NULL, kind
       FROM lims_entity WHERE json_extract(fields, '$.sequence.mode') = 'file'
       AND json_type(fields, '$.sequence.relPath') = 'text'`
    )
    .all({ id: workspaceId }) as {
    path: string | null;
    workspace_id: number | null;
    relative_path: string | null;
    type: string;
  }[];
  if (
    bindings.some((row) => {
      if (row.path && isAbsolute(row.path) && owns(row.path, row.type === 'folder')) return true;
      if (!owner || row.workspace_id !== owner.id) return false;
      const relativePath = row.relative_path || row.path;
      return (
        relativePath !== null && owns(resolve(owner.path, relativePath), row.type === 'folder')
      );
    })
  )
    return true;
  if (!owner) return false;
  const manifest = readCatalogManifestSource(owner);
  if (
    manifest?.entities.some((entity) => {
      const physical = nativeWorkspaceEntityPhysicalRoot(entity);
      return physical !== null && owns(join(owner.path, physical));
    })
  )
    return true;
  return new ScientificObjectStore(db, owner.id)
    .catalog()
    .entries.some((slot) => slot.path && owns(join(owner.path, slot.path)));
}

export async function assertSystemTrashAllowed(db: Database.Database, path: string): Promise<void> {
  const root = findKnownWorkspaceRoot(db, path);
  if (workspaceEntityOwnsPath(db, root, path)) throw new Error(retainedEntityMessage);
  if (!root) return;
  const inspect = async (entry: string): Promise<void> => {
    if (isSavedEntityMember(entry)) throw new Error(retainedEntityMessage);
    const stat = await lstat(entry);
    if (stat.isDirectory())
      for (const child of await readdir(entry)) await inspect(join(entry, child));
  };
  await inspect(resolve(path));
  if (workspaceEntityOwnsPath(db, root, path)) throw new Error(retainedEntityMessage);
}
