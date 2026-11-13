import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import {
  parseNativeWorkspaceManifestFragment,
  type NativeWorkspaceManifestV2,
  type NativeWorkspaceManifestEntityV2,
} from '../shared/native-workspace-manifest';
import { scopedProjectionId } from '../shared/workspace-scoped-identity';
import { limsLinkFromRow, type LimsLink, type LimsUpdateEntityInput } from '../shared/lims';
import {
  assertRelationshipTypeExists,
  getLinkRowById,
  insertAuditEvent,
  LINEAGE_RELATIONSHIP_TYPES,
  nextEventSeq,
  upsertLimsLinkProjectionInsideTx,
  wouldCreateRelationshipCycle,
} from './lims-engine-core';
import { nativeLimsRelationshipType } from './benchling-migration/native-materialization';
import { nativeLimsEndpointPresent } from './native-workspace-reconcile-graph';

type CatalogLink = NativeWorkspaceManifestV2['links'][number];
type RegistryLink = NonNullable<NativeWorkspaceManifestV2['limsLinks']>[number];
type Change<T> = { before: T | null; after: T | null };
export type RecordFieldGraphDelta = {
  version: 1;
  catalog: Change<CatalogLink>[];
  lims: Change<RegistryLink>[];
};
type Authority = { id: number; path: string; scope: string };
const ACTOR = 'native-record-field-edit';
const OWNER_SCHEMA = 'dnaforge.native-record-field-owner.v1';
const catalogKey = (link: CatalogLink) =>
  JSON.stringify([link.sourceId, link.relation, link.targetId]);
const limsKey = (link: RegistryLink) =>
  JSON.stringify([link.fromEntityId, link.type, link.toEntityId]);
const linkIdentity = (from: string, type: string, to: string) =>
  `link-${createHash('sha256').update(`${from}:${type}:${to}`).digest('hex').slice(0, 24)}`;

export function prepareRecordRelationshipUpdate(
  db: Database.Database,
  authority: Authority,
  manifest: NativeWorkspaceManifestV2,
  before: NativeWorkspaceManifestEntityV2,
  input: LimsUpdateEntityInput
): LimsUpdateEntityInput {
  if (input.relationshipTargets === undefined) return input;
  if (!record(input.relationshipTargets))
    throw new Error('Record relationship targets must be an object.');
  const definitions = before.lims?.schemaSnapshot?.fields ?? [];
  const fields = { ...input.fields };
  for (const [key, target] of Object.entries(input.relationshipTargets)) {
    const field = definitions.find((field) => field.key === key);
    if (!field || field.type !== 'record_relationship')
      throw new Error(`Unknown relationship field: ${key}`);
    if (input.fields && Object.hasOwn(input.fields, key))
      throw new Error(`Relationship ${key} was supplied both as a value and a target.`);
    if (target === null) {
      fields[key] = null;
      continue;
    }
    if (typeof target !== 'string' || !target || target.length > 1024 || target === input.id)
      throw new Error('Record relationship target is invalid or points to itself.');
    const portable = manifest.entities.find(
      (entity) => scopedProjectionId(authority.scope, entity.id) === target
    );
    const row = db
      .prepare(
        `SELECT l.name FROM lims_entity l JOIN catalog_entities c ON c.id=l.id
      JOIN workspaces w ON w.id=c.workspace_id WHERE l.id=? AND l.workspace_id=? AND c.workspace_id=?
      AND l.tombstone=0 AND l.archived_at IS NULL AND c.status='active'
      AND w.archived_at IS NULL AND w.trashed_at IS NULL`
      )
      .get(target, authority.id, authority.id);
    if (
      !portable?.lims ||
      portable.lifecycle?.state === 'archived' ||
      !record(row) ||
      typeof row.name !== 'string'
    )
      throw new Error(
        'Record relationship target is not an active portable record in this workspace.'
      );
    const prior = before.lims?.fields[key];
    fields[key] = {
      origin: 'native',
      destinationEntityId: target,
      relationType:
        record(prior) && typeof prior.relationType === 'string' ? prior.relationType : key,
      label: row.name,
      resolution: 'exact',
    };
  }
  const { relationshipTargets: _targets, ...ordinaryInput } = input;
  return { ...ordinaryInput, fields };
}

