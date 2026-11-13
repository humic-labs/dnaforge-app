import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformBridge } from '../platform';
import type { SqliteIpcValue } from '../shared/sqlite-ipc';
import { createLimsTestBridge } from '../main/__tests__/lims-bridge-for-db';
import { registerCatalogEntityInDb } from '../main/catalog-entity-registration';
import { resolveExactNativeCatalogDestination } from './native-catalog-destination';

let bridge: ReturnType<typeof createLimsTestBridge>;
vi.mock('../platform', () => ({
  platform: () => ({
    db: {
      select: async (sql: string, params: SqliteIpcValue[] = []) =>
        bridge.db.prepare(sql).all(...params),
    },
    lims: {
      queryEntities: (input: Parameters<PlatformBridge['lims']['queryEntities']>[0]) =>
        bridge.lims.queryEntities(input),
    },
    fs: {},
  }),
}));
const id = 'native-registry-record';
const root = '/owner';
const relativePath = 'strains/Owned.entity.json';
const resolve = () => resolveExactNativeCatalogDestination({ workspaceRoot: root, entityId: id });

beforeEach(async () => {
  bridge = createLimsTestBridge();
  bridge.db
    .prepare('INSERT INTO workspaces(id,name,path,created_at,last_opened_at) VALUES(7,?,?,1,1)')
    .run('Owner', root);
  registerCatalogEntityInDb(bridge.db, {
    id,
    type: 'file',
    name: 'Owned strain',
    locator: `file://${root}/${relativePath}`,
    storageType: 'file',
    workspaceRoot: root,
  });
  await bridge.lims.registerEntity({
    id,
    kind: 'strain',
    name: 'Owned strain',
    workspaceId: 7,
    fields: {
      genotypeCanonical: 'recA1',
      artifact: { schema: 'waypoint.entity.v2', relativePath },
    },
  });
  bridge.db
    .prepare(
      `INSERT INTO catalog_entity_files
      (id,entity_id,workspace_id,path,relative_path,file_kind,status,created_at,updated_at)
      VALUES('owned-binding',?,7,?,?,'waypoint-entity','current',1,1)`
    )
    .run(id, `${root}/${relativePath}`, relativePath);
});
afterEach(() => bridge.db.close());

describe('native Registry file destination', () => {
  it('routes the canonical file owner to its exact LIMS entity identity', async () => {
    expect(await resolve()).toMatchObject({
      entityId: id,
      title: 'Owned strain',
      locator: { kind: 'lims_entity', entityId: id },
    });
  });
  it('refuses a missing Registry projection', async () => {
    bridge.db.prepare('DELETE FROM lims_entity WHERE id=?').run(id);
    expect(await resolve()).toBeNull();
  });
  it('refuses a Registry projection owned by another project', async () => {
    bridge.db
      .prepare(
        "INSERT INTO workspaces(id,name,path,created_at,last_opened_at) VALUES(8,'Other','/other',1,1)"
      )
      .run();
    bridge.db.prepare('UPDATE lims_entity SET workspace_id=8 WHERE id=?').run(id);
    expect(await resolve()).toBeNull();
  });
  it('refuses an archived Registry projection', async () => {
    bridge.db.prepare('UPDATE lims_entity SET tombstone=1,archived_at=2 WHERE id=?').run(id);
    expect(await resolve()).toBeNull();
  });
  it('refuses a Registry projection whose artifact names another file', async () => {
    bridge.db.prepare('UPDATE lims_entity SET fields=? WHERE id=?').run(
      JSON.stringify({
        artifact: { schema: 'waypoint.entity.v2', relativePath: 'other.entity.json' },
      }),
      id
    );
    expect(await resolve()).toBeNull();
  });
});
