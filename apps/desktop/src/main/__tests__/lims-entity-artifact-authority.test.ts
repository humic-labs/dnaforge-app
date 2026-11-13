import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLimsTestBridge } from './lims-bridge-for-db';
import { upsertLimsEntityProjectionInsideTx } from '../lims-engine-core';
import { rebuildLimsProjectionFromAuditRowsInDb } from '../lims-projection-rebuild';
import { rememberDeveloperImportSourceRootsInDb } from '../registry-source-eligibility';

let bridge: ReturnType<typeof createLimsTestBridge>;

const fields = {
  genotypeCanonical: 'recA1',
  artifact: {
    schema: 'waypoint.entity.v1',
    relativePath: 'records/strain/Owned.entity.json',
  },
};

beforeEach(() => {
  bridge = createLimsTestBridge();
  bridge.db
    .prepare(
      `INSERT INTO workspaces (id, name, path, created_at, last_opened_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(7, 'Workspace', '/ws', 1, 1);
});

afterEach(() => bridge.db.close());

describe('file-authoritative Registry ownership invariant', () => {
  it('rejects ownerless active projections at the one SQLite write boundary', () => {
    expect(() =>
      upsertLimsEntityProjectionInsideTx(bridge.db, {
        id: 'direct-ownerless-strain',
        kind: 'strain',
        schemaId: null,
        schemaRevisionId: 'builtin:strain:v1',
        name: 'Direct ownerless strain',
        registryId: null,
        fields,
        registrationStatus: 'registered',
        domainStatus: null,
        workspaceId: null,
        actor: 'test',
        eventSeq: 1,
        tombstone: false,
        createdAt: 1,
        updatedAt: 1,
        archivedAt: null,
      })
    ).toThrow(/must belong to a project/i);
  });

  it('rejects an active entity-artifact projection without a durable workspace owner', async () => {
    await expect(
      bridge.lims.registerEntity({
        id: 'ownerless-strain',
        kind: 'strain',
        name: 'Ownerless strain',
        fields,
      })
    ).rejects.toThrow(/requires its owning project/i);
  });

  it('cannot restore an ownerless entity-artifact projection', async () => {
    await bridge.lims.registerEntity({
      id: 'owned-strain',
      kind: 'strain',
      name: 'Owned strain',
      fields,
      workspaceId: 7,
    });
    await bridge.lims.archiveEntity({ id: 'owned-strain', actor: 'test' });

    bridge.db
      .prepare('UPDATE lims_entity SET workspace_id = NULL WHERE id = ?')
      .run('owned-strain');

    await expect(bridge.lims.restoreEntity({ id: 'owned-strain', actor: 'test' })).rejects.toThrow(
      /requires its owning project/i
    );
  });
});

describe('artifact Registry catalog search projection', () => {
  const row = (id: string) =>
    bridge.db
      .prepare(
        'SELECT type,name,locator,storage_type,workspace_id,status FROM catalog_entities WHERE id=?'
      )
      .get(id);

  it.each(['waypoint.entity.v1', 'waypoint.entity.v2'])(
    'publishes the exact owned %s artifact as one Registry search target',
    async (schema) => {
      await bridge.lims.registerEntity({
        id: 'search-owned',
        kind: 'strain',
        name: 'Owned searchable strain',
        fields: { ...fields, artifact: { ...fields.artifact, schema } },
        workspaceId: 7,
      });
      expect(row('search-owned')).toMatchObject({
        type: 'record',
        name: 'Owned searchable strain',
        locator: 'entity://lims/search-owned',
        storage_type: 'database',
        workspace_id: 7,
        status: 'active',
      });
      expect(
        bridge.db
          .prepare('SELECT count(*) AS count FROM catalog_entities WHERE id=?')
          .get('search-owned')
      ).toEqual({ count: 1 });
    }
  );

  it('keeps name and archive/restore state in the same existing target without extra audit actions', async () => {
    await bridge.lims.registerEntity({
      id: 'search-lifecycle',
      kind: 'strain',
      name: 'Before',
      fields,
      workspaceId: 7,
    });
    await bridge.lims.updateEntity({ id: 'search-lifecycle', name: 'After', actor: 'test' });
    expect(row('search-lifecycle')).toMatchObject({ name: 'After', status: 'active' });
    await bridge.lims.archiveEntity({ id: 'search-lifecycle', actor: 'test' });
    expect(row('search-lifecycle')).toMatchObject({ status: 'archived' });
    await bridge.lims.restoreEntity({ id: 'search-lifecycle', actor: 'test' });
    expect(row('search-lifecycle')).toMatchObject({ status: 'active', name: 'After' });
    expect(
      bridge.db
        .prepare('SELECT count(*) AS count FROM catalog_entities WHERE id=?')
        .get('search-lifecycle')
    ).toEqual({ count: 1 });
    expect((await bridge.lims.getEntityHistory({ entityId: 'search-lifecycle' })).length).toBe(4);
  });

  it('does not replace a catalog entry owned by a different scientific document', async () => {
    bridge.db
      .prepare(
        "INSERT INTO catalog_entities(id,type,name,locator,storage_type,status,workspace_id,metadata,created_at,updated_at) VALUES (?,'protein',?,'file:///ws/existing.faa','file','active',7,?,1,1)"
      )
      .run('search-conflict', 'Existing protein', JSON.stringify({ owner: 'native-file' }));
    await bridge.lims.registerEntity({
      id: 'search-conflict',
      kind: 'strain',
      name: 'Another representation',
      fields,
      workspaceId: 7,
    });
    expect(row('search-conflict')).toMatchObject({
      type: 'protein',
      name: 'Existing protein',
      storage_type: 'file',
      locator: 'file:///ws/existing.faa',
    });
  });

  it('does not adopt an ordinary database-only record through the artifact projection contract', async () => {
    await bridge.lims.registerEntity({
      id: 'ordinary-record',
      kind: 'strain',
      name: 'Ordinary',
      fields: { genotypeCanonical: 'recA1' },
      workspaceId: 7,
    });
    expect(row('ordinary-record')).toBeUndefined();
  });

  it('retires derived search targets when rebuilding an empty projection', async () => {
    await bridge.lims.registerEntity({
      id: 'rebuild-search',
      kind: 'strain',
      name: 'Before rebuild',
      fields,
      workspaceId: 7,
    });
    rebuildLimsProjectionFromAuditRowsInDb(bridge.db, []);
    expect(row('rebuild-search')).toMatchObject({ status: 'missing' });
  });
  it('retires an owned artifact target when its artifact representation is withdrawn', async () => {
    await bridge.lims.registerEntity({
      id: 'withdrawn-search',
      kind: 'strain',
      name: 'Withdrawn',
      fields,
      workspaceId: 7,
    });
    await bridge.lims.updateEntity({
      id: 'withdrawn-search',
      fields: { genotypeCanonical: 'recA1' },
      replaceFields: true,
      actor: 'test',
    });
    expect(row('withdrawn-search')).toMatchObject({ status: 'missing' });
  });

  it('preserves unrelated malformed catalog metadata during a projection rebuild', () => {
    bridge.db
      .prepare(
        "INSERT INTO catalog_entities(id,type,name,locator,storage_type,status,workspace_id,metadata,created_at,updated_at) VALUES ('foreign-index','record','Foreign','entity://lims/foreign-index','database','active',7,'{invalid',1,1)"
      )
      .run();
    rebuildLimsProjectionFromAuditRowsInDb(bridge.db, []);
    expect(row('foreign-index')).toMatchObject({ name: 'Foreign', status: 'active' });
  });
  it('retires its derived index when an owner is subsequently declared a developer import source', async () => {
    await bridge.lims.registerEntity({
      id: 'source-reclassified',
      kind: 'strain',
      name: 'Source',
      fields,
      workspaceId: 7,
    });
    expect(row('source-reclassified')).toMatchObject({ status: 'active' });
    rememberDeveloperImportSourceRootsInDb(bridge.db, ['/ws']);
    expect(row('source-reclassified')).toMatchObject({ status: 'missing' });
  });
});
