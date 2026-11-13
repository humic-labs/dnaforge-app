import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { benchlingRelationshipDisplayNames } from '../shared/benchling-relationship-names';
import type { LimsImportUnresolvedLink, LimsPendingRef } from '../shared/lims';
import {
  isExactProviderStableId,
  isProviderObjectClass,
  providerObjectReferenceKey,
} from '../shared/provider-object-reference';
import { insertAuditEvent, linkLimsEntitiesOrExistingInsideTx } from './lims-engine-core';

export type { LimsPendingRef } from '../shared/lims';

const REF_REJECT_EVENT = 'pending_ref_candidate_rejected';
const REF_DISMISS_EVENT = 'pending_ref_dismissed';
const REF_RESTORE_EVENT = 'pending_ref_restored';

const PENDING_SEVERITIES = new Set(['provisional_stub', 'ambiguous']);

function normalizeName(name: string): string {
  return name
    .replace(/^\ufeff/, '')
    .trim()
    .toLowerCase();
}

function pushInto(map: Map<string, string[]>, key: string, value: string): void {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}

function pushProviderCandidate(
  map: Map<string, Array<{ entityId: string; workspaceId: number | null }>>,
  key: string,
  value: { entityId: string; workspaceId: number | null }
): void {
  const candidates = map.get(key);
  if (candidates) candidates.push(value);
  else map.set(key, [value]);
}

interface AppliedPayload {
  insertedEntityIds?: Array<{ recordId: string; entityId: string }>;
  unresolvedLinks?: Array<{
    recordId: string;
    link: LimsImportUnresolvedLink;
  }>;
}

type TargetProviderIdentity = NonNullable<LimsImportUnresolvedLink['targetProviderIdentity']>;

function parseTargetProviderIdentity(value: unknown): TargetProviderIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const identity = value as Record<string, unknown>;
  if (identity.provider !== 'benchling') return null;
  if (!isExactProviderStableId(identity.stableObjectId)) return null;
  if (!isProviderObjectClass(identity.objectClass)) return null;
  return {
    provider: 'benchling',
    stableObjectId: identity.stableObjectId,
    objectClass: identity.objectClass,
  };
}

interface EntityRow {
  id: string;
  kind: string;
  name: string;
}

interface AppliedAuditRow {
  batch_id: string | null;
  workspace_id: number | null;
  payload: string | null;
}

interface PendingRefBirth {
  referrerEntityId: string;
  type: string;
  targetKind: string | null;
  targetName: string;
  targetProviderIdentity: TargetProviderIdentity | null;
  sourceBatchId: string;
  workspaceId: number | null;
}

interface PendingRefDecisionRow {
  event_type: string;
  payload: string | null;
}

type ProviderIdentityIndex = Map<string, Array<{ entityId: string; workspaceId: number | null }>>;

function pendingRefLinkKey(from: string, to: string, type: string): string {
  return `${from}|${to}|${type}`;
}

function pendingRefBirthFromUnresolvedLink(
  unresolved: NonNullable<AppliedPayload['unresolvedLinks']>[number],
  referrerByRecord: Map<string, string>,
  row: AppliedAuditRow
): { key: string; birth: PendingRefBirth } | null {
  if (
    !unresolved.link ||
    !unresolved.link.type ||
    !PENDING_SEVERITIES.has(unresolved.link.severity ?? '')
  ) {
    return null;
  }
  const referrerEntityId = referrerByRecord.get(unresolved.recordId);
  if (!referrerEntityId) return null;

  const targetKind = unresolved.link.kind ?? null;
  const targetName = unresolved.link.label;
  const norm = normalizeName(targetName);
  const targetProviderIdentity = parseTargetProviderIdentity(
    unresolved.link.targetProviderIdentity
  );
  const targetIdentity = targetProviderIdentity
    ? `provider:${providerObjectReferenceKey(targetProviderIdentity)}`
    : `name:${norm}`;
  const key = createHash('sha256')
    .update(`${referrerEntityId}|${unresolved.link.type}|${targetKind ?? ''}|${targetIdentity}`)
    .digest('hex');
  return {
    key,
    birth: {
      referrerEntityId,
      type: unresolved.link.type,
      targetKind,
      targetName,
      targetProviderIdentity,
      sourceBatchId: row.batch_id ?? '',
      workspaceId: row.workspace_id,
    },
  };
}

