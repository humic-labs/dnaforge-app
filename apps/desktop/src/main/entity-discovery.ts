import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  isPrimerEntity,
  LINKABLE_CATALOG_ENTITY_TYPES,
  namedEntityTypePresentation,
  PRIMER_ROLE_PRESENTATION,
  resolveNamedEntityType,
} from '@waypoint/scientific-artifacts/shared/entity-types';
import { z } from 'zod';
import { catalogIconContext } from '../shared/catalog-icon-context';
import {
  entityDiscoveryRequestSchema,
  entityDiscoveryResolveRequestSchema,
  entityDiscoveryTypesRequestSchema,
} from '../shared/entity-discovery-schema';
import {
  entityDiscoveryCategory,
  normalizeEntityDiscoveryText,
  type EntityDescriptor,
  type EntityDiscoveryCoverage,
  type EntityDiscoveryPage,
  type EntityDiscoveryRequest,
  type EntityDiscoveryResolution,
  type EntityDiscoveryResolveRequest,
  type EntityDiscoveryTypesRequest,
  type EntityDiscoveryTypes,
  type EntityDiscoveryFacet,
} from '../shared/entity-discovery';
import { pathIsAtOrUnder, pathRelativeToBoundary, stripTrailingSep } from '../shared/path-boundary';
import { workspaceScopeKey } from '../shared/workspace-scoped-identity';
import { LIMS_REGISTRATION_STATUSES } from '../shared/lims';
import { registryRepresentationForEntity } from '../shared/registry-entity-opening';
import { registrySourceEligibilitySql } from './registry-source-eligibility';

