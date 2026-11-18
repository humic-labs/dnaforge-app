import { catalogNameSearch } from './catalog-name-search';
import type { CatalogEntityType } from './catalog-entity';
import type { SqliteIpcValue } from './sqlite-ipc';
import { isPortableNativeEntityId } from './native-entity-reference';
import { stripTrailingSep } from './path-boundary';
import { sequenceDisplayName } from './sequence-presentation';
import type { EntityColorContext } from './entity-color-family';
import { catalogIconContext } from './catalog-icon-context';

export type SidebarSearchableCatalogEntityType = Exclude<CatalogEntityType, 'selection' | 'folder'>;

const sidebarSearchableCatalogEntityTypeInventory = {
  'track-view': true,
  'molecular-document': true,
  sequence: true,
  primer: true,
  notebook: true,
  design: true,
  alignment: true,
  trace: true,
  report: true,
  construct: true,
  sample: true,
  record: true,
  structure: true,
  protein: true,
  protocol: true,
  protocol_run: true,
  file: true,
} as const satisfies Record<SidebarSearchableCatalogEntityType, true>;

export const SIDEBAR_SEARCHABLE_CATALOG_ENTITY_TYPES = Object.keys(
  sidebarSearchableCatalogEntityTypeInventory
) as SidebarSearchableCatalogEntityType[];

export interface MountedCatalogEntitySearchResult {
  entityId: string;
  entityType: SidebarSearchableCatalogEntityType;
  name: string;
  workspaceRoot: string;
  workspaceName: string;
  iconContext?: EntityColorContext;
}

export interface SearchMountedCatalogEntitiesInput {
  query: string;

  workspaceRoots: readonly string[];

  openLocalDesignIds?: readonly string[];
  limit?: number;
  entityTypes?: readonly SidebarSearchableCatalogEntityType[];
}

export interface MountedCatalogSearchPosition {
  name: string;
  updatedAt: number;
  entityId: string;
  workspaceRoot: string;
}

export interface MountedCatalogSearchPage {
  results: MountedCatalogEntitySearchResult[];
  nextPosition: MountedCatalogSearchPosition | null;
}

export interface MountedCatalogEntitySearchRow {
  entity_id: string;
  entity_type: string;
  name: string;
  storage_type: string;
  metadata: string | null;
  workspace_root: string;
  workspace_name: string;
  updated_at: number;
  icon_kind?: string | null;
  icon_path?: string | null;
}

const sidebarSearchableCatalogEntityTypeSet = new Set<string>(
  SIDEBAR_SEARCHABLE_CATALOG_ENTITY_TYPES
);

export type CatalogSearchSelect = <T>(sql: string, params: SqliteIpcValue[]) => Promise<T>;

export interface MountedCatalogSearchRead {
  query: string;
  workspaceRoots: readonly string[];
  openLocalDesignIds: readonly string[];
  entityTypes: readonly SidebarSearchableCatalogEntityType[];
  limit: number;
  after?: MountedCatalogSearchPosition;
}

export type MountedCatalogSearchReader = (
  request: MountedCatalogSearchRead
) => Promise<MountedCatalogEntitySearchRow[]>;

