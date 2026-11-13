import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import type Database from 'better-sqlite3';
import { mapPortableRecordRelationships } from '../shared/portable-record-relationships';
import type { CatalogEntityType } from '../shared/catalog-entity';

import { isSafeWorkspaceRelativePath } from '../shared/path-boundary';
import { scopedProjectionId, workspaceScopeKey } from '../shared/workspace-scoped-identity';
import {
  limsEntityFromRow,
  type DnaSequenceRef,
  type LimsEntityRow,
  type LimsImportUnresolvedLink,
  type LimsRegisterEntityInput,
} from '../shared/lims';
import {
  isExactProviderStableId,
  isProviderObjectClass,
  type ProviderObjectClass,
} from '../shared/provider-object-reference';
import { upsertProviderBinding } from './catalog-provider-bindings';
import { prepareCachedStatement } from './sqlite-statement-cache';
import type {
  NativeWorkspaceManifestSourceIdentity,
  NativeWorkspaceMigrationSourceRef,
  NativeWorkspacePlacement,
} from '../shared/native-workspace-manifest';
import {
  insertAuditEvent,
  linkLimsEntitiesOrExistingInsideTx,
  registerLimsEntityInsideTx,
  replaceNativeCatalogRecordInsideTx,
  seedLimsBuiltinsInDb,
  updateLimsEntityInsideTx,
} from './lims-engine-core';
import {
  nativeCatalogRecordStateSha256,
  readNativeCatalogRecordState,
} from './native-catalog-record-state';
import { isDeepStrictEqual } from 'node:util';
import { tombstoneLimsLinkInsideTx } from './lims-import';
import type { LimsLinkRow } from '../shared/lims';
import { nativeFileSequenceFields } from './native-file-sequence-fields';

export const NATIVE_WORKSPACE_MATERIALIZATION_SCHEMA =
  'dnaforge.native-workspace-materialization.v1' as const;

export type NativeWorkspaceRegistration = {
  name: string;
  path: string;
  repoUuid: string | null;
  createdAt: number;
  lastOpenedAt: number;
};

export type NativeWorkspaceEntityInput = {
  rawId: string;
  type: CatalogEntityType;
  name: string;
  locator: { kind: 'file' } | { kind: 'entity'; namespace: string };
  storageType: 'file' | 'database' | 'localStorage' | 'sidecar' | 'external';
  relativePath?: string;
  fileKind?: string;
  placement?: NativeWorkspacePlacement;
  contentHash?: string | null;
  sizeBytes?: number | null;
  modifiedAt?: number | null;
  objectUuid?: string;
  metadata?: Record<string, unknown> | null;
  sourceIdentities?: NativeWorkspaceManifestSourceIdentity[];
  migrationSource?: NativeWorkspaceMigrationSourceRef;
  page?: {
    title: string;
    content: unknown;
    date?: number | null;
    createdAt: number;
    updatedAt: number;
  };
};

export type NativeWorkspaceEntityLinkInput = {
  sourceRawId: string;
  relation: string;
  targetRawId: string;
  confidence?: 'suggested' | 'confirmed' | 'rejected';
  evidence?: Record<string, unknown> | null;
};

export type NativeWorkspaceEntityEventInput = {
  id: string;
  entityRawId: string;
  eventType: string;
  actor?: string;
  summary?: string | null;
  payload?: Record<string, unknown> | null;
  createdAt: number;
};

export type NativeExistingEntityReplacement =
  | { entityRawId: string; kind: 'scientific'; expectedScientificSha256: `sha256:${string}` }
  | {
      entityRawId: string;
      kind: 'notebook_package';
      layout: 'native' | 'legacy';
      expectedPlacement: Extract<NativeWorkspacePlacement, { kind: 'package' }>;
    }
  | {
      entityRawId: string;
      kind: 'protocol_package';
      layout: 'native' | 'legacy';
      expectedType: 'protocol' | 'protocol_run';
      expectedPlacement: Extract<NativeWorkspacePlacement, { kind: 'package' }>;
    };

export type NativeWorkspaceMaterializationPlan = {
  schema: typeof NATIVE_WORKSPACE_MATERIALIZATION_SCHEMA;
  existingEntityRawIds?: readonly string[];
  needsSequenceCompletionRawIds?: readonly string[];
  existingEntityReplacements?: readonly NativeExistingEntityReplacement[];
  entities: NativeWorkspaceEntityInput[];
  links: NativeWorkspaceEntityLinkInput[];
  removedRelationships?: {
    catalog: NativeWorkspaceEntityLinkInput[];
    lims: NonNullable<NativeWorkspaceMaterializationPlan['limsLinks']>;
  };
  events: NativeWorkspaceEntityEventInput[];
  limsEntities?: Array<{
    entityRawId: string;
    input: Omit<LimsRegisterEntityInput, 'id' | 'workspaceId'>;
  }>;
  limsLinks?: Array<{
    id: string;
    fromEntityRawId: string;
    toEntityRawId: string;
    type: string;
    payload?: Record<string, unknown>;
  }>;
  pendingReferences?: Array<{
    id: string;
    sourceEntityRawId: string;
    relationType: string;
    targetName: string;
    targetKind?: string;
    targetProviderIdentity?: LimsImportUnresolvedLink['targetProviderIdentity'];
    classification: 'unresolved' | 'ambiguous';
    candidateEntityRawIds?: readonly string[];
  }>;
};

export type NativeWorkspaceMaterializationResult = {
  workspaceId: number;
  entityIdsByRawId: Readonly<Record<string, string>>;
  entitiesMaterialized: number;
  linksMaterialized: number;
  eventsMaterialized: number;
  pagesMaterialized: number;
  limsEntitiesMaterialized: number;
  limsLinksMaterialized: number;
  pendingReferencesMaterialized: number;
  providerBindingsMaterialized: number;
  needsSequenceCompletionsAdopted: string[];
  needsSequenceCompletionsCorroborated: string[];
};

export class NativeSequenceSourceVersionConflictError extends Error {
  constructor(
    readonly entityRawId: string,
    readonly existingNormalizedSequenceHash: string,
    readonly candidateNormalizedSequenceHash: string
  ) {
    super(`Imported sequence ${entityRawId} conflicts with bases already in this project.`);
    this.name = 'NativeSequenceSourceVersionConflictError';
  }
}