type Use = { fieldKey: string; relation: string; targetId: string };
function uses(entity: NativeWorkspaceManifestEntityV2): Use[] {
  return (entity.lims?.schemaSnapshot?.fields ?? []).flatMap((field) => {
    if (field.type !== 'record_relationship') return [];
    const value = entity.lims?.fields[field.key];
    if (value === undefined || value === null) return [];
    if (!record(value) || typeof value.relationType !== 'string')
      throw new Error('Record relationship value is invalid.');
    if (value.resolution === 'source_broken' && value.destinationEntityId === null) return [];
    if (value.resolution !== 'exact' || typeof value.destinationEntityId !== 'string')
      throw new Error('Record relationship has no exact destination.');
    return [
      { fieldKey: field.key, relation: value.relationType, targetId: value.destinationEntityId },
    ];
  });
}

export function planRecordFieldGraphChange(
  manifest: NativeWorkspaceManifestV2,
  before: NativeWorkspaceManifestEntityV2,
  after: NativeWorkspaceManifestEntityV2
): RecordFieldGraphDelta {
  const previous = uses(before),
    next = uses(after);
  const fieldCatalog = (use: Use): CatalogLink => ({
    sourceId: before.id,
    relation: use.relation,
    targetId: use.targetId,
  });
  const oldCatalog = new Map(
    previous.map((use) => [catalogKey(fieldCatalog(use)), fieldCatalog(use)])
  );
  const newCatalog = new Map(next.map((use) => [catalogKey(fieldCatalog(use)), fieldCatalog(use)]));
  const catalog: Change<CatalogLink>[] = [];
  for (const [key] of oldCatalog) {
    if (newCatalog.has(key)) continue;
    const existing = manifest.links.find((entry) => catalogKey(entry) === key);
    if (!existing)
      throw new Error('Record relationship is missing from the portable catalog graph.');
    catalog.push({ before: existing, after: null });
  }
  for (const [key, link] of newCatalog) {
    if (oldCatalog.has(key)) continue;
    if (manifest.links.some((entry) => catalogKey(entry) === key))
      throw new Error('A different portable relationship already owns this catalog tuple.');
    catalog.push({
      before: null,
      after: {
        ...link,
        confidence: 'confirmed',
        evidence: {
          kind: 'native_record_field',
        },
      },
    });
  }
  const catalogAfter = patch(manifest.links, catalog, catalogKey);
  const fieldLims = (use: Use): RegistryLink => {
    const type = nativeLimsRelationshipType(use.relation);
    return {
      id: linkIdentity(before.id, type, use.targetId),
      fromEntityId: before.id,
      toEntityId: use.targetId,
      type,
    };
  };
  const hasLimsTarget = (use: Use) =>
    manifest.entities.some((entity) => entity.id === use.targetId && entity.lims);
  const oldLims = new Map(
    previous.filter(hasLimsTarget).map((use) => [limsKey(fieldLims(use)), fieldLims(use)])
  );
  const newLims = new Map(
    next.filter(hasLimsTarget).map((use) => [limsKey(fieldLims(use)), fieldLims(use)])
  );
  const lims: Change<RegistryLink>[] = [];
  for (const [key] of oldLims) {
    if (newLims.has(key)) continue;
    const existing = manifest.limsLinks?.find((entry) => limsKey(entry) === key);
    if (!existing)
      throw new Error('Record relationship is missing from the portable Registry graph.');
    if (
      catalogAfter.some(
        (link) =>
          link.sourceId === existing.fromEntityId &&
          link.targetId === existing.toEntityId &&
          nativeLimsRelationshipType(link.relation) === existing.type
      )
    )
      continue;
    lims.push({ before: existing, after: null });
  }
  for (const [key, link] of newLims) {
    if (oldLims.has(key)) continue;
    if (manifest.limsLinks?.some((entry) => limsKey(entry) === key))
      throw new Error('A different portable relationship already owns this Registry tuple.');
    lims.push({
      before: null,
      after: {
        ...link,
        payload: {
          kind: 'native_record_field',
        },
      },
    });
  }
  return { version: 1, catalog, lims };
}

