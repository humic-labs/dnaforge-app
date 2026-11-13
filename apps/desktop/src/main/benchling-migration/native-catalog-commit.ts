import type Database from 'better-sqlite3';
import { isDeepStrictEqual } from 'node:util';
import {
  parseNativeWorkspaceManifestFragment,
  type NativeWorkspaceManifest,
} from '../../shared/native-workspace-manifest';
import { insertAuditEvent } from '../lims-engine-core';
import {
  nativeCatalogRecordStateSha256,
  readNativeCatalogRecordState,
} from '../native-catalog-record-state';
import { scopedProjectionId } from '../../shared/workspace-scoped-identity';

export type NativeCatalogCommit = {
  workspaceId: number;
  manifest: NativeWorkspaceManifest;
  replacedEntityIds: readonly string[];
  publishLims: boolean;
  existingEntityIds: readonly string[];
  removedRelationships?: NativeWorkspaceManifest;
  recordPostconditions: readonly {
    entityId: string;
    stateSha256: string;
    beforeEntity: string | null;
    beforeGraph: string;
    afterGraph: string;
  }[];
};

export function recordNativeCatalogCommit(
  db: Database.Database,
  scopeId: string,
  actionId: string,
  commit: Omit<NativeCatalogCommit, 'recordPostconditions'>,
  priorManifest?: NativeWorkspaceManifest
): void {
  if (!db.inTransaction)
    throw new Error('Native catalog commit receipt requires an active transaction.');
  const recordPostconditions = commit.manifest.entities
    .filter((entity) => entity.type === 'record')
    .map((entity) => {
      const current = readNativeCatalogRecordState(db, scopedProjectionId(scopeId, entity.id));
      if (!current || current.workspaceId !== commit.workspaceId)
        throw new Error('Committed native record is missing from its workspace.');
      const before = priorManifest?.entities.find((prior) => prior.id === entity.id);
      return {
        entityId: entity.id,
        stateSha256: nativeCatalogRecordStateSha256(current),
        beforeEntity: before ? JSON.stringify(before) : null,
        beforeGraph: JSON.stringify(portableGraph(priorManifest, entity.id)),
        afterGraph: JSON.stringify(committedPortableGraph(commit, priorManifest, entity.id)),
      };
    });
  insertAuditEvent(db, {
    eventType: 'native_catalog_action_committed',
    idempotencyKey: key(scopeId, actionId),
    operationId: actionId,
    workspaceId: commit.workspaceId,
    actor: 'migration',
    payload: { schema: 'dnaforge.native-catalog-commit.v1', ...commit, recordPostconditions },
  });
}

export function readNativeCatalogCommit(
  db: Database.Database,
  scopeId: string,
  actionId: string
): NativeCatalogCommit | null {
  const row = db
    .prepare('SELECT event_type, workspace_id, payload FROM lims_audit WHERE idempotency_key = ?')
    .get(key(scopeId, actionId)) as
    | {
        event_type: string;
        workspace_id: number | null;
        payload: string;
      }
    | undefined;
  if (!row) return null;
  const payload: unknown = JSON.parse(row.payload);
  if (
    row.event_type !== 'native_catalog_action_committed' ||
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    !('schema' in payload) ||
    payload.schema !== 'dnaforge.native-catalog-commit.v1' ||
    !('workspaceId' in payload) ||
    !Number.isSafeInteger(payload.workspaceId) ||
    payload.workspaceId !== row.workspace_id ||
    !('manifest' in payload) ||
    !('replacedEntityIds' in payload) ||
    !Array.isArray(payload.replacedEntityIds) ||
    !payload.replacedEntityIds.every(
      (id): id is string => typeof id === 'string' && id.length > 0
    ) ||
    !('existingEntityIds' in payload) ||
    !Array.isArray(payload.existingEntityIds) ||
    !payload.existingEntityIds.every(
      (id): id is string => typeof id === 'string' && id.length > 0
    ) ||
    !('publishLims' in payload) ||
    typeof payload.publishLims !== 'boolean' ||
    row.workspace_id === null
  )
    throw new Error('Native catalog commit receipt is invalid.');
  if (!('recordPostconditions' in payload) || !Array.isArray(payload.recordPostconditions))
    throw new Error('Native catalog commit has no record edit-protection evidence.');
  const recordPostconditions = payload.recordPostconditions.map((entry: unknown) => {
    if (
      !entry ||
      typeof entry !== 'object' ||
      !('entityId' in entry) ||
      typeof entry.entityId !== 'string' ||
      !('stateSha256' in entry) ||
      typeof entry.stateSha256 !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/.test(entry.stateSha256) ||
      !('beforeEntity' in entry) ||
      (entry.beforeEntity !== null && typeof entry.beforeEntity !== 'string') ||
      !('beforeGraph' in entry) ||
      typeof entry.beforeGraph !== 'string' ||
      !('afterGraph' in entry) ||
      typeof entry.afterGraph !== 'string'
    )
      throw new Error('Native catalog commit record evidence is invalid.');
    return {
      entityId: entry.entityId,
      stateSha256: entry.stateSha256,
      beforeEntity: entry.beforeEntity,
      beforeGraph: entry.beforeGraph,
      afterGraph: entry.afterGraph,
    };
  });
  return {
    workspaceId: row.workspace_id,
    recordPostconditions,
    manifest: parseNativeWorkspaceManifestFragment(
      JSON.stringify(payload.manifest),
      payload.existingEntityIds
    ),
    existingEntityIds: payload.existingEntityIds,
    ...('removedRelationships' in payload
      ? {
          removedRelationships: parseNativeWorkspaceManifestFragment(
            JSON.stringify(payload.removedRelationships),
            payload.existingEntityIds
          ),
        }
      : {}),
    replacedEntityIds: payload.replacedEntityIds,
    publishLims: payload.publishLims,
  };
}