export function registerNativeWorkspaceInsideTx(
  db: Database.Database,
  input: NativeWorkspaceRegistration
): number {
  assertInsideTransaction(db);
  const name = requiredText(input.name, 'Project name');
  const path = requiredText(input.path, 'Project path');
  const repoUuid = input.repoUuid;
  if (repoUuid !== null) requiredText(repoUuid, 'Project repository UUID');
  const createdAt = requiredTimestamp(input.createdAt, 'Project creation time');
  const lastOpenedAt = requiredTimestamp(input.lastOpenedAt, 'Project last-opened time');

  prepareCachedStatement(
    db,
    `INSERT INTO workspaces
       (name, path, repo_uuid, origin_path, created_at, last_opened_at)
     VALUES (?, ?, ?, NULL, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       repo_uuid = excluded.repo_uuid,
       last_opened_at = excluded.last_opened_at`
  ).run(name, path, repoUuid, createdAt, lastOpenedAt);

  const row = prepareCachedStatement(db, 'SELECT id, repo_uuid FROM workspaces WHERE path = ?').get(
    path
  ) as { id: number; repo_uuid: string | null } | undefined;
  if (!row || row.repo_uuid !== repoUuid) {
    throw new Error('Native workspace registration is incomplete.');
  }
  return row.id;
}

function uniqueRawIdSet(rawIds: readonly string[] | undefined, errorMessage: string): Set<string> {
  const unique = new Set(rawIds ?? []);
  if (unique.size !== (rawIds?.length ?? 0)) {
    throw new Error(errorMessage);
  }
  return unique;
}

function collectNativeReplacementByRawId(
  plan: NativeWorkspaceMaterializationPlan,
  completionRawIds: Set<string>
): Map<string, NativeExistingEntityReplacement> {
  const replacementByRawId = new Map(
    (plan.existingEntityReplacements ?? []).map((replacement) => [
      requiredText(replacement.entityRawId, 'Replacement entity raw ID'),
      replacement,
    ])
  );
  if (replacementByRawId.size !== (plan.existingEntityReplacements?.length ?? 0)) {
    throw new Error('Native replacement identities must be unique.');
  }
  for (const [rawId, replacement] of replacementByRawId) {
    if (
      completionRawIds.has(rawId) ||
      (replacement.kind === 'scientific' && !isSha256(replacement.expectedScientificSha256))
    ) {
      throw new Error(`Native replacement ${rawId} has invalid compare-and-set authority.`);
    }
  }
  return replacementByRawId;
}

function admitExistingNativeEntityRawIds(
  db: Database.Database,
  workspaceId: number,
  workspaceScope: string,
  plan: NativeWorkspaceMaterializationPlan,
  completionRawIds: Set<string>,
  entityIdsByRawId: Record<string, string>
): void {
  for (const rawIdentity of plan.existingEntityRawIds ?? []) {
    const rawId = requiredText(rawIdentity, 'Existing entity raw ID');
    if (completionRawIds.has(rawId)) {
      throw new Error(
        `Needs sequence completion ${rawId} cannot also be read-only existing state.`
      );
    }
    if (entityIdsByRawId[rawId]) throw new Error(`Duplicate native entity identity: ${rawId}`);
    const entityId = scopedProjectionId(workspaceScope, rawId);
    const existing = prepareCachedStatement(
      db,
      'SELECT id, workspace_id FROM catalog_entities WHERE id = ?'
    ).get(entityId) as { id: string; workspace_id: number | null } | undefined;
    if (!existing || existing.workspace_id !== workspaceId) {
      throw new Error(`Existing native entity identity is not registered: ${rawId}`);
    }
    entityIdsByRawId[rawId] = entityId;
  }
}

function admitPlannedNativeEntityRawIds(
  workspaceScope: string,
  plan: NativeWorkspaceMaterializationPlan,
  entityIdsByRawId: Record<string, string>
): void {
  for (const entity of plan.entities) {
    const rawId = requiredText(entity.rawId, 'Entity raw ID');
    if (entityIdsByRawId[rawId]) throw new Error(`Duplicate native entity identity: ${rawId}`);
    entityIdsByRawId[rawId] = scopedProjectionId(workspaceScope, rawId);
  }
}

function materializeNativeLimsEntities(
  db: Database.Database,
  args: {
    workspaceId: number;
    plan: NativeWorkspaceMaterializationPlan;
    entityIdsByRawId: Record<string, string>;
    completionDisposition: Map<string, NeedsSequenceCompletionDisposition>;
    replacementByRawId: ReadonlyMap<string, NativeExistingEntityReplacement>;
  }
): void {
  const limsEntities = args.plan.limsEntities ?? [];
  if (limsEntities.length > 0) seedLimsBuiltinsInDb(db);
  for (const limsEntity of limsEntities) {
    const entityId =
      args.entityIdsByRawId[requiredText(limsEntity.entityRawId, 'LIMS entity raw ID')];
    if (!entityId) throw new Error('Native LIMS entity references an unknown catalog entity.');
    const materializedFields = () => {
      const fields = mapPortableRecordRelationships(
        limsEntity.input.fields,
        limsEntity.input.schemaSnapshot,
        (rawId) => {
          const id = args.entityIdsByRawId[rawId];
          if (!id)
            throw new Error(`Native record relationship references an unknown entity: ${rawId}`);
          return id;
        }
      );
      return nativeFileSequenceFields({
        fields,
        kind: limsEntity.input.kind,
        documentId: entityId,
      });
    };
    const existing = prepareCachedStatement(db, 'SELECT id FROM lims_entity WHERE id = ?').get(
      entityId
    ) as { id: string } | undefined;
    if (!existing) {
      registerLimsEntityInsideTx(db, {
        ...limsEntity.input,
        fields: materializedFields(),
        id: entityId,
        workspaceId: args.workspaceId,
      });
    } else if (
      args.completionDisposition.has(limsEntity.entityRawId) ||
      args.replacementByRawId.get(limsEntity.entityRawId)?.kind === 'scientific'
    ) {
      const fields = materializedFields();
      if (limsEntity.input.schemaSnapshot?.baseKind === 'record') {
        replaceNativeCatalogRecordInsideTx(db, {
          ...limsEntity.input,
          id: entityId,
          workspaceId: args.workspaceId,
          fields,
        });
      } else
        updateLimsEntityInsideTx(db, {
          id: entityId,
          fields,
          ...(args.replacementByRawId.get(limsEntity.entityRawId)?.kind === 'scientific'
            ? { name: limsEntity.input.name }
            : {}),
          registrationStatus: limsEntity.input.registrationStatus ?? 'registered',
          actor: 'migration',
        });
    }
  }
}

