import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { parseScientificDocumentIdentity, parseWorkspaceIdentity } from '@waypoint/domain-services';
import type {
  EntityDescriptor,
  EntityDiscoveryRequest,
  EntityDiscoveryResolution,
  EntityDiscoveryResolveRequest,
} from '../shared/entity-discovery';
import { limsEntityFromRow, type LimsEntityRow } from '../shared/lims';
import { HARD_CAP_BYTES } from '../shared/oversized-guard';
import { readBoundPrimerArtifact } from '../shared/primers/primer-artifact';
import { registryRepresentationForEntity } from '../shared/registry-entity-opening';
import { canonicalWorkspacePath } from './primer-artifact-files';
import {
  EntityDiscoveryError,
  entityDiscoveryGenerationInDb,
  resolveEntitiesInDb,
  searchEntitiesInDb,
} from './entity-discovery';
import { getActiveStoredSession } from './auth/session-store';
import { readPrimerArtifactRevisionStateInMain } from './primer-artifact-mutations';
import { readFileBoundedFromHandle } from './ipc/bounded-file-read';
import { readScientificDocumentInMain } from './scientific-document-reader';

function primerDocumentPath(db: Database.Database, entity: EntityDescriptor) {
  if (entity.source === 'project') {
    const binding = db
      .prepare("SELECT file_kind FROM catalog_entity_files WHERE entity_id=? AND status='current'")
      .pluck()
      .get(entity.id);
    if (binding === 'primer-artifact') return entity.path;
  }
  if (entity.source === 'primer') return undefined;
  const row = db.prepare('SELECT * FROM lims_entity WHERE id=?').get(entity.id) as
    | LimsEntityRow
    | undefined;
  if (!row) return undefined;
  const target = registryRepresentationForEntity(limsEntityFromRow(row)).openTarget;
  if (target.kind !== 'primer') return undefined;
  return entity.source === 'project' ? entity.path : target.artifactRelativePath;
}

export async function resolveNotebookEntityTargets(
  db: Database.Database,
  request: EntityDiscoveryResolveRequest,
  assertCurrent: () => void = () => {}
) {
  assertCurrent();
  return checkNotebookTargets(db, request, resolveEntitiesInDb(db, request), assertCurrent);
}

async function checkNotebookTargets(
  db: Database.Database,
  request: EntityDiscoveryResolveRequest,
  resolution: EntityDiscoveryResolution,
  assertCurrent: () => void
) {
  const targets = resolution.items.map((item) =>
    item.status === 'available' ? primerDocumentPath(db, item.entity) : undefined
  );
  if (targets.every((path) => path === undefined)) return resolution;
  for (const [index, item] of resolution.items.entries()) {
    const path = targets[index];
    if (item.status !== 'available' || path === undefined) continue;
    const { projectRoot, projectId } = item.entity;
    if (path && projectRoot && projectId) {
      try {
        const result = await readScientificDocumentInMain(
          {
            operationId: randomUUID(),
            workspaceRoot: projectRoot,
            workspace: parseWorkspaceIdentity(projectId),
            document: parseScientificDocumentIdentity(path),
          },
          {
            database: db,
            canonicalize: async (input) => {
              const canonical = await canonicalWorkspacePath(input);
              assertCurrent();
              return canonical;
            },
            read: (file) => readFileBoundedFromHandle(file, HARD_CAP_BYTES),
          }
        );
        if (result.ok) {
          readBoundPrimerArtifact(result.document.content, path, item.id);
          const publication = await readPrimerArtifactRevisionStateInMain({
            db,
            entityId: item.id,
            runDatabase: (read) => {
              assertCurrent();
              return read();
            },
            getActiveAccountId: async () => (await getActiveStoredSession())?.accountId ?? null,
          });
          if (publication.state === 'not_enrolled') continue;
          assertCurrent();
          const owner = db
            .prepare('SELECT id FROM workspaces WHERE path=?')
            .pluck()
            .get(projectRoot);
          const sameOwner = publication.workspaceId === owner && publication.relativePath === path;
          if (
            sameOwner &&
            (publication.state === 'ready'
              ? publication.entity.id === item.id && publication.artifact.id === item.id
              : item.entity.source === 'project' && publication.entityId === item.id)
          )
            continue;
        }
      } catch (error) {
        if (!(error instanceof Error)) throw error;
      }
    }
    resolution.items[index] = { id: item.id, status: 'unavailable' };
  }
  assertCurrent();
  if (entityDiscoveryGenerationInDb(db) === resolution.generation) return resolution;
  const current = resolveEntitiesInDb(db, request);
  for (const [index, item] of current.items.entries()) {
    const checked = resolution.items[index];
    if (item.status !== 'available') continue;
    if (
      checked.status !== 'available' ||
      item.entity.source !== checked.entity.source ||
      item.entity.projectRoot !== checked.entity.projectRoot ||
      item.entity.path !== checked.entity.path ||
      item.entity.contentHash !== checked.entity.contentHash ||
      primerDocumentPath(db, item.entity) !== targets[index]
    ) {
      current.items[index] = { id: item.id, status: 'unavailable' };
    }
  }
  return current;
}

export async function searchNotebookEntityTargets(
  db: Database.Database,
  request: EntityDiscoveryRequest,
  assertCurrent: () => void = () => {}
) {
  assertCurrent();
  let page = searchEntitiesInDb(db, request);
  const generation = page.generation;
  const limit = request.limit ?? 50;
  const items: EntityDescriptor[] = [];
  for (;;) {
    const checked = await checkNotebookTargets(
      db,
      { ids: page.items.map((item) => item.id), scope: request.scope },
      {
        ...page,
        items: page.items.map((entity) => ({ id: entity.id, status: 'available', entity })),
      },
      assertCurrent
    );
    assertCurrent();
    if (checked.generation !== generation) {
      throw new EntityDiscoveryError(
        'ENTITY_DISCOVERY_REFRESH_REQUIRED',
        'The available entities changed. Refresh this search.'
      );
    }
    for (const entry of checked.items) {
      if (entry.status === 'available') items.push(entry.entity);
    }
    if (!page.nextCursor || items.length === limit) return { ...page, items };
    page = searchEntitiesInDb(db, {
      ...request,
      limit: limit - items.length,
      cursor: page.nextCursor,
    });
  }
}