function collectPendingRefBirths(applied: AppliedAuditRow[]): Map<string, PendingRefBirth> {
  const births = new Map<string, PendingRefBirth>();
  for (const row of applied) {
    let payload: AppliedPayload;
    try {
      payload = JSON.parse(row.payload ?? '{}') as AppliedPayload;
    } catch {
      continue;
    }
    const referrerByRecord = new Map<string, string>();
    for (const inserted of payload.insertedEntityIds ?? []) {
      referrerByRecord.set(inserted.recordId, inserted.entityId);
    }
    for (const unresolved of payload.unresolvedLinks ?? []) {
      const born = pendingRefBirthFromUnresolvedLink(unresolved, referrerByRecord, row);
      if (!born || births.has(born.key)) continue;
      births.set(born.key, born.birth);
    }
  }
  return births;
}

function foldPendingRefDecisions(decisions: PendingRefDecisionRow[]): {
  rejectedByRef: Map<string, Set<string>>;
  dismissedRefs: Set<string>;
} {
  const rejectedByRef = new Map<string, Set<string>>();
  const dismissedRefs = new Set<string>();
  for (const decision of decisions) {
    let payload: { refKey?: string; rejectedEntityId?: string };
    try {
      payload = JSON.parse(decision.payload ?? '{}');
    } catch {
      continue;
    }
    if (!payload.refKey) continue;
    if (decision.event_type === REF_REJECT_EVENT && payload.rejectedEntityId) {
      const set = rejectedByRef.get(payload.refKey) ?? new Set<string>();
      set.add(payload.rejectedEntityId);
      rejectedByRef.set(payload.refKey, set);
    } else if (decision.event_type === REF_DISMISS_EVENT) {
      dismissedRefs.add(payload.refKey);
    } else if (decision.event_type === REF_RESTORE_EVENT) {
      dismissedRefs.delete(payload.refKey);
    }
  }
  return { rejectedByRef, dismissedRefs };
}

function indexLivePendingRefEntities(liveEntities: EntityRow[]): {
  liveById: Set<string>;
  entityById: Map<string, EntityRow>;
  byKindName: Map<string, string[]>;
  byName: Map<string, string[]>;
} {
  const liveById = new Set(liveEntities.map((entity) => entity.id));
  const entityById = new Map(liveEntities.map((entity) => [entity.id, entity]));
  const byKindName = new Map<string, string[]>();
  const byName = new Map<string, string[]>();
  for (const entity of liveEntities) {
    const normalized = normalizeName(entity.name);
    pushInto(byName, normalized, entity.id);
    pushInto(byKindName, `${entity.kind}|${normalized}`, entity.id);
  }
  return { liveById, entityById, byKindName, byName };
}

function loadProviderIdentityIndex(
  db: Database.Database,
  births: Map<string, PendingRefBirth>
): ProviderIdentityIndex {
  const byProviderIdentity: ProviderIdentityIndex = new Map();
  if (![...births.values()].some((birth) => birth.targetProviderIdentity !== null)) {
    return byProviderIdentity;
  }
  const providerRows = db
    .prepare(
      `SELECT b.provider, b.stable_object_id, b.object_class, b.entity_id,
              e.workspace_id
         FROM catalog_provider_bindings b
         JOIN catalog_entities e
           ON e.id = b.entity_id
          AND e.status = 'active'
         JOIN lims_entity l
           ON l.id = b.entity_id
          AND l.tombstone = 0
        ORDER BY b.entity_id`
    )
    .all() as Array<{
    provider: TargetProviderIdentity['provider'];
    stable_object_id: string;
    object_class: TargetProviderIdentity['objectClass'];
    entity_id: string;
    workspace_id: number | null;
  }>;
  for (const row of providerRows) {
    pushProviderCandidate(
      byProviderIdentity,
      providerObjectReferenceKey({
        provider: row.provider,
        stableObjectId: row.stable_object_id,
        objectClass: row.object_class,
      }),
      { entityId: row.entity_id, workspaceId: row.workspace_id }
    );
  }
  return byProviderIdentity;
}

