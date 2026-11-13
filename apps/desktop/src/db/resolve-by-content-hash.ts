import { platform } from '../platform';
import { pathIsAtOrUnder, pathRelativeToBoundary, stripTrailingSep } from '../shared/path-boundary';

export interface ResolvedByContentHash {
  absolutePath: string;
  workspaceRelativePath: string;
  entityId: string;
  objectUuid: string | null;
}

interface Row {
  path: string;
  relative_path: string | null;
  status: string;
  entity_id: string;
  object_uuid: string | null;
}

const SHA256_FINGERPRINT = /^sha256:[0-9a-f]{64}$/i;

export async function resolveFileByContentHash(
  contentHash: string,
  workspaceRoot: string | null
): Promise<ResolvedByContentHash | null> {
  if (!contentHash || !workspaceRoot) return null;
  if (!SHA256_FINGERPRINT.test(contentHash)) return null;

  const root = stripTrailingSep(workspaceRoot);

  const rows = await platform().db.select<Row[]>(
    `SELECT path, relative_path, status, entity_id, object_uuid
       FROM catalog_entity_files
      WHERE content_hash = ?
        AND status = 'current'
      ORDER BY path`,
    [contentHash]
  );

  const inRoot = rows.filter((r) => pathIsAtOrUnder(r.path, root));
  if (inRoot.length !== 1) return null;

  const row = inRoot[0];
  const relative = row.relative_path ?? pathRelativeToBoundary(row.path, root);
  if (!relative) return null;

  return {
    absolutePath: row.path,
    workspaceRelativePath: relative,
    entityId: row.entity_id,
    objectUuid: row.object_uuid,
  };
}
