import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import { classifyLimsEntityFieldIssues, type LimsFieldDefinition } from '../../shared/lims';
import {
  NATIVE_WORKSPACE_MANIFEST_V2_SCHEMA,
  type NativeWorkspaceManifest,
} from '../../shared/native-workspace-manifest';
import { mapPortableRecordRelationships } from '../../shared/portable-record-relationships';
import { scopedProjectionId, stripWorkspaceScope } from '../../shared/workspace-scoped-identity';
import type { NativeWorkspaceMaterializationPlan } from '../native-workspace-materializer';
import {
  nativeCatalogRecordStateSha256,
  readNativeCatalogRecordState,
} from '../native-catalog-record-state';
import { nativeLimsRelationshipType } from './native-materialization';

export function addNativeRegistryRelationshipRepairs(input: {
  db: Database.Database;
  workspaceId: number;
  scopeId: string;
  currentManifest: NativeWorkspaceManifest;
  plan: NativeWorkspaceMaterializationPlan;
}): void {
  if (input.currentManifest.schema !== NATIVE_WORKSPACE_MANIFEST_V2_SCHEMA) return;
  const currentById = new Map(input.currentManifest.entities.map((entity) => [entity.id, entity]));
  const plannedIds = new Set(input.plan.entities.map((entity) => entity.rawId));
  for (const candidate of input.plan.limsEntities ?? []) {
    if (
      plannedIds.has(candidate.entityRawId) ||
      candidate.input.schemaSnapshot?.baseKind !== 'record'
    )
      continue;
    const portable = currentById.get(candidate.entityRawId);
    if (
      portable?.type !== 'record' ||
      portable.placement.kind !== 'catalog-record' ||
      !portable.lims?.schemaSnapshot
    )
      continue;
    const current = readNativeCatalogRecordState(
      input.db,
      scopedProjectionId(input.scopeId, candidate.entityRawId)
    );
    if (!current || current.workspaceId !== input.workspaceId)
      throw new Error('Registry relationship source is no longer active.');
    const fields = mapPortableRecordRelationships(
      current.fields,
      current.schemaSnapshot,
      stripWorkspaceScope
    );
    let repaired = false;
    for (const field of candidate.input.schemaSnapshot.fields) {
      if (
        current.registrationStatus !== 'unresolved' ||
        field.type !== 'record_relationship' ||
        !current.schemaSnapshot.fields.some(
          (existing) => existing.key === field.key && existing.type === field.type
        ) ||
        Object.hasOwn(portable.lims.fields, field.key)
      )
        continue;
      const incoming = candidate.input.fields[field.key];
      if (incoming === undefined || incoming === null) continue;
      if (Object.hasOwn(fields, field.key) && !isDeepStrictEqual(fields[field.key], incoming))
        continue;
      fields[field.key] = structuredClone(incoming);
      repaired = true;
    }
    const hasTarget = (fieldKey: string, targetId: string) => {
      const value = fields[fieldKey];
      return (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        'destinationEntityId' in value &&
        value.destinationEntityId === targetId
      );
    };
    input.plan.links = input.plan.links.filter(
      (link) =>
        link.sourceRawId !== candidate.entityRawId ||
        link.evidence?.kind !== 'migration_relationship' ||
        typeof link.evidence.relationshipId !== 'string' ||
        !link.evidence.relationshipId.startsWith('registry:') ||
        hasTarget(link.relation, link.targetRawId)
    );
    input.plan.limsLinks = input.plan.limsLinks?.filter(
      (link) =>
        link.fromEntityRawId !== candidate.entityRawId ||
        typeof link.payload?.sourceRelationshipId !== 'string' ||
        !link.payload.sourceRelationshipId.startsWith('registry:') ||
        input.plan.links.some(
          (catalogLink) =>
            catalogLink.sourceRawId === candidate.entityRawId &&
            catalogLink.targetRawId === link.toEntityRawId &&
            nativeLimsRelationshipType(catalogLink.relation) === link.type &&
            catalogLink.evidence?.kind === 'migration_relationship'
        )
    );
    if (!repaired) continue;
    const issues = classifyLimsEntityFieldIssues(
      current.schemaSnapshot.name,
      fields,
      current.schemaSnapshot.fields as LimsFieldDefinition[]
    );
    if (issues.malformed.length)
      throw new Error(`Registry relationship repair is invalid: ${issues.malformed.join('; ')}`);
    candidate.input = {
      ...candidate.input,
      kind: current.schemaSnapshot.name,
      schemaRevisionId: current.schemaSnapshot.schemaRevisionId,
      schemaSnapshot: current.schemaSnapshot,
      name: current.name,
      fields,
      registrationStatus: issues.incomplete.length ? 'unresolved' : 'registered',
      domainStatus: current.domainStatus,
      createdAt: portable.lims.createdAt,
    };
    input.plan.entities.push({
      rawId: portable.id,
      type: 'record',
      name: current.name,
      locator: { kind: 'entity', namespace: 'lims' },
      storageType: 'database',
      placement: { ...portable.placement, displayName: current.name },
      metadata: portable.metadata,
      sourceIdentities: portable.sourceIdentities,
      migrationSource: portable.migrationSource,
    });
    input.plan.existingEntityReplacements = [
      ...(input.plan.existingEntityReplacements ?? []),
      {
        entityRawId: portable.id,
        kind: 'scientific',
        expectedScientificSha256: nativeCatalogRecordStateSha256(current),
      },
    ];
  }
}