function patch<T>(
  current: readonly T[],
  changes: readonly Change<T>[],
  key: (entry: T) => string
): T[] {
  const result = [...current];
  const keys = new Set<string>();
  for (const change of changes) {
    const reference = change.before ?? change.after;
    if (!reference || (change.before && change.after && key(change.before) !== key(change.after)))
      throw new Error('Record relationship delta changes its identity.');
    const identity = key(reference);
    if (keys.has(identity)) throw new Error('Record relationship delta repeats a tuple.');
    keys.add(identity);
    const index = result.findIndex((entry) => key(entry) === identity);
    const present = index < 0 ? null : result[index];
    if (!isDeepStrictEqual(present, change.before) && !isDeepStrictEqual(present, change.after))
      throw new Error(
        'Portable relationship changed after the record edit; later data was preserved.'
      );
    if (index >= 0) result.splice(index, 1);
    if (change.after) result.push(change.after);
  }
  return result;
}

export function applyRecordFieldGraphDeltaToManifest(
  manifest: NativeWorkspaceManifestV2,
  delta: RecordFieldGraphDelta
): NativeWorkspaceManifestV2 {
  const links = patch(manifest.links, delta.catalog, catalogKey);
  const limsLinks = patch(manifest.limsLinks ?? [], delta.lims, limsKey);
  return { ...manifest, links, ...(limsLinks.length || manifest.limsLinks ? { limsLinks } : {}) };
}

export function parseRecordFieldGraphDelta(
  value: unknown,
  manifest: NativeWorkspaceManifestV2
): RecordFieldGraphDelta {
  if (
    !record(value) ||
    value.version !== 1 ||
    !Array.isArray(value.catalog) ||
    !Array.isArray(value.lims)
  )
    throw new Error('Native record graph receipt is invalid.');
  const parse = (value: unknown, kind: 'catalog' | 'lims') => {
    if (!record(value) || !Object.hasOwn(value, 'before') || !Object.hasOwn(value, 'after'))
      throw new Error('Native record graph change is invalid.');
    const snapshot = (entry: unknown) => {
      if (entry === null) return null;
      const parsed = parseNativeWorkspaceManifestFragment(
        JSON.stringify({
          schema: manifest.schema,
          entities: [],
          links: kind === 'catalog' ? [entry] : [],
          ...(kind === 'lims' ? { limsLinks: [entry] } : {}),
        }),
        manifest.entities.map((entity) => entity.id)
      );
      return kind === 'catalog' ? parsed.links[0] : (parsed.limsLinks?.[0] ?? null);
    };
    return { before: snapshot(value.before), after: snapshot(value.after) };
  };
  const catalog: Change<CatalogLink>[] = value.catalog.map((value) => {
    const parsed = parse(value, 'catalog');
    if (
      (parsed.before && !('sourceId' in parsed.before)) ||
      (parsed.after && !('sourceId' in parsed.after))
    )
      throw new Error('Invalid catalog graph receipt.');
    return { before: parsed.before, after: parsed.after };
  });
  const lims: Change<RegistryLink>[] = value.lims.map((value) => {
    const parsed = parse(value, 'lims');
    if (
      (parsed.before && !('fromEntityId' in parsed.before)) ||
      (parsed.after && !('fromEntityId' in parsed.after))
    )
      throw new Error('Invalid Registry graph receipt.');
    return { before: parsed.before, after: parsed.after };
  });
  const delta: RecordFieldGraphDelta = { version: 1, catalog, lims };
  applyRecordFieldGraphDeltaToManifest(manifest, delta);
  return delta;
}

