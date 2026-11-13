import { platform } from '../platform';
import { pathIsAtOrUnder, pathRelativeToBoundary, stripTrailingSep } from '../shared/path-boundary';
import { escapeLikeWildcards } from './catalog-reference-search';

export interface CurrentFileByFilename {
  path: string;
  contentHash: string | null;
  objectUuid: string | null;
  entityId: string;
}

interface Row {
  path: string;
  relative_path: string | null;
  content_hash: string | null;
  object_uuid: string | null;
  entity_id: string;
}

export async function findCurrentFilesByFilename(
  filenameOrPath: string,
  workspaceRoot: string | null
): Promise<CurrentFileByFilename[]> {
  if (!filenameOrPath || !workspaceRoot) return [];

  const basename = filenameOrPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '';
  if (!basename) return [];

  const root = stripTrailingSep(workspaceRoot);

  const rows = await platform().db.select<Row[]>(
    `SELECT path, relative_path, content_hash, object_uuid, entity_id
       FROM catalog_entity_files
      WHERE status = 'current'
        AND path LIKE ? ESCAPE '\\'
      ORDER BY path`,
    [`%/${escapeLikeWildcards(basename)}`]
  );

  return rows.flatMap((row) => {
    if (!pathIsAtOrUnder(row.path, root)) return [];
    const relative = row.relative_path ?? pathRelativeToBoundary(row.path, root);
    if (!relative) return [];
    return [
      {
        path: relative,
        contentHash: row.content_hash,
        objectUuid: row.object_uuid,
        entityId: row.entity_id,
      },
    ];
  });
}
