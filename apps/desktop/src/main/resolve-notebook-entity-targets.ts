import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { parseScientificDocumentIdentity, parseWorkspaceIdentity } from '@waypoint/domain-services';
import type {
  EntityDescriptor,
  EntityDiscoveryPage,
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
  assertCurrent: () => void,
  targets = resolution.items.map((item) =>
    item.status === 'available' ? primerDocumentPath(db, item.entity) : undefined
  )
) {
  if (targets.every((path) => path === undefined)) return resolution;
  for (const [index, item] of resolution.items.entries()) {
    const path = targets[index];
    if (item.status !== 'available' || path === undefined) continue;
    const { projectRoot, projectId } = item.entity;
    if (path && projectRoot && projectId) {
      try {
        let workingFileStillMatches = () => true;
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
            read: async (file) => {
              const before = lstatSync(file, { bigint: true });
              const bytes = await readFileBoundedFromHandle(file, HARD_CAP_BYTES);
              workingFileStillMatches = () => {
                const now = lstatSync(file, { bigint: true, throwIfNoEntry: false });
                return (
                  !!now &&
                  now.isFile() &&
                  now.dev === before.dev &&
                  now.ino === before.ino &&
                  now.ctimeNs === before.ctimeNs &&
                  now.size === before.size
                );
              };
              return bytes;
            },
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
          if (!workingFileStillMatches()) throw new Error('The checked primer file changed.');
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
      item.entity.projectId !== checked.entity.projectId ||
      item.entity.projectRoot !== checked.entity.projectRoot ||
      item.entity.objectUuid !== checked.entity.objectUuid ||
      item.entity.path !== checked.entity.path ||
      item.entity.contentHash !== checked.entity.contentHash ||
      primerDocumentPath(db, item.entity) !== targets[index]
    ) {
      current.items[index] = { id: item.id, status: 'unavailable' };
    }
  }
  return current;
}

type SearchWindow = {
  limit: number;
  page: EntityDiscoveryPage;
  paths: ReturnType<typeof primerDocumentPath>[];
  statuses: EntityDiscoveryResolution['items'][number]['status'][];
};
function refreshRequired() {
  return new EntityDiscoveryError(
    'ENTITY_DISCOVERY_REFRESH_REQUIRED',
    'The available entities changed. Refresh this search.'
  );
}

function currentSearchWindow(
  db: Database.Database,
  request: EntityDiscoveryRequest,
  windows: readonly SearchWindow[]
) {
  return db.transaction(() => {
    let current: EntityDiscoveryPage | undefined;
    for (const window of windows) {
      if (current && !current.nextCursor) return;
      current = searchEntitiesInDb(db, {
        ...request,
        limit: window.limit,
        cursor: current?.nextCursor ?? undefined,
      });
      if (
        !isDeepStrictEqual(current.items, window.page.items) ||
        current.items.some(
          (entity, index) => primerDocumentPath(db, entity) !== window.paths[index]
        )
      )
        return;
    }
    return current;
  })();
}

async function verifySearchPage(
  db: Database.Database,
  scope: EntityDiscoveryRequest['scope'],
  page: EntityDiscoveryPage,
  paths: SearchWindow['paths'],
  assertCurrent: () => void
) {
  return checkNotebookTargets(
    db,
    { ids: page.items.map((item) => item.id), scope },
    {
      ...page,
      items: page.items.map((entity) => ({ id: entity.id, status: 'available', entity })),
    },
    assertCurrent,
    paths
  );
}

async function checkedSearch(
  db: Database.Database,
  request: EntityDiscoveryRequest,
  assertCurrent: () => void
): Promise<EntityDiscoveryPage | undefined> {
  let page = searchEntitiesInDb(db, request);
  const limit = request.limit ?? 50;
  const items: EntityDescriptor[] = [];
  const windows: SearchWindow[] = [];
  const initialCandidateCount =
    page.coverage.catalog + page.coverage.registry + page.coverage.primers;
  let candidatesRead = 0;
  for (;;) {
    candidatesRead += page.items.length;
    const paths = page.items.map((entity) => primerDocumentPath(db, entity));
    const checked = await verifySearchPage(db, request.scope, page, paths, assertCurrent);
    windows.push({
      limit: limit - items.length,
      page,
      paths,
      statuses: checked.items.map((item) => item.status),
    });
    assertCurrent();
    if (entityDiscoveryGenerationInDb(db) !== page.generation) {
      if (request.cursor) throw refreshRequired();
      if (!currentSearchWindow(db, request, windows)) return;
      for (const window of windows) {
        if (window.paths.every((path) => path === undefined)) continue;
        const verified = await verifySearchPage(
          db,
          request.scope,
          window.page,
          window.paths,
          assertCurrent
        );
        if (
          !isDeepStrictEqual(
            verified.items.map((item) => item.status),
            window.statuses
          )
        )
          return;
      }
      assertCurrent();
      const current = currentSearchWindow(db, request, windows);
      if (!current) return;
      page = current;
    }
    for (const [index, entry] of checked.items.entries())
      if (entry.status === 'available') items.push(page.items[index]);
    if (!page.nextCursor || items.length === limit) return { ...page, items };
    if (!request.cursor && candidatesRead >= initialCandidateCount) return;
    try {
      page = searchEntitiesInDb(db, {
        ...request,
        limit: limit - items.length,
        cursor: page.nextCursor,
      });
    } catch (error) {
      if (
        !request.cursor &&
        error instanceof EntityDiscoveryError &&
        error.code === 'ENTITY_DISCOVERY_REFRESH_REQUIRED'
      )
        return;
      throw error;
    }
  }
}

export async function searchNotebookEntityTargets(
  db: Database.Database,
  request: EntityDiscoveryRequest,
  assertCurrent: () => void = () => {}
): Promise<EntityDiscoveryPage> {
  for (let attempt = 0; attempt < 3; attempt++) {
    assertCurrent();
    const page = await checkedSearch(db, request, assertCurrent);
    if (page) return page;
  }
  throw refreshRequired();
}
