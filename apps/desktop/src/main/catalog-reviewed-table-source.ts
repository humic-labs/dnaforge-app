import type Database from 'better-sqlite3';
import { parseNativeWorkspaceMigrationSource } from '../shared/native-workspace-manifest';
import type { ExternalProviderSourceRequest } from '../shared/benchling-migration-raw-source';
import type { ReviewedRegistryTableRowRef } from '../shared/benchling-registry-table-review';
import { reviewedTableRowId } from './benchling-migration/reviewed-table-source';

export function readCatalogReviewedTableSource(
  db: Database.Database,
  entityId: string
): {
  request: ExternalProviderSourceRequest;
  workspacePath: string;
  historyRunId: string;
  sourceId: string;
  sourceObjectId: string;
  reviewedTable: ReviewedRegistryTableRowRef;
} | null {
  const row = db
    .prepare(
      `SELECT w.id AS workspaceId, w.path AS workspacePath, e.metadata
    FROM catalog_entities e JOIN workspaces w ON w.id=e.workspace_id
    JOIN lims_entity l ON l.id=e.id
    WHERE e.id=? AND e.type='record' AND e.status='active' AND l.tombstone=0
      AND w.archived_at IS NULL AND w.trashed_at IS NULL`
    )
    .get(entityId) as
    | { workspaceId: number; workspacePath: string; metadata: string | null }
    | undefined;
  if (!row?.metadata) return null;
  try {
    const metadata: unknown = JSON.parse(row.metadata);
    if (!metadata || typeof metadata !== 'object' || !('migrationSource' in metadata)) return null;
    const source = parseNativeWorkspaceMigrationSource(metadata.migrationSource, entityId);
    if (source?.kind !== 'reviewed_table_row') return null;
    const ref = source.reviewedTable;
    if (
      source.sourceObjectId.startsWith('local-row-') &&
      source.sourceObjectId !==
        reviewedTableRowId(ref.source.entryPath, ref.source.entrySha256, ref.rowOrdinal)
    )
      return null;
    return {
      request: {
        kind: 'reviewed_table_row',
        workspaceId: row.workspaceId,
        entityId,
        sourceRecordId: source.sourceObjectId,
      },
      workspacePath: row.workspacePath,
      historyRunId: source.historyRunId,
      sourceId: source.sourceId,
      sourceObjectId: source.sourceObjectId,
      reviewedTable: ref,
    };
  } catch {
    return null;
  }
}
