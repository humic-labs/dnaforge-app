import { platform } from '../platform';
import { pathIsAtOrUnder, pathRelativeToBoundary, stripTrailingSep } from '../shared/path-boundary';

export interface ResolvedByObjectUuid {
  absolutePath: string;
  workspaceRelativePath: string;
  contentHash: string | null;
  entityId: string;
}

export interface CurrentFileByObjectUuid {
  absolutePath: string;
}

interface Row {
  path: string;
  relative_path: string | null;
  content_hash: string | null;
  status: string;
  entity_id: string;
}

export async function resolveFileByObjectUuid(
  objectUuid: string,
  workspaceRoot: string | null
): Promise<ResolvedByObjectUuid | null> {
  if (!objectUuid || !workspaceRoot) return null;

  const root = stripTrailingSep(workspaceRoot);

  const row = await selectCurrentRowByObjectUuid(objectUuid);
  if (!row) return null;
  if (!pathIsAtOrUnder(row.path, root)) return null;

  const relative = row.relative_path ?? pathRelativeToBoundary(row.path, root);
  if (!relative) return null;

  return {
    absolutePath: row.path,
    workspaceRelativePath: relative,
    contentHash: row.content_hash,
    entityId: row.entity_id,
  };
}

export async function resolveCurrentFileByObjectUuid(
  objectUuid: string
): Promise<CurrentFileByObjectUuid | null> {
  if (!objectUuid) return null;
  const row = await selectCurrentRowByObjectUuid(objectUuid);
  return row ? { absolutePath: row.path } : null;
}

async function selectCurrentRowByObjectUuid(objectUuid: string): Promise<Row | null> {
  const rows = await platform().db.select<Row[]>(
    `SELECT path, relative_path, content_hash, status, entity_id
       FROM catalog_entity_files
      WHERE object_uuid = ?
        AND status = 'current'
      LIMIT 1`,
    [objectUuid]
  );

  return rows[0] ?? null;
}
