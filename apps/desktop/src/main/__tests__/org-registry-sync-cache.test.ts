import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureSchema } from '../schema';
import {
  applyOrgRegistryEventPage,
  acknowledgeOrgRegistryMutation,
  invalidateOrgRegistryAccess,
  readOrgRegistryMutationReceipt,
  orgRegistryMutationFingerprint,
  enqueueOrgRegistryMutation,
  listOrgRegistryCachedOrganizationIds,
  markOrgRegistryMutationConflict,
  readOrgRegistryCache,
  readOrgRegistryRecordDetails,
  readOrgRegistrySyncDetails,
  readPendingOrgRegistryMutations,
  replaceOrgRegistrySnapshot,
  resolveOrgRegistryConflict,
  revokeOrgRegistryCache,
} from '../org-registry-sync-cache';
import { createTestDb } from './test-db';

const ORG = '20000000-0000-4000-8000-000000000001';
const ACCOUNT = '10000000-0000-4000-8000-000000000001';
const ENTITY = '30000000-0000-4000-8000-000000000001';
const PLACEMENT = '40000000-0000-4000-8000-000000000001';

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
  ensureSchema(db, ':memory:');
});

afterEach(() => db?.close());

describe('organization Registry SQLite cache and outbox', () => {
  it('creates account-scoped cache, cursor, outbox, and conflict tables', () => {
    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'org_registry_sync_state',
        'org_registry_cache',
        'org_registry_outbox',
        'org_registry_conflicts',
      ])
    );
  });

  it('replaces a bootstrap snapshot atomically and preserves multi-project placements', () => {
    replaceOrgRegistrySnapshot(db, {
      accessGeneration: 'scope-1',
      orgId: ORG,
      accountId: ACCOUNT,
      cursor: 7,
      snapshot: {
        idSchemes: [{ entityKind: '*', prefix: 'REG', padWidth: 6, nextValue: 2 }],
        schemas: [{ id: 'schema-1', name: 'strain' }],
        schemaRevisions: [],
        entities: [{ id: ENTITY, registryId: 'REG-000001', name: 'MG1655', revision: 1 }],
        entityRevisions: [],
        relationships: [],
        placements: [
          { id: PLACEMENT, entityId: ENTITY, workspaceId: 'workspace-1', path: 'samples/a' },
          { id: 'placement-2', entityId: ENTITY, workspaceId: 'workspace-2', path: 'samples/a' },
        ],
      },
      now: 100,
    });

    const cache = readOrgRegistryCache(db, { orgId: ORG, accountId: ACCOUNT });
    expect(cache.state).toMatchObject({ cursor: 7, status: 'ready' });
    expect(cache.entities).toHaveLength(1);
    expect(cache.placements).toHaveLength(2);
  });

  it('enqueues exact-once mutation identities and rejects changed replays', () => {
    const input = {
      orgId: ORG,
      accountId: ACCOUNT,
      clientId: 'desktop:test-device',
      mutationId: '50000000-0000-4000-8000-000000000001',
      operation: 'entity.update' as const,
      payload: { id: ENTITY, expectedRevision: 1, name: 'Updated' },
      now: 200,
    };
    expect(enqueueOrgRegistryMutation(db, input)).toMatchObject({ status: 'pending' });
    expect(enqueueOrgRegistryMutation(db, input)).toMatchObject({ status: 'pending' });
    expect(() =>
      enqueueOrgRegistryMutation(db, { ...input, payload: { ...input.payload, name: 'Different' } })
    ).toThrow(/mutation id/i);
    expect(() =>
      enqueueOrgRegistryMutation(db, {
        ...input,
        orgId: '20000000-0000-4000-8000-000000000002',
      })
    ).toThrow(/mutation id/i);
    expect(readPendingOrgRegistryMutations(db, { orgId: ORG, accountId: ACCOUNT })).toHaveLength(1);
  });

  it('applies ordered events and removes a placement tombstone', () => {
    replaceOrgRegistrySnapshot(db, {
      accessGeneration: 'scope-1',
      orgId: ORG,
      accountId: ACCOUNT,
      cursor: 7,
      snapshot: {
        idSchemes: [],
        schemas: [],
        schemaRevisions: [],
        entities: [{ id: ENTITY, registryId: 'REG-000001', name: 'Before', revision: 1 }],
        entityRevisions: [],
        relationships: [],
        placements: [{ id: PLACEMENT, entityId: ENTITY, workspaceId: 'workspace-1' }],
      },
      now: 100,
    });

    applyOrgRegistryEventPage(db, {
      accessGeneration: 'scope-1',
      orgId: ORG,
      accountId: ACCOUNT,
      nextCursor: 9,
      now: 300,
      events: [
        {
          eventSeq: 8,
          eventType: 'entity.updated',
          payload: {
            entity: { id: ENTITY, registryId: 'REG-000001', name: 'After', revision: 2 },
            entityRevision: {
              entityId: ENTITY,
              revision: 2,
              eventSeq: 8,
              snapshot: { id: ENTITY, registryId: 'REG-000001', name: 'After', revision: 2 },
            },
          },
        },
        {
          eventSeq: 9,
          eventType: 'placement.removed',
          payload: { placement: { id: PLACEMENT, entityId: ENTITY, removedAt: 'now' } },
        },
      ],
    });

    const cache = readOrgRegistryCache(db, { orgId: ORG, accountId: ACCOUNT });
    expect(cache.state.cursor).toBe(9);
    expect(cache.entities[0]).toMatchObject({ name: 'After', revision: 2 });
    expect(cache.entityRevisions).toEqual([
      expect.objectContaining({ entityId: ENTITY, revision: 2, eventSeq: 8 }),
    ]);
    expect(cache.placements).toEqual([]);
  });

  it('replays schema definitions and their immutable revision history together', () => {
    replaceOrgRegistrySnapshot(db, {
      accessGeneration: 'scope-1',
      orgId: ORG,
      accountId: ACCOUNT,
      cursor: 2,
      snapshot: {
        idSchemes: [],
        schemas: [],
        schemaRevisions: [],
        entities: [],
        entityRevisions: [],
        relationships: [],
        placements: [],
      },
      now: 100,
    });

    applyOrgRegistryEventPage(db, {
      accessGeneration: 'scope-1',
      orgId: ORG,
      accountId: ACCOUNT,
      nextCursor: 3,
      now: 200,
      events: [
        {
          eventSeq: 3,
          eventType: 'schema.created',
          payload: {
            schema: {
              id: 'schema-1',
              name: 'strain',
              currentRevisionId: 'schema-revision-1',
              version: 1,
            },
            schemaRevision: {
              id: 'schema-revision-1',
              schemaId: 'schema-1',
              version: 1,
              fields: [],
            },
          },
        },
      ],
    });

    const cache = readOrgRegistryCache(db, { orgId: ORG, accountId: ACCOUNT });
    expect(cache.schemas).toEqual([expect.objectContaining({ id: 'schema-1', version: 1 })]);
    expect(cache.schemaRevisions).toEqual([
      expect.objectContaining({ id: 'schema-revision-1', schemaId: 'schema-1', version: 1 }),
    ]);
  });

  it('rejects an unknown event without advancing the durable cursor', () => {
    replaceOrgRegistrySnapshot(db, {
      accessGeneration: 'scope-1',
      orgId: ORG,
      accountId: ACCOUNT,
      cursor: 4,
      snapshot: {
        idSchemes: [],
        schemas: [],
        schemaRevisions: [],
        entities: [],
        entityRevisions: [],
        relationships: [],
        placements: [],
      },
      now: 100,
    });

    expect(() =>
      applyOrgRegistryEventPage(db, {
        accessGeneration: 'scope-1',
        orgId: ORG,
        accountId: ACCOUNT,
        nextCursor: 5,
        now: 200,
        events: [{ eventSeq: 5, eventType: 'future.unsupported', payload: {} }],
      })
    ).toThrow('Unsupported Registry event type');
    expect(readOrgRegistryCache(db, { orgId: ORG, accountId: ACCOUNT }).state.cursor).toBe(4);
  });

  it('hides revoked organization data without destroying durable conflict intent', () => {
    const mutation = enqueueOrgRegistryMutation(db, {
      orgId: ORG,
      accountId: ACCOUNT,
      clientId: 'desktop:test-device',
      mutationId: '50000000-0000-4000-8000-000000000001',
      operation: 'entity.update',
      payload: { id: ENTITY, expectedRevision: 1, name: 'Updated' },
      now: 200,
    });
    markOrgRegistryMutationConflict(db, {
      mutationId: mutation.mutationId,
      code: 'REGISTRY_CONFLICT',
      message: 'Revision changed.',
      details: { expectedRevision: 1 },
      now: 300,
    });
    expect(listOrgRegistryCachedOrganizationIds(db, { accountId: ACCOUNT })).toEqual([ORG]);
    expect(
      db
        .prepare(`SELECT status FROM org_registry_outbox WHERE mutation_id = ?`)
        .get(mutation.mutationId)
    ).toEqual({ status: 'conflict' });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM org_registry_conflicts`).get()).toEqual({
      count: 1,
    });

    revokeOrgRegistryCache(db, { orgId: ORG, accountId: ACCOUNT, now: 400 });
    expect(readOrgRegistryCache(db, { orgId: ORG, accountId: ACCOUNT })).toMatchObject({
      state: { status: 'access_revoked' },
      entities: [],
      placements: [],
    });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM org_registry_outbox`).get()).toEqual({
      count: 1,
    });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM org_registry_conflicts`).get()).toEqual({
      count: 1,
    });
    expect(listOrgRegistryCachedOrganizationIds(db, { accountId: ACCOUNT })).toEqual([]);
    expect(readOrgRegistrySyncDetails(db, { orgId: ORG, accountId: ACCOUNT })).toEqual({
      mutations: [],
      conflicts: [],
    });
    expect(readOrgRegistrySyncDetails(db, { orgId: ORG, accountId: 'another-account' })).toEqual({
      mutations: [],
      conflicts: [],
    });
  });

  it('exposes pending/conflict state and requires an explicit conflict outcome', () => {
    const original = enqueueOrgRegistryMutation(db, {
      orgId: ORG,
      accountId: ACCOUNT,
      clientId: 'desktop:test-device',
      mutationId: '50000000-0000-4000-8000-000000000001',
      operation: 'entity.update',
      payload: { id: ENTITY, expectedRevision: 1, name: 'Offline edit' },
      now: 200,
    });
    markOrgRegistryMutationConflict(db, {
      mutationId: original.mutationId,
      code: 'CONFLICT',
      message: 'Revision changed.',
      details: { currentRevision: 2 },
      now: 300,
    });

    expect(readOrgRegistrySyncDetails(db, { orgId: ORG, accountId: ACCOUNT })).toMatchObject({
      mutations: [
        {
          mutationId: original.mutationId,
          status: 'conflict',
          errorCode: 'CONFLICT',
        },
      ],
      conflicts: [
        {
          mutationId: original.mutationId,
          localPayload: { id: ENTITY, expectedRevision: 1, name: 'Offline edit' },
          details: { currentRevision: 2 },
          status: 'open',
        },
      ],
    });

    const conflict = readOrgRegistrySyncDetails(db, {
      orgId: ORG,
      accountId: ACCOUNT,
    }).conflicts[0];
    resolveOrgRegistryConflict(db, {
      orgId: ORG,
      accountId: ACCOUNT,
      conflictId: conflict.id,
      resolution: 'retry_against_latest',
      replacementMutationId: '50000000-0000-4000-8000-000000000002',
      replacementPayload: { id: ENTITY, expectedRevision: 2, name: 'Offline edit' },
      now: 400,
    });

    const resolved = readOrgRegistrySyncDetails(db, { orgId: ORG, accountId: ACCOUNT });
    expect(resolved.conflicts).toEqual([]);
    expect(resolved.mutations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ mutationId: original.mutationId, status: 'failed' }),
        expect.objectContaining({
          mutationId: '50000000-0000-4000-8000-000000000002',
          status: 'pending',
          payload: { id: ENTITY, expectedRevision: 2, name: 'Offline edit' },
        }),
      ])
    );
  });
});

describe('scoped Registry access and durable mutation receipts', () => {
  const context = { orgId: ORG, accountId: ACCOUNT, clientId: 'desktop:scope' };
  const snapshot = {
    idSchemes: [],
    schemas: [],
    schemaRevisions: [],
    entityRevisions: [],
    relationships: [],
    placements: [],
    entities: [{ id: ENTITY, name: 'Existing' }],
  };

  it('advances identity-free scoped checkpoints and preserves queued work across access reset', () => {
    replaceOrgRegistrySnapshot(db, {
      ...context,
      accessGeneration: 'home-v1:first',
      cursor: 1,
      snapshot,
      now: 1,
    });
    const mutation = {
      ...context,
      mutationId: '50000000-0000-4000-8000-000000000099',
      operation: 'entity.update' as const,
      payload: { id: ENTITY, expectedRevision: 1, name: 'Offline' },
      now: 2,
    };
    enqueueOrgRegistryMutation(db, mutation);
    applyOrgRegistryEventPage(db, {
      ...context,
      accessGeneration: 'home-v1:first',
      nextCursor: 2,
      events: [{ eventSeq: 2, eventType: 'scope.filtered', payload: {} }],
      now: 3,
    });
    expect(readOrgRegistryCache(db, context)).toMatchObject({
      state: { cursor: 2, accessGeneration: 'home-v1:first' },
      entities: snapshot.entities,
    });
    expect(() =>
      applyOrgRegistryEventPage(db, {
        ...context,
        accessGeneration: 'home-v1:other',
        nextCursor: 3,
        events: [{ eventSeq: 3, eventType: 'scope.filtered', payload: {} }],
        now: 4,
      })
    ).toThrow(/generation/i);
    expect(() =>
      applyOrgRegistryEventPage(db, {
        ...context,
        accessGeneration: 'home-v1:first',
        nextCursor: 3,
        events: [{ eventSeq: 3, eventType: 'scope.filtered', payload: { entityId: ENTITY } }],
        now: 4,
      })
    ).toThrow(/filtered/i);
    expect(readOrgRegistryCache(db, context).state.cursor).toBe(2);
    invalidateOrgRegistryAccess(db, { ...context, now: 5 });
    expect(readOrgRegistryCache(db, context)).toMatchObject({
      state: { cursor: 0, accessGeneration: null },
      entities: [],
    });
    expect(readPendingOrgRegistryMutations(db, context)).toMatchObject([
      { mutationId: mutation.mutationId, payload: mutation.payload },
    ]);
    replaceOrgRegistrySnapshot(db, {
      ...context,
      accessGeneration: 'home-v1:second',
      cursor: 2,
      snapshot: { ...snapshot, entities: [{ id: ENTITY, name: 'Newly granted existing record' }] },
      now: 6,
    });
    expect(readOrgRegistryCache(db, context).entities).toEqual([
      { id: ENTITY, name: 'Newly granted existing record' },
    ]);
  });

  it('keeps an exact durable mutation receipt after outbox removal and fences changed retries', () => {
    replaceOrgRegistrySnapshot(db, {
      ...context,
      accessGeneration: 'home-v1:first',
      cursor: 1,
      snapshot,
      now: 1,
    });
    const mutation = {
      ...context,
      mutationId: '50000000-0000-4000-8000-000000000098',
      operation: 'entity.create' as const,
      payload: {
        id: ENTITY,
        homeWorkspaceId: '60000000-0000-4000-8000-000000000001',
        name: 'Claimed',
      },
      now: 2,
    };
    enqueueOrgRegistryMutation(db, mutation);
    const receipt = {
      status: 'applied' as const,
      eventSeq: 2,
      accessGeneration: 'home-v1:first',
      mutationId: mutation.mutationId,
      entityId: ENTITY,
      homeWorkspaceId: mutation.payload.homeWorkspaceId,
      entity: { ...mutation.payload },
    };
    expect(() =>
      acknowledgeOrgRegistryMutation(db, {
        ...context,
        mutationId: mutation.mutationId,
        receipt: { ...receipt, entityId: 'another-record' },
        now: 3,
      })
    ).toThrow(/identity|receipt/i);
    expect(readPendingOrgRegistryMutations(db, context)).toHaveLength(1);
    db.exec(
      `CREATE TEMP TRIGGER reject_outbox_delete BEFORE DELETE ON org_registry_outbox BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END`
    );
    expect(() =>
      acknowledgeOrgRegistryMutation(db, {
        ...context,
        mutationId: mutation.mutationId,
        receipt,
        now: 3,
      })
    ).toThrow('simulated storage failure');
    expect(
      readOrgRegistryMutationReceipt(db, { ...context, mutationId: mutation.mutationId })
    ).toBeNull();
    expect(readPendingOrgRegistryMutations(db, context)).toHaveLength(1);
    db.exec('DROP TRIGGER reject_outbox_delete');
    acknowledgeOrgRegistryMutation(db, {
      ...context,
      mutationId: mutation.mutationId,
      receipt,
      now: 3,
    });
    expect(readPendingOrgRegistryMutations(db, context)).toEqual([]);
    expect(
      readOrgRegistryMutationReceipt(db, { ...context, mutationId: mutation.mutationId })
    ).toMatchObject({
      ...context,
      ...receipt,
      operation: mutation.operation,
      requestFingerprint: orgRegistryMutationFingerprint(mutation.operation, mutation.payload),
    });
    expect(
      readOrgRegistryMutationReceipt(db, {
        ...context,
        accountId: 'other-account',
        mutationId: mutation.mutationId,
      })
    ).toBeNull();
    enqueueOrgRegistryMutation(db, mutation);
    expect(readPendingOrgRegistryMutations(db, context)).toEqual([]);
    expect(() =>
      enqueueOrgRegistryMutation(db, {
        ...mutation,
        payload: { ...mutation.payload, name: 'Changed' },
      })
    ).toThrow(/mutation id/i);
  });
  it('correlates relationship receipts to entityId rather than a nonexistent record id', () => {
    replaceOrgRegistrySnapshot(db, {
      ...context,
      accessGeneration: 'home-v1:first',
      cursor: 1,
      snapshot,
      now: 1,
    });
    const mutation = {
      ...context,
      mutationId: '50000000-0000-4000-8000-000000000097',
      operation: 'relationships.replace' as const,
      payload: { entityId: ENTITY, expectedRevision: 1, relationships: [] },
      now: 2,
    };
    enqueueOrgRegistryMutation(db, mutation);
    const receipt = {
      status: 'applied' as const,
      eventSeq: 2,
      accessGeneration: 'home-v1:first',
      mutationId: mutation.mutationId,
      entityId: ENTITY,
      homeWorkspaceId: 'home',
      entity: { id: ENTITY, homeWorkspaceId: 'home' },
    };
    acknowledgeOrgRegistryMutation(db, {
      ...context,
      mutationId: mutation.mutationId,
      receipt,
      now: 3,
    });
    expect(
      readOrgRegistryMutationReceipt(db, { ...context, mutationId: mutation.mutationId })
    ).toMatchObject({ entityId: ENTITY, operation: 'relationships.replace' });
    expect(readPendingOrgRegistryMutations(db, context)).toEqual([]);
  });
});

describe('organization Registry scoped record details', () => {
  const schemaId = '60000000-0000-4000-8000-000000000001';
  const pinnedId = '70000000-0000-4000-8000-000000000001';
  const newerId = '70000000-0000-4000-8000-000000000002';
  const homeId = '80000000-0000-4000-8000-000000000001';
  const otherId = '30000000-0000-4000-8000-000000000002';
  const hiddenId = '30000000-0000-4000-8000-000000000003';
  const read = () =>
    readOrgRegistryRecordDetails(db, {
      orgId: ORG,
      accountId: ACCOUNT,
      entityId: ENTITY,
      expectedAccessGeneration: 'scope-details',
    });
  function seedDetails() {
    const entity = {
      id: ENTITY,
      orgId: ORG,
      homeWorkspaceId: homeId,
      schemaId,
      schemaRevisionId: pinnedId,
      name: 'Canonical organization name',
      kind: 'strain',
      registryId: 'ORG0001',
      revision: 4,
      archivedAt: null,
      fields: { genotype: 'canonical' },
    };
    replaceOrgRegistrySnapshot(db, {
      orgId: ORG,
      accountId: ACCOUNT,
      cursor: 9,
      accessGeneration: 'scope-details',
      now: 100,
      snapshot: {
        idSchemes: [],
        schemas: [
          {
            id: schemaId,
            orgId: ORG,
            name: 'strain',
            baseKind: 'strain',
            currentRevisionId: newerId,
          },
        ],
        schemaRevisions: [
          {
            id: pinnedId,
            orgId: ORG,
            schemaId,
            version: 1,
            fields: [{ key: 'genotype', type: 'text' }],
          },
          {
            id: newerId,
            orgId: ORG,
            schemaId,
            version: 2,
            fields: [{ key: 'newer', type: 'text' }],
          },
        ],
        entities: [entity, { ...entity, id: otherId, name: 'Readable related record' }],
        entityRevisions: [{ entityId: ENTITY, revision: 3, snapshot: { name: 'Historical name' } }],
        relationships: [
          {
            id: 'link-visible',
            orgId: ORG,
            fromEntityId: ENTITY,
            toEntityId: otherId,
            relationshipType: 'derived_from',
            payload: { note: 'preserved' },
          },
          {
            id: 'link-hidden',
            orgId: ORG,
            fromEntityId: ENTITY,
            toEntityId: hiddenId,
            relationshipType: 'derived_from',
          },
          {
            id: 'link-unrelated',
            orgId: ORG,
            fromEntityId: otherId,
            toEntityId: otherId,
            relationshipType: 'derived_from',
          },
        ],
        placements: [
          {
            id: PLACEMENT,
            orgId: ORG,
            entityId: ENTITY,
            workspaceId: homeId,
            path: 'records/reference',
          },
          { id: 'placement-unrelated', orgId: ORG, entityId: otherId, workspaceId: homeId },
        ],
      },
    });
    return entity;
  }

  it('returns the canonical record, its pinned revision, and only accessible related data without writes', () => {
    const entity = seedDetails();
    const before = db
      .prepare('SELECT * FROM org_registry_cache ORDER BY record_type,record_id')
      .all();
    const result = read();
    expect(result).toMatchObject({
      scope: { accountId: ACCOUNT, orgId: ORG, accessGeneration: 'scope-details', cursor: 9 },
      entity,
      schema: { currentRevisionId: newerId },
      schemaRevision: { id: pinnedId, version: 1 },
      relationships: [{ id: 'link-visible', payload: { note: 'preserved' } }],
      placements: [{ id: PLACEMENT, path: 'records/reference' }],
    });
    expect(result.relationships).toHaveLength(1);
    expect(result.placements).toHaveLength(1);
    expect(
      db.prepare('SELECT * FROM org_registry_cache ORDER BY record_type,record_id').all()
    ).toEqual(before);
  });

  it('never substitutes the latest schema when the record’s pinned definition is absent or belongs elsewhere', () => {
    seedDetails();
    db.prepare(
      "DELETE FROM org_registry_cache WHERE record_type='schema_revision' AND record_id=?"
    ).run(pinnedId);
    expect(read).toThrow(/pinned schema revision/i);
    seedDetails();
    db.prepare(
      "UPDATE org_registry_cache SET payload_json=json_set(payload_json,'$.schemaId',?) WHERE record_type='schema_revision' AND record_id=?"
    ).run('60000000-0000-4000-8000-000000000002', pinnedId);
    expect(read).toThrow(/pinned schema revision/i);
  });

  it('refuses another account, an obsolete generation, and revoked access', () => {
    seedDetails();
    expect(() =>
      readOrgRegistryRecordDetails(db, {
        orgId: ORG,
        accountId: '10000000-0000-4000-8000-000000000002',
        entityId: ENTITY,
        expectedAccessGeneration: 'scope-details',
      })
    ).toThrow(/access/i);
    expect(() =>
      readOrgRegistryRecordDetails(db, {
        orgId: ORG,
        accountId: ACCOUNT,
        entityId: ENTITY,
        expectedAccessGeneration: 'older-scope',
      })
    ).toThrow(/access/i);
    invalidateOrgRegistryAccess(db, {
      orgId: ORG,
      accountId: ACCOUNT,
      clientId: 'desktop:test',
      now: 101,
    });
    expect(read).toThrow(/access/i);
    seedDetails();
    revokeOrgRegistryCache(db, { orgId: ORG, accountId: ACCOUNT, now: 102 });
    expect(read).toThrow(/access/i);
  });
});