export function ownsNativeRecordFieldGraphRow(
  db: Database.Database,
  table: string,
  id: string,
  current: unknown
): boolean {
  const latest = db
    .prepare(
      'SELECT actor,after,operation_id,payload FROM lims_audit WHERE subject_table=? AND subject_id=? ORDER BY event_seq DESC LIMIT 1'
    )
    .get(table, id);
  if (
    !record(latest) ||
    typeof latest.after !== 'string' ||
    !isDeepStrictEqual(JSON.parse(latest.after), current)
  )
    return false;
  if (latest.actor === 'migration' || latest.actor === 'workspace-reconcile') return true;
  if (
    latest.actor !== ACTOR ||
    typeof latest.operation_id !== 'string' ||
    typeof latest.payload !== 'string'
  )
    return false;
  const owner: unknown = JSON.parse(latest.payload);
  if (!record(owner) || owner.schema !== OWNER_SCHEMA || typeof owner.recordId !== 'string')
    return false;
  const receipt = db
    .prepare(
      "SELECT payload FROM lims_audit WHERE event_type='native_catalog_publication_required' AND operation_id=? AND subject_id=?"
    )
    .get(latest.operation_id, owner.recordId);
  if (!record(receipt) || typeof receipt.payload !== 'string') return false;
  const intent: unknown = JSON.parse(receipt.payload);
  if (
    !record(intent) ||
    intent.schema !== 'dnaforge.native-record-edit.v2' ||
    !record(intent.graphDelta)
  )
    return false;
  const effects =
    table === 'catalog_entity_links'
      ? intent.graphDelta.catalog
      : table === 'lims_link'
        ? intent.graphDelta.lims
        : null;
  return (
    Array.isArray(effects) &&
    effects.some((effect) => record(effect) && isDeepStrictEqual(effect, owner.effect))
  );
}

type CatalogRow = {
  id: string;
  source_entity_id: string;
  relation: string;
  target_entity_id: string;
  confidence: string;
  evidence: string | null;
};
function catalogRow(value: unknown): CatalogRow | null {
  if (value === undefined) return null;
  if (
    !record(value) ||
    typeof value.id !== 'string' ||
    typeof value.source_entity_id !== 'string' ||
    typeof value.target_entity_id !== 'string' ||
    typeof value.relation !== 'string' ||
    typeof value.confidence !== 'string' ||
    (value.evidence !== null && typeof value.evidence !== 'string')
  )
    throw new Error('Catalog relationship row is invalid.');
  return {
    id: value.id,
    source_entity_id: value.source_entity_id,
    target_entity_id: value.target_entity_id,
    relation: value.relation,
    confidence: value.confidence,
    evidence: value.evidence,
  };
}
function catalogState(row: CatalogRow) {
  return { ...row, evidence: JSON.parse(row.evidence ?? 'null') };
}

type RecordFieldGraphApplyInput = {
  authority: Authority;
  recordId: string;
  operationId: string;
  delta: RecordFieldGraphDelta;
  manifest: NativeWorkspaceManifestV2;
};

function graphOwner(input: RecordFieldGraphApplyInput, effect: unknown) {
  return { schema: OWNER_SCHEMA, recordId: input.recordId, effect };
}

function scopedGraphId(authority: Authority, rawId: string): string {
  return scopedProjectionId(authority.scope, rawId);
}

function findCatalogRelationship(
  db: Database.Database,
  from: string,
  relation: string,
  to: string
): CatalogRow | null {
  return catalogRow(
    db
      .prepare(
        'SELECT * FROM catalog_entity_links WHERE source_entity_id=? AND relation=? AND target_entity_id=?'
      )
      .get(from, relation, to)
  );
}

function assertCatalogGraphEffectApplicable(
  db: Database.Database,
  effect: Change<CatalogLink>,
  existing: CatalogRow | null
): void {
  if (effect.before) {
    if (
      !existing ||
      existing.confidence !== (effect.before.confidence ?? 'confirmed') ||
      !isDeepStrictEqual(JSON.parse(existing.evidence ?? 'null'), effect.before.evidence ?? null) ||
      !ownsNativeRecordFieldGraphRow(
        db,
        'catalog_entity_links',
        existing.id,
        catalogState(existing)
      )
    )
      throw new Error(
        'Catalog relationship changed or has a different owner; later data was preserved.'
      );
  } else if (existing) throw new Error('An unrelated catalog relationship owns this tuple.');
}

function catalogRelationshipAfter(
  effect: Change<CatalogLink>,
  link: CatalogLink,
  id: string,
  from: string,
  to: string
): ReturnType<typeof catalogState> | null {
  return effect.after
    ? {
        id,
        source_entity_id: from,
        relation: link.relation,
        target_entity_id: to,
        confidence: effect.after.confidence ?? 'confirmed',
        evidence: effect.after.evidence ?? null,
      }
    : null;
}

