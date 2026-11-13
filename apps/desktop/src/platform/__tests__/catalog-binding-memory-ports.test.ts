import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserMockBridge } from '../browser-mock';
import { hostedBrowserBridge } from '../hosted';
import { clearMockData } from '../../test/platform-mocks';
import { hostedWorkspaceSessionController } from '../../hosted/controller';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const otherWorkspaceId = '22222222-2222-4222-8222-222222222222';
const root = `/hosted/${workspaceId}`;
const otherRoot = `/hosted/${otherWorkspaceId}`;

describe.each([
  ['browser fixture', browserMockBridge.db],
  ['hosted browser', hostedBrowserBridge.db],
] as const)('%s catalog binding port', (_runtime, db) => {
  let activeWorkspaceId = workspaceId;

  const snapshot = async () => ({
    entities: await db.select('SELECT * FROM catalog_entities'),
    files: await db.select('SELECT * FROM catalog_entity_files'),
    events: await db.select('SELECT * FROM catalog_entity_events'),
    workspaces: await db.select('SELECT * FROM workspaces'),
  });

  beforeEach(async () => {
    clearMockData();
    activeWorkspaceId = workspaceId;
    const original = hostedWorkspaceSessionController.getState();
    vi.spyOn(hostedWorkspaceSessionController, 'getState').mockImplementation(() => ({
      ...original,
      principal: { id: 'catalog-account', label: 'Catalog account' },
      activeWorkspaceId,
      snapshot: {
        workspaceId: activeWorkspaceId,
        revisionId: null,
        revisionNumber: 0,
        files: ['Before/page.json', 'After/page.json'].map((path) => ({
          path,
          resourceId: null,
          contentRevision: 'fixture',
          contentSha256: null,
          contentType: 'application/json',
          sizeBytes: 2,
        })),
      },
      workspaces: [workspaceId, otherWorkspaceId].map((id) => ({
        workspaceId: id,
        displayName: 'Project',
        latestRevisionId: null,
        latestRevisionNumber: 0,
      })),
    }));
    for (const table of [
      'catalog_entity_files',
      'catalog_entity_events',
      'catalog_entities',
      'workspaces',
    ]) {
      await db.execute(`DELETE FROM ${table}`);
    }
    const ownerId = await db.ensureWorkspaceOwner(root, undefined, { name: 'Project' });
    const entity = await db.registerCatalogEntity({
      id: 'target',
      type: 'notebook',
      name: 'Notebook',
      locator: 'entity://notebook/target',
      storageType: 'file',
      workspaceRoot: root,
    });
    expect(entity.workspace_id).toBe(ownerId);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retains the complete old state when promotion would collide with an existing object identity', async () => {
    await db.bindCatalogEntityFile({
      entityId: 'target',
      path: `${root}/Before`,
      workspaceRoot: root,
      objectUuid: 'existing-object',
    });
    await db.execute(
      `INSERT INTO catalog_entity_events(id,entity_id,event_type,actor,summary,payload,created_at)
       VALUES(?, ?, 'fixture', 'user', 'Retained event', ?, 1)`,
      ['retained', 'target', '{"keep":"exact bytes"}']
    );
    const before = await snapshot();
    await expect(
      db.bindCatalogEntityFile({
        entityId: 'target',
        path: `${root}/After`,
        workspaceRoot: root,
        objectUuid: 'existing-object',
      })
    ).rejects.toThrow(/object identity.*another file/i);
    expect(await snapshot()).toEqual(before);
  });

  it('refuses another registered workspace owner without changing catalog state', async () => {
    await db.bindCatalogEntityFile({
      entityId: 'target',
      path: `${root}/Before`,
      workspaceRoot: root,
    });
    activeWorkspaceId = otherWorkspaceId;
    await db.ensureWorkspaceOwner(otherRoot, undefined, { name: 'Other project' });
    activeWorkspaceId = workspaceId;
    const before = await snapshot();
    await expect(
      db.bindCatalogEntityFile({
        entityId: 'target',
        path: `${otherRoot}/After`,
        workspaceRoot: otherRoot,
      })
    ).rejects.toThrow(/entity workspace owner/i);
    expect(await snapshot()).toEqual(before);
  });

  it('preserves the unique missing file identity through a move and subsequent path update', async () => {
    const hash = `sha256:${'b'.repeat(64)}`;
    const missing = await db.bindCatalogEntityFile({
      entityId: 'target',
      path: `${root}/Before`,
      workspaceRoot: root,
      status: 'missing',
      contentHash: hash,
    });
    const moved = await db.bindCatalogEntityFile({
      entityId: 'target',
      path: `${root}/After`,
      workspaceRoot: root,
      contentHash: hash,
    });
    expect(moved).toMatchObject({
      id: missing.id,
      object_uuid: missing.object_uuid,
      status: 'current',
    });
    const repeated = await db.bindCatalogEntityFile({
      entityId: 'target',
      path: `${root}/After`,
      workspaceRoot: root,
      objectUuid: 'replace-attempt',
    });
    expect(repeated.object_uuid).toBe(missing.object_uuid);
    const rows = await db.select<Array<{ id: string; path: string; status: string }>>(
      'SELECT * FROM catalog_entity_files'
    );
    expect(rows.map(({ id, path, status }) => ({ id, path, status }))).toEqual([
      { id: missing.id, path: `${root}/After`, status: 'current' },
    ]);
  });
});