export function createMountedCatalogSearch(
  select: CatalogSearchSelect,
  readProjectedRows?: (
    request: MountedCatalogSearchRead
  ) => ReturnType<MountedCatalogSearchReader> | undefined
) {
  async function searchMountedCatalogEntitiesByName({
    query,
    workspaceRoots,
    openLocalDesignIds = [],
    limit = 100,
    entityTypes,
  }: SearchMountedCatalogEntitiesInput): Promise<MountedCatalogEntitySearchResult[]> {
    const rows = await readMountedCatalogSearchRows({
      query,
      workspaceRoots,
      openLocalDesignIds,
      limit: Math.max(1, Math.min(200, Math.trunc(limit))),
      entityTypes,
    });
    return mountedCatalogSearchResults(rows, workspaceRoots, openLocalDesignIds);
  }

  async function searchMountedCatalogEntityPage(
    input: SearchMountedCatalogEntitiesInput & { after?: MountedCatalogSearchPosition }
  ): Promise<MountedCatalogSearchPage> {
    const limit = Math.max(1, Math.min(200, Math.trunc(input.limit ?? 25)));
    const rows = await readMountedCatalogSearchRows({ ...input, limit: limit + 1 });
    const valid = mountedCatalogSearchResults(rows, input.workspaceRoots, input.openLocalDesignIds);
    const results = valid.slice(0, limit);
    const last =
      valid.length > limit
        ? rows.find(
            (row) =>
              row.entity_id === results[results.length - 1].entityId &&
              row.workspace_root === results[results.length - 1].workspaceRoot
          )
        : rows.length === limit + 1
          ? rows[rows.length - 1]
          : undefined;
    return {
      results,
      nextPosition: last
        ? {
            name: last.name,
            updatedAt: last.updated_at,
            entityId: last.entity_id,
            workspaceRoot: last.workspace_root,
          }
        : null,
    };
  }

  async function readMountedCatalogSearchRows({
    query,
    workspaceRoots,
    openLocalDesignIds = [],
    limit = 100,
    entityTypes = SIDEBAR_SEARCHABLE_CATALOG_ENTITY_TYPES,
    after,
  }: SearchMountedCatalogEntitiesInput & {
    after?: MountedCatalogSearchPosition;
  }): Promise<MountedCatalogEntitySearchRow[]> {
    const roots = [
      ...new Set(workspaceRoots.map((root) => stripTrailingSep(root)).filter(Boolean)),
    ];
    if (roots.length === 0) return [];
    const types = [...new Set(entityTypes)];
    if (types.some((type) => !sidebarSearchableCatalogEntityTypeSet.has(type)))
      throw new Error('The search contains an unsupported entity type.');
    if (types.length === 0) return [];
    const trimmed = query.trim();
    const localDesignIds = [...new Set(openLocalDesignIds.map((id) => id.trim()).filter(Boolean))];
    const rowLimit = Math.max(1, Math.min(201, Math.trunc(limit)));
    const projected = readProjectedRows?.({
      query: trimmed,
      workspaceRoots: roots,
      openLocalDesignIds: localDesignIds,
      entityTypes: types,
      limit: rowLimit,
      after,
    });
    if (projected) return projected;

    const typePlaceholders = types.map(() => '?').join(', ');
    const rootPlaceholders = roots.map(() => '?').join(', ');
    const params: SqliteIpcValue[] = [...types, ...roots];
    const search = trimmed ? await catalogNameSearch(trimmed, 'name', select) : null;

    let sql = `
    SELECT e.id AS entity_id,
           e.type AS entity_type,
           e.name AS name,
           e.storage_type AS storage_type,
           e.metadata AS metadata,
           (SELECT kind FROM lims_entity l WHERE l.id = e.id) AS icon_kind,
           (SELECT path FROM catalog_entity_files f
             WHERE f.entity_id = e.id AND f.workspace_id = e.workspace_id
               AND f.status = 'current' ORDER BY f.id LIMIT 1) AS icon_path,
           w.path AS workspace_root,
           w.name AS workspace_name,
           COALESCE(e.updated_at, 0) AS updated_at
    FROM catalog_entities e${search?.indexSql ?? ''}
    JOIN workspaces w ON w.id = e.workspace_id
    WHERE e.type IN (${typePlaceholders})
      AND e.status = 'active'
      AND w.path IN (${rootPlaceholders})
      AND w.archived_at IS NULL
      AND w.trashed_at IS NULL
      AND (
        e.type <> 'design'
        OR e.storage_type <> 'localStorage'
        OR CASE
          WHEN json_valid(e.metadata)
          THEN json_extract(e.metadata, '$.embeddedDesignAvailable') IS NOT 0
          ELSE 1
        END
        ${
          localDesignIds.length > 0
            ? `OR e.id IN (${localDesignIds.map(() => '?').join(', ')})`
            : ''
        }
      )
      AND (
        EXISTS (
          SELECT 1
          FROM catalog_entity_files f
          WHERE f.entity_id = e.id
            AND f.workspace_id = e.workspace_id
            AND f.status = 'current'
        )
        OR (
          e.storage_type = 'database'
          AND e.locator = 'entity://lims/' || e.id
        )
        OR (
          e.type = 'notebook'
          AND e.storage_type = 'database'
          AND e.locator = 'entity://page/' || e.id
          AND EXISTS (
            SELECT 1
            FROM pages p
            WHERE p.id = e.id
          )
        )
      )`;

    params.push(...localDesignIds);

    if (search) {
      sql += search.sql;
      params.push(...search.params);
    }

    if (after) {
      sql += ` AND (
      e.name COLLATE NOCASE > ? COLLATE NOCASE
      OR (e.name COLLATE NOCASE = ? COLLATE NOCASE AND (
        COALESCE(e.updated_at, 0) < ?
        OR (COALESCE(e.updated_at, 0) = ? AND (
          e.id > ? OR (e.id = ? AND w.path > ?)
        ))
      ))
    )`;
      params.push(
        after.name,
        after.name,
        after.updatedAt,
        after.updatedAt,
        after.entityId,
        after.entityId,
        after.workspaceRoot
      );
    }
    sql += ` ORDER BY e.name COLLATE NOCASE ASC, COALESCE(e.updated_at, 0) DESC, e.id ASC, w.path ASC LIMIT ?`;
    params.push(rowLimit);
    return select<MountedCatalogEntitySearchRow[]>(sql, params);
  }

  function mountedCatalogSearchResults(
    rows: readonly MountedCatalogEntitySearchRow[],
    workspaceRoots: readonly string[],
    openLocalDesignIds: readonly string[] = []
  ): MountedCatalogEntitySearchResult[] {
    const roots = new Set(workspaceRoots.map(stripTrailingSep));
    const localDesignIdSet = new Set(openLocalDesignIds);
    return rows.flatMap((row) => {
      if (!roots.has(row.workspace_root)) return [];
      if (!sidebarSearchableCatalogEntityTypeSet.has(row.entity_type)) return [];
      if (!isPortableNativeEntityId(row.entity_id)) return [];
      if (
        row.entity_type === 'design' &&
        row.storage_type === 'localStorage' &&
        designSnapshotExplicitlyUnavailable(row.metadata) &&
        !localDesignIdSet.has(row.entity_id)
      )
        return [];

      const iconContext = catalogIconContext({
        kind: row.icon_kind,
        path: row.icon_path,
        metadata: row.metadata,
      });
      return [
        {
          entityId: row.entity_id,
          entityType: row.entity_type as SidebarSearchableCatalogEntityType,
          name: row.entity_type === 'sequence' ? sequenceDisplayName(row.name) : row.name,
          workspaceRoot: row.workspace_root,
          workspaceName: row.workspace_name,
          ...(iconContext ? { iconContext } : {}),
        },
      ];
    });
  }

  return { searchMountedCatalogEntitiesByName, searchMountedCatalogEntityPage };
}