function projectCatalogRelationshipAfterInsideTx(
  db: Database.Database,
  after: ReturnType<typeof catalogState> | null,
  id: string,
  from: string,
  relation: string,
  to: string
): void {
  if (after) {
    db.prepare(
      'INSERT INTO catalog_entity_links (id,source_entity_id,relation,target_entity_id,confidence,evidence,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET confidence=excluded.confidence,evidence=excluded.evidence,updated_at=excluded.updated_at'
    ).run(
      id,
      from,
      relation,
      to,
      after.confidence,
      after.evidence === null ? null : JSON.stringify(after.evidence),
      Date.now(),
      Date.now()
    );
    return;
  }
  db.prepare('DELETE FROM catalog_entity_links WHERE id=?').run(id);
}

function applyCatalogGraphEffectInsideTx(
  db: Database.Database,
  input: RecordFieldGraphApplyInput,
  effect: Change<CatalogLink>
): void {
  const link = effect.before ?? effect.after;
  if (!link) throw new Error('Empty catalog relationship change.');
  const from = scopedGraphId(input.authority, link.sourceId);
  const to = scopedGraphId(input.authority, link.targetId);
  const existing = findCatalogRelationship(db, from, link.relation, to);
  assertCatalogGraphEffectApplicable(db, effect, existing);
  const id = existing?.id ?? randomUUID();
  const after = catalogRelationshipAfter(effect, link, id, from, to);
  insertAuditEvent(db, {
    eventType: after ? 'catalog_relationship_projected' : 'catalog_relationship_removed',
    operationId: input.operationId,
    subjectTable: 'catalog_entity_links',
    subjectId: id,
    workspaceId: input.authority.id,
    actor: ACTOR,
    before: existing ? catalogState(existing) : null,
    after,
    payload: graphOwner(input, effect),
  });
  projectCatalogRelationshipAfterInsideTx(db, after, id, from, link.relation, to);
}

type ExistingRegistryRelationship = {
  id: string;
  from: string;
  to: string;
  existing: LimsLink | null;
};

function findRegistryRelationship(
  db: Database.Database,
  authority: Authority,
  link: RegistryLink
): ExistingRegistryRelationship {
  const from = scopedGraphId(authority, link.fromEntityId);
  const to = scopedGraphId(authority, link.toEntityId);
  const id = scopedGraphId(authority, link.id);
  const row = db
    .prepare('SELECT id FROM lims_link WHERE from_entity_id=? AND to_entity_id=? AND type=?')
    .get(from, to, link.type);
  const rowId = record(row) && typeof row.id === 'string' ? row.id : null;
  if (row !== undefined && rowId === null)
    throw new Error('Registry relationship row has no identity.');
  const existing = rowId === null ? null : limsLinkFromRow(getLinkRowById(db, rowId));
  const claimed = db.prepare('SELECT id FROM lims_link WHERE id=?').get(id);
  if (claimed && existing?.id !== id) throw new Error('Record relationship identity collision.');
  return { id, from, to, existing };
}

function shouldDeferRegistryRelationshipRemoval(
  db: Database.Database,
  input: RecordFieldGraphApplyInput,
  effect: Change<RegistryLink>,
  link: RegistryLink,
  relationship: ExistingRegistryRelationship
): boolean {
  if (!effect.before || effect.after || relationship.existing) return false;
  const fromPresent = nativeLimsEndpointPresent(
    db,
    input.authority,
    input.manifest.entities.find((entity) => entity.id === link.fromEntityId),
    relationship.from
  );
  const toPresent = nativeLimsEndpointPresent(
    db,
    input.authority,
    input.manifest.entities.find((entity) => entity.id === link.toEntityId),
    relationship.to
  );
  return !fromPresent || !toPresent;
}

