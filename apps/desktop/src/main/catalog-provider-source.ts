import type Database from 'better-sqlite3';
import type { ExternalProviderSourceRequest } from '../shared/benchling-migration-raw-source';
import {
  isExactProviderStableId,
  providerObjectClassForStableId,
} from '../shared/provider-object-reference';

export function readCatalogProviderSource(
  db: Database.Database,
  entityId: string
): {
  request: ExternalProviderSourceRequest;
  workspacePath: string;
  historyRunId: string;
  sourceId: string;
  sourceObjectId: string;
} | null {
  const rows = db
    .prepare(
      `
    SELECT w.id AS workspace_id, w.path AS workspace_path, e.metadata,
           b.stable_object_id, b.object_class, b.evidence_json
    FROM catalog_entities e
    JOIN workspaces w ON w.id=e.workspace_id
    JOIN catalog_provider_bindings b ON b.entity_id=e.id
    WHERE e.id=? AND e.status='active' AND w.archived_at IS NULL AND w.trashed_at IS NULL
      AND b.provider='benchling' AND b.binding_kind IN ('observed','reviewed')
  `
    )
    .all(entityId);
  const matches = rows.flatMap((row) => {
    if (
      !record(row) ||
      typeof row.workspace_id !== 'number' ||
      typeof row.workspace_path !== 'string'
    )
      return [];
    const metadata = jsonRecord(row.metadata);
    const source = metadata?.migrationSource;
    if (
      !record(source) ||
      !opaqueId(source.historyRunId) ||
      !opaqueId(source.sourceId) ||
      !isExactProviderStableId(source.sourceObjectId) ||
      row.stable_object_id !== source.sourceObjectId ||
      row.object_class !== providerObjectClassForStableId(source.sourceObjectId)
    )
      return [];
    const evidence = jsonRecord(row.evidence_json);
    if (!evidence || evidence.conflict) return [];
    return [
      {
        request: { workspaceId: row.workspace_id, entityId, sourceRecordId: source.sourceObjectId },
        workspacePath: row.workspace_path,
        historyRunId: source.historyRunId,
        sourceId: source.sourceId,
        sourceObjectId: source.sourceObjectId,
      },
    ];
  });
  return matches.length === 1 ? matches[0] : null;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function jsonRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return record(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function opaqueId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 512 &&
    !/[\0\r\n]/u.test(value)
  );
}