const cursorSchema = z
  .object({
    version: z.literal(1),
    request: z.string(),
    generation: z.string(),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export class EntityDiscoveryError extends Error {
  constructor(
    readonly code: 'ENTITY_DISCOVERY_CURSOR_INVALID' | 'ENTITY_DISCOVERY_REFRESH_REQUIRED',
    message: string
  ) {
    super(`${code}: ${message}`);
    this.name = 'EntityDiscoveryError';
  }
}

const connectionIds = new WeakMap<Database.Database, string>();

function prepareConnection(db: Database.Database): string {
  let identity = connectionIds.get(db);
  if (identity) return identity;
  identity = randomUUID();
  connectionIds.set(db, identity);
  db.function('entity_discovery_text', { deterministic: true }, (value: unknown) =>
    typeof value === 'string' ? normalizeEntityDiscoveryText(value) : ''
  );
  db.function('entity_discovery_project', { deterministic: true }, (repo: unknown, id: unknown) =>
    workspaceScopeKey(typeof repo === 'string' ? repo : null, typeof id === 'number' ? id : null)
  );
  db.function('entity_discovery_path', { deterministic: true }, (path: unknown, root: unknown) => {
    if (typeof path !== 'string' || typeof root !== 'string' || !pathIsAtOrUnder(path, root))
      return null;
    return pathRelativeToBoundary(path, root) || null;
  });
  db.function(
    'entity_discovery_registry_target',
    { deterministic: true },
    (id, kind, name, fields, registrationStatus, workspaceId) =>
      registryRepresentationForEntity({
        id: String(id),
        kind: String(kind),
        name: String(name),
        fields: typeof fields === 'string' ? JSON.parse(fields) : {},
        registrationStatus: z.enum(LIMS_REGISTRATION_STATUSES).parse(registrationStatus),
        workspaceId: typeof workspaceId === 'number' ? workspaceId : null,
      }).openTarget.kind
  );
  db.function(
    'entity_discovery_category',
    { deterministic: true },
    (type: unknown, kind: unknown, representation: unknown, path: unknown) =>
      entityDiscoveryCategory(
        typeof type === 'string' ? type : '',
        typeof kind === 'string' ? kind : null,
        typeof representation === 'string' ? representation : null,
        typeof path === 'string' ? path : null
      )
  );
  db.function(
    'entity_discovery_is_primer',
    { deterministic: true },
    (type: unknown, kind: unknown, use: unknown) =>
      Number(
        isPrimerEntity(
          typeof type === 'string' ? type : '',
          typeof kind === 'string' ? kind : null,
          typeof use === 'string' ? use : null
        )
      )
  );
  db.function(
    'entity_discovery_named_type',
    { deterministic: true },
    (
      type: unknown,
      kind: unknown,
      schemaId: unknown,
      schemaBuiltin: unknown,
      representation: unknown
    ) =>
      resolveNamedEntityType({
        type: typeof type === 'string' ? type : '',
        registryKind: typeof kind === 'string' ? kind : null,
        schemaId: typeof schemaId === 'string' ? schemaId : null,
        schemaBuiltin: typeof schemaBuiltin === 'number' ? schemaBuiltin : null,
        representationKind: typeof representation === 'string' ? representation : null,
      })
  );
  return identity;
}

export function entityDiscoveryGenerationInDb(db: Database.Database): string {
  const identity = prepareConnection(db);
  const changes = (db.prepare('SELECT total_changes() AS value').get() as { value: number }).value;
  return `${identity}:${changes}:${db.pragma('data_version', { simple: true })}:${db.pragma('schema_version', { simple: true })}`;
}

function candidatesSql(db: Database.Database): string {
  const projectTypes = LINKABLE_CATALOG_ENTITY_TYPES.map((type) => `'${type}'`).join(',');
  return `WITH raw_candidates AS (
    SELECT e.id, CASE WHEN e.type='notebook' THEN 'page' ELSE e.type END AS type,
      e.name, 'project' AS source, 0 AS priority,
      entity_discovery_path(f.path,w.path) AS path, f.content_hash AS contentHash,
      f.object_uuid AS objectUuid, CASE WHEN s.id IS NOT NULL THEN l.kind END AS registryKind, l.registry_id AS registryId,
      s.id AS schemaId, s.display_name AS schemaLabel,
      entity_discovery_project(w.repo_uuid,w.id) AS projectId, w.path AS projectRoot,
      w.name AS projectName, (e.status='archived' OR w.archived_at IS NOT NULL OR COALESCE(l.tombstone,0)=1 OR l.archived_at IS NOT NULL) AS archived,
      CASE WHEN json_valid(l.fields) THEN json_extract(l.fields,'$.use') END AS role,
      f.id AS representationId, f.file_kind AS representationKind,
      CASE WHEN json_valid(l.fields) THEN json_extract(l.fields,'$.sequence.length') END AS sequenceLength,
      s.name AS schemaName,s.builtin AS schemaBuiltin,e.metadata AS iconMetadata,l.kind AS colorKind
    FROM catalog_entities e
    JOIN catalog_entity_files f ON f.entity_id=e.id AND f.workspace_id=e.workspace_id AND f.status='current'
    JOIN workspaces w ON w.id=e.workspace_id AND w.trashed_at IS NULL
    LEFT JOIN lims_entity l ON l.id=e.id
    LEFT JOIN lims_schema_revision r ON r.id=l.schema_revision_id
    LEFT JOIN lims_schema s ON s.id=r.schema_id AND s.kind='entity'
    WHERE e.type IN (${projectTypes}) AND e.status IN ('active','archived')
      AND entity_discovery_path(f.path,w.path) IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM workspace_sync_restore_locks lock WHERE lock.workspace_id=w.id AND lock.status<>'completed')
    UNION ALL
    SELECT lims_entity.id, 'registry', lims_entity.name, 'registry', 1,
      NULL,NULL,NULL,lims_entity.kind,lims_entity.registry_id,
      s.id,s.display_name,
      entity_discovery_project(w.repo_uuid,w.id),w.path,w.name,
      (lims_entity.tombstone=1 OR lims_entity.archived_at IS NOT NULL OR w.archived_at IS NOT NULL),
      CASE WHEN json_valid(lims_entity.fields) THEN json_extract(lims_entity.fields,'$.use') END,
      '',NULL,CASE WHEN json_valid(lims_entity.fields) THEN json_extract(lims_entity.fields,'$.sequence.length') END,
      s.name,s.builtin,c.metadata,lims_entity.kind
    FROM lims_entity
    LEFT JOIN catalog_entities c ON c.id=lims_entity.id
    LEFT JOIN workspaces w ON w.id=COALESCE(c.workspace_id,lims_entity.workspace_id)
    LEFT JOIN lims_schema_revision r ON r.id=lims_entity.schema_revision_id
    LEFT JOIN lims_schema s ON s.id=r.schema_id AND s.kind='entity'
    WHERE (w.id IS NULL OR w.trashed_at IS NULL) AND (${registrySourceEligibilitySql(db)})
      AND CASE entity_discovery_registry_target(lims_entity.id,lims_entity.kind,lims_entity.name,
        CASE WHEN json_valid(lims_entity.fields) THEN CASE WHEN json_type(lims_entity.fields)='object' THEN lims_entity.fields END END,
        lims_entity.registration_status,lims_entity.workspace_id)
        WHEN 'primer' THEN EXISTS (SELECT 1 FROM catalog_entity_files current_file
          WHERE current_file.entity_id=lims_entity.id AND current_file.workspace_id=w.id
            AND current_file.file_kind='primer-artifact' AND current_file.status='current')
          OR (c.storage_type IS NOT 'file' AND NOT EXISTS (SELECT 1 FROM catalog_entity_files known_file
            WHERE known_file.entity_id=lims_entity.id AND known_file.file_kind='primer-artifact'))
        WHEN 'record_file' THEN s.id IS NOT NULL
        WHEN 'record_detail' THEN s.id IS NOT NULL OR EXISTS (SELECT 1 FROM catalog_entity_files current_file
          WHERE current_file.entity_id=lims_entity.id AND current_file.workspace_id=lims_entity.workspace_id AND current_file.status='current')
        ELSE 1 END
      AND NOT EXISTS (SELECT 1 FROM workspace_sync_restore_locks lock WHERE lock.workspace_id=w.id AND lock.status<>'completed')
    UNION ALL
    SELECT p.id,'primer',p.name,'primer',2,NULL,NULL,NULL,NULL,p.catalog_number,NULL,NULL,
      entity_discovery_project(w.repo_uuid,w.id),w.path,w.name,
      (COALESCE(p.status='archived',0) OR w.archived_at IS NOT NULL),'primer','',NULL,p.length,NULL,NULL,NULL,NULL
    FROM primers p
    LEFT JOIN workspaces w ON w.id=p.workspace_id
    WHERE (w.id IS NULL OR w.trashed_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM workspace_sync_restore_locks lock WHERE lock.workspace_id=w.id AND lock.status<>'completed')
      AND NOT EXISTS (SELECT 1 FROM lims_entity alias_target
        WHERE alias_target.id=p.id OR alias_target.id=CASE WHEN json_valid(p.origin_details) THEN json_extract(p.origin_details,'$.limsEntityId') END)
  ), numbered AS (
    SELECT *,ROW_NUMBER() OVER(PARTITION BY id ORDER BY priority,representationId) AS ordinal
    FROM raw_candidates
  ), candidates AS (
    SELECT *,entity_discovery_text(name) AS normalizedName,
      entity_discovery_text(registryId) AS normalizedRegistryId,
      entity_discovery_category(type,registryKind,representationKind,path) AS category,
      entity_discovery_is_primer(type,registryKind,role) AS isPrimer,
      entity_discovery_named_type(type,registryKind,schemaId,schemaBuiltin,representationKind) AS namedTypeKey
    FROM numbered WHERE ordinal=1
  )`;
}

interface CandidateRow extends Omit<EntityDescriptor, 'archived' | 'kindLabel' | 'iconKind'> {
  archived: number;
  schemaLabel: string | null;
  schemaName: string | null;
  iconMetadata: string | null;
  colorKind: string | null;
}

function descriptor(row: CandidateRow): EntityDescriptor {
  const { kindLabel, iconKind } = namedEntityTypePresentation(
    row.namedTypeKey,
    row.schemaName,
    row.schemaLabel
  );
  const iconContext = catalogIconContext({
    kind: row.colorKind ?? row.schemaName,
    path: row.path,
    metadata: row.iconMetadata,
  });
  return {
    id: row.id,
    type: row.type,
    ...(iconContext ? { iconContext } : {}),
    name: row.name,
    sequenceLength:
      typeof row.sequenceLength === 'number' &&
      Number.isSafeInteger(row.sequenceLength) &&
      row.sequenceLength >= 0
        ? row.sequenceLength
        : null,
    source: row.source,
    namedTypeKey: row.namedTypeKey,
    kindLabel,
    iconKind,
    path: row.path,
    contentHash: row.contentHash,
    objectUuid: row.objectUuid,
    registryKind: row.registryKind,
    registryId: row.registryId,
    schemaId: row.schemaId,
    projectId: row.projectId,
    projectRoot: row.projectRoot,
    projectName: row.projectName,
    archived: Boolean(row.archived),
    ...(row.source === 'primer' ? { localOnly: row.path === null } : {}),
  };
}

function scopeWhere(scope: EntityDiscoveryRequest['scope']): {
  sql: string;
  params: (string | number)[];
} {
  const clauses = [scope?.includeArchived ? '1' : 'archived=0'];
  const params: (string | number)[] = [];
  if (scope?.projectId) {
    clauses.push('projectId=?');
    params.push(scope.projectId);
  }
  if (scope?.projectRoot) {
    clauses.push('projectRoot=?');
    params.push(stripTrailingSep(scope.projectRoot));
  }
  if (scope?.projectRoots) {
    clauses.push('projectRoot IN (SELECT value FROM json_each(?))');
    params.push(JSON.stringify(scope.projectRoots.map(stripTrailingSep)));
  }
  return { sql: clauses.join(' AND '), params };
}

function coverage(
  db: Database.Database,
  cte: string,
  scope: EntityDiscoveryRequest['scope']
): EntityDiscoveryCoverage {
  const where = scopeWhere(scope);
  const counts = db
    .prepare(
      `${cte} SELECT source,COUNT(*) AS count FROM candidates WHERE ${where.sql} GROUP BY source`
    )
    .all(...where.params) as { source: string; count: number }[];
  const total = (
    db
      .prepare(
        'SELECT (SELECT COUNT(*) FROM catalog_entities)+(SELECT COUNT(*) FROM lims_entity)+(SELECT COUNT(*) FROM primers) AS count'
      )
      .get() as { count: number }
  ).count;
  const get = (source: string) => counts.find((entry) => entry.source === source)?.count ?? 0;
  return {
    catalog: get('project'),
    registry: get('registry'),
    primers: get('primer'),
    excluded: Math.max(0, total - counts.reduce((sum, row) => sum + row.count, 0)),
  };
}

export function searchEntitiesInDb(
  db: Database.Database,
  input: EntityDiscoveryRequest
): EntityDiscoveryPage {
  const request = entityDiscoveryRequestSchema.parse(input);
  prepareConnection(db);
  return db.transaction(() => {
    const currentGeneration = entityDiscoveryGenerationInDb(db);
    const query = normalizeEntityDiscoveryText(request.query);
    const filter = request.filter;
    const requestIdentity = createHash('sha256')
      .update(
        JSON.stringify({
          query,
          scope: {
            projectId: request.scope?.projectId ?? null,
            projectRoot: request.scope?.projectRoot
              ? stripTrailingSep(request.scope.projectRoot)
              : null,
            projectRoots: request.scope?.projectRoots
              ? [...new Set(request.scope.projectRoots.map(stripTrailingSep))].sort()
              : null,
            includeArchived: request.scope?.includeArchived ?? false,
          },
          filter: {
            namedTypeKey: filter?.namedTypeKey ?? null,
            category: filter?.category ?? null,
            entityTypes: filter?.entityTypes ? [...new Set(filter.entityTypes)].sort() : null,
            registryKinds: filter?.registryKinds ? [...new Set(filter.registryKinds)].sort() : null,
            schemaId: filter?.schemaId ?? null,
            role: filter?.role ?? null,
          },
          preferredProjectId: request.preferredProjectId ?? null,
          preferredProjectRoot: request.preferredProjectRoot
            ? stripTrailingSep(request.preferredProjectRoot)
            : null,
        })
      )
      .digest('hex');
    let offset = 0;
    if (request.cursor) {
      let cursor: z.infer<typeof cursorSchema>;
      try {
        cursor = cursorSchema.parse(
          JSON.parse(Buffer.from(request.cursor, 'base64url').toString('utf8'))
        );
      } catch {
        throw new EntityDiscoveryError('ENTITY_DISCOVERY_CURSOR_INVALID', 'Start a new search.');
      }
      if (cursor.request !== requestIdentity)
        throw new EntityDiscoveryError(
          'ENTITY_DISCOVERY_CURSOR_INVALID',
          'The query, scope or filters changed.'
        );
      if (cursor.generation !== currentGeneration)
        throw new EntityDiscoveryError(
          'ENTITY_DISCOVERY_REFRESH_REQUIRED',
          'The available entities changed. Refresh this search.'
        );
      offset = cursor.offset;
    }
    const cte = candidatesSql(db);
    const scoped = scopeWhere(request.scope);
    const clauses = [scoped.sql];
    const params = [...scoped.params];
    if (query) {
      clauses.push(
        '(instr(normalizedName,?)>0 OR instr(normalizedRegistryId,?)>0 OR entity_discovery_text(id)=?)'
      );
      params.push(query, query, query);
    }
    if (filter?.category) {
      clauses.push('category=?');
      params.push(filter.category);
    }
    if (filter?.namedTypeKey) {
      clauses.push('namedTypeKey=?');
      params.push(filter.namedTypeKey);
    }
    if (filter?.entityTypes) {
      clauses.push('type IN (SELECT value FROM json_each(?))');
      params.push(
        JSON.stringify(filter.entityTypes.map((kind) => (kind === 'notebook' ? 'page' : kind)))
      );
    }
    if (filter?.registryKinds) {
      clauses.push('registryKind IN (SELECT value FROM json_each(?))');
      params.push(JSON.stringify(filter.registryKinds));
    }
    if (filter?.schemaId) {
      clauses.push('schemaId=?');
      params.push(filter.schemaId);
    }
    if (filter?.role === 'primer') clauses.push('isPrimer=1');
    const limit = request.limit ?? 50;
    const rows = db
      .prepare(
        `${cte} SELECT * FROM candidates WHERE ${clauses.join(' AND ')}
      ORDER BY CASE WHEN normalizedName=? OR normalizedRegistryId=? OR entity_discovery_text(id)=? THEN 0
        WHEN substr(normalizedName,1,length(?))=? THEN 1 ELSE 2 END,
        CASE WHEN projectId=? OR projectRoot=? THEN 0 ELSE 1 END,
        normalizedName COLLATE BINARY,id COLLATE BINARY LIMIT ? OFFSET ?`
      )
      .all(
        ...params,
        query,
        query,
        query,
        query,
        query,
        request.preferredProjectId ?? null,
        request.preferredProjectRoot ? stripTrailingSep(request.preferredProjectRoot) : null,
        limit + 1,
        offset
      ) as CandidateRow[];
    const nextCursor =
      rows.length > limit
        ? Buffer.from(
            JSON.stringify({
              version: 1,
              request: requestIdentity,
              generation: currentGeneration,
              offset: offset + limit,
            })
          ).toString('base64url')
        : null;
    return {
      items: rows.slice(0, limit).map(descriptor),
      nextCursor,
      generation: currentGeneration,
      coverage: coverage(db, cte, request.scope),
    };
  })();
}

export function resolveEntitiesInDb(
  db: Database.Database,
  input: EntityDiscoveryResolveRequest
): EntityDiscoveryResolution {
  const request = entityDiscoveryResolveRequestSchema.parse(input);
  prepareConnection(db);
  return db.transaction(() => {
    const currentGeneration = entityDiscoveryGenerationInDb(db);
    const cte = candidatesSql(db);
    const scoped = scopeWhere(request.scope);
    const rows = db
      .prepare(
        `${cte} SELECT * FROM candidates WHERE ${scoped.sql} AND id IN (SELECT value FROM json_each(?))`
      )
      .all(...scoped.params, JSON.stringify(request.ids)) as CandidateRow[];
    const byId = new Map(rows.map((row) => [row.id, descriptor(row)]));
    return {
      items: request.ids.map((id) => {
        const entity = byId.get(id);
        return entity
          ? { id, status: 'available' as const, entity }
          : { id, status: 'unavailable' as const };
      }),
      generation: currentGeneration,
      coverage: coverage(db, cte, request.scope),
    };
  })();
}

export function entityDiscoveryTypesInDb(
  db: Database.Database,
  input: EntityDiscoveryTypesRequest = {}
): EntityDiscoveryTypes {
  const request = entityDiscoveryTypesRequestSchema.parse(input);
  prepareConnection(db);
  return db.transaction(() => {
    const currentGeneration = entityDiscoveryGenerationInDb(db);
    const cte = candidatesSql(db);
    const scoped = scopeWhere(request.scope);
    const counts = db
      .prepare(
        `${cte} SELECT namedTypeKey,MIN(schemaName) AS schemaName,MIN(schemaLabel) AS schemaLabel,
        COUNT(*) AS count FROM candidates WHERE ${scoped.sql} GROUP BY namedTypeKey`
      )
      .all(...scoped.params) as {
      namedTypeKey: string;
      schemaName: string | null;
      schemaLabel: string | null;
      count: number;
    }[];
    const items: EntityDiscoveryFacet[] = counts.map((row) => {
      const { label, terms, iconKind } = namedEntityTypePresentation(
        row.namedTypeKey,
        row.schemaName,
        row.schemaLabel
      );
      return {
        key: row.namedTypeKey,
        kind: 'type',
        label,
        terms,
        filter: { namedTypeKey: row.namedTypeKey },
        iconKind,
        ...(row.namedTypeKey.startsWith('schema:') && row.schemaName
          ? { iconContext: { kind: row.schemaName } }
          : {}),
        count: row.count,
      };
    });
    items.sort(
      (left, right) => left.label.localeCompare(right.label) || left.key.localeCompare(right.key)
    );
    const primerCount = db
      .prepare(
        `${cte} SELECT COUNT(*) AS count FROM candidates WHERE ${scoped.sql}
        AND isPrimer=1`
      )
      .get(...scoped.params) as { count: number };
    if (primerCount.count > 0)
      items.push({
        ...PRIMER_ROLE_PRESENTATION,
        kind: 'shortcut',
        filter: { role: 'primer' },
        count: primerCount.count,
      });
    return {
      items,
      generation: currentGeneration,
      coverage: coverage(db, cte, request.scope),
    };
  })();
}
