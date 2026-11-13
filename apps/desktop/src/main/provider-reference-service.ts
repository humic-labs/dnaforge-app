import type Database from 'better-sqlite3';

import {
  parseProviderObjectReference,
  type ProviderObjectReference,
  type ProviderReferenceResolution,
} from '../shared/provider-object-reference';
import { queryProviderBindingCandidates } from './catalog-provider-bindings';
import {
  resolveProviderReference,
  type ProviderReferenceDisposition,
} from './benchling-migration/provider-reference-resolver';

export type ProviderReferenceTarget = {
  entityId: string;
  title: string;
  entityType: string;
  scope: 'workspace' | 'registry';
};

export type ProviderReferenceResolutionView = {
  resolution: ProviderReferenceResolution;
  target: ProviderReferenceTarget | null;
};

export type ResolveProviderReferenceRequest = {
  workspaceRoot: string;
  reference: unknown;
  disposition?: ProviderReferenceDisposition;
  sourceUrl?: string | null;
  brokenReason?: string | null;
};

type WorkspaceRow = { id: number; path: string };

export function allowedWorkspaceIds(db: Database.Database): number[] {
  return (
    db
      .prepare(
        `SELECT id FROM workspaces
          WHERE archived_at IS NULL
            AND trashed_at IS NULL
          ORDER BY id`
      )
      .all() as Array<{ id: number }>
  ).map((row) => row.id);
}

export function destinationWorkspaceId(
  db: Database.Database,
  workspaceRoot: string
): number | null {
  const row = db
    .prepare(
      `SELECT id, path FROM workspaces
        WHERE path = ?
          AND archived_at IS NULL
          AND trashed_at IS NULL
        LIMIT 1`
    )
    .get(workspaceRoot) as WorkspaceRow | undefined;
  return row?.id ?? null;
}

export function visibleRegistryEntityIds(db: Database.Database): string[] {
  return (
    db
      .prepare(
        `SELECT id FROM catalog_entities
          WHERE workspace_id IS NULL
            AND status = 'active'
          ORDER BY id`
      )
      .all() as Array<{ id: string }>
  ).map((row) => row.id);
}

function loadTarget(
  db: Database.Database,
  entityId: string,
  scope: 'workspace' | 'registry'
): ProviderReferenceTarget | null {
  const row = db
    .prepare(`SELECT id, name, type FROM catalog_entities WHERE id = ? AND status = 'active'`)
    .get(entityId) as { id: string; name: string; type: string } | undefined;
  if (!row) return null;
  return { entityId: row.id, title: row.name, entityType: row.type, scope };
}

export function resolveStoredProviderReference(
  db: Database.Database,
  request: ResolveProviderReferenceRequest
): ProviderReferenceResolutionView {
  const reference: ProviderObjectReference | null = parseProviderObjectReference(request.reference);

  const destination = destinationWorkspaceId(db, request.workspaceRoot);
  const workspaceIds = allowedWorkspaceIds(db);
  const registryIds = visibleRegistryEntityIds(db);

  const candidates = reference
    ? queryProviderBindingCandidates(db, {
        provider: reference.provider,
        stableObjectId: reference.stableObjectId,
        objectClass: reference.objectClass,
        allowedWorkspaceIds: workspaceIds,
        allowedRegistryEntityIds: registryIds,
      })
    : [];

  const resolution = resolveProviderReference({
    reference,
    ...(request.disposition ? { disposition: request.disposition } : {}),
    sourceUrl: request.sourceUrl ?? null,
    brokenReason: request.brokenReason ?? null,
    destinationWorkspaceId: destination === null ? null : String(destination),
    allowedWorkspaceIds: workspaceIds.map(String),
    allowedRegistryEntityIds: registryIds,
    candidates,
  });

  if (resolution.status !== 'resolved') {
    return { resolution, target: null };
  }

  const target = loadTarget(db, resolution.entityId, resolution.scope);
  if (!target) {
    return { resolution: { status: 'pending', reason: 'target_not_imported' }, target: null };
  }
  return { resolution, target };
}
