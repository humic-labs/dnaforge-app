import { platform } from '../platform';
import {
  isSafeWorkspaceRelativePath,
  pathIsAtOrUnder,
  pathRelativeToBoundary,
  stripTrailingSep,
} from '../shared/path-boundary';
import { MANAGED_SEQUENCE_DOCUMENT_FIELD } from '../shared/managed-sequence-document';
import {
  SEQUENCE_PACKAGE_FILE_KIND_ALIASES,
  isSequencePackageFileKind,
} from './sequence-package-contract';
import { sequenceProductExtensionForPath } from './sequence-package';
import { isHostedBrowserRuntime } from '../utils/environment';
import { escapeLikeWildcards } from './catalog-reference-search';

export interface CurrentFileByFilename {
  path: string;
  contentHash: string | null;
  objectUuid: string | null;
  entityId: string;
}

interface Row {
  file_kind: string;
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

  const relativePath = filenameOrPath.replace(/\\/g, '/');
  const basename = relativePath.split('/').filter(Boolean).pop() ?? '';
  if (!basename) return [];

  const root = stripTrailingSep(workspaceRoot);

  const rows = await platform().db.select<Row[]>(
    `SELECT path, relative_path, content_hash, object_uuid, entity_id, file_kind
       FROM catalog_entity_files
      WHERE status = 'current' AND path LIKE ? ESCAPE '\\'
      ORDER BY path`,
    [`%/${escapeLikeWildcards(basename)}`]
  );

  const hosted = isHostedBrowserRuntime();
  const matches: CurrentFileByFilename[] = [];
  for (const row of rows) {
    if ((!hosted && isSequencePackageFileKind(row.file_kind)) || !pathIsAtOrUnder(row.path, root))
      continue;
    const path = row.relative_path ?? pathRelativeToBoundary(row.path, root);
    if (path)
      matches.push({
        path,
        contentHash: row.content_hash,
        objectUuid: row.object_uuid,
        entityId: row.entity_id,
      });
  }
  const packagePath =
    relativePath.includes('/') && isSafeWorkspaceRelativePath(relativePath) ? relativePath : null;
  const productName = sequenceProductExtensionForPath(basename) ? basename : null;
  if (hosted || (!packagePath && !productName)) return matches;
  const packages = await platform().db.select<Row[]>(
    `SELECT f.path, f.relative_path, f.content_hash, f.object_uuid, f.entity_id, f.file_kind
         FROM catalog_entity_files f
         JOIN catalog_entities e ON e.id = f.entity_id
         JOIN workspaces w ON w.id = f.workspace_id
        WHERE f.status = 'current' AND e.status = 'active' AND e.workspace_id = w.id
          AND w.path = ? AND w.archived_at IS NULL AND w.trashed_at IS NULL
          AND f.file_kind IN (${SEQUENCE_PACKAGE_FILE_KIND_ALIASES.map(() => '?').join(', ')})
          AND (replace(f.path, char(92), '/') = rtrim(replace(w.path, char(92), '/'), '/') || '/' || ?
            OR COALESCE(json_extract(CASE WHEN json_valid(e.metadata) THEN e.metadata END,
                '$.${MANAGED_SEQUENCE_DOCUMENT_FIELD}.productFile'), ?) = ? COLLATE NOCASE)
        ORDER BY f.path`,
    [root, ...SEQUENCE_PACKAGE_FILE_KIND_ALIASES, packagePath, productName, productName]
  );
  if (!packages.length) return matches;
  const { readBoundSequenceProduct } = await import('./bound-sequence-product');
  for (const row of packages) {
    if (!isSequencePackageFileKind(row.file_kind)) continue;
    const product = await readBoundSequenceProduct(
      { kind: 'managed-sequence', packageRoot: row.path, packageId: row.entity_id },
      root
    );
    if (!product) continue;
    const exactDirectory =
      packagePath !== null && pathRelativeToBoundary(row.path, root) === packagePath;
    if (exactDirectory || (productName && product.name.toLowerCase() === productName.toLowerCase()))
      matches.push({
        path: exactDirectory ? packagePath : product.path,
        contentHash: row.content_hash,
        objectUuid: row.object_uuid,
        entityId: row.entity_id,
      });
  }
  return matches;
}