export function materializeNativeWorkspaceInsideTx(
  db: Database.Database,
  input: {
    workspace: NativeWorkspaceRegistration;
    plan: NativeWorkspaceMaterializationPlan;
  }
): NativeWorkspaceMaterializationResult {
  assertInsideTransaction(db);
  if (input.plan.schema !== NATIVE_WORKSPACE_MATERIALIZATION_SCHEMA) {
    throw new Error('Native workspace materialization schema is unsupported.');
  }
  const workspaceId = registerNativeWorkspaceInsideTx(db, input.workspace);
  const workspaceScope = workspaceScopeKey(input.workspace.repoUuid, workspaceId);
  if (!workspaceScope) throw new Error('Native workspace projection scope is missing.');
  const entityIdsByRawId: Record<string, string> = {};
  const completionRawIds = uniqueRawIdSet(
    input.plan.needsSequenceCompletionRawIds,
    'Native sequence completion identities must be unique.'
  );
  const replacementByRawId = collectNativeReplacementByRawId(input.plan, completionRawIds);
  admitExistingNativeEntityRawIds(
    db,
    workspaceId,
    workspaceScope,
    input.plan,
    completionRawIds,
    entityIdsByRawId
  );
  admitPlannedNativeEntityRawIds(workspaceScope, input.plan, entityIdsByRawId);

  const completionDisposition = classifyNeedsSequenceCompletions({
    db,
    workspaceId,
    workspacePath: input.workspace.path,
    plan: input.plan,
    entityIdsByRawId,
    completionRawIds,
  });
  assertExistingReplacementPreconditions({
    db,
    workspaceId,
    entityIdsByRawId,
    replacementByRawId,
    entities: input.plan.entities,
    workspacePath: input.workspace.path,
  });
  for (const link of input.plan.removedRelationships?.catalog ?? []) {
    const sourceId = entityIdsByRawId[link.sourceRawId];
    const targetId = entityIdsByRawId[link.targetRawId];
    const replacement = replacementByRawId.get(link.sourceRawId);
    const documentOwned =
      (replacement?.kind === 'notebook_package' || replacement?.kind === 'protocol_package') &&
      link.evidence?.kind === 'migration_relationship' &&
      link.evidence.classification === 'exact' &&
      typeof link.evidence.relationshipId === 'string' &&
      !link.evidence.relationshipId.startsWith('registry:') &&
      typeof link.evidence.targetProviderStableId === 'string';
    if (
      !documentOwned &&
      (replacement?.kind !== 'scientific' || !readNativeCatalogRecordState(db, sourceId))
    )
      throw new Error(
        'Only a checked native replacement can remove its owned catalog relationships.'
      );
    const row = db
      .prepare(
        'SELECT id, evidence, confidence FROM catalog_entity_links WHERE source_entity_id = ? AND relation = ? AND target_entity_id = ?'
      )
      .get(sourceId, link.relation, targetId) as
      | { id: string; evidence: string | null; confidence: string }
      | undefined;
    if (
      !row ||
      row.confidence !== (link.confidence ?? 'confirmed') ||
      !isDeepStrictEqual(JSON.parse(row.evidence ?? 'null'), link.evidence)
    )
      throw new Error('An imported catalog relationship changed after replacement planning.');
    insertAuditEvent(db, {
      eventType: 'catalog_relationship_removed',
      subjectTable: 'catalog_entity_links',
      subjectId: row.id,
      workspaceId,
      actor: 'migration',
      before: {
        ...row,
        source_entity_id: sourceId,
        relation: link.relation,
        target_entity_id: targetId,
      },
    });
    db.prepare('DELETE FROM catalog_entity_links WHERE id = ?').run(row.id);
  }
  for (const link of input.plan.removedRelationships?.lims ?? []) {
    const sourceId = entityIdsByRawId[link.fromEntityRawId];
    const targetId = entityIdsByRawId[link.toEntityRawId];
    if (
      replacementByRawId.get(link.fromEntityRawId)?.kind !== 'scientific' ||
      !readNativeCatalogRecordState(db, sourceId)
    )
      throw new Error(
        'Only a checked native record replacement can remove its owned relationships.'
      );
    const row = db
      .prepare(
        'SELECT * FROM lims_link WHERE id = ? AND from_entity_id = ? AND to_entity_id = ? AND type = ? AND tombstone = 0'
      )
      .get(scopedProjectionId(workspaceScope, link.id), sourceId, targetId, link.type) as
      | LimsLinkRow
      | undefined;
    if (!row || !isDeepStrictEqual(JSON.parse(row.payload), link.payload ?? {}))
      throw new Error('An imported Registry relationship changed after replacement planning.');
    tombstoneLimsLinkInsideTx(db, row, {
      actor: 'migration',
      batchId: `native-record-replacement:${sourceId}`,
      reason: 'imported_relationship_replaced',
    });
  }

  for (const entity of input.plan.entities) {
    materializeEntity(db, {
      workspace: input.workspace,
      workspaceId,
      entity,
      entityId: entityIdsByRawId[entity.rawId],
      preserveExistingName: completionDisposition.has(entity.rawId),
    });
  }

  let providerBindingsMaterialized = 0;
  for (const entity of input.plan.entities) {
    const entityId = entityIdsByRawId[entity.rawId];
    for (const identity of entity.sourceIdentities ?? []) {
      upsertProviderBinding(db, {
        reference: {
          provider: identity.provider,
          stableObjectId: identity.stableObjectId,
          objectClass: identity.objectClass as ProviderObjectClass,
          canonicalUrl: identity.canonicalUrl ?? null,
          providerAccountHint: identity.providerAccountHint ?? null,
        },
        entityId,
        bindingKind: identity.bindingKind,
        evidence: {
          source: 'benchling_native_materialization',
          runId: workspaceScope,
        },
      });
      providerBindingsMaterialized += 1;
    }
  }

  for (const link of input.plan.links) {
    materializeLink(db, link, entityIdsByRawId);
  }
  for (const event of input.plan.events) {
    materializeEvent(db, event, entityIdsByRawId, workspaceScope);
  }
  materializeNativeLimsEntities(db, {
    workspaceId,
    plan: input.plan,
    entityIdsByRawId,
    completionDisposition,
    replacementByRawId,
  });
  const limsLinks = input.plan.limsLinks ?? [];
  for (const limsLink of limsLinks) {
    const fromEntityId =
      entityIdsByRawId[requiredText(limsLink.fromEntityRawId, 'LIMS link source')];
    const toEntityId = entityIdsByRawId[requiredText(limsLink.toEntityRawId, 'LIMS link target')];
    if (!fromEntityId || !toEntityId) {
      throw new Error('Native LIMS link references an unknown catalog entity.');
    }
    linkLimsEntitiesOrExistingInsideTx(db, {
      id: scopedProjectionId(workspaceScope, requiredText(limsLink.id, 'LIMS link ID')),
      fromEntityId,
      toEntityId,
      type: requiredText(limsLink.type, 'LIMS link type'),
      payload: limsLink.payload ?? {},
      actor: 'migration',
      workspaceId,
    });
  }
  const pendingReferences = input.plan.pendingReferences ?? [];
  for (const pending of pendingReferences) {
    materializePendingReferenceAudit(db, {
      workspaceScope,
      workspaceId,
      pending,
      entityIdsByRawId,
    });
  }

  return {
    workspaceId,
    entityIdsByRawId,
    entitiesMaterialized: input.plan.entities.length,
    linksMaterialized: input.plan.links.length,
    eventsMaterialized: input.plan.events.length,
    pagesMaterialized: input.plan.entities.filter((entity) => entity.page !== undefined).length,
    limsEntitiesMaterialized: (input.plan.limsEntities ?? []).length,
    limsLinksMaterialized: limsLinks.length,
    pendingReferencesMaterialized: pendingReferences.length,
    providerBindingsMaterialized,
    needsSequenceCompletionsAdopted: [...completionDisposition]
      .filter(([, disposition]) => disposition === 'adopt')
      .map(([rawId]) => rawId)
      .sort(),
    needsSequenceCompletionsCorroborated: [...completionDisposition]
      .filter(([, disposition]) => disposition === 'corroborate')
      .map(([rawId]) => rawId)
      .sort(),
  };
}