interface ProjectedCatalogSearchRow extends MountedCatalogEntitySearchRow {
  locator: string;
  hasCurrentFile: boolean;
  hasNotebookPage: boolean;
}

export function searchProjectedCatalogRows(
  rows: readonly ProjectedCatalogSearchRow[],
  request: MountedCatalogSearchRead
): MountedCatalogEntitySearchRow[] {
  const types = new Set<string>(request.entityTypes);
  const localDesigns = new Set(request.openLocalDesignIds);
  const query = foldCatalogName(request.query);
  return rows
    .filter((row) => {
      if (!types.has(row.entity_type) || !foldCatalogName(row.name).includes(query)) return false;
      if (request.after && compareCatalogPositions(catalogPosition(row), request.after) <= 0)
        return false;
      if (
        row.entity_type === 'design' &&
        row.storage_type === 'localStorage' &&
        designSnapshotExplicitlyUnavailable(row.metadata) &&
        !localDesigns.has(row.entity_id)
      )
        return false;

      return (
        row.hasCurrentFile ||
        (row.storage_type === 'database' && row.locator === `entity://lims/${row.entity_id}`) ||
        (row.entity_type === 'notebook' &&
          row.storage_type === 'database' &&
          row.locator === `entity://page/${row.entity_id}` &&
          row.hasNotebookPage)
      );
    })
    .sort((left, right) => compareCatalogPositions(catalogPosition(left), catalogPosition(right)))
    .slice(0, request.limit);
}

function catalogPosition(row: MountedCatalogEntitySearchRow): MountedCatalogSearchPosition {
  return {
    name: row.name,
    updatedAt: row.updated_at,
    entityId: row.entity_id,
    workspaceRoot: row.workspace_root,
  };
}

function compareCatalogPositions(
  left: MountedCatalogSearchPosition,
  right: MountedCatalogSearchPosition
): number {
  return (
    compareCatalogText(foldCatalogName(left.name), foldCatalogName(right.name)) ||
    right.updatedAt - left.updatedAt ||
    compareCatalogText(left.entityId, right.entityId) ||
    compareCatalogText(left.workspaceRoot, right.workspaceRoot)
  );
}

function foldCatalogName(text: string): string {
  return text.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function compareCatalogText(left: string, right: string): number {
  const rhs = right[Symbol.iterator]();
  for (const character of left) {
    const next = rhs.next();
    if (next.done) return 1;
    const order = character.codePointAt(0)! - next.value.codePointAt(0)!;
    if (order !== 0) return order;
  }
  return rhs.next().done ? 0 : -1;
}

function designSnapshotExplicitlyUnavailable(metadata: string | null | undefined): boolean {
  if (!metadata) return false;
  try {
    const value = JSON.parse(metadata) as { embeddedDesignAvailable?: unknown };
    return value.embeddedDesignAvailable === false;
  } catch {
    return false;
  }
}

export function escapeLikeWildcards(input: string): string {
  return input.replace(/[\\%_]/g, (match) => `\\${match}`);
}
