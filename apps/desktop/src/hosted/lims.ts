import { HostedCapabilityError } from './errors';
import {
  LIMS_ENTITY_KINDS,
  LIMS_BUILTIN_ENTITY_SCHEMAS,
  type LimsAuditRow,
  type LimsEntity,
  type LimsLink,
  type LimsSchemaDefinitionView,
  type LimsTelemetryInput,
} from '../shared/lims';
import type { ProjectableEntitySchemaRevisionSnapshot } from '../shared/entity-schema';
import { resolveEntityRecordFieldValues } from '../shared/entity-record';
import { createLimsEntityQuery } from '../shared/lims-entity-query';
import { createRegistryQuery } from '../shared/registry-query';
import type { PlatformBridge } from '../platform/types';

export function createHostedLims(): PlatformBridge['lims'] {
  const entities: LimsEntity[] = [];
  const links: LimsLink[] = [];
  const schemaSnapshots = new Map<string, ProjectableEntitySchemaRevisionSnapshot>();
  let eventSeq = 0;

  function requireEntity(id: string, includeArchived = false): LimsEntity {
    const entity = entities.find((row) => row.id === id && (includeArchived || !row.tombstone));
    if (!entity) throw new Error(`LIMS entity not found: ${id}`);
    return entity;
  }

  function summaryFor(entity: LimsEntity) {
    const outgoing = links.filter((link) => link.fromEntityId === entity.id && !link.tombstone);
    const incoming = links.filter((link) => link.toEntityId === entity.id && !link.tombstone);
    const representation =
      entity.kind === 'notebook'
        ? {
            kind: 'notebook' as const,
            label: 'Notebook',
            canOpen: true,
            openTarget: {
              kind: 'notebook' as const,
              entityId: entity.id,
              entityKind: entity.kind,
              label: entity.name,
              filePath:
                typeof entity.fields.packagePath === 'string'
                  ? entity.fields.packagePath
                  : undefined,
            },
          }
        : {
            kind: 'none' as const,
            label: entity.kind,
            canOpen: false,
          };
    const schemaSnapshot =
      schemaSnapshots.get(entity.schemaRevisionId) ?? hostedSchemaSnapshot(entity);
    return {
      id: entity.id,
      kind: entity.kind,
      schemaSnapshot,
      fieldValues: resolveEntityRecordFieldValues(schemaSnapshot, entity.fields),
      schemaDisplayName: schemaSnapshot.displayName,
      eventSeq: entity.eventSeq,
      name: entity.name,
      registryId: entity.registryId,
      registrationStatus: entity.registrationStatus,
      domainStatus: entity.domainStatus,
      representation,
      summary:
        typeof entity.fields.packagePath === 'string'
          ? String(entity.fields.packagePath)
          : `${entity.kind} record`,
      linkSummary: {
        outgoingCount: outgoing.length,
        incomingCount: incoming.length,
        notable: outgoing.slice(0, 3).map((link) => ({
          type: link.type,
          label: link.type,
          entityId: link.toEntityId,
        })),
      },
      searchableText: `${entity.name} ${entity.kind} ${entity.registryId ?? ''}`.trim(),
      updatedAt: entity.updatedAt,
      archived: Boolean(entity.tombstone),
    };
  }

  return {
    readPrimerArtifactRevisionState: async () => ({ state: 'not_enrolled' }),
    revisePrimerArtifact: async () => {
      throw new HostedCapabilityError('lims.revisePrimerArtifact');
    },
    resumePrimerArtifactPublication: async () => {
      throw new HostedCapabilityError('lims.resumePrimerArtifactPublication');
    },
    reviewClassification: async () => ({ status: 'unavailable', reason: 'desktop_required' }),
    applyClassification: async () => {
      throw new HostedCapabilityError('lims.applyClassification');
    },
    ensureSeeded: async () => undefined,
    defineSchema: async () => {
      throw new HostedCapabilityError('lims.defineSchema');
    },
    refineSchema: async () => {
      throw new HostedCapabilityError('lims.refineSchema');
    },
    registerEntity: async (input) => {
      const existing = entities.find((row) => row.id === (input.id ?? ''));
      if (existing) return existing;
      const now = input.createdAt ?? Date.now();
      if (input.schemaSnapshot) {
        schemaSnapshots.set(input.schemaSnapshot.schemaRevisionId, input.schemaSnapshot);
      }
      const entity: LimsEntity = {
        id: input.id ?? crypto.randomUUID(),
        kind: input.kind,
        schemaId: input.schemaSnapshot?.schemaId ?? null,
        schemaRevisionId:
          input.schemaRevisionId ??
          input.schemaSnapshot?.schemaRevisionId ??
          builtinSchemaView(input.kind)?.currentRevisionId ??
          `schema-entity-${input.kind}-v1`,
        name: input.name,
        registryId: null,
        fields: { ...input.fields },
        registrationStatus: input.registrationStatus ?? 'registered',
        domainStatus: input.domainStatus ?? null,
        workspaceId: input.workspaceId ?? null,
        actor: input.actor ?? 'hosted-user',
        eventSeq: ++eventSeq,
        tombstone: false,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      };
      entities.push(entity);
      return entity;
    },
    upgradeLegacyEntityArtifact: async () => ({ published: false }),
    repairEntityProjectionFromAudit: async (entityId) =>
      entities.some((entity) => entity.id === entityId),
    reconstructLegacyAcceptedPlasmid: async () => {
      throw new HostedCapabilityError('lims.reconstructLegacyAcceptedPlasmid');
    },
    updateEntity: async (input) => {
      const entity = requireEntity(input.id, true);
      if (input.name !== undefined) entity.name = input.name;
      if (input.fields) {
        entity.fields = input.replaceFields
          ? { ...input.fields }
          : { ...entity.fields, ...input.fields };
      }
      if (input.registrationStatus) entity.registrationStatus = input.registrationStatus;
      if (input.domainStatus !== undefined) entity.domainStatus = input.domainStatus;
      if (input.workspaceId !== undefined) entity.workspaceId = input.workspaceId;
      entity.eventSeq = ++eventSeq;
      entity.updatedAt = Date.now();
      return entity;
    },
    revertEntity: async (input) => {
      const entity = requireEntity(input.id, true);
      return { reverted: false, entity, reason: 'no-prior-edit' };
    },
    archiveEntity: async (input) => {
      const entity = requireEntity(input.id);
      entity.tombstone = true;
      entity.archivedAt = Date.now();
      entity.updatedAt = entity.archivedAt;
      entity.eventSeq = ++eventSeq;
      return entity;
    },
    restoreEntity: async (input) => {
      const entity = requireEntity(input.id, true);
      entity.tombstone = false;
      entity.archivedAt = null;
      entity.updatedAt = Date.now();
      entity.eventSeq = ++eventSeq;
      return entity;
    },
    getEntityHistory: async (input) => {
      const entity = entities.find((row) => row.id === input.entityId);
      if (!entity) return [];
      return [
        {
          eventSeq: entity.eventSeq ?? 1,
          eventType: 'entity_registered' as const,
          label: 'Registered',
          actor: entity.actor,
          at: entity.createdAt,
          changes: [{ field: 'name', label: 'Name', kind: 'added' as const, after: entity.name }],
        },
      ];
    },
    linkEntities: async (input) => {
      const link: LimsLink = {
        id: crypto.randomUUID(),
        fromEntityId: input.fromEntityId,
        toEntityId: input.toEntityId,
        type: input.type,
        payload: input.payload ?? {},
        workspaceId: input.workspaceId ?? null,
        actor: input.actor ?? 'hosted-user',
        eventSeq: ++eventSeq,
        tombstone: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        archivedAt: null,
      };
      links.push(link);
      return link;
    },
    replaceOutgoingRelationships: async (input) => {
      let tombstoned = 0;
      const desired = new Set(
        input.relationships.map(
          (relationship) => `${relationship.type}\u0000${relationship.toEntityId}`
        )
      );
      for (const link of links) {
        if (
          link.fromEntityId === input.entityId &&
          !link.tombstone &&
          !desired.has(`${link.type}\u0000${link.toEntityId}`)
        ) {
          link.tombstone = true;
          link.archivedAt = Date.now();
          tombstoned += 1;
        }
      }
      const active = [];
      for (const relationship of input.relationships) {
        const existing = links.find(
          (link) =>
            link.fromEntityId === input.entityId &&
            link.toEntityId === relationship.toEntityId &&
            link.type === relationship.type
        );
        if (existing) {
          existing.payload = relationship.payload ?? {};
          existing.tombstone = false;
          existing.archivedAt = null;
          existing.updatedAt = Date.now();
          active.push(existing);
          continue;
        }
        active.push(
          await (async () => {
            const created: LimsLink = {
              id: crypto.randomUUID(),
              fromEntityId: input.entityId,
              toEntityId: relationship.toEntityId,
              type: relationship.type,
              payload: relationship.payload ?? {},
              workspaceId: input.workspaceId ?? null,
              actor: input.actor ?? 'hosted-user',
              eventSeq: ++eventSeq,
              tombstone: false,
              createdAt: Date.now(),
              updatedAt: Date.now(),
              archivedAt: null,
            };
            links.push(created);
            return created;
          })()
        );
      }
      return { active, tombstoned };
    },
    queryEntities: async (input = {}) => createLimsEntityQuery(input).selectProjectedRows(entities),
    countEntitiesByKind: async () => {
      const counts = new Map<string, number>(LIMS_ENTITY_KINDS.map((kind) => [kind, 0]));
      for (const entity of entities) {
        if (!entity.tombstone) {
          counts.set(entity.kind, (counts.get(entity.kind) ?? 0) + 1);
        }
      }
      return Object.fromEntries(counts);
    },
    applyImportBatch: async () => {
      throw new HostedCapabilityError('lims.applyImportBatch');
    },
    undoImportBatch: async (input) => ({
      batchId: input.batchId,
      tombstonedEntities: 0,
      tombstonedLinks: 0,
      skippedEntities: 0,
      skippedLinks: 0,
    }),
    pendingRefs: async () => [],
    confirmPendingRef: async () => {
      throw new HostedCapabilityError('lims.confirmPendingRef');
    },
    rejectPendingRefCandidate: async () => {
      throw new HostedCapabilityError('lims.rejectPendingRefCandidate');
    },
    dismissPendingRef: async () => undefined,
    restorePendingRef: async () => undefined,
    getRegistrationBadgeCandidates: async () => [],
    getAllPrimers: async () => [],
    queryRegistrySummaries: async (input = {}) => {
      const {
        entities: selected,
        totalCount,
        limit,
        offset,
      } = createRegistryQuery(input)(entities);
      return {
        summaries: selected.map((entity) => summaryFor(entity)),
        totalCount,
        limit,
        offset,
      };
    },
    getRegistryPreview: async (input) => {
      const entity = requireEntity(input.entityId, true);
      const summary = summaryFor(entity);
      return {
        entity,
        summary,
        schemaSnapshot: summary.schemaSnapshot,
        outgoingLinks: links
          .filter((link) => link.fromEntityId === entity.id && !link.tombstone)
          .map((link) => {
            const target = entities.find((row) => row.id === link.toEntityId);
            return {
              link,
              entity: {
                id: target?.id ?? link.toEntityId,
                kind: target?.kind ?? 'unknown',
                name: target?.name ?? link.toEntityId,
                registrationStatus: target?.registrationStatus ?? 'registered',
                domainStatus: target?.domainStatus ?? null,
              },
              summary: target ? summaryFor(target) : summary,
            };
          }),
        incomingLinks: [],
      };
    },
    queryRecordRelationshipTargets: async () => ({ targets: [], hasMore: false }),
    getIdSchemes: async () => [],
    listSchemas: async () =>
      LIMS_BUILTIN_ENTITY_SCHEMAS.map((schema) => builtinSchemaView(schema.name)!).sort((a, b) =>
        a.entityKind.localeCompare(b.entityKind)
      ),
    setIdScheme: async (input) => ({
      kind: input.kind,
      prefix: input.prefix ?? '',
      padWidth: input.padWidth ?? 6,
      nextSeq: 1,
      enabled: input.enabled ?? true,
      updatedAt: Date.now(),
    }),
    backfillRegistryIds: async () => ({ assigned: 0, byKind: {} }),
    getStrainGenomeSummaries: async () => ({ summaries: {} }),
    seedDemoDataset: async () => {
      throw new HostedCapabilityError('lims.seedDemoDataset');
    },
    seedMockDemo: async () => {
      throw new HostedCapabilityError('lims.seedMockDemo');
    },
    seedPracticeDemo: async () => {
      throw new HostedCapabilityError('lims.seedPracticeDemo');
    },
    seedStarterRegistry: async () => {
      throw new HostedCapabilityError('lims.seedStarterRegistry');
    },
    resetRegistry: async () => {
      entities.splice(0, entities.length);
      links.splice(0, links.length);
      return { cleared: true as const, entityCount: 0 as const };
    },
    recordStrainParentGenome: async () => {
      throw new HostedCapabilityError('lims.recordStrainParentGenome');
    },
    attachGenomeHypothesis: async () => {
      throw new HostedCapabilityError('lims.attachGenomeHypothesis');
    },
    attachVerifiedGenome: async () => {
      throw new HostedCapabilityError('lims.attachVerifiedGenome');
    },
    getStrainGenomeSummary: async () => {
      throw new HostedCapabilityError('lims.getStrainGenomeSummary');
    },
    logTelemetry: async (input) => hostedTelemetryRow(input),
  };
}