function assertExistingReplacementPreconditions(input: {
  db: Database.Database;
  workspaceId: number;
  entityIdsByRawId: Readonly<Record<string, string>>;
  replacementByRawId: ReadonlyMap<string, NativeExistingEntityReplacement>;
  entities: readonly NativeWorkspaceEntityInput[];
  workspacePath: string;
}): void {
  for (const [rawId, replacement] of input.replacementByRawId) {
    const entityId = input.entityIdsByRawId[rawId];
    if (!entityId) throw new Error(`Native replacement ${rawId} has no catalog identity.`);
    const catalog = prepareCachedStatement(
      input.db,
      "SELECT workspace_id, type, storage_type, locator, metadata FROM catalog_entities WHERE id = ? AND status = 'active'"
    ).get(entityId) as
      | {
          workspace_id: number | null;
          type: string;
          storage_type: string;
          locator: string;
          metadata: string | null;
        }
      | undefined;
    if (!catalog || catalog.workspace_id !== input.workspaceId) {
      throw new Error(`Native replacement ${rawId} is no longer active in this workspace.`);
    }
    if (replacement.kind !== 'scientific') {
      const incoming = input.entities.filter((entity) => entity.rawId === rawId);
      const entity = incoming[0];
      const placement = replacement.expectedPlacement;
      const expectedType =
        replacement.kind === 'notebook_package' ? 'notebook' : replacement.expectedType;
      const expectedFileKind =
        expectedType === 'notebook'
          ? 'waypoint-notebook'
          : expectedType === 'protocol'
            ? 'waypoint-protocol'
            : 'waypoint-protocol-run';
      const bindingRelativePath =
        expectedType === 'notebook' ? placement.rootRelativePath : placement.primaryRelativePath;
      const bindings = prepareCachedStatement(
        input.db,
        "SELECT workspace_id, path, relative_path, file_kind FROM catalog_entity_files WHERE entity_id = ? AND status = 'current'"
      ).all(entityId) as {
        workspace_id: number;
        path: string;
        relative_path: string;
        file_kind: string;
      }[];
      const binding = bindings[0];
      if (
        incoming.length !== 1 ||
        !entity ||
        entity.type !== expectedType ||
        placement.fileKind !== expectedFileKind ||
        (replacement.layout === 'native'
          ? !isDeepStrictEqual(entity.placement, placement) ||
            !isDeepStrictEqual(parseMetadata(catalog.metadata).placement, placement)
          : entity.placement !== undefined ||
            entity.relativePath !== bindingRelativePath ||
            entity.fileKind !== placement.fileKind ||
            parseMetadata(catalog.metadata).placement !== undefined) ||
        !isSafeWorkspaceRelativePath(placement.rootRelativePath) ||
        !placement.primaryRelativePath.startsWith(`${placement.rootRelativePath}/`) ||
        !isSafeWorkspaceRelativePath(placement.primaryRelativePath) ||
        catalog.type !== expectedType ||
        bindings.length !== 1 ||
        !binding ||
        binding.workspace_id !== input.workspaceId ||
        binding.relative_path !== bindingRelativePath ||
        binding.path !== resolve(input.workspacePath, bindingRelativePath) ||
        binding.file_kind !== placement.fileKind ||
        prepareCachedStatement(input.db, 'SELECT id FROM lims_entity WHERE id = ?').get(entityId)
      ) {
        throw new Error(`Native ${expectedType} replacement ${rawId} changed its package binding.`);
      }
      const page = prepareCachedStatement(input.db, 'SELECT id FROM pages WHERE id = ?').get(
        entityId
      );
      const invalidStorage =
        expectedType === 'notebook'
          ? !entity.page ||
            entity.storageType !== 'database' ||
            entity.locator.kind !== 'entity' ||
            entity.locator.namespace !== 'page' ||
            catalog.storage_type !== 'database' ||
            catalog.locator !== `entity://page/${entityId}` ||
            !page
          : entity.page !== undefined ||
            entity.storageType !== 'file' ||
            entity.locator.kind !== 'file' ||
            catalog.storage_type !== 'file' ||
            catalog.locator !== `file://${resolve(input.workspacePath, bindingRelativePath)}` ||
            page;
      if (invalidStorage) {
        throw new Error(`Native ${expectedType} replacement ${rawId} changed its storage binding.`);
      }
      continue;
    }
    const { expectedScientificSha256 } = replacement;
    const record = readNativeCatalogRecordState(input.db, entityId);
    if (record) {
      if (nativeCatalogRecordStateSha256(record) !== expectedScientificSha256)
        throw new Error(`Native replacement ${rawId} changed after the import decision.`);
      continue;
    }
    const row = prepareCachedStatement(input.db, 'SELECT * FROM lims_entity WHERE id = ?').get(
      entityId
    ) as LimsEntityRow | undefined;
    if (!row) throw new Error(`Native replacement ${rawId} has no scientific record.`);
    const existing = limsEntityFromRow(row);
    if (existing.kind !== 'dna_sequence') {
      throw new Error(`Native replacement ${rawId} has unsupported scientific record kind.`);
    }
    const sequence = existing.fields.sequence as DnaSequenceRef | undefined;
    if (!sequence || sequence.mode === 'unresolved') {
      throw new Error(`Native replacement ${rawId} has no comparable scientific content.`);
    }
    if (normalizedSequenceHash(sequence) !== expectedScientificSha256) {
      throw new Error(`Native replacement ${rawId} changed after the import decision.`);
    }
  }
}