function pendingRefCandidateIds(
  birth: PendingRefBirth,
  indexes: {
    byProviderIdentity: ProviderIdentityIndex;
    byKindName: Map<string, string[]>;
    byName: Map<string, string[]>;
  },
  rejected: Set<string> | undefined
): string[] {
  const allCandidates = birth.targetProviderIdentity
    ? (
        indexes.byProviderIdentity.get(providerObjectReferenceKey(birth.targetProviderIdentity)) ??
        []
      )
        .filter(
          (candidate) => birth.workspaceId === null || candidate.workspaceId === birth.workspaceId
        )
        .map((candidate) => candidate.entityId)
    : birth.targetKind
      ? (indexes.byKindName.get(`${birth.targetKind}|${normalizeName(birth.targetName)}`) ?? [])
      : (indexes.byName.get(normalizeName(birth.targetName)) ?? []);
  return rejected ? allCandidates.filter((candidate) => !rejected.has(candidate)) : allCandidates;
}

function pendingRefStatus(
  resolved: boolean,
  dismissed: boolean,
  candidateCount: number
): LimsPendingRef['status'] {
  if (resolved) return 'resolved';
  if (dismissed) return 'dismissed';
  if (candidateCount === 0) return 'open';
  if (candidateCount === 1) return 'draft';
  return 'ambiguous';
}

function projectPendingRef(
  key: string,
  birth: PendingRefBirth,
  ctx: {
    liveById: Set<string>;
    entityById: Map<string, EntityRow>;
    byKindName: Map<string, string[]>;
    byName: Map<string, string[]>;
    byProviderIdentity: ProviderIdentityIndex;
    rejectedByRef: Map<string, Set<string>>;
    dismissedRefs: Set<string>;
    activeLinkSet: Set<string>;
  }
): LimsPendingRef | null {
  if (!ctx.liveById.has(birth.referrerEntityId)) return null;
  const candidates = pendingRefCandidateIds(birth, ctx, ctx.rejectedByRef.get(key));
  const resolved = candidates.some((candidate) =>
    ctx.activeLinkSet.has(pendingRefLinkKey(birth.referrerEntityId, candidate, birth.type))
  );
  return {
    key,
    referrerEntityId: birth.referrerEntityId,
    referrerName: ctx.entityById.get(birth.referrerEntityId)?.name ?? birth.referrerEntityId,
    type: birth.type,
    targetKind: birth.targetKind,
    targetName: birth.targetName,
    normalizedTargetName: normalizeName(birth.targetName),
    ...(birth.targetProviderIdentity
      ? { targetProviderIdentity: birth.targetProviderIdentity }
      : {}),
    sourceBatchId: birth.sourceBatchId,
    status: pendingRefStatus(resolved, ctx.dismissedRefs.has(key), candidates.length),
    candidateEntityIds: candidates,
    candidates: candidates.map((candidate) => {
      const entity = ctx.entityById.get(candidate);
      return { id: candidate, name: entity?.name ?? candidate, kind: entity?.kind ?? '' };
    }),
  };
}

export function derivePendingRefsInDb(db: Database.Database): LimsPendingRef[] {
  const applied = db
    .prepare(
      `SELECT batch_id, workspace_id, payload FROM lims_audit
       WHERE event_type = 'import_batch_applied'
       ORDER BY event_seq ASC`
    )
    .all() as AppliedAuditRow[];

  const births = collectPendingRefBirths(applied);
  if (births.size === 0) return [];

  const decisions = db
    .prepare(
      `SELECT event_type, payload FROM lims_audit
       WHERE event_type IN (?, ?, ?)
       ORDER BY event_seq ASC`
    )
    .all(REF_REJECT_EVENT, REF_DISMISS_EVENT, REF_RESTORE_EVENT) as PendingRefDecisionRow[];
  const { rejectedByRef, dismissedRefs } = foldPendingRefDecisions(decisions);

  const liveEntities = db
    .prepare(`SELECT id, kind, name FROM lims_entity WHERE tombstone = 0`)
    .all() as EntityRow[];
  const live = indexLivePendingRefEntities(liveEntities);

  const byProviderIdentity = loadProviderIdentityIndex(db, births);

  const activeLinks = db
    .prepare(`SELECT from_entity_id, to_entity_id, type FROM lims_link WHERE tombstone = 0`)
    .all() as Array<{ from_entity_id: string; to_entity_id: string; type: string }>;
  const activeLinkSet = new Set(
    activeLinks.map((link) => pendingRefLinkKey(link.from_entity_id, link.to_entity_id, link.type))
  );

  const out: LimsPendingRef[] = [];
  const indexes = { ...live, byProviderIdentity };
  for (const [key, birth] of births) {
    for (const atomic of expandJoinedPendingRef(key, birth, indexes)) {
      const dismissedForAtomic = dismissedRefs.has(key)
        ? new Set([...dismissedRefs, atomic.key])
        : dismissedRefs;
      const projected = projectPendingRef(atomic.key, atomic.birth, {
        ...live,
        byProviderIdentity,
        rejectedByRef,
        dismissedRefs: dismissedForAtomic,
        activeLinkSet,
      });
      if (projected) out.push(projected);
    }
  }
  return out;
}