export function planNativeRegistryRelationshipRemovals(input: {
  db: Database.Database;
  scopeId: string;
  currentManifest: NativeWorkspaceManifest;
  plan: NativeWorkspaceMaterializationPlan;
}): void {
  const replaced = new Set(
    (input.plan.existingEntityReplacements ?? []).map((entry) => entry.entityRawId)
  );
  const records = new Set(
    input.plan.entities
      .filter((entity) => entity.type === 'record' && replaced.has(entity.rawId))
      .map((entity) => entity.rawId)
  );
  const catalog: NativeWorkspaceMaterializationPlan['links'] = [];
  const documents = new Set(
    (input.plan.existingEntityReplacements ?? [])
      .filter((entry) => entry.kind === 'notebook_package' || entry.kind === 'protocol_package')
      .map((entry) => entry.entityRawId)
  );
  const lims: NonNullable<NativeWorkspaceMaterializationPlan['limsLinks']> = [];
  for (const link of input.currentManifest.links) {
    if (
      link.evidence?.kind !== 'migration_relationship' ||
      typeof link.evidence.relationshipId !== 'string' ||
      !(records.has(link.sourceId)
        ? link.evidence.relationshipId.startsWith('registry:')
        : documents.has(link.sourceId) &&
          !link.evidence.relationshipId.startsWith('registry:') &&
          link.evidence.classification === 'exact' &&
          typeof link.evidence.targetProviderStableId === 'string') ||
      input.plan.links.some(
        (next) =>
          next.sourceRawId === link.sourceId &&
          next.targetRawId === link.targetId &&
          next.relation === link.relation
      )
    )
      continue;
    const row = input.db
      .prepare(
        'SELECT evidence, confidence FROM catalog_entity_links WHERE source_entity_id = ? AND relation = ? AND target_entity_id = ?'
      )
      .get(
        scopedProjectionId(input.scopeId, link.sourceId),
        link.relation,
        scopedProjectionId(input.scopeId, link.targetId)
      ) as { evidence: string | null; confidence: string } | undefined;
    if (
      !row ||
      row.confidence !== (link.confidence ?? 'confirmed') ||
      !isDeepStrictEqual(JSON.parse(row.evidence ?? 'null'), link.evidence)
    )
      continue;
    catalog.push({
      sourceRawId: link.sourceId,
      targetRawId: link.targetId,
      relation: link.relation,
      confidence: link.confidence,
      evidence: link.evidence,
    });
  }
  for (const link of input.currentManifest.limsLinks ?? []) {
    if (
      !records.has(link.fromEntityId) ||
      typeof link.payload?.sourceRelationshipId !== 'string' ||
      !link.payload.sourceRelationshipId.startsWith('registry:') ||
      input.plan.limsLinks?.some(
        (next) =>
          next.fromEntityRawId === link.fromEntityId &&
          next.toEntityRawId === link.toEntityId &&
          next.type === link.type
      )
    )
      continue;
    const row = input.db
      .prepare(
        'SELECT payload FROM lims_link WHERE id = ? AND from_entity_id = ? AND to_entity_id = ? AND type = ? AND tombstone = 0'
      )
      .get(
        scopedProjectionId(input.scopeId, link.id),
        scopedProjectionId(input.scopeId, link.fromEntityId),
        scopedProjectionId(input.scopeId, link.toEntityId),
        link.type
      ) as { payload: string } | undefined;
    if (!row || !isDeepStrictEqual(JSON.parse(row.payload), link.payload)) continue;
    lims.push({
      id: link.id,
      fromEntityRawId: link.fromEntityId,
      toEntityRawId: link.toEntityId,
      type: link.type,
      payload: link.payload,
    });
  }
  if (catalog.length || lims.length) input.plan.removedRelationships = { catalog, lims };
}

export function withoutRemovedNativeRelationships(
  manifest: NativeWorkspaceManifest,
  removed: NativeWorkspaceManifest | undefined
): NativeWorkspaceManifest {
  if (!removed) return manifest;
  const linkKeys = new Set(
    removed.links.map((link) => JSON.stringify([link.sourceId, link.relation, link.targetId]))
  );
  const limsIds = new Set(removed.limsLinks?.map((link) => link.id));
  return {
    ...manifest,
    links: manifest.links.filter(
      (link) => !linkKeys.has(JSON.stringify([link.sourceId, link.relation, link.targetId]))
    ),
    limsLinks: manifest.limsLinks?.filter((link) => !limsIds.has(link.id)),
  };
}