function builtinSchemaView(kind: string): LimsSchemaDefinitionView | null {
  const schema = LIMS_BUILTIN_ENTITY_SCHEMAS.find((candidate) => candidate.name === kind);
  if (!schema) return null;
  const schemaId = `schema-entity-${schema.name.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  const version = schema.version ?? 1;
  return {
    schemaId,
    currentRevisionId: `${schemaId}-v${version}`,
    entityKind: schema.name,
    baseKind: schema.baseKind ?? schema.name,
    displayName: schema.displayName,
    description: schema.description,
    version,
    builtin: true,
    fields: schema.fields.map((field) => ({ ...field })),
  };
}

function hostedSchemaSnapshot(entity: LimsEntity): ProjectableEntitySchemaRevisionSnapshot {
  const builtin = LIMS_BUILTIN_ENTITY_SCHEMAS.find((schema) => schema.name === entity.kind);
  return {
    schemaId: entity.schemaId ?? `schema-entity-${entity.kind}`,
    schemaRevisionId: entity.schemaRevisionId,
    name: entity.kind,
    displayName: builtin?.displayName ?? entity.kind,
    description: builtin?.description,
    baseKind: builtin?.baseKind ?? entity.kind,
    version: builtin?.version ?? 1,
    fields: (
      builtin?.fields ??
      Object.keys(entity.fields).map((key) => ({ key, label: key, type: 'text' as const }))
    ).map((field) => ({ ...field })),
  };
}

function hostedTelemetryRow(input: LimsTelemetryInput): LimsAuditRow {
  return {
    id: crypto.randomUUID(),
    event_seq: 0,
    schema_version: null,
    idempotency_key: null,
    operation_id: null,
    event_type: input.eventType,
    subject_table: input.subjectTable ?? null,
    subject_id: input.subjectId ?? null,
    batch_id: null,
    actor: input.actor ?? null,
    actor_client_id: null,
    actor_user_id: null,
    workspace_id: input.workspaceId ?? null,
    before: null,
    after: null,
    payload: input.payload ? JSON.stringify(input.payload) : null,
    prev_hash: null,
    hash: null,
    tombstone: 0,
    created_at: Date.now(),
  };
}
