import { platform } from '../platform';
import { LINKABLE_CATALOG_ENTITY_TYPES } from '@waypoint/scientific-artifacts/shared/entity-types';
import { pathIsAtOrUnder, pathRelativeToBoundary, stripTrailingSep } from '../shared/path-boundary';
import type { SqliteIpcValue } from '../shared/sqlite-ipc';
import { catalogNameSearch } from './catalog-name-search';
import { SEQUENCE_PACKAGE_FILE_KIND_ALIASES } from './sequence-package-contract';
import { workspaceScopeKey } from '../shared/workspace-scoped-identity';
import { catalogIconContext } from '../shared/catalog-icon-context';
import type { EntityColorContext } from '../shared/entity-color-family';

export const PROJECT_REFERENCE_ENTITY_TYPES = LINKABLE_CATALOG_ENTITY_TYPES.filter(
  (type) => type !== 'sequence' && type !== 'primer' && type !== 'notebook'
);

export type ProjectReferenceEntityType = (typeof PROJECT_REFERENCE_ENTITY_TYPES)[number];

export type ProjectSearchEntityType = 'sequence' | 'notebook' | ProjectReferenceEntityType;

export interface ProjectReferenceCandidate {
  entityId: string;
  entityType: ProjectSearchEntityType;
  name: string;
  workspaceRelativePath: string;
  contentHash: string | null;
  objectUuid: string | null;
  projectId: string | null;
  projectRoot: string;
  projectName: string;
  iconContext?: EntityColorContext;
}

export interface ProjectReferenceSearchResult {
  candidates: ProjectReferenceCandidate[];
  truncated: boolean;
}

interface ProjectReferenceRow {
  entity_id: string;
  entity_type: string;
  name: string;
  path: string;
  relative_path: string | null;
  content_hash: string | null;
  object_uuid: string | null;
  file_kind: string;
  project_workspace_id: number;
  project_repo_uuid: string | null;
  project_root: string;
  project_name: string;
  metadata: string | null;
  icon_kind: string | null;
}

const MAX_LIMIT = 200;
const sequencePackageKinds = new Set<string>(SEQUENCE_PACKAGE_FILE_KIND_ALIASES);

export async function searchProjectReferencesByName({
  query,
  entityTypes,
  workspaceRoots,
  preferredRoot = null,
  limit = 100,
}: {
  query: string;
  entityTypes: readonly ProjectSearchEntityType[];
  workspaceRoots: readonly string[];
  preferredRoot?: string | null;
  limit?: number;
}): Promise<ProjectReferenceSearchResult> {
  const roots = [...new Set(workspaceRoots.map(stripTrailingSep).filter(Boolean))];
  const types = [...new Set(entityTypes)];
  if (roots.length === 0 || types.length === 0) return { candidates: [], truncated: false };
  const includeSequencePackages = types.includes('sequence');
  const capped = Math.max(1, Math.min(MAX_LIMIT, Math.trunc(limit)));
  const trimmed = query.trim();
  const search = trimmed ? await catalogNameSearch(trimmed, 'updated') : null;

  const typeClause = includeSequencePackages
    ? `(e.type IN (${types.map(() => '?').join(', ')}) OR f.file_kind IN (${SEQUENCE_PACKAGE_FILE_KIND_ALIASES.map(() => '?').join(', ')}))`
    : `e.type IN (${types.map(() => '?').join(', ')})`;
  const params: SqliteIpcValue[] = [
    ...types,
    ...(includeSequencePackages ? SEQUENCE_PACKAGE_FILE_KIND_ALIASES : []),
    ...roots,
  ];

  let sql = `
    SELECT e.id AS entity_id,
           e.type AS entity_type,
           e.name AS name,
           e.metadata AS metadata,
           l.kind AS icon_kind,
           f.path AS path,
           f.relative_path AS relative_path,
           f.content_hash AS content_hash,
           f.object_uuid AS object_uuid,
           f.file_kind AS file_kind,
           w.id AS project_workspace_id,
           w.repo_uuid AS project_repo_uuid,
           w.path AS project_root,
           w.name AS project_name
    FROM catalog_entities e${search?.indexSql ?? ''}
    JOIN catalog_entity_files f ON f.entity_id = e.id AND f.workspace_id = e.workspace_id
    JOIN workspaces w ON w.id = f.workspace_id
    LEFT JOIN lims_entity l ON l.id = e.id
    WHERE ${typeClause}
      AND e.status = 'active'
      AND f.status = 'current'
      AND w.path IN (${roots.map(() => '?').join(', ')})
      AND w.archived_at IS NULL
      AND w.trashed_at IS NULL`;

  if (search) {
    sql += search.sql;
    params.push(...search.params);
  }

  const preferred = preferredRoot ? stripTrailingSep(preferredRoot) : null;
  if (preferred) {
    sql += ` ORDER BY (w.path = ?) DESC, e.updated_at DESC LIMIT ?`;
    params.push(preferred);
  } else {
    sql += ` ORDER BY e.updated_at DESC LIMIT ?`;
  }
  params.push(capped + 1);

  const rows = await platform().db.select<ProjectReferenceRow[]>(sql, params);
  const allowedTypes = new Set<string>(types);
  const seen = new Set<string>();
  const candidates = rows.slice(0, capped).flatMap((row): ProjectReferenceCandidate[] => {
    if (seen.has(row.entity_id)) return [];
    const entityType = sequencePackageKinds.has(row.file_kind) ? 'sequence' : row.entity_type;
    if (!allowedTypes.has(entityType)) return [];
    const projectRoot = stripTrailingSep(row.project_root);
    if (!pathIsAtOrUnder(row.path, projectRoot)) return [];
    const relative = row.relative_path ?? pathRelativeToBoundary(row.path, projectRoot);
    if (!relative) return [];
    seen.add(row.entity_id);
    return [
      {
        entityId: row.entity_id,
        entityType: entityType as ProjectSearchEntityType,
        name: row.name,
        workspaceRelativePath: relative,
        contentHash: row.content_hash,
        objectUuid: row.object_uuid,
        projectId: workspaceScopeKey(row.project_repo_uuid, row.project_workspace_id),
        projectRoot,
        projectName: row.project_name,
        iconContext: catalogIconContext({
          kind: row.icon_kind ?? entityType,
          path: relative,
          metadata: row.metadata,
        }),
      },
    ];
  });
  return { candidates, truncated: rows.length > capped };
}
