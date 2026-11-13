import { userMessage } from '@waypoint/user-messages';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestDb } from '../../main/__tests__/test-db';
import {
  acquireWorkspaceSyncDatabaseFence,
  assertRendererDatabaseStatementAllowed,
} from '../../main/workspace-sync-database-fence';
import {
  EntityDetailsSession,
  type EntityDetailsDefinition,
} from '../entity-details/public/session-model';
import type { LimsEntity, LimsRegistryPreview } from '../../shared/lims';

const native = vi.hoisted(() => ({
  queryEntities: vi.fn<() => Promise<LimsEntity[]>>(),
  getRegistryPreview: vi.fn<() => Promise<LimsRegistryPreview>>(),
}));
vi.mock('../../platform', () => ({ platform: () => ({ lims: native }) }));

import { getLimsRegistryPreview, queryLimsEntities } from './operations';

let db: ReturnType<typeof createTestDb>;
let release = () => {};
let session: EntityDetailsSession;
let reads = 0;

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  db = createTestDb();
  db.exec('CREATE TABLE saved_record (id TEXT PRIMARY KEY, name TEXT, count INTEGER)');
  db.prepare('INSERT INTO saved_record VALUES (?, ?, ?)').run('saved-record', 'Specimen', 3);
  reads = 0;
  native.queryEntities.mockImplementation(async () => {
    assertRendererDatabaseStatementAllowed(db);
    reads++;
    const row = db.prepare('SELECT id, name, count FROM saved_record').get() as {
      id: string;
      name: string;
      count: number;
    };
    return [
      {
        id: row.id,
        name: row.name,
        kind: 'strain',
        schemaId: 'specimen',
        schemaRevisionId: 'specimen-v1',
        registryId: 's1',
        fields: { count: row.count },
        registrationStatus: 'registered',
        domainStatus: null,
        workspaceId: 7,
        actor: null,
        eventSeq: 1,
        tombstone: false,
        createdAt: 1,
        updatedAt: 1,
        archivedAt: null,
      },
    ];
  });
  session = new EntityDetailsSession(
    { entityId: 'saved-record' },
    {
      load: async () => {
        const [entity] = await queryLimsEntities({ id: 'saved-record' });
        const definition: EntityDetailsDefinition = {
          record: {
            id: entity.id,
            name: entity.name,
            fields: entity.fields,
            registryId: entity.registryId,
            registrationStatus: entity.registrationStatus,
            path: '/project/specimen.entity.json',
            preview: null,
            properties: {},
            refreshGeneticCodeRevision: false,
            schema: {
              schemaId: 'specimen',
              schemaRevisionId: 'specimen-v1',
              name: 'strain',
              displayName: 'Specimen',
              baseKind: 'record',
              version: 1,
              fields: [],
            },
          },
          save: async () => {},
        };
        return definition;
      },
      history: async () => [],
      changed: () => {},
    }
  );
});

afterEach(() => {
  release();
  release = () => {};
  session.discard();
  session.dispose();
  db.close();
  vi.useRealTimers();
});

it('preserves the active Metadata draft across a native cloud database fence', async () => {
  await session.load();
  session.stage('count', { valid: true, value: 27 });
  session.fieldEditing('count', true);
  release = await acquireWorkspaceSyncDatabaseFence(db);
  const refresh = session.load();
  await vi.advanceTimersByTimeAsync(100);
  expect(session.getSnapshot()).toMatchObject({
    requiresReload: false,
    error: null,
    activeField: 'count',
    draft: { name: 'Specimen', fields: { count: 27 } },
  });
  expect(reads).toBe(1);
  release();
  await vi.advanceTimersByTimeAsync(250);
  await expect(refresh).resolves.toBe(false);
  expect(reads).toBe(2);
  expect(session.getSnapshot()).toMatchObject({
    requiresReload: false,
    error: null,
    activeField: 'count',
    draft: { name: 'Specimen', fields: { count: 27 } },
    definition: { record: { id: 'saved-record', path: '/project/specimen.entity.json' } },
  });
});

it('waits for a native fence and still reports a genuine Registry preview error', async () => {
  native.getRegistryPreview.mockImplementation(async () => {
    assertRendererDatabaseStatementAllowed(db);
    throw new Error('Preview schema rejected');
  });
  release = await acquireWorkspaceSyncDatabaseFence(db);
  const preview = getLimsRegistryPreview({ entityId: 'saved-record' }).catch(
    (error: unknown) => error
  );
  await vi.advanceTimersByTimeAsync(100);
  release();
  await vi.advanceTimersByTimeAsync(250);
  expect(await preview).toEqual(new Error('Preview schema rejected'));
  expect(native.getRegistryPreview).toHaveBeenCalledWith({ entityId: 'saved-record' });
});

it('reports a real query failure once while preserving the unsaved draft', async () => {
  await session.load();
  session.stage('count', { valid: true, value: 27 });
  native.queryEntities.mockRejectedValue(new Error('Registry permission denied'));
  await expect(session.load()).resolves.toBe(false);
  expect(native.queryEntities).toHaveBeenCalledTimes(2);
  expect(session.getSnapshot()).toMatchObject({
    requiresReload: true,
    error: userMessage('operation.failed'),
    draft: { fields: { count: 27 } },
  });
});
