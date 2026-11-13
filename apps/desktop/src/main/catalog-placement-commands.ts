import type Database from 'better-sqlite3';
import { isDeepStrictEqual } from 'node:util';
import {
  normalizeCatalogPlacement,
  type CatalogWorkspacePlacementInput,
  type CatalogWorkspacePlacementRow,
} from '../shared/catalog-associations';
import { nativeWorkspaceEntityPlacement } from '../shared/native-workspace-manifest';
import { loadCatalogManifestEntity, requireCatalogEntity } from './catalog-source-authority';

export function writeCatalogWorkspacePlacementInDb(
  db: Database.Database,
  input: CatalogWorkspacePlacementInput
): CatalogWorkspacePlacementRow {
  const normalized = normalizeCatalogPlacement(input);
  return db.transaction(() => {
    const entity = requireCatalogEntity(db, normalized.entityId);
    if (entity.workspace_id !== normalized.workspaceId)
      throw new Error('Catalog placement must use its exact entity workspace owner.');
    const source = loadCatalogManifestEntity(db, entity);
    const placement = source ? nativeWorkspaceEntityPlacement(source.portable) : null;
    const expectedStatus =
      source && 'lifecycle' in source.portable && source.portable.lifecycle?.state === 'archived'
        ? 'hidden'
        : 'active';
    if (
      !placement ||
      placement.kind !== 'catalog-record' ||
      !isDeepStrictEqual(
        {
          parentRelativePath: normalized.parentRelativePath,
          displayName: normalized.displayName,
          presentationKind: normalized.presentationKind,
          status: normalized.status,
        },
        {
          parentRelativePath: placement.parentRelativePath,
          displayName: placement.displayName,
          presentationKind: placement.presentationKind,
          status: expectedStatus,
        }
      )
    )
      throw new Error('Catalog placement does not match its authoritative project source.');
    const now = Date.now();
    db.prepare(
      `INSERT INTO catalog_workspace_placements(entity_id,workspace_id,parent_relative_path,display_name,normalized_sibling_name,presentation_kind,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(entity_id) DO UPDATE SET workspace_id=excluded.workspace_id,parent_relative_path=excluded.parent_relative_path,display_name=excluded.display_name,normalized_sibling_name=excluded.normalized_sibling_name,presentation_kind=excluded.presentation_kind,status=excluded.status,updated_at=excluded.updated_at`
    ).run(
      entity.id,
      normalized.workspaceId,
      normalized.parentRelativePath,
      normalized.displayName,
      normalized.normalizedSiblingName,
      normalized.presentationKind,
      normalized.status,
      now,
      now
    );
    return db
      .prepare('SELECT * FROM catalog_workspace_placements WHERE entity_id=?')
      .get(entity.id) as CatalogWorkspacePlacementRow;
  })();
}

export function removeCatalogWorkspacePlacementInDb(
  db: Database.Database,
  entityId: string,
  mode: 'hide' | 'delete'
): boolean {
  if (mode !== 'hide' && mode !== 'delete')
    throw new Error('Catalog placement removal mode is invalid.');
  return db.transaction(() => {
    const entity = requireCatalogEntity(db, entityId);
    const existing = db
      .prepare('SELECT * FROM catalog_workspace_placements WHERE entity_id=?')
      .get(entity.id) as CatalogWorkspacePlacementRow | undefined;
    if (!existing || (mode === 'hide' && existing.status === 'hidden')) return false;
    if (existing.workspace_id !== entity.workspace_id)
      throw new Error('Catalog placement has a conflicting workspace owner.');
    const source = loadCatalogManifestEntity(db, entity);
    const placement = source ? nativeWorkspaceEntityPlacement(source.portable) : null;
    if (
      placement?.kind === 'catalog-record' &&
      !('lifecycle' in source!.portable && source!.portable.lifecycle?.state === 'archived')
    )
      throw new Error('Catalog placement remains active in its authoritative project source.');
    return (
      (mode === 'delete'
        ? db.prepare('DELETE FROM catalog_workspace_placements WHERE entity_id=?').run(entity.id)
        : db
            .prepare(
              "UPDATE catalog_workspace_placements SET status='hidden',updated_at=? WHERE entity_id=?"
            )
            .run(Date.now(), entity.id)
      ).changes === 1
    );
  })();
}
