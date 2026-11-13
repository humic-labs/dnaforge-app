import type Database from 'better-sqlite3';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
  NATIVE_WORKSPACE_MANIFEST_PATH,
  parseNativeWorkspaceManifest,
  type NativeWorkspaceManifestAnyEntity,
} from '../shared/native-workspace-manifest';
import type { CatalogEntityRow } from '../shared/catalog-registration';
import { scopedProjectionId, workspaceScopeKey } from '../shared/workspace-scoped-identity';
import { readClassificationFile } from './native-sequence-classification-review';

export interface CatalogSourceOwner {
  id: number;
  path: string;
  repo_uuid: string | null;
  access_mode: string;
  archived_at: number | null;
  trashed_at: number | null;
}

export function requireCatalogSourceOwner(
  db: Database.Database,
  workspaceId: number
): CatalogSourceOwner {
  const owner = db.prepare('SELECT * FROM workspaces WHERE id=?').get(workspaceId) as
    | CatalogSourceOwner
    | undefined;
  if (!owner || owner.archived_at !== null || owner.trashed_at !== null)
    throw new Error('Catalog entity has no active project owner.');
  return owner;
}

export function requireCatalogEntity(db: Database.Database, entityId: string): CatalogEntityRow {
  if (typeof entityId !== 'string' || !entityId.trim() || entityId.includes('\0'))
    throw new Error('Catalog entity identity is invalid.');
  const entity = db.prepare('SELECT * FROM catalog_entities WHERE id=?').get(entityId) as
    | CatalogEntityRow
    | undefined;
  if (!entity) throw new Error('Catalog entity identity does not exist.');
  if (entity.workspace_id !== null) requireCatalogSourceOwner(db, entity.workspace_id);
  return entity;
}

export function readCatalogManifestSource(owner: CatalogSourceOwner) {
  try {
    const root = realpathSync(owner.path);
    return parseNativeWorkspaceManifest(
      readClassificationFile(
        root,
        join(root, NATIVE_WORKSPACE_MANIFEST_PATH),
        16 * 1024 * 1024
      ).toString('utf8')
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function findCatalogManifestEntity(
  owner: CatalogSourceOwner,
  entityId: string,
  entities: readonly NativeWorkspaceManifestAnyEntity[]
): NativeWorkspaceManifestAnyEntity | null {
  const scope = workspaceScopeKey(owner.repo_uuid, owner.id);
  const matches = entities.filter(
    (entity) => entity.id === entityId || scopedProjectionId(scope, entity.id) === entityId
  );
  if (matches.length > 1) throw new Error('Catalog source entity identity is ambiguous.');
  return matches[0] ?? null;
}

export function loadCatalogManifestEntity(db: Database.Database, entity: CatalogEntityRow) {
  if (entity.workspace_id === null) return null;
  const owner = requireCatalogSourceOwner(db, entity.workspace_id);
  const manifest = readCatalogManifestSource(owner);
  if (!manifest) return null;
  const portable = findCatalogManifestEntity(owner, entity.id, manifest.entities);
  return portable ? { owner, manifest, portable } : null;
}