function materializePendingReferenceAudit(
  db: Database.Database,
  input: {
    workspaceScope: string;
    workspaceId: number;
    pending: NonNullable<NativeWorkspaceMaterializationPlan['pendingReferences']>[number];
    entityIdsByRawId: Readonly<Record<string, string>>;
  }
): void {
  const pendingId = requiredText(input.pending.id, 'Pending relationship ID');
  const sourceRawId = requiredText(
    input.pending.sourceEntityRawId,
    'Pending relationship source entity'
  );
  const sourceEntityId = input.entityIdsByRawId[sourceRawId];
  if (!sourceEntityId) throw new Error('Pending relationship references an unknown source entity.');
  const sourceLimsEntity = prepareCachedStatement(
    db,
    'SELECT id FROM lims_entity WHERE id = ? AND tombstone = 0'
  ).get(sourceEntityId) as { id: string } | undefined;
  if (!sourceLimsEntity) {
    throw new Error('Pending relationship source is not a live LIMS entity.');
  }
  const candidateEntityIds = [...new Set(input.pending.candidateEntityRawIds ?? [])]
    .map((rawId) => {
      const candidate =
        input.entityIdsByRawId[requiredText(rawId, 'Pending relationship candidate')];
      if (!candidate) throw new Error('Pending relationship references an unknown candidate.');
      return candidate;
    })
    .sort();
  if (input.pending.classification === 'ambiguous' && candidateEntityIds.length < 2) {
    throw new Error('Ambiguous pending relationship requires at least two candidates.');
  }
  const relationType = requiredText(input.pending.relationType, 'Pending relationship type');
  const targetName = requiredText(input.pending.targetName, 'Pending relationship target');
  const targetKind = input.pending.targetKind
    ? requiredText(input.pending.targetKind, 'Pending relationship target kind')
    : undefined;
  const targetProviderIdentity = input.pending.targetProviderIdentity;
  if (
    targetProviderIdentity &&
    (targetProviderIdentity.provider !== 'benchling' ||
      !isExactProviderStableId(targetProviderIdentity.stableObjectId) ||
      !isProviderObjectClass(targetProviderIdentity.objectClass))
  ) {
    throw new Error('Pending relationship provider identity is invalid.');
  }
  const digest = createHash('sha256')
    .update(`${input.workspaceScope}\0${pendingId}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
  const auditId = `benchling-pending-${digest}`;
  insertAuditEvent(db, {
    id: auditId,
    idempotencyKey: `benchling-native-pending:v1:${input.workspaceScope}:${pendingId}`,
    eventType: 'import_batch_applied',
    subjectTable: 'lims_audit',
    batchId: auditId,
    workspaceId: input.workspaceId,
    actor: 'migration',
    payload: {
      sourceName: 'Benchling migration',
      sourceKind: 'mixed',
      insertedEntities: 0,
      insertedLinks: 0,
      skipped: 0,
      insertedEntityIds: [{ recordId: pendingId, entityId: sourceEntityId }],
      insertedLinkIds: [],
      skippedRecordIds: [],
      unresolvedLinks: [
        {
          recordId: pendingId,
          link: {
            label: targetName,
            ...(targetKind ? { kind: targetKind } : {}),
            ...(targetProviderIdentity ? { targetProviderIdentity } : {}),
            type: relationType,
            severity:
              input.pending.classification === 'ambiguous' ? 'ambiguous' : 'provisional_stub',
            ...(candidateEntityIds.length > 0 ? { candidateEntityIds } : {}),
            reason:
              input.pending.classification === 'ambiguous'
                ? 'More than one exact source candidate matched.'
                : 'No exact source candidate is available yet.',
          },
        },
      ],
      oracle: null,
    },
  });
}

type NeedsSequenceCompletionDisposition = 'adopt' | 'corroborate';

function classifyNeedsSequenceCompletions(input: {
  db: Database.Database;
  workspaceId: number;
  workspacePath: string;
  plan: NativeWorkspaceMaterializationPlan;
  entityIdsByRawId: Readonly<Record<string, string>>;
  completionRawIds: ReadonlySet<string>;
}): Map<string, NeedsSequenceCompletionDisposition> {
  const dispositions = new Map<string, NeedsSequenceCompletionDisposition>();
  for (const rawId of [...input.completionRawIds].sort()) {
    const entity = input.plan.entities.find((candidate) => candidate.rawId === rawId);
    const physical = entity ? nativeEntityPhysicalFacts(entity) : null;
    const primaryRelativePath = physical?.primaryRelativePath ?? null;
    const limsEntries = (input.plan.limsEntities ?? []).filter(
      (candidate) => candidate.entityRawId === rawId
    );
    const entityId = input.entityIdsByRawId[rawId];
    if (
      !entity ||
      !entityId ||
      entity.type !== 'sequence' ||
      entity.locator.kind !== 'file' ||
      entity.storageType !== 'file' ||
      primaryRelativePath === null ||
      limsEntries.length !== 1 ||
      limsEntries[0]!.input.kind !== 'dna_sequence'
    ) {
      throw new Error(`Needs sequence completion ${rawId} is not one native DNA entity.`);
    }
    const catalog = prepareCachedStatement(
      input.db,
      'SELECT workspace_id, locator FROM catalog_entities WHERE id = ?'
    ).get(entityId) as { workspace_id: number | null; locator: string } | undefined;
    const unresolvedLocator = `entity://lims/${entityId}`;
    const candidateFileLocator = `file://${resolve(input.workspacePath, primaryRelativePath)}`;
    if (
      !catalog ||
      catalog.workspace_id !== input.workspaceId ||
      (catalog.locator !== unresolvedLocator && catalog.locator !== candidateFileLocator)
    ) {
      throw new Error(`Needs sequence completion ${rawId} has no compatible catalog identity.`);
    }
    const row = prepareCachedStatement(input.db, 'SELECT * FROM lims_entity WHERE id = ?').get(
      entityId
    ) as LimsEntityRow | undefined;
    if (!row) throw new Error(`Needs sequence completion ${rawId} has no LIMS entity.`);
    const existing = limsEntityFromRow(row);
    if (existing.kind !== 'dna_sequence') {
      throw new Error(`Needs sequence completion ${rawId} has the wrong LIMS kind.`);
    }
    const candidateSequence = limsEntries[0]!.input.fields.sequence as DnaSequenceRef | undefined;
    if (candidateSequence?.mode !== 'file' || !isSha256(candidateSequence.normalizedSequenceHash)) {
      throw new Error(`Needs sequence completion ${rawId} has no file-backed DNA sequence.`);
    }
    const existingSequence = existing.fields.sequence as DnaSequenceRef | undefined;
    if (!existingSequence || existingSequence.mode === 'unresolved') {
      dispositions.set(rawId, 'adopt');
      continue;
    }
    const existingHash = normalizedSequenceHash(existingSequence);
    if (existingHash === candidateSequence.normalizedSequenceHash) {
      dispositions.set(rawId, 'corroborate');
      continue;
    }
    throw new NativeSequenceSourceVersionConflictError(
      rawId,
      existingHash,
      candidateSequence.normalizedSequenceHash
    );
  }
  return dispositions;
}

