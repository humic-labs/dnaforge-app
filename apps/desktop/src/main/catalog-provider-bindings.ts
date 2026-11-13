import type Database from 'better-sqlite3';

import type { CatalogEntityType } from '../shared/catalog-entity';

import { prepareCachedStatement } from './sqlite-statement-cache';

import {
  isExactProviderStableId,
  type ProviderObjectClass,
  type ProviderObjectReference,
} from '../shared/provider-object-reference';
import type { ProviderBindingCandidate } from './benchling-migration/provider-reference-resolver';

export type ProviderBindingKind = 'observed' | 'reviewed';

export type DBCatalogProviderBinding = {
  id: string;
  provider: string;
  stable_object_id: string;
  object_class: string;
  entity_id: string;
  binding_kind: ProviderBindingKind;
  provider_account_hint: string | null;
  canonical_url: string | null;
  evidence_json: string;
  created_at: number;
  updated_at: number;
};

export type WorkspaceProviderBindingInventoryRow = DBCatalogProviderBinding & {
  entity_name: string;
  entity_type: CatalogEntityType;
  entity_storage_type: string;
  entity_status: string;
  entity_workspace_id: number | null;
  file_path: string | null;
  file_relative_path: string | null;
  file_kind: string | null;
  file_status: string | null;
};

export type ProviderBindingEvidence = {
  source: string;
  runId?: string;
  corroboration?: Record<string, string>;
  conflict?: string;
};

export type UpsertProviderBindingInput = {
  reference: ProviderObjectReference;
  entityId: string;
  bindingKind: ProviderBindingKind;
  evidence: ProviderBindingEvidence;
};

export function providerBindingRowId(
  provider: string,
  objectClass: string,
  stableObjectId: string,
  entityId: string
): string {
  return `pb:${provider}:${objectClass}:${stableObjectId}:${entityId}`;
}

export function upsertProviderBinding(
  db: Database.Database,
  input: UpsertProviderBindingInput,
  now = Date.now()
): void {
  const { reference } = input;
  if (!isExactProviderStableId(reference.stableObjectId)) {
    throw new Error('A provider binding requires an exact provider stable object ID.');
  }
  const entity = prepareCachedStatement(
    db,
    'SELECT workspace_id FROM catalog_entities WHERE id=?'
  ).get(input.entityId) as { workspace_id: number | null } | undefined;
  if (!entity) throw new Error('A provider binding requires an existing catalog entity identity.');
  if (
    entity.workspace_id !== null &&
    prepareCachedStatement(
      db,
      `SELECT b.entity_id FROM catalog_provider_bindings b JOIN catalog_entities e ON e.id=b.entity_id
     WHERE b.provider=? AND b.stable_object_id=? AND b.object_class=? AND e.workspace_id=? AND b.entity_id<>? LIMIT 1`
    ).get(
      reference.provider,
      reference.stableObjectId,
      reference.objectClass,
      entity.workspace_id,
      input.entityId
    )
  )
    throw new Error('Provider identity conflicts with another catalog entity in this project.');
  prepareCachedStatement(
    db,
    `INSERT INTO catalog_provider_bindings
       (id, provider, stable_object_id, object_class, entity_id, binding_kind,
        provider_account_hint, canonical_url, evidence_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider, stable_object_id, object_class, entity_id) DO UPDATE SET
       binding_kind = excluded.binding_kind,
       provider_account_hint = excluded.provider_account_hint,
       canonical_url = excluded.canonical_url,
       evidence_json = excluded.evidence_json,
       updated_at = excluded.updated_at`
  ).run(
    providerBindingRowId(
      reference.provider,
      reference.objectClass,
      reference.stableObjectId,
      input.entityId
    ),
    reference.provider,
    reference.stableObjectId,
    reference.objectClass,
    input.entityId,
    input.bindingKind,
    reference.providerAccountHint,
    reference.canonicalUrl,
    JSON.stringify(input.evidence),
    now,
    now
  );
}

export type ProviderBindingCandidateQuery = {
  provider: string;
  stableObjectId: string;
  objectClass: ProviderObjectClass;
  allowedWorkspaceIds: readonly number[];
  allowedRegistryEntityIds: readonly string[];
};