function expandJoinedPendingRef(
  key: string,
  birth: PendingRefBirth,
  indexes: {
    byProviderIdentity: ProviderIdentityIndex;
    byKindName: Map<string, string[]>;
    byName: Map<string, string[]>;
  }
): Array<{ key: string; birth: PendingRefBirth }> {
  if (birth.targetProviderIdentity) return [{ key, birth }];
  if (pendingRefCandidateIds(birth, indexes, undefined).length > 0) return [{ key, birth }];
  const parts = benchlingRelationshipDisplayNames(birth.targetName);
  if (parts.length < 2) return [{ key, birth }];
  const unique = new Map<string, { key: string; birth: PendingRefBirth }>();
  for (const name of parts) {
    const atomicKey = createHash('sha256')
      .update(`${key}|${normalizeName(name)}`)
      .digest('hex');
    unique.set(atomicKey, { key: atomicKey, birth: { ...birth, targetName: name } });
  }
  return [...unique.values()];
}

export interface ConfirmPendingRefInput {
  key: string;
  targetEntityId: string;
  actor?: string | null;
}

export function confirmPendingRefInDb(db: Database.Database, input: ConfirmPendingRefInput): void {
  const ref = derivePendingRefsInDb(db).find((r) => r.key === input.key);
  if (!ref) throw new Error(`Pending reference not found: ${input.key}`);
  if (!ref.candidateEntityIds.includes(input.targetEntityId)) {
    throw new Error(
      `Cannot confirm reference ${input.key}: ${input.targetEntityId} is not a candidate for "${ref.targetName}"`
    );
  }

  db.transaction(() => {
    linkLimsEntitiesOrExistingInsideTx(db, {
      fromEntityId: ref.referrerEntityId,
      toEntityId: input.targetEntityId,
      type: ref.type,
      batchId: ref.sourceBatchId || null,
      actor: input.actor ?? null,
      payload: { resolution: { method: 'human-confirmed', refKey: ref.key } },
    });
  })();
}

export function rejectPendingRefCandidateInDb(
  db: Database.Database,
  input: { key: string; rejectedEntityId: string; actor?: string | null }
): void {
  insertAuditEvent(db, {
    eventType: REF_REJECT_EVENT,
    subjectTable: 'lims_pending_ref',
    subjectId: input.key,
    actor: input.actor ?? null,
    payload: { refKey: input.key, rejectedEntityId: input.rejectedEntityId },
    idempotencyKey: `pref:reject:${input.key}:${input.rejectedEntityId}`,
  });
}

export function dismissPendingRefInDb(
  db: Database.Database,
  input: { key: string; actor?: string | null }
): void {
  insertAuditEvent(db, {
    eventType: REF_DISMISS_EVENT,
    subjectTable: 'lims_pending_ref',
    subjectId: input.key,
    actor: input.actor ?? null,
    payload: { refKey: input.key },
  });
}

export function restorePendingRefInDb(
  db: Database.Database,
  input: { key: string; actor?: string | null }
): void {
  insertAuditEvent(db, {
    eventType: REF_RESTORE_EVENT,
    subjectTable: 'lims_pending_ref',
    subjectId: input.key,
    actor: input.actor ?? null,
    payload: { refKey: input.key },
  });
}
