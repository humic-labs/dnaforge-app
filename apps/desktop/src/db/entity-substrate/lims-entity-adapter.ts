import { platform } from '../../platform';
import { entityArtifactProjectionFingerprint } from '../../shared/entity-artifact-projection';
import {
  isEntityArtifactPath,
  parseEntityArtifact,
  serializeEntityArtifact,
  ENTITY_ARTIFACT_CURRENT_SCHEMA,
  type EntityArtifact,
  type EntityArtifactV2,
} from '../../shared/entity-artifact';
import {
  registerEntityAdapter,
  type EntityProjectionState,
  type EntityReconcileContext,
  type WorkspaceEntityAdapter,
} from './adapter';

async function publishMatchingLegacySource(
  bytes: string,
  path: string,
  entityId: string,
  ctx?: EntityReconcileContext
): Promise<void> {
  if (!ctx?.mutationToken || !ctx.workspaceRoot || ctx.workspaceId == null) return;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(bytes));
  const expectedContentHash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
  await platform().lims.upgradeLegacyEntityArtifact(
    {
      workspaceRoot: ctx.workspaceRoot,
      workspaceId: ctx.workspaceId,
      path,
      entityId,
      expectedContentHash,
    },
    ctx.mutationToken
  );
}

export const limsEntityArtifactAdapter: WorkspaceEntityAdapter<EntityArtifact> = {
  kind: 'lims-entity',

  matchesPath(path) {
    return isEntityArtifactPath(path);
  },

  parse(bytes) {
    return parseEntityArtifact(bytes);
  },

  async parseSource(bytes, path, fileMtimeMs, ctx) {
    const legacy = parseEntityArtifact(bytes);
    if (legacy.schema === ENTITY_ARTIFACT_CURRENT_SCHEMA) return { document: legacy, fileMtimeMs };

    let [existing] = await platform().lims.queryEntities({
      id: legacy.id,
      includeArchived: true,
      limit: 1,
    });
    if (
      !existing &&
      (await platform().lims.repairEntityProjectionFromAudit(legacy.id, ctx?.mutationToken))
    ) {
      [existing] = await platform().lims.queryEntities({
        id: legacy.id,
        includeArchived: true,
        limit: 1,
      });
    }
    const preview = existing && (await platform().lims.getRegistryPreview({ entityId: legacy.id }));
    if (!preview || existing.kind !== legacy.kind) {
      throw new Error(
        'Legacy Registry record has no authoritative frozen schema revision. Restore its verified history or explicitly supply the reviewed definition before importing it.'
      );
    }
    const document: EntityArtifactV2 = {
      ...legacy,
      schema: ENTITY_ARTIFACT_CURRENT_SCHEMA,
      schemaRevisionId: preview.schemaSnapshot.schemaRevisionId,
      schemaSnapshot: preview.schemaSnapshot,
      archived: preview.entity.tombstone,
    };
    await publishMatchingLegacySource(bytes, path, legacy.id, ctx);
    return { document, fileMtimeMs };
  },

  serialize(doc) {
    return serializeEntityArtifact(doc);
  },

  identity(doc) {
    return doc.id;
  },

  projectionFingerprint(doc) {
    if (doc.schema !== ENTITY_ARTIFACT_CURRENT_SCHEMA) {
      throw new Error(
        'A legacy record requires its authoritative frozen schema before comparison.'
      );
    }
    return entityArtifactProjectionFingerprint(doc);
  },

  async getProjection(id, ctx): Promise<EntityProjectionState | null> {
    const [entity] = await platform().lims.queryEntities({ id, includeArchived: true, limit: 1 });
    if (!entity) return null;
    return {
      fingerprint: entityArtifactProjectionFingerprint({ ...entity, archived: entity.tombstone }),
      eventSeq: entity.eventSeq ?? undefined,
      updatedAtMs: entity.updatedAt,
      sourceBindingMatches: ctx.workspaceId === undefined || entity.workspaceId === ctx.workspaceId,
    };
  },

  async writeProjection(
    doc,
    id,
    _fileMtimeMs,
    _path,
    ctx,
    expectedProjection?: EntityProjectionState | null
  ) {
    if (ctx.workspaceId == null) {
      throw new Error('A file-authoritative Registry projection requires a project owner.');
    }
    if (doc.schema !== ENTITY_ARTIFACT_CURRENT_SCHEMA)
      throw new Error('Registry record is missing its frozen schema.');
    let [existing] = await platform().lims.queryEntities({ id, includeArchived: true, limit: 1 });
    if (
      !existing &&
      (await platform().lims.repairEntityProjectionFromAudit(id, ctx.mutationToken))
    ) {
      [existing] = await platform().lims.queryEntities({ id, includeArchived: true, limit: 1 });
    }
    if (!existing) {
      await platform().lims.registerEntity(
        {
          id,
          kind: doc.kind,
          schemaRevisionId: doc.schemaRevisionId,
          schemaSnapshot: doc.schemaSnapshot,
          name: doc.name,
          fields: doc.fields,
          registrationStatus: doc.registrationStatus,
          domainStatus: doc.domainStatus,
          workspaceId: ctx.workspaceId,
          actor: 'workspace-reconcile',
        },
        ctx.mutationToken
      );
      if (doc.archived) {
        const [created] = await platform().lims.queryEntities({
          id,
          includeArchived: true,
          limit: 1,
        });
        await platform().lims.archiveEntity(
          {
            id,
            actor: 'workspace-reconcile',
            expectedEventSeq: created.eventSeq ?? undefined,
            operationId: crypto.randomUUID(),
          },
          ctx.mutationToken
        );
      }
      return;
    }
    const updated = await platform().lims.updateEntity(
      {
        id,
        expectedEventSeq: expectedProjection?.eventSeq ?? existing.eventSeq ?? undefined,
        projectionSchema: {
          kind: doc.kind,
          schemaRevisionId: doc.schemaRevisionId,
          schemaSnapshot: doc.schemaSnapshot,
        },
        name: doc.name,
        fields: doc.fields,
        replaceFields: true,
        registrationStatus: doc.registrationStatus,
        domainStatus: doc.domainStatus,
        workspaceId: ctx.workspaceId,
        actor: 'workspace-reconcile',
      },
      ctx.mutationToken
    );
    if (updated.tombstone !== doc.archived) {
      const action = doc.archived ? platform().lims.archiveEntity : platform().lims.restoreEntity;
      await action(
        {
          id,
          actor: 'workspace-reconcile',
          expectedEventSeq: updated.eventSeq ?? undefined,
          operationId: crypto.randomUUID(),
        },
        ctx.mutationToken
      );
    }
  },

  async reconcileRelationships(doc, id, _path, ctx) {
    if (doc.schema === ENTITY_ARTIFACT_CURRENT_SCHEMA && doc.archived) return;

    if (doc.schema !== ENTITY_ARTIFACT_CURRENT_SCHEMA) {
      const [existing] = await platform().lims.queryEntities({
        id,
        includeArchived: true,
        limit: 1,
      });
      if (existing?.tombstone) return;
    }
    const outgoing = doc.relationships.map((relationship) => {
      if (relationship.fromEntityId !== id) {
        throw new Error(
          `Entity artifact ${id} cannot own an outgoing relationship from ${relationship.fromEntityId}.`
        );
      }
      return {
        toEntityId: relationship.toEntityId,
        type: relationship.type,
        payload: relationship.payload,
      };
    });
    await platform().lims.replaceOutgoingRelationships(
      {
        entityId: id,
        relationships: outgoing,
        actor: 'workspace-reconcile',
        workspaceId: ctx.workspaceId,
      },
      ctx.mutationToken
    );
  },
};

let registered = false;

export function registerLimsEntityArtifactAdapter(): void {
  if (registered) return;
  registered = true;
  registerEntityAdapter(limsEntityArtifactAdapter);
}