export function queryProviderBindingCandidates(
  db: Database.Database,
  query: ProviderBindingCandidateQuery
): ProviderBindingCandidate[] {
  if (!isExactProviderStableId(query.stableObjectId)) return [];
  const workspaceIds = [...new Set(query.allowedWorkspaceIds)];
  const registryIds = [...new Set(query.allowedRegistryEntityIds)];
  if (workspaceIds.length === 0 && registryIds.length === 0) return [];

  const scopeClauses: string[] = [];
  const parameters: Array<string | number> = [
    query.provider,
    query.stableObjectId,
    query.objectClass,
  ];
  if (workspaceIds.length > 0) {
    scopeClauses.push(`e.workspace_id IN (${workspaceIds.map(() => '?').join(', ')})`);
    parameters.push(...workspaceIds);
  }
  if (registryIds.length > 0) {
    scopeClauses.push(`b.entity_id IN (${registryIds.map(() => '?').join(', ')})`);
    parameters.push(...registryIds);
  }

  const rows = db
    .prepare(
      `SELECT b.*, e.workspace_id AS entity_workspace_id
         FROM catalog_provider_bindings b
         JOIN catalog_entities e ON e.id = b.entity_id
        WHERE b.provider = ?
          AND b.stable_object_id = ?
          AND b.object_class = ?
          AND e.status = 'active'
          AND (${scopeClauses.join(' OR ')})
        ORDER BY b.entity_id`
    )
    .all(...parameters) as Array<DBCatalogProviderBinding & { entity_workspace_id: number | null }>;

  const registrySet = new Set(registryIds);
  return rows.map((row) => {
    let conflict = false;
    try {
      conflict = Boolean((JSON.parse(row.evidence_json) as ProviderBindingEvidence).conflict);
    } catch {
      conflict = false;
    }
    const scope: 'workspace' | 'registry' =
      row.entity_workspace_id === null && registrySet.has(row.entity_id) ? 'registry' : 'workspace';
    return {
      entityId: row.entity_id,
      objectClass: row.object_class,
      bindingKind: row.binding_kind,
      scope,
      workspaceId: row.entity_workspace_id === null ? null : String(row.entity_workspace_id),
      providerAccountHint: row.provider_account_hint,
      ...(conflict ? { corroborationConflict: true } : {}),
    };
  });
}

export function listProviderBindingsForEntity(
  db: Database.Database,
  entityId: string
): DBCatalogProviderBinding[] {
  return db
    .prepare(
      `SELECT * FROM catalog_provider_bindings
        WHERE entity_id = ?
        ORDER BY provider, object_class, stable_object_id`
    )
    .all(entityId) as DBCatalogProviderBinding[];
}

export function listProviderBindingsForIdentity(
  db: Database.Database,
  provider: string,
  stableObjectId: string,
  objectClass: string
): DBCatalogProviderBinding[] {
  return db
    .prepare(
      `SELECT * FROM catalog_provider_bindings
        WHERE provider = ? AND stable_object_id = ? AND object_class = ?
        ORDER BY entity_id`
    )
    .all(provider, stableObjectId, objectClass) as DBCatalogProviderBinding[];
}

export function listProviderBindingInventoryForWorkspace(
  db: Database.Database,
  workspaceId: number,
  provider = 'benchling'
): WorkspaceProviderBindingInventoryRow[] {
  if (!Number.isSafeInteger(workspaceId) || workspaceId <= 0) {
    throw new Error('Provider-binding inventory requires a positive workspace row ID.');
  }
  return db
    .prepare(
      `SELECT b.*,
              e.name AS entity_name,
              e.type AS entity_type,
              e.storage_type AS entity_storage_type,
              e.status AS entity_status,
              e.workspace_id AS entity_workspace_id,
              f.path AS file_path,
              f.relative_path AS file_relative_path,
              f.file_kind AS file_kind,
              f.status AS file_status
         FROM catalog_provider_bindings b
         JOIN catalog_entities e ON e.id = b.entity_id
         LEFT JOIN catalog_entity_files f
           ON f.entity_id = e.id
          AND f.workspace_id = ?
          AND f.status = 'current'
        WHERE b.provider = ?
          AND e.workspace_id = ?
        ORDER BY b.stable_object_id, b.object_class, b.entity_id, f.path`
    )
    .all(workspaceId, provider, workspaceId) as WorkspaceProviderBindingInventoryRow[];
}
