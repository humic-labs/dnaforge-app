import { SEQUENCE_SAVE_PRIMER_PUBLICATION_EVENT_TYPE } from '../shared/sequence-edit-lineage';
import { FASTA_KIND_DECLARATION_EVENT } from '../shared/fasta-kind';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { basename, extname, join } from 'node:path';
import { lstatSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import {
  catalogJsonObject,
  requireCatalogText,
  type CatalogEntityLinkInput,
  type CatalogEntityLinkRow,
  type CatalogEventInput,
  type CatalogEventRow,
  type CatalogEntityPresentationInput,
  type ArchiveSupersededNotebookCatalogInput,
} from '../shared/catalog-associations';
import type { CatalogEntityRow } from '../shared/catalog-registration';
import {
  parseCatalogEntityPresentation,
  planCatalogEntityPresentation,
} from '../shared/catalog-presentation';
import {
  NATIVE_WORKSPACE_MANIFEST_PATH,
  nativeWorkspaceEntityPlacement,
} from '../shared/native-workspace-manifest';
import {
  scopedProjectionId,
  stripWorkspaceScope,
  workspaceScopeKey,
} from '../shared/workspace-scoped-identity';
import { sequencePackageMetaPaths } from '../db/sequence-package';
import {
  notebookPackagePaths,
  notebookPackageRootForMetaPath,
  parseNotebookPackageMetadata,
} from '../db/notebook-package';
import {
  requireCatalogEntity,
  requireCatalogSourceOwner,
  loadCatalogManifestEntity,
} from './catalog-source-authority';
import { assertWorkspaceWriteAllowed } from './workspace-write-admission';
import { readClassificationFile } from './native-sequence-classification-review';

function json(value: unknown, field: string): string | null {
  return value == null ? null : JSON.stringify(catalogJsonObject(value, field));
}
function assertMutable(db: Database.Database, entity: CatalogEntityRow): void {
  if (entity.status !== 'active') throw new Error('Catalog entity is inactive.');
  if (entity.workspace_id !== null)
    assertWorkspaceWriteAllowed(db, [requireCatalogSourceOwner(db, entity.workspace_id).path]);
}
function sourceEndpointMatches(
  source: NonNullable<ReturnType<typeof loadCatalogManifestEntity>>,
  raw: string,
  id: string
): boolean {
  return (
    raw === id ||
    scopedProjectionId(workspaceScopeKey(source.owner.repo_uuid, source.owner.id), raw) === id
  );
}

export function linkCatalogEntitiesInDb(
  db: Database.Database,
  input: CatalogEntityLinkInput
): CatalogEntityLinkRow {
  if (!input || typeof input !== 'object') throw new Error('Catalog relationship is invalid.');
  const relation = requireCatalogText(input.relation, 'relationship relation');
  const confidence = input.confidence ?? 'suggested';
  if (!['suggested', 'confirmed', 'rejected'].includes(confidence))
    throw new Error('Catalog relationship confidence is invalid.');
  const evidence = json(input.evidence, 'relationship evidence');
  return db.transaction(() => {
    const from = requireCatalogEntity(db, input.sourceEntityId);
    if (from.type === 'molecular-document' && relation === 'uses-source')
      throw new Error('Molecular document source links require their saved-file projection owner.');
    const to = requireCatalogEntity(db, input.targetEntityId);
    const existing = db
      .prepare(
        'SELECT * FROM catalog_entity_links WHERE source_entity_id=? AND relation=? AND target_entity_id=?'
      )
      .get(from.id, relation, to.id) as CatalogEntityLinkRow | undefined;
    if (
      existing &&
      existing.confidence === confidence &&
      isDeepStrictEqual(
        existing.evidence === null ? null : JSON.parse(existing.evidence),
        input.evidence ?? null
      )
    )
      return existing;
    const source = loadCatalogManifestEntity(db, from);
    const sourceLink = source?.manifest.links.find(
      (link) =>
        sourceEndpointMatches(source, link.sourceId, from.id) &&
        sourceEndpointMatches(source, link.targetId, to.id) &&
        link.relation === relation &&
        (link.confidence ?? 'confirmed') === confidence &&
        isDeepStrictEqual(link.evidence ?? null, input.evidence ?? null)
    );
    if (!sourceLink) assertMutable(db, from);
    const now = Date.now();
    const id = existing?.id ?? randomUUID();
    db.prepare(
      `INSERT INTO catalog_entity_links(id,source_entity_id,relation,target_entity_id,confidence,evidence,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(source_entity_id,relation,target_entity_id) DO UPDATE SET confidence=excluded.confidence,evidence=excluded.evidence,updated_at=excluded.updated_at`
    ).run(id, from.id, relation, to.id, confidence, evidence, now, now);
    return db
      .prepare('SELECT * FROM catalog_entity_links WHERE id=?')
      .get(id) as CatalogEntityLinkRow;
  })();
}

export function recordCatalogEventInDb(
  db: Database.Database,
  input: CatalogEventInput
): CatalogEventRow {
  if (!input || typeof input !== 'object') throw new Error('Catalog event is invalid.');
  if (input.eventType === SEQUENCE_SAVE_PRIMER_PUBLICATION_EVENT_TYPE)
    throw new Error(
      'SEQUENCE_SAVE_HISTORY_PROTECTED: Native publication receipts require the Save owner.'
    );
  if (input.eventType === FASTA_KIND_DECLARATION_EVENT)
    throw new Error(
      'FASTA_KIND_HISTORY_PROTECTED: Native kind history requires the classification owner.'
    );
  const id = input.id === undefined ? randomUUID() : requireCatalogText(input.id, 'event identity');
  const row: CatalogEventRow = {
    id,
    entity_id: requireCatalogText(input.entityId, 'entity identity'),
    event_type: requireCatalogText(input.eventType, 'event type'),
    actor: input.actor === undefined ? 'user' : requireCatalogText(input.actor, 'event actor'),
    summary: input.summary == null ? null : requireCatalogText(input.summary, 'event summary'),
    payload: json(input.payload, 'event payload'),
    created_at: input.createdAt ?? Date.now(),
  };
  if (!Number.isSafeInteger(row.created_at) || row.created_at < 0)
    throw new Error('Catalog event creation time is invalid.');
  return db.transaction(() => {
    const entity = requireCatalogEntity(db, row.entity_id);
    const existing = db.prepare('SELECT * FROM catalog_entity_events WHERE id=?').get(id) as
      | CatalogEventRow
      | undefined;
    if (existing) {
      if (!isDeepStrictEqual(existing, row))
        throw new Error('Catalog event identity already belongs to a different event.');
      return existing;
    }
    const source = loadCatalogManifestEntity(db, entity);
    const sourceEvent = source?.manifest.events?.find(
      (event) =>
        sourceEndpointMatches(source, event.entityId, entity.id) &&
        (event.id === id ||
          scopedProjectionId(
            workspaceScopeKey(source.owner.repo_uuid, source.owner.id),
            event.id
          ) === id) &&
        event.eventType === row.event_type &&
        event.actor === row.actor &&
        (event.summary ?? null) === row.summary &&
        isDeepStrictEqual(event.payload ?? null, input.payload ?? null) &&
        event.createdAt === row.created_at
    );
    if (!sourceEvent) assertMutable(db, entity);
    db.prepare(
      'INSERT INTO catalog_entity_events(id,entity_id,event_type,actor,summary,payload,created_at) VALUES(@id,@entity_id,@event_type,@actor,@summary,@payload,@created_at)'
    ).run(row);
    return row;
  })();
}

function sourcePresentationNames(
  db: Database.Database,
  entity: CatalogEntityRow
): Set<string> | null {
  if (entity.workspace_id === null) return null;
  const owner = requireCatalogSourceOwner(db, entity.workspace_id);
  const files = db
    .prepare(
      "SELECT path,workspace_id FROM catalog_entity_files WHERE entity_id=? AND status='current'"
    )
    .all(entity.id) as Array<{ path: string; workspace_id: number | null }>;
  if (files.length === 0) return null;
  if (files.length !== 1 || files[0].workspace_id !== owner.id)
    throw new Error('Catalog presentation has no unique file owner.');
  const file = files[0];
  const names = new Set([basename(file.path), basename(file.path, extname(file.path))]);
  const candidates = lstatSync(file.path).isDirectory()
    ? [...sequencePackageMetaPaths(file.path), notebookPackagePaths(file.path).metaPath]
    : [file.path];
  for (const path of candidates) {
    let content: Buffer;
    try {
      content = readClassificationFile(owner.path, path, 4 * 1024 * 1024);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    let document: unknown;
    try {
      document = JSON.parse(content.toString('utf8'));
    } catch {
      continue;
    }
    if (!document || typeof document !== 'object' || Array.isArray(document)) continue;
    const record = document as Record<string, unknown>;
    if (
      typeof record.id === 'string' &&
      stripWorkspaceScope(record.id) !== stripWorkspaceScope(entity.id)
    )
      throw new Error('Catalog presentation file has a different source identity.');
    for (const value of [record.name, record.title])
      if (typeof value === 'string' && value.trim()) names.add(value);
  }
  return names;
}

export function updateCatalogEntityPresentationInDb(
  db: Database.Database,
  input: CatalogEntityPresentationInput
): CatalogEntityRow | null {
  const request = parseCatalogEntityPresentation(input);
  return db.transaction(() => {
    const found = db.prepare('SELECT * FROM catalog_entities WHERE id=?').get(request.entityId) as
      | CatalogEntityRow
      | undefined;
    if (!found) return null;
    const entity = requireCatalogEntity(db, found.id);
    const source = loadCatalogManifestEntity(db, entity);
    const planned = planCatalogEntityPresentation(entity, request, {
      sourceName: source?.portable.name,
      sourceMetadata: source
        ? {
            ...source.portable.metadata,
            ...('migrationSource' in source.portable && source.portable.migrationSource
              ? { migrationSource: source.portable.migrationSource }
              : {}),
            portableId: source.portable.id,
            placement: nativeWorkspaceEntityPlacement(source.portable),
            reconstructedFrom: NATIVE_WORKSPACE_MANIFEST_PATH,
          }
        : null,
      readSourceNames: () => sourcePresentationNames(db, entity),
      assertMutable: () => assertMutable(db, entity),
      now: Date.now(),
    });
    db.prepare('UPDATE catalog_entities SET name=?,metadata=?,updated_at=? WHERE id=?').run(
      planned.name,
      planned.metadata,
      planned.updated_at,
      planned.id
    );
    return db
      .prepare('SELECT * FROM catalog_entities WHERE id=?')
      .get(entity.id) as CatalogEntityRow;
  })();
}

export function archiveSupersededNotebookCatalogInDb(
  db: Database.Database,
  input: ArchiveSupersededNotebookCatalogInput
): void {
  if (!input || !Number.isSafeInteger(input.workspaceId))
    throw new Error('Notebook catalog retirement identity is invalid.');
  db.transaction(() => {
    const owner = requireCatalogSourceOwner(db, input.workspaceId);
    const source = requireCatalogEntity(db, input.sourceEntityId);
    const successor = requireCatalogEntity(db, input.successorEntityId);
    if (
      source.id === successor.id ||
      source.type !== 'notebook' ||
      successor.type !== 'notebook' ||
      source.workspace_id !== owner.id ||
      successor.workspace_id !== owner.id ||
      scopedProjectionId(workspaceScopeKey(owner.repo_uuid, owner.id), source.id) !== successor.id
    )
      throw new Error('Notebook catalog retirement requires its exact scoped successor identity.');
    const bindings = db
      .prepare(
        "SELECT path,file_kind,workspace_id FROM catalog_entity_files WHERE entity_id=? AND status='current'"
      )
      .all(successor.id) as Array<{ path: string; file_kind: string; workspace_id: number }>;
    if (
      db
        .prepare("SELECT 1 FROM catalog_entity_files WHERE entity_id=? AND status='current'")
        .get(source.id) ||
      bindings.length !== 1 ||
      bindings[0].workspace_id !== owner.id ||
      bindings[0].file_kind !== 'waypoint-notebook'
    )
      throw new Error('Notebook catalog successor has no current native file authority.');
    const packageRoot = notebookPackageRootForMetaPath(bindings[0].path) ?? bindings[0].path;
    const paths = notebookPackagePaths(packageRoot);
    const metadata = parseNotebookPackageMetadata(
      readClassificationFile(owner.path, paths.metaPath, 4 * 1024 * 1024).toString('utf8')
    );
    if (
      scopedProjectionId(workspaceScopeKey(owner.repo_uuid, owner.id), metadata.id) !== successor.id
    )
      throw new Error('Notebook catalog successor file has a different source identity.');
    readClassificationFile(
      owner.path,
      join(packageRoot, metadata.authority.path),
      16 * 1024 * 1024
    );
    if (source.status === 'archived') return;
    if (source.status !== 'active') throw new Error('Notebook catalog source is inactive.');
    db.prepare("UPDATE catalog_entities SET status='archived',updated_at=? WHERE id=?").run(
      Date.now(),
      source.id
    );
  })();
}