export function assertNativeCatalogCommitRecordsUnchanged(input: {
  db: Database.Database;
  scopeId: string;
  commit: NativeCatalogCommit;
  currentManifest: NativeWorkspaceManifest | null;
}): void {
  const records = input.commit.manifest.entities.filter((entity) => entity.type === 'record');
  if (records.length !== input.commit.recordPostconditions.length)
    throw new Error('Native catalog commit record evidence is incomplete.');
  for (const after of records) {
    const proof = input.commit.recordPostconditions.find((entry) => entry.entityId === after.id);
    if (!proof) throw new Error('Native catalog commit record evidence is incomplete.');
    const current = readNativeCatalogRecordState(
      input.db,
      scopedProjectionId(input.scopeId, after.id)
    );
    if (!current || nativeCatalogRecordStateSha256(current) !== proof.stateSha256)
      throw new Error(
        `Native record ${after.id} changed after catalog commit; preserve the later edit before resuming.`
      );
    const portable =
      input.currentManifest?.entities.find((entity) => entity.id === after.id) ?? null;
    const before: unknown = proof.beforeEntity === null ? null : JSON.parse(proof.beforeEntity);
    if (!isDeepStrictEqual(portable, before) && !isDeepStrictEqual(portable, after))
      throw new Error(
        `Native record ${after.id} changed after catalog commit in the portable catalog; preserve the later edit before resuming.`
      );
    const graph = portableGraph(input.currentManifest ?? undefined, after.id);
    if (
      !isDeepStrictEqual(graph, JSON.parse(proof.beforeGraph)) &&
      !isDeepStrictEqual(graph, JSON.parse(proof.afterGraph))
    )
      throw new Error(
        `Native record ${after.id} relationships changed after catalog commit; preserve the later edit before resuming.`
      );
  }
}

function portableGraph(manifest: NativeWorkspaceManifest | undefined, entityId: string) {
  return {
    catalog: (manifest?.links ?? [])
      .filter((link) => link.sourceId === entityId)
      .sort((a, b) => graphLinkKey(a).localeCompare(graphLinkKey(b))),
    lims: (manifest?.limsLinks ?? [])
      .filter((link) => link.fromEntityId === entityId)
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

function committedPortableGraph(
  commit: Omit<NativeCatalogCommit, 'recordPostconditions'>,
  before: NativeWorkspaceManifest | undefined,
  entityId: string
) {
  const removed = portableGraph(commit.removedRelationships, entityId);
  const current = portableGraph(before, entityId);
  const incoming = portableGraph(commit.manifest, entityId);
  const catalog = new Map(
    current.catalog
      .filter(
        (link) => !removed.catalog.some((entry) => graphLinkKey(entry) === graphLinkKey(link))
      )
      .map((link) => [graphLinkKey(link), link])
  );
  const lims = new Map(
    current.lims
      .filter((link) => !removed.lims.some((entry) => entry.id === link.id))
      .map((link) => [link.id, link])
  );
  for (const link of incoming.catalog)
    if (!catalog.has(graphLinkKey(link))) catalog.set(graphLinkKey(link), link);
  for (const link of incoming.lims) if (!lims.has(link.id)) lims.set(link.id, link);
  return {
    catalog: [...catalog.values()].sort((a, b) => graphLinkKey(a).localeCompare(graphLinkKey(b))),
    lims: [...lims.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

function graphLinkKey(link: NativeWorkspaceManifest['links'][number]): string {
  return JSON.stringify([link.sourceId, link.relation, link.targetId]);
}

function key(scopeId: string, actionId: string): string {
  return `native-catalog-commit:${JSON.stringify([scopeId, actionId])}`;
}