function assertRegistryGraphEffectApplicable(
  db: Database.Database,
  input: RecordFieldGraphApplyInput,
  effect: Change<RegistryLink>,
  relationship: ExistingRegistryRelationship
): void {
  const { existing, id } = relationship;
  if (effect.before) {
    if (
      !existing ||
      existing.id !== scopedGraphId(input.authority, effect.before.id) ||
      existing.tombstone ||
      !isDeepStrictEqual(existing.payload, effect.before.payload ?? {}) ||
      !ownsNativeRecordFieldGraphRow(db, 'lims_link', existing.id, existing)
    )
      throw new Error(
        'Registry relationship changed or has a different owner; later data was preserved.'
      );
  } else if (
    existing &&
    (!existing.tombstone ||
      existing.id !== id ||
      !ownsNativeRecordFieldGraphRow(db, 'lims_link', existing.id, existing))
  )
    throw new Error('An unrelated Registry relationship owns this tuple.');
}

function assertRegistryRelationshipMayBeCreated(
  db: Database.Database,
  authority: Authority,
  link: RegistryLink,
  relationship: ExistingRegistryRelationship
): void {
  if (relationship.from === relationship.to)
    throw new Error('Record relationships cannot point to themselves.');
  for (const endpoint of [relationship.from, relationship.to]) {
    if (
      !db
        .prepare(
          "SELECT 1 FROM lims_entity l JOIN catalog_entities c ON c.id=l.id WHERE l.id=? AND l.workspace_id=? AND c.workspace_id=? AND l.tombstone=0 AND l.archived_at IS NULL AND c.status='active'"
        )
        .get(endpoint, authority.id, authority.id)
    )
      throw new Error('Record relationship endpoint is missing or archived.');
  }
  assertRelationshipTypeExists(db, link.type);
  if (
    LINEAGE_RELATIONSHIP_TYPES.has(link.type) &&
    wouldCreateRelationshipCycle(db, relationship.from, relationship.to, link.type)
  )
    throw new Error('Record relationship creates a cycle.');
}

function registryRelationshipAfter(
  db: Database.Database,
  authority: Authority,
  effect: Change<RegistryLink>,
  link: RegistryLink,
  relationship: ExistingRegistryRelationship
): LimsLink {
  const now = Date.now();
  return {
    id: relationship.id,
    fromEntityId: relationship.from,
    toEntityId: relationship.to,
    type: link.type,
    payload: effect.after?.payload ?? relationship.existing?.payload ?? {},
    workspaceId: authority.id,
    actor: ACTOR,
    eventSeq: nextEventSeq(db),
    tombstone: !effect.after,
    createdAt: relationship.existing?.createdAt ?? now,
    updatedAt: now,
    archivedAt: effect.after ? null : now,
  };
}

function applyRegistryGraphEffectInsideTx(
  db: Database.Database,
  input: RecordFieldGraphApplyInput,
  effect: Change<RegistryLink>
): void {
  const link = effect.before ?? effect.after;
  if (!link) throw new Error('Empty Registry relationship change.');
  const relationship = findRegistryRelationship(db, input.authority, link);
  if (shouldDeferRegistryRelationshipRemoval(db, input, effect, link, relationship)) return;
  assertRegistryGraphEffectApplicable(db, input, effect, relationship);
  if (effect.after) assertRegistryRelationshipMayBeCreated(db, input.authority, link, relationship);
  const after = registryRelationshipAfter(db, input.authority, effect, link, relationship);
  insertAuditEvent(db, {
    eventType: !effect.after
      ? 'link_tombstoned'
      : relationship.existing
        ? 'link_updated'
        : 'link_created',
    operationId: input.operationId,
    eventSeq: after.eventSeq ?? undefined,
    subjectTable: 'lims_link',
    subjectId: relationship.id,
    workspaceId: input.authority.id,
    actor: ACTOR,
    before: relationship.existing,
    after,
    payload: graphOwner(input, effect),
  });
  upsertLimsLinkProjectionInsideTx(db, after);
}

export function applyRecordFieldGraphChangeInsideTx(
  db: Database.Database,
  input: RecordFieldGraphApplyInput
): void {
  if (!db.inTransaction) throw new Error('Record graph edit requires a transaction.');
  for (const effect of input.delta.catalog) applyCatalogGraphEffectInsideTx(db, input, effect);
  for (const effect of input.delta.lims) applyRegistryGraphEffectInsideTx(db, input, effect);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
