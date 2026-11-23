import type Database from 'better-sqlite3';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { lstat, readdir } from 'node:fs/promises';
import { isSavedEntityMember } from '../shared/catalog-file-kind';
import { retainedEntityMessage } from '../shared/workspace-file-trash';
import { nativeWorkspaceEntityPhysicalRoot } from '../shared/native-workspace-manifest';
import { pathIsAtOrUnder } from '../shared/path-boundary';
import { readCatalogManifestSource, type CatalogSourceOwner } from './catalog-source-authority';
import { ScientificObjectStore, hasAcceptedScientificWorkspace } from './scientific-object-store';
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
     UNION ALL SELECT r.source_path,r.workspace_id,NULL,'retained-source' FROM retained_file_source_revisions r
       WHERE (@id IS NULL OR r.workspace_id=@id OR r.workspace_id IS NULL) AND r.status='committed'
         AND r.rowid=(SELECT latest.rowid FROM retained_file_source_revisions latest WHERE latest.workspace_id IS r.workspace_id
           AND latest.entity_id=r.entity_id AND latest.status='committed' ORDER BY latest.created_at DESC,latest.rowid DESC LIMIT 1)
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
  if (!hasAcceptedScientificWorkspace(db, owner.id)) return false;
  return new ScientificObjectStore(db, owner.id)
    .catalog()
    .entries.some((slot) => slot.path && owns(join(owner.path, slot.path)));
}

export function workspaceContainsSavedRecords(db: Database.Database, workspaceId: number): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM lims_entity WHERE workspace_id=@id
    UNION ALL SELECT 1 FROM lims_link WHERE workspace_id=@id
    UNION ALL SELECT 1 FROM lims_audit WHERE workspace_id=@id
    UNION ALL SELECT 1 FROM primers WHERE workspace_id=@id
    UNION ALL SELECT 1 FROM catalog_entities WHERE workspace_id=@id AND type NOT IN ('file','folder')
    UNION ALL SELECT 1 FROM catalog_entity_files f JOIN catalog_entities e ON e.id=f.entity_id
      WHERE f.workspace_id=@id AND e.type NOT IN ('file','folder')
    UNION ALL SELECT 1 FROM catalog_workspace_placements WHERE workspace_id=@id
    UNION ALL SELECT 1 FROM scientific_revision_refs WHERE workspace_id=@id AND head IS NOT NULL
    UNION ALL SELECT 1 FROM retained_file_source_revisions WHERE workspace_id=@id AND status='committed' LIMIT 1`
    )
    .get({ id: workspaceId });
}

export async function assertWorkspaceTreeCanEnterTrash(
  db: Database.Database,
  root: string,
  path: string
) {
  const isOwned = () => workspaceEntityOwnsPath(db, root, path);
  if (isOwned()) throw new Error(retainedEntityMessage);
  const inspect = async (entry: string): Promise<void> => {
    if (isSavedEntityMember(entry)) throw new Error(retainedEntityMessage);
    if (basename(entry) === '.git') return;
    const stat = await lstat(entry);
    if (stat.isDirectory())
      for (const child of await readdir(entry)) await inspect(join(entry, child));
  };
  await inspect(resolve(path));
  if (isOwned()) throw new Error(retainedEntityMessage);
}

export function assertProjectHasNoSavedOwners(db: Database.Database, id: number, root: string) {
  if (workspaceContainsSavedRecords(db, id) || workspaceEntityOwnsPath(db, root, root))
    throw new Error(retainedEntityMessage);
}

export async function assertProjectTrashAllowed(db: Database.Database, id: number, root: string) {
  if (workspaceContainsSavedRecords(db, id)) throw new Error(retainedEntityMessage);
  try {
    await assertWorkspaceTreeCanEnterTrash(db, root, root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try {
      await lstat(root);
    } catch (missing) {
      if ((missing as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw missing;
    }
    throw error;
  }
  if (workspaceContainsSavedRecords(db, id)) throw new Error(retainedEntityMessage);
}

export async function assertSystemTrashAllowed(db: Database.Database, path: string): Promise<void> {
  const root = findKnownWorkspaceRoot(db, path);
  const target = workspaceMutationRootIdentity(path);
  const projects = (
    db.prepare('SELECT id,path FROM workspaces WHERE path IS NOT NULL').all() as {
      id: number;
      path: string;
    }[]
  ).filter((row) => pathIsAtOrUnder(workspaceMutationRootIdentity(row.path), target));
  for (const project of projects) await assertProjectTrashAllowed(db, project.id, project.path);
  if (root) await assertWorkspaceTreeCanEnterTrash(db, root, path);
  else if (workspaceEntityOwnsPath(db, null, path)) throw new Error(retainedEntityMessage);
}