function normalizedSequenceHash(sequence: Exclude<DnaSequenceRef, { mode: 'unresolved' }>): string {
  if (sequence.mode === 'inline') {
    return `sha256:${createHash('sha256').update(sequence.bases.toUpperCase()).digest('hex')}`;
  }
  if (!isSha256(sequence.normalizedSequenceHash)) {
    throw new Error('Existing file-backed DNA sequence has no normalized sequence hash.');
  }
  return sequence.normalizedSequenceHash;
}

function isSha256(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function materializeEntity(
  db: Database.Database,
  input: {
    workspace: NativeWorkspaceRegistration;
    workspaceId: number;
    entity: NativeWorkspaceEntityInput;
    entityId: string;
    preserveExistingName?: boolean;
  }
): void {
  const { workspace, workspaceId, entity, entityId } = input;
  const physical = nativeEntityPhysicalFacts(entity);
  const relativePath = physical.bindingRelativePath;
  if (entity.locator.kind === 'file' && relativePath === null) {
    throw new Error(`File entity ${entity.rawId} requires a relative path.`);
  }
  if (entity.placement?.kind === 'catalog-record' && entity.locator.kind !== 'entity') {
    throw new Error(`Catalog entity ${entity.rawId} requires a database locator.`);
  }
  const absolutePath = relativePath === null ? null : resolve(workspace.path, relativePath);
  const locator =
    entity.locator.kind === 'file'
      ? `file://${absolutePath}`
      : `entity://${requiredText(entity.locator.namespace, 'Entity locator namespace')}/${entityId}`;
  const now = Math.max(entity.modifiedAt ?? 0, entity.page?.updatedAt ?? 0, workspace.lastOpenedAt);

  const existingById = prepareCachedStatement(
    db,
    'SELECT id, locator, name, metadata FROM catalog_entities WHERE id = ?'
  ).get(entityId) as
    | { id: string; locator: string; name: string; metadata: string | null }
    | undefined;
  const existingByLocator = prepareCachedStatement(
    db,
    'SELECT id, locator FROM catalog_entities WHERE locator = ?'
  ).get(locator) as { id: string; locator: string } | undefined;
  if (existingById && existingByLocator && existingById.id !== existingByLocator.id) {
    throw new Error(`Native entity ${entity.rawId} conflicts with an existing locator.`);
  }
  if (existingByLocator && existingByLocator.id !== entityId) {
    throw new Error(`Native entity ${entity.rawId} locator belongs to another entity.`);
  }

  if (input.preserveExistingName) {
    if (!existingById) {
      throw new Error(`Needs sequence completion ${entity.rawId} has no existing catalog entity.`);
    }
  }
  const effectiveName = input.preserveExistingName
    ? requiredText(existingById!.name, `Entity ${entity.rawId} existing name`)
    : requiredText(entity.name, `Entity ${entity.rawId} name`);
  const effectiveMetadata = input.preserveExistingName
    ? { ...parseMetadata(existingById!.metadata), ...(entity.metadata ?? {}) }
    : entity.metadata;
  const serializedMetadata = jsonOrNull({
    ...(effectiveMetadata ?? {}),
    ...(relativePath === null ? {} : { path: absolutePath, relativePath }),
    ...(physical.fileKind ? { fileKind: physical.fileKind } : {}),
    ...(entity.placement ? { placement: entity.placement } : {}),
    ...(entity.migrationSource ? { migrationSource: entity.migrationSource } : {}),
    portableId: entity.rawId,
  });

  prepareCachedStatement(
    db,
    `INSERT INTO catalog_entities
       (id, type, name, locator, storage_type, status, workspace_id, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       type = excluded.type,
       name = excluded.name,
       locator = excluded.locator,
       storage_type = excluded.storage_type,
       status = 'active',
       workspace_id = excluded.workspace_id,
       metadata = excluded.metadata,
       updated_at = excluded.updated_at`
  ).run(
    entityId,
    entity.type,
    effectiveName,
    locator,
    entity.storageType,
    workspaceId,
    serializedMetadata,
    now,
    now
  );

  const hasAuthoritativeFileBinding =
    entity.locator.kind === 'file' ||
    (entity.type === 'notebook' && physical.fileKind === 'waypoint-notebook');
  if (hasAuthoritativeFileBinding && relativePath !== null && absolutePath !== null) {
    materializeFileBinding(db, {
      workspaceId,
      entityId,
      absolutePath,
      relativePath,
      fileKind: requiredText(physical.fileKind ?? 'file', `Entity ${entity.rawId} file kind`),
      contentHash: entity.contentHash ?? null,
      sizeBytes: entity.sizeBytes ?? null,
      modifiedAt: entity.modifiedAt ?? null,
      objectUuid: entity.objectUuid,
      now,
    });
  }

  materializeWorkspacePlacement(db, {
    workspaceId,
    entityId,
    placement: entity.placement,
    now,
  });

  if (entity.page) {
    prepareCachedStatement(
      db,
      `INSERT INTO pages (id, title, content, date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         content = excluded.content,
         date = excluded.date,
         updated_at = excluded.updated_at`
    ).run(
      entityId,
      requiredText(entity.page.title, `Page ${entity.rawId} title`),
      JSON.stringify(entity.page.content),
      entity.page.date ?? null,
      requiredTimestamp(entity.page.createdAt, `Page ${entity.rawId} creation time`),
      requiredTimestamp(entity.page.updatedAt, `Page ${entity.rawId} update time`)
    );
  }
}

function nativeEntityPhysicalFacts(entity: NativeWorkspaceEntityInput): {
  bindingRelativePath: string | null;
  primaryRelativePath: string | null;
  fileKind: string | null;
} {
  if (!entity.placement) {
    const relativePath = entity.relativePath
      ? safeRelativePath(entity.relativePath, `Entity ${entity.rawId} path`)
      : null;
    return {
      bindingRelativePath: relativePath,
      primaryRelativePath: relativePath,
      fileKind: entity.fileKind ?? null,
    };
  }
  if (entity.placement.kind === 'catalog-record') {
    if (entity.relativePath !== undefined || entity.fileKind !== undefined) {
      throw new Error(`Catalog entity ${entity.rawId} cannot carry legacy file fields.`);
    }
    return { bindingRelativePath: null, primaryRelativePath: null, fileKind: null };
  }
  const bindingRelativePath = safeRelativePath(
    entity.placement.kind === 'file'
      ? entity.placement.relativePath
      : entity.type === 'notebook'
        ? entity.placement.rootRelativePath
        : entity.placement.primaryRelativePath,
    `Entity ${entity.rawId} binding path`
  );
  const primaryRelativePath = safeRelativePath(
    entity.placement.kind === 'file'
      ? entity.placement.relativePath
      : entity.placement.primaryRelativePath,
    `Entity ${entity.rawId} primary path`
  );
  if (entity.relativePath !== undefined && entity.relativePath !== bindingRelativePath) {
    throw new Error(`Entity ${entity.rawId} legacy path contradicts its v2 placement.`);
  }
  if (entity.fileKind !== undefined && entity.fileKind !== entity.placement.fileKind) {
    throw new Error(`Entity ${entity.rawId} legacy file kind contradicts its v2 placement.`);
  }
  return {
    bindingRelativePath,
    primaryRelativePath,
    fileKind: entity.placement.fileKind,
  };
}

function materializeWorkspacePlacement(
  db: Database.Database,
  input: {
    workspaceId: number;
    entityId: string;
    placement: NativeWorkspacePlacement | undefined;
    now: number;
  }
): void {
  if (input.placement?.kind !== 'catalog-record') {
    prepareCachedStatement(db, 'DELETE FROM catalog_workspace_placements WHERE entity_id = ?').run(
      input.entityId
    );
    return;
  }
  const parentRelativePath =
    input.placement.parentRelativePath === ''
      ? ''
      : safeRelativePath(input.placement.parentRelativePath, 'Catalog placement parent path');
  const displayName = requiredText(
    input.placement.displayName,
    'Catalog placement display name'
  ).normalize('NFC');
  const normalizedSiblingName = displayName.toLowerCase();
  prepareCachedStatement(
    db,
    `INSERT INTO catalog_workspace_placements
       (entity_id, workspace_id, parent_relative_path, display_name,
        normalized_sibling_name, presentation_kind, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
     ON CONFLICT(entity_id) DO UPDATE SET
       workspace_id = excluded.workspace_id,
       parent_relative_path = excluded.parent_relative_path,
       display_name = excluded.display_name,
       normalized_sibling_name = excluded.normalized_sibling_name,
       presentation_kind = excluded.presentation_kind,
       status = 'active',
       updated_at = excluded.updated_at`
  ).run(
    input.entityId,
    input.workspaceId,
    parentRelativePath,
    displayName,
    normalizedSiblingName,
    input.placement.presentationKind,
    input.now,
    input.now
  );
}

export function materializeFileBinding(
  db: Database.Database,
  input: {
    workspaceId: number;
    entityId: string;
    absolutePath: string;
    relativePath: string;
    fileKind: string;
    contentHash: string | null;
    sizeBytes: number | null;
    modifiedAt: number | null;
    objectUuid?: string;
    now: number;
  }
): void {
  const existing = prepareCachedStatement(
    db,
    'SELECT id, entity_id, object_uuid, created_at FROM catalog_entity_files WHERE path = ?'
  ).get(input.absolutePath) as
    | { id: string; entity_id: string; object_uuid: string | null; created_at: number }
    | undefined;
  if (existing && existing.entity_id !== input.entityId) {
    throw new Error(`Native file binding already belongs to another entity: ${input.relativePath}`);
  }
  prepareCachedStatement(
    db,
    `UPDATE catalog_entity_files
     SET status = 'historical', updated_at = ?
     WHERE entity_id = ? AND status = 'current' AND path <> ?`
  ).run(input.now, input.entityId, input.absolutePath);

  prepareCachedStatement(
    db,
    `INSERT INTO catalog_entity_files
       (id, entity_id, workspace_id, path, relative_path, file_kind, content_hash,
        size_bytes, modified_at, status, last_seen_at, missing_since, object_uuid,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'current', ?, NULL, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       entity_id = excluded.entity_id,
       workspace_id = excluded.workspace_id,
       relative_path = excluded.relative_path,
       file_kind = excluded.file_kind,
       sequence_fingerprint = CASE
         WHEN excluded.content_hash IS catalog_entity_files.content_hash
         THEN catalog_entity_files.sequence_fingerprint
       END,
       content_hash = excluded.content_hash,
       size_bytes = excluded.size_bytes,
       modified_at = excluded.modified_at,
       status = 'current',
       last_seen_at = excluded.last_seen_at,
       missing_since = NULL,
       updated_at = excluded.updated_at`
  ).run(
    existing?.id ?? randomUUID(),
    input.entityId,
    input.workspaceId,
    input.absolutePath,
    input.relativePath,
    input.fileKind,
    input.contentHash,
    input.sizeBytes,
    input.modifiedAt,
    input.now,
    existing?.object_uuid ?? input.objectUuid ?? randomUUID(),
    existing?.created_at ?? input.now,
    input.now
  );
}

function materializeLink(
  db: Database.Database,
  input: NativeWorkspaceEntityLinkInput,
  entityIdsByRawId: Readonly<Record<string, string>>
): void {
  const sourceId = entityIdsByRawId[requiredText(input.sourceRawId, 'Link source ID')];
  const targetId = entityIdsByRawId[requiredText(input.targetRawId, 'Link target ID')];
  if (!sourceId || !targetId) throw new Error('Native entity link references an unknown entity.');
  const relation = requiredText(input.relation, 'Entity link relation');
  const now = Date.now();
  const before = prepareCachedStatement(
    db,
    'SELECT * FROM catalog_entity_links WHERE source_entity_id=? AND relation=? AND target_entity_id=?'
  ).get(sourceId, relation, targetId) as
    | { id: string; confidence: string; evidence: string | null }
    | undefined;
  const changed =
    !before ||
    before.confidence !== (input.confidence ?? 'confirmed') ||
    !isDeepStrictEqual(JSON.parse(before.evidence ?? 'null'), input.evidence ?? null);
  const id = before?.id ?? randomUUID();
  prepareCachedStatement(
    db,
    `INSERT INTO catalog_entity_links
       (id, source_entity_id, relation, target_entity_id, confidence, evidence, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_entity_id, relation, target_entity_id) DO UPDATE SET
       confidence = excluded.confidence,
       evidence = excluded.evidence,
       updated_at = excluded.updated_at`
  ).run(
    id,
    sourceId,
    relation,
    targetId,
    input.confidence ?? 'confirmed',
    jsonOrNull(input.evidence),
    now,
    now
  );
  const record = prepareCachedStatement(
    db,
    "SELECT workspace_id FROM catalog_entities WHERE id IN (?,?) AND type='record' LIMIT 1"
  ).get(sourceId, targetId) as { workspace_id: number } | undefined;
  if (record && changed)
    insertAuditEvent(db, {
      eventType: 'catalog_relationship_projected',
      subjectTable: 'catalog_entity_links',
      subjectId: id,
      workspaceId: record.workspace_id,
      actor: 'migration',
      before,
      after: {
        id,
        source_entity_id: sourceId,
        relation,
        target_entity_id: targetId,
        confidence: input.confidence ?? 'confirmed',
        evidence: input.evidence ?? null,
      },
    });
}

function materializeEvent(
  db: Database.Database,
  input: NativeWorkspaceEntityEventInput,
  entityIdsByRawId: Readonly<Record<string, string>>,
  workspaceScope: string
): void {
  const entityId = entityIdsByRawId[requiredText(input.entityRawId, 'Event entity ID')];
  if (!entityId) throw new Error('Native catalog event references an unknown entity.');
  prepareCachedStatement(
    db,
    `INSERT INTO catalog_entity_events
       (id, entity_id, event_type, actor, summary, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       entity_id = excluded.entity_id,
       event_type = excluded.event_type,
       actor = excluded.actor,
       summary = excluded.summary,
       payload = excluded.payload`
  ).run(
    scopedProjectionId(workspaceScope, requiredText(input.id, 'Catalog event ID')),
    entityId,
    requiredText(input.eventType, 'Catalog event type'),
    input.actor ?? 'migration',
    input.summary ?? null,
    jsonOrNull(input.payload),
    requiredTimestamp(input.createdAt, 'Catalog event creation time')
  );
}

function safeRelativePath(value: string, label: string): string {
  const normalized = value.replace(/\\/g, '/');
  if (!isSafeWorkspaceRelativePath(normalized)) throw new Error(`${label} is unsafe.`);
  return normalized;
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || containsControlCharacter(normalized)) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) <= 31) return true;
  }
  return false;
}

function requiredTimestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid.`);
  return value;
}

function jsonOrNull(value: Record<string, unknown> | null | undefined): string | null {
  return value ? JSON.stringify(value) : null;
}

function parseMetadata(value: string | null): Record<string, unknown> {
  if (value === null) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    throw new Error('Existing native entity metadata is invalid.');
  }
}

function assertInsideTransaction(db: Database.Database): void {
  if (!db.inTransaction) {
    throw new Error('Native workspace materialization requires an active transaction.');
  }
}
