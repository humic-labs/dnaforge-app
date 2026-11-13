import { platform } from '../platform';
import { isSequencePackageFileKind } from './sequence-package';
import { SEQUENCE_PACKAGE_FILE_KIND_ALIASES } from './sequence-package-contract';
import type { SequenceDocumentRef } from '../shared/managed-sequence-document';
import { pathIsAtOrUnder, pathRelativeToBoundary, stripTrailingSep } from '../shared/path-boundary';
import type { SqliteIpcValue } from '../shared/sqlite-ipc';
import { catalogNameSearch } from './catalog-name-search';

import { createMountedCatalogSearch } from '../shared/workspace-search-catalog';
export {
  SIDEBAR_SEARCHABLE_CATALOG_ENTITY_TYPES,
  escapeLikeWildcards,
} from '../shared/workspace-search-catalog';
export type {
  SidebarSearchableCatalogEntityType,
  MountedCatalogEntitySearchResult,
  SearchMountedCatalogEntitiesInput,
  MountedCatalogSearchPosition,
  MountedCatalogSearchPage,
} from '../shared/workspace-search-catalog';
const mountedCatalogSearch = createMountedCatalogSearch(
  <T>(sql: string, params: SqliteIpcValue[]) => platform().db.select<T>(sql, params),
  (request) => platform().db.readMountedCatalogSearchRows?.(request)
);
export const searchMountedCatalogEntitiesByName =
  mountedCatalogSearch.searchMountedCatalogEntitiesByName;
export const searchMountedCatalogEntityPage = mountedCatalogSearch.searchMountedCatalogEntityPage;

export interface CatalogReferenceCandidate {
  entityId: string;
  name: string;
  absolutePath: string;
  workspaceRelativePath: string;
  contentHash: string | null;

  objectUuid: string | null;

  sizeBytes: number | null;

  sequenceDocument: SequenceDocumentRef | null;
}

export interface SearchInput {
  query: string;
  entityType: 'sequence' | 'primer' | 'design' | 'structure';

  workspaceRoot: string | null;
  limit?: number;
}

export interface SearchSequencePackagesInput {
  sequencePackageIds: readonly string[];
  workspaceRoot: string | null;
}

interface CatalogReferenceRow {
  entity_id: string;
  name: string;
  path: string;
  relative_path: string | null;
  content_hash: string | null;
  object_uuid: string | null;
  size_bytes: number | null;
  file_kind: string;
}

export async function searchCatalogReferencesByName({
  query,
  entityType,
  workspaceRoot,
  limit = 20,
}: SearchInput): Promise<CatalogReferenceCandidate[]> {
  if (!workspaceRoot) return [];

  const trimmed = query.trim();
  const search = trimmed ? await catalogNameSearch(trimmed, 'updated') : null;
  const root = stripTrailingSep(workspaceRoot);
  const packageKindPlaceholders = SEQUENCE_PACKAGE_FILE_KIND_ALIASES.map(() => '?').join(', ');
  const params: SqliteIpcValue[] = [
    entityType,
    entityType,
    ...SEQUENCE_PACKAGE_FILE_KIND_ALIASES,
    root,
    root,
    `${root}/%`,
  ];

  let sql = `
    SELECT e.id AS entity_id,
           e.name AS name,
           f.path AS path,
           f.relative_path AS relative_path,
           f.content_hash AS content_hash,
           f.object_uuid AS object_uuid,
           f.size_bytes AS size_bytes,
           f.file_kind AS file_kind
    FROM catalog_entities e${search?.indexSql ?? ''}
    JOIN catalog_entity_files f ON f.entity_id = e.id
    JOIN workspaces w ON w.id = f.workspace_id
    WHERE (e.type = ? OR (? = 'sequence' AND f.file_kind IN (${packageKindPlaceholders})))
      AND e.status = 'active'
      AND f.status = 'current'
      AND w.path = ?
      AND w.archived_at IS NULL
      AND w.trashed_at IS NULL
      AND (f.path = ? OR f.path LIKE ?)`;

  if (search) {
    sql += search.sql;
    params.push(...search.params);
  }

  sql += ` ORDER BY e.updated_at DESC LIMIT ?`;
  params.push(limit);

  const rows = await platform().db.select<CatalogReferenceRow[]>(sql, params);

  return catalogReferenceCandidatesFromRows(rows, root, entityType);
}

export async function searchCatalogSequencePackagesByIds({
  sequencePackageIds,
  workspaceRoot,
}: SearchSequencePackagesInput): Promise<CatalogReferenceCandidate[]> {
  if (!workspaceRoot) return [];
  const ids = [...new Set(sequencePackageIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return [];

  const root = stripTrailingSep(workspaceRoot);
  const rows: CatalogReferenceRow[] = [];
  const batchSize = 500;
  for (let offset = 0; offset < ids.length; offset += batchSize) {
    const batch = ids.slice(offset, offset + batchSize);
    const packageKindPlaceholders = SEQUENCE_PACKAGE_FILE_KIND_ALIASES.map(() => '?').join(', ');
    const idPlaceholders = batch.map(() => '?').join(', ');
    rows.push(
      ...(await platform().db.select<CatalogReferenceRow[]>(
        `SELECT e.id AS entity_id,
                e.name AS name,
                f.path AS path,
                f.relative_path AS relative_path,
                f.content_hash AS content_hash,
                f.object_uuid AS object_uuid,
                f.size_bytes AS size_bytes,
                f.file_kind AS file_kind
           FROM catalog_entities e
           JOIN catalog_entity_files f ON f.entity_id = e.id
           JOIN workspaces w ON w.id = f.workspace_id
          WHERE f.file_kind IN (${packageKindPlaceholders})
            AND e.status = 'active'
            AND f.status = 'current'
            AND w.path = ?
            AND w.archived_at IS NULL
            AND w.trashed_at IS NULL
            AND (f.path = ? OR f.path LIKE ?)
            AND e.id IN (${idPlaceholders})
          ORDER BY e.id ASC`,
        [...SEQUENCE_PACKAGE_FILE_KIND_ALIASES, root, root, `${root}/%`, ...batch]
      ))
    );
  }

  return catalogReferenceCandidatesFromRows(rows, root, 'sequence');
}

function catalogReferenceCandidatesFromRows(
  rows: readonly CatalogReferenceRow[],
  root: string,
  entityType: SearchInput['entityType']
): CatalogReferenceCandidate[] {
  return rows.flatMap((row) => {
    if (!pathIsAtOrUnder(row.path, root)) return [];

    const relative = row.relative_path ?? pathRelativeToBoundary(row.path, root);
    if (relative === null) return [];

    return [
      {
        entityId: row.entity_id,
        name: row.name,
        absolutePath: row.path,
        workspaceRelativePath: relative || '.',
        contentHash: row.content_hash,
        objectUuid: row.object_uuid,
        sizeBytes: row.size_bytes,
        sequenceDocument:
          entityType !== 'sequence'
            ? null
            : isSequencePackageFileKind(row.file_kind)
              ? {
                  kind: 'managed-sequence',
                  packageId: row.entity_id,
                  packageRoot: row.path,
                }
              : { kind: 'catalog-sequence', entityId: row.entity_id },
      },
    ];
  });
}
