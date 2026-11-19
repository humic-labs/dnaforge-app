/** @vitest-environment node */
import { EventEmitter } from 'node:events';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  db: null as Database.Database | null,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  sender: null as (EventEmitter & { id: number }) | null,
  selectionBytes: '',
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      state.handlers.set(channel, handler);
    }),
  },
  dialog: { showErrorBox: vi.fn() },
  app: {
    getPath: vi.fn(() => '/tmp/dnaforge-test-app-data'),
    exit: vi.fn(),
    getVersion: vi.fn(() => '1.0.0'),
  },
}));
vi.mock('../../platform', () => ({
  platform: () => ({
    fs: {
      beginWorkspaceMutation: async (root: string) => {
        const release = await acquireWorkspaceMutationShared(root);
        return workspaceMutationCapabilities.issue(state.sender!.id, root, release);
      },
      endWorkspaceMutation: async (token: string) => {
        workspaceMutationCapabilities.release(token, state.sender!.id);
      },
      readTextFile: async () => state.selectionBytes,
      stat: async () => ({ size: state.selectionBytes.length, mtime: 1 }),
    },
    db: {
      linkCatalogEntities: async (input: unknown) =>
        state.handlers.get('db:linkCatalogEntities')!({ sender: state.sender }, input),
      recordCatalogEvent: async (input: unknown) =>
        state.handlers.get('db:recordCatalogEvent')!({ sender: state.sender }, input),
      ensureWorkspaceOwner: async (root: string, access?: string) =>
        state.handlers.get('db:ensureWorkspaceOwner')!({ sender: state.sender }, root, access),
      setCatalogFileState: async (path: string, status: string, reason: string) =>
        state.handlers.get('db:setCatalogFileState')!(
          { sender: state.sender },
          path,
          status,
          reason
        ),
      refreshCatalogFileFingerprints: async (files: unknown[]) =>
        state.handlers.get('db:refreshCatalogFileFingerprints')!({ sender: state.sender }, files),
      releaseMissingCatalogFilePath: async (file: unknown, replacement: string) =>
        state.handlers.get('db:releaseMissingCatalogFilePath')!(
          { sender: state.sender },
          file,
          replacement
        ),
      registerWorkspaceFile: async (input: unknown, mutationToken?: string) =>
        state.handlers.get('db:registerWorkspaceFile')!(
          { sender: state.sender },
          input,
          mutationToken
        ),
      rebindCatalogFiles: async (input: unknown, mutationToken?: string) =>
        state.handlers.get('db:rebindCatalogFiles')!(
          { sender: state.sender },
          input,
          mutationToken
        ),
      clearCatalogProjection: async (root: string) =>
        state.handlers.get('db:clearCatalogProjection')!({ sender: state.sender }, root),
      deleteCatalogEntityIfUnbound: async (id: string) =>
        state.handlers.get('db:deleteCatalogEntityIfUnbound')!({ sender: state.sender }, id),
      deleteCatalogEntityWithExactBinding: async (input: unknown) =>
        state.handlers.get('db:deleteCatalogEntityWithExactBinding')!(
          { sender: state.sender },
          input
        ),
      execute: async (sql: string, params?: unknown[]) => {
        const handler = state.handlers.get('db:execute')!;
        return handler({ sender: state.sender }, sql, params);
      },
      select: async (sql: string, params?: unknown[]) => {
        const handler = state.handlers.get('db:select')!;
        return handler({ sender: state.sender }, sql, params);
      },
      registerCatalogEntity: async (input: unknown) => {
        const handler = state.handlers.get('db:registerCatalogEntity');
        if (!handler) throw new Error('Native catalog registration handler is missing');
        return handler({ sender: state.sender }, input);
      },
      bindCatalogEntityFile: async (input: unknown, mutationToken?: string) => {
        const handler = state.handlers.get('db:bindCatalogEntityFile');
        if (!handler) throw new Error('Atomic catalog binding handler is missing');
        return handler({ sender: state.sender }, input, mutationToken);
      },
    },
  }),
}));

import * as projectMemory from '../../db/project-memory';
import { rebuildWorkspaceCatalogProjection } from '../../db/project-memory-projection';
import * as environment from '../../utils/environment';
import { ensureSchema } from '../schema';
import { seedLimsBuiltinsInDb } from '../lims-engine-core';
import { createTestDb } from './test-db';
import { registerDatabaseHandlers } from '../ipc/database';
import {
  bindCatalogEntityToFile,
  registerWorkspaceFile,
  registerContextualCatalogEntity,
  registerCatalogEntity,
  markCatalogFileHistorical,
  markCatalogFileMissing,
} from '../../db/workspace-catalog';
import { workspaceMutationCapabilities } from '../ipc/workspace-mutation-capability';
import {
  acquireWorkspaceMutationShared,
  acquireWorkspaceSyncMutationLease,
  tryAcquireWorkspaceMutationShared,
  workspaceMutationWaiterCountForTest,
} from '../workspace-sync-mutation-lease';
import { acquireWorkspaceSyncDatabaseFence } from '../workspace-sync-database-fence';
import {
  createSavedResidueSelectionDocument,
  serializeSavedResidueSelectionDocument,
} from '@waypoint/workspace-editor';
import { indexWorkspaceHeadIntoCatalog } from '../../services/workspace-git-indexer';

const sha256 = `sha256:${'a'.repeat(64)}`;

beforeEach(() => {
  state.db = createTestDb();
  ensureSchema(state.db, ':memory:');
  state.sender = Object.assign(new EventEmitter(), { id: 71639 });
  state.handlers.clear();
  registerDatabaseHandlers(() => state.db!);
  state.db
    .prepare('INSERT INTO workspaces(id,name,path,created_at) VALUES(7,?,?,1)')
    .run('One', '/ws');
  state.db
    .prepare('INSERT INTO workspaces(id,name,path,created_at) VALUES(8,?,?,1)')
    .run('Two', '/other');
  for (const id of ['target', 'historical-owner']) {
    state.db
      .prepare(
        `INSERT INTO catalog_entities(id,type,name,locator,storage_type,workspace_id,created_at,updated_at)
       VALUES(?, 'notebook', ?, ?, 'database', 7, 1, 1)`
      )
      .run(id, id, `entity://page/${id}`);
  }
});

afterEach(() => {
  workspaceMutationCapabilities.releaseOwner(state.sender!.id);
  state.db?.close();
  state.db = null;
});

function addBinding(
  id: string,
  path: string,
  options: {
    entityId?: string;
    workspaceId?: number | null;
    status?: string;
    hash?: string | null;
    uuid?: string | null;
  } = {}
) {
  state
    .db!.prepare(
      `INSERT INTO catalog_entity_files(id,entity_id,workspace_id,path,relative_path,file_kind,content_hash,
     object_uuid,size_bytes,modified_at,status,last_seen_at,missing_since,created_at,updated_at)
     VALUES(?,?,?,?,?,'waypoint-notebook',?,?,17,2,?,3,4,1,2)`
    )
    .run(
      id,
      options.entityId ?? 'target',
      options.workspaceId === undefined ? 7 : options.workspaceId,
      path,
      path.split('/').pop(),
      options.hash ?? sha256,
      options.uuid === undefined ? `object-${id}` : options.uuid,
      options.status ?? 'current'
    );
}

function snapshot() {
  return {
    files: state.db!.prepare('SELECT * FROM catalog_entity_files ORDER BY id').all(),
    events: state.db!.prepare('SELECT * FROM catalog_entity_events ORDER BY id').all(),
    entities: state.db!.prepare('SELECT * FROM catalog_entities ORDER BY id').all(),
  };
}

describe('catalog binding through real renderer delegation, production IPC, and SQLite', () => {
  it('preserves a historical binding when reconciliation reports its path missing', async () => {
    const path = '/ws/retired.waypoint-notebook';
    addBinding('retired', path);
    await markCatalogFileHistorical(path, 'notebook-deleted');
    const before = snapshot();

    await expect(markCatalogFileMissing(path)).resolves.toMatchObject({ status: 'historical' });
    expect(snapshot()).toEqual(before);
  });

  it.each([
    { id: 'target', locator: 'entity://page/target', workspaceRoot: '/other', type: 'notebook' },
    { id: 'replacement', locator: 'entity://page/target', workspaceRoot: '/ws', type: 'notebook' },
    { id: 'target', locator: 'entity://page/replacement', workspaceRoot: '/ws', type: 'notebook' },
    { id: 'target', locator: 'entity://page/target', workspaceRoot: '/ws', type: 'sequence' },
    {
      id: 'ws8::forged-owner',
      locator: 'entity://page/ws8::forged-owner',
      workspaceRoot: '/ws',
      type: 'notebook',
    },
  ] as const)(
    'rejects a conflicting catalog identity without rewriting existing data: %j',
    async (claim) => {
      const before = snapshot();
      await expect(
        registerCatalogEntity({
          ...claim,
          name: 'Conflicting claim',
          storageType: 'database',
        })
      ).rejects.toThrow(/identity|owner|workspace|kind|locator/i);
      expect(snapshot()).toEqual(before);
    }
  );

  it.each([
    ['UPDATE catalog_entities SET workspace_id = ? WHERE id = ?', [8, 'target']],
    [
      'WITH chosen AS (SELECT ?) UPDATE "catalog_entities" SET "workspace_id" = (SELECT * FROM chosen) WHERE id = ?',
      [8, 'target'],
    ],
    [
      "INSERT INTO catalog_entities(id,type,name,locator,storage_type,created_at,updated_at) VALUES('bypass','notebook','Bypass','entity://page/bypass','database',1,1)",
      [],
    ],
    [
      "UPDATE catalog_entity_files SET entity_id = 'historical-owner' WHERE entity_id = 'target'",
      [],
    ],
    ["DELETE FROM catalog_entities WHERE id = 'target'", []],
  ] as const)(
    'refuses raw renderer identity SQL without relying on its spelling: %s',
    async (sql, params) => {
      addBinding('original', '/ws/Original');
      const before = snapshot();
      const execute = state.handlers.get('db:execute')!;
      await expect(
        Promise.resolve().then(() => execute({ sender: state.sender }, sql, [...params]))
      ).rejects.toThrow(/REQUIRES_NATIVE_COMMAND/);
      expect(snapshot()).toEqual(before);
    }
  );

  it('preserves entity and object identity when ordinary discovery finds an externally moved loose file', async () => {
    const original = await registerWorkspaceFile({
      path: '/ws/Before.gb',
      entityType: 'sequence',
      workspaceRoot: '/ws',
      contentHash: sha256,
    });
    const binding = state
      .db!.prepare('SELECT * FROM catalog_entity_files WHERE entity_id = ?')
      .get(original.id) as { object_uuid: string };
    state
      .db!.prepare("UPDATE catalog_entity_files SET status='missing' WHERE entity_id = ?")
      .run(original.id);
    const moved = await registerWorkspaceFile({
      path: '/ws/After.gb',
      entityType: 'sequence',
      workspaceRoot: '/ws',
      contentHash: sha256,
    });
    expect(moved).toMatchObject({
      id: original.id,
      locator: 'file:///ws/After.gb',
      workspace_id: 7,
    });
    expect(
      state
        .db!.prepare('SELECT object_uuid,path,status FROM catalog_entity_files WHERE entity_id = ?')
        .all(original.id)
    ).toEqual([{ object_uuid: binding.object_uuid, path: '/ws/After.gb', status: 'current' }]);
  });

  it.each([
    "UPDATE primers SET name='Bypass' WHERE id='canonical-primer'",
    "DELETE FROM primers WHERE id='canonical-primer'",
    "UPDATE primers SET origin_details='{}' WHERE id='canonical-primer'",
    "INSERT OR REPLACE INTO primers(id,name,sequence,length,origin_details,created_at,updated_at) VALUES('canonical-primer','Replacement','AAAA',4,'{}',1,2)",
  ])('refuses raw mutation of a canonical primer projection: %s', async (sql) => {
    state
      .db!.prepare(
        `INSERT INTO primers(id,catalog_number,name,sequence,length,origin_details,created_at,updated_at)
      VALUES('canonical-primer','P999','Canonical','ATCGATCGATCG',12,?,1,1)`
      )
      .run(JSON.stringify({ authority: 'primer_artifact', artifactPath: 'Canonical.primer.json' }));
    const before = state.db!.prepare('SELECT * FROM primers').all();
    const execute = state.handlers.get('db:execute')!;
    await expect(
      Promise.resolve().then(() => execute({ sender: state.sender }, sql))
    ).rejects.toThrow(/NATIVE_COMMAND|canonical|artifact/);
    expect(state.db!.prepare('SELECT * FROM primers').all()).toEqual(before);
  });

  it('permits deliberate existing legacy/global edits while refusing new raw primer rows and identity takeover', async () => {
    state
      .db!.prepare(
        "INSERT INTO primers(id,name,sequence,length,workspace_id,created_at,updated_at) VALUES('legacy-primer','Legacy','ATCG',4,7,1,1)"
      )
      .run();
    const execute = state.handlers.get('db:execute')!;
    await execute(
      { sender: state.sender },
      "UPDATE primers SET name='Edited legacy' WHERE id='legacy-primer'"
    );
    expect(state.db!.prepare("SELECT name FROM primers WHERE id='legacy-primer'").get()).toEqual({
      name: 'Edited legacy',
    });
    for (const sql of [
      "INSERT INTO primers(id,name,sequence,length,created_at,updated_at) VALUES('phantom','Phantom','ATCG',4,1,1)",
      "UPDATE primers SET id='replacement' WHERE id='legacy-primer'",
      "UPDATE primers SET workspace_id=8 WHERE id='legacy-primer'",
    ]) {
      await expect(
        Promise.resolve().then(() => execute({ sender: state.sender }, sql))
      ).rejects.toThrow(/REQUIRES_NATIVE_COMMAND/);
    }
    state.db!.prepare("UPDATE primers SET workspace_id=NULL WHERE id='legacy-primer'").run();
    await execute(
      { sender: state.sender },
      "UPDATE primers SET notes='Global record' WHERE id='legacy-primer'"
    );
    expect(state.db!.prepare("SELECT notes FROM primers WHERE id='legacy-primer'").get()).toEqual({
      notes: 'Global record',
    });
  });

  it.each([
    "DELETE FROM primers WHERE id='legacy'",
    "DELETE FROM primer_bindings WHERE id='attachment'",
    "UPDATE OR REPLACE primers SET catalog_number='P001' WHERE id='global'",
    "UPDATE OR REPLACE primer_bindings SET binding_start=1 WHERE id='another'",
    "INSERT OR REPLACE INTO primer_bindings(id,primer_id,sequence_id,binding_start,binding_end,strand,created_at,updated_at) VALUES('new','legacy',1,1,4,1,1,1)",
  ])(
    'preserves saved legacy primers and attachments through renderer SQL: %s',
    async (statement) => {
      const db = state.db!;
      db.exec(`INSERT INTO indexed_files(id,workspace_id,path,name,extension,indexed_at)
      VALUES(1,7,'/ws/example.gb','example.gb','gb',1);
      INSERT INTO sequences(id,file_id,name,length) VALUES(1,1,'Example',20);
      INSERT INTO primers(id,catalog_number,name,sequence,length,workspace_id,created_at,updated_at)
      VALUES('legacy','P001','Legacy','ATCG',4,7,1,1),('global','P002','Global','CGAT',4,NULL,1,1);
      INSERT INTO primer_bindings(id,primer_id,sequence_id,binding_start,binding_end,strand,created_at,updated_at)
      VALUES('attachment','legacy',1,1,4,1,1,1),('another','legacy',1,6,9,1,1,1);`);
      function savedRows() {
        return {
          primers: db.prepare('SELECT * FROM primers ORDER BY id').all(),
          bindings: db.prepare('SELECT * FROM primer_bindings ORDER BY id').all(),
        };
      }
      const before = savedRows();
      const execute = state.handlers.get('db:execute')!;
      await expect(
        Promise.resolve().then(() => execute({ sender: state.sender }, statement))
      ).rejects.toThrow(/REQUIRES_NATIVE_COMMAND/);
      expect(savedRows()).toEqual(before);
    }
  );

  it.each(["access_mode='reference'", 'archived_at=9', 'trashed_at=9'])(
    'refuses legacy content and attachment mutations under a nonwritable owner: %s',
    async (authority) => {
      state.db!
        .exec(`INSERT INTO indexed_files(id,workspace_id,path,name,extension,indexed_at) VALUES(1,7,'/ws/Target.gb','Target.gb','gb',1);
        INSERT INTO sequences(id,file_id,name,length) VALUES(1,1,'Target',20);
        INSERT INTO primers(id,name,sequence,length,workspace_id,created_at,updated_at) VALUES('legacy-primer','Legacy','ATCG',4,7,1,1);
        INSERT INTO primer_bindings(id,primer_id,sequence_id,binding_start,binding_end,strand,created_at,updated_at) VALUES('legacy-binding','legacy-primer',1,1,4,1,1,1);`);
      state.db!.exec(`UPDATE workspaces SET ${authority} WHERE id=7`);
      const before = {
        primers: state.db!.prepare('SELECT * FROM primers').all(),
        bindings: state.db!.prepare('SELECT * FROM primer_bindings').all(),
      };
      const execute = state.handlers.get('db:execute')!;
      for (const sql of [
        "UPDATE primers SET name='Bypass' WHERE id='legacy-primer'",
        "DELETE FROM primers WHERE id='legacy-primer'",
        "DELETE FROM primer_bindings WHERE id='legacy-binding'",
        "INSERT INTO primer_bindings(id,primer_id,sequence_id,binding_start,binding_end,strand,created_at,updated_at) VALUES('new-binding','legacy-primer',1,3,7,1,1,1)",
      ]) {
        await expect(
          Promise.resolve().then(() => execute({ sender: state.sender }, sql))
        ).rejects.toThrow(/REQUIRES_WRITABLE_WORKSPACE/);
      }
      expect({
        primers: state.db!.prepare('SELECT * FROM primers').all(),
        bindings: state.db!.prepare('SELECT * FROM primer_bindings').all(),
      }).toEqual(before);
    }
  );

  it.each([
    "UPDATE primer_bindings SET binding_start=5 WHERE id='canonical-binding'",
    "DELETE FROM primer_bindings WHERE id='canonical-binding'",
    "UPDATE primer_bindings SET primer_id='legacy-primer' WHERE id='canonical-binding'",
    "INSERT INTO primer_bindings(id,primer_id,sequence_id,binding_start,binding_end,strand,created_at,updated_at) VALUES('new-binding','canonical-primer',1,3,10,1,1,1)",
  ])('refuses raw mutation of a canonical primer relationship: %s', async (sql) => {
    state.db!
      .exec(`INSERT INTO indexed_files(id,workspace_id,path,name,extension,indexed_at) VALUES(1,7,'/ws/Target.gb','Target.gb','gb',1);
      INSERT INTO sequences(id,file_id,name,length) VALUES(1,1,'Target',20);
      INSERT INTO primers(id,name,sequence,length,origin_details,created_at,updated_at) VALUES('canonical-primer','Canonical','ATCG',4,'{"authority":"primer_artifact"}',1,1);
      INSERT INTO primers(id,name,sequence,length,created_at,updated_at) VALUES('legacy-primer','Legacy','ATCG',4,1,1);
      INSERT INTO primer_bindings(id,primer_id,sequence_id,binding_start,binding_end,strand,created_at,updated_at) VALUES('canonical-binding','canonical-primer',1,1,4,1,1,1);`);
    const before = state.db!.prepare('SELECT * FROM primer_bindings').all();
    const execute = state.handlers.get('db:execute')!;
    await expect(
      Promise.resolve().then(() => execute({ sender: state.sender }, sql))
    ).rejects.toThrow(/CANONICAL_PRIMER_REQUIRES_NATIVE_COMMAND/);
    expect(state.db!.prepare('SELECT * FROM primer_bindings').all()).toEqual(before);
  });

  it.each([
    "UPDATE lims_schema SET fields='[]' WHERE builtin=1",
    'DELETE FROM lims_schema_revision WHERE schema_id IN (SELECT id FROM lims_schema WHERE builtin=1)',
    "INSERT INTO lims_schema(id,kind,name,display_name,fields,created_at,updated_at) VALUES('bypass','entity','bypass','Bypass','[]',1,1)",
  ])('refuses raw Registry schema authority mutation: %s', async (sql) => {
    seedLimsBuiltinsInDb(state.db!);
    const before = state.db!.prepare('SELECT * FROM lims_schema ORDER BY id').all();
    const revisions = state.db!.prepare('SELECT * FROM lims_schema_revision ORDER BY id').all();
    expect(before.length).toBeGreaterThan(0);
    const execute = state.handlers.get('db:execute')!;
    await expect(
      Promise.resolve().then(() => execute({ sender: state.sender }, sql))
    ).rejects.toThrow(/REGISTRY_AUTHORITY_REQUIRES_NATIVE_COMMAND/);
    expect(state.db!.prepare('SELECT * FROM lims_schema ORDER BY id').all()).toEqual(before);
    expect(state.db!.prepare('SELECT * FROM lims_schema_revision ORDER BY id').all()).toEqual(
      revisions
    );
  });

  it.each([
    "UPDATE pages SET content='forged' WHERE id='native-page'",
    "DELETE FROM pages WHERE id='native-page'",
    "INSERT OR REPLACE INTO pages(id,title,content,created_at,updated_at) VALUES('native-page','Forged','forged',1,2)",
    "INSERT INTO entity_projection_sources VALUES('sequence','forged','workspace:7','Target.gb',1,'forged',2)",
    "UPDATE entity_projection_sources SET synchronized_fingerprint='forged'",
    'DELETE FROM entity_projection_sources',
  ])('refuses raw notebook or equality receipt publication: %s', async (sql) => {
    state
      .db!.prepare(
        "INSERT INTO pages(id,title,content,created_at,updated_at) VALUES('native-page','Native','original',1,1)"
      )
      .run();
    state
      .db!.prepare(
        "INSERT INTO entity_projection_sources VALUES('notebook','native-page','workspace:7','Native.notebook',1,'original',1)"
      )
      .run();
    const before = {
      pages: state.db!.prepare('SELECT * FROM pages').all(),
      receipts: state.db!.prepare('SELECT * FROM entity_projection_sources').all(),
    };
    const execute = state.handlers.get('db:execute')!;
    await expect(
      Promise.resolve().then(() => execute({ sender: state.sender }, sql))
    ).rejects.toThrow(/REQUIRES_NATIVE_COMMAND/);
    expect({
      pages: state.db!.prepare('SELECT * FROM pages').all(),
      receipts: state.db!.prepare('SELECT * FROM entity_projection_sources').all(),
    }).toEqual(before);
  });

  it('refuses an unlisted Registry representation table under the native namespace', async () => {
    state.db!.exec('CREATE TABLE lims_new_projection(id TEXT PRIMARY KEY, value TEXT)');
    const execute = state.handlers.get('db:execute')!;
    await expect(
      Promise.resolve().then(() =>
        execute(
          { sender: state.sender },
          "INSERT INTO lims_new_projection VALUES('bypass','forged')"
        )
      )
    ).rejects.toThrow(/REGISTRY_AUTHORITY_REQUIRES_NATIVE_COMMAND/);
    expect(state.db!.prepare('SELECT * FROM lims_new_projection').all()).toEqual([]);
  });

  it('keeps an existing semantic entity and binding when ordinary file discovery revisits its bytes', async () => {
    addBinding('semantic', '/ws/Notebook', { entityId: 'target' });
    const result = await registerWorkspaceFile({
      path: '/ws/Notebook',
      fileKind: 'folder',
      workspaceRoot: '/ws',
    });
    expect(result).toMatchObject({
      id: 'target',
      type: 'notebook',
      locator: 'entity://page/target',
    });
    expect(
      state
        .db!.prepare(
          'SELECT entity_id,object_uuid,file_kind FROM catalog_entity_files WHERE id = ?'
        )
        .get('semantic')
    ).toEqual({
      entity_id: 'target',
      object_uuid: 'object-semantic',
      file_kind: 'waypoint-notebook',
    });
    expect(state.db!.prepare('SELECT COUNT(*) AS count FROM catalog_entities').get()).toEqual({
      count: 2,
    });
  });

  it('refuses mutation through a row-returning statement on the read channel', async () => {
    const before = snapshot();
    const select = state.handlers.get('db:select')!;
    await expect(
      Promise.resolve().then(() =>
        select(
          { sender: state.sender },
          "UPDATE catalog_entities SET workspace_id = 8 WHERE id = 'target' RETURNING id"
        )
      )
    ).rejects.toThrow(/read.only/);
    expect(snapshot()).toEqual(before);
  });

  it.each([
    'DROP TRIGGER dnaforge_renderer_catalog_entities_update',
    'PRAGMA writable_schema = ON',
    'CREATE TEMP TRIGGER bypass AFTER UPDATE ON workspaces BEGIN SELECT 1; END',
    "UPDATE workspaces SET access_mode='writable' WHERE id=7",
    'UPDATE workspaces SET archived_at=NULL,trashed_at=NULL WHERE id=7',
  ])('refuses raw renderer schema or permission tampering: %s', async (sql) => {
    const execute = state.handlers.get('db:execute')!;
    await execute(
      { sender: state.sender },
      'UPDATE workspaces SET last_opened_at = ? WHERE id = ?',
      [3, 7]
    );
    const before = snapshot();
    await expect(
      Promise.resolve().then(() => execute({ sender: state.sender }, sql))
    ).rejects.toThrow(/schema or authority|REQUIRES_NATIVE_COMMAND/);
    expect(snapshot()).toEqual(before);
    expect(state.db!.pragma('writable_schema', { simple: true })).toBe(0);
  });

  it('keeps a discovered reference workspace read-only under implicit and explicit re-registration', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'catalog-reference-project-')));
    state.db!.prepare('UPDATE workspaces SET path = ? WHERE id = 7').run(root);
    try {
      const resolve = state.handlers.get('db:ensureWorkspaceOwner')!;
      await resolve({ sender: state.sender }, root, 'reference');
      await expect(Promise.resolve(resolve({ sender: state.sender }, root))).resolves.toBe(7);
      await expect(
        Promise.resolve().then(() => resolve({ sender: state.sender }, root, 'writable'))
      ).rejects.toThrow(/cannot acquire write authority/);
      expect(state.db!.prepare('SELECT access_mode FROM workspaces WHERE id=7').get()).toEqual({
        access_mode: 'reference',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refreshes the same identity in the same project without replacing its stable owner', async () => {
    const updated = await registerCatalogEntity({
      id: 'target',
      type: 'notebook',
      name: 'Updated notebook',
      locator: 'entity://page/target',
      storageType: 'database',
      workspaceRoot: '/ws',
      metadata: { revision: 2 },
    });
    expect(updated).toMatchObject({ id: 'target', workspace_id: 7, name: 'Updated notebook' });
    expect(state.db!.prepare('SELECT COUNT(*) AS count FROM catalog_entities').get()).toEqual({
      count: 2,
    });
  });

  it('rejects native file binding to a different project from the entity owner', async () => {
    addBinding('original', '/ws/Original');
    const before = snapshot();
    await expect(
      bindCatalogEntityToFile({
        entityId: 'target',
        path: '/other/Replacement',
        workspaceRoot: '/other',
      })
    ).rejects.toThrow(/owner|workspace/i);
    expect(snapshot()).toEqual(before);
  });

  it('rejects taking an existing current path from another entity', async () => {
    addBinding('original', '/ws/Original', { entityId: 'historical-owner' });
    const before = snapshot();
    await expect(
      bindCatalogEntityToFile({
        entityId: 'target',
        path: '/ws/Original',
        workspaceRoot: '/ws',
      })
    ).rejects.toThrow('Legacy sequence package binding has no exact current project authority.');
    expect(snapshot()).toEqual(before);
  });

  it('reconstructs a saved selection at HEAD without reacquiring its parent project lease', async () => {
    state.selectionBytes = serializeSavedResidueSelectionDocument(
      createSavedResidueSelectionDocument({
        id: 'saved-selection',
        name: 'Selected residues',
        color: '#ef4444',
        revisionId: 'selection-v1',
        createdAt: '2026-07-14T12:00:00.000Z',
        actor: { kind: 'user' },
        members: [
          {
            id: 'member-1',
            selection: {
              target: {
                moleculeId: 'protein:sha256:abc123',
                moleculeKind: 'protein',
                coordinateSystem: 'residue',
                intervals: [{ start: 0, end: 3 }],
              },
            },
            scope: { kind: 'polymer' },
            polymerRevision: {
              moleculeId: 'protein:sha256:abc123',
              moleculeKind: 'protein',
              sequenceDigestSha256: 'abc123',
            },
          },
        ],
      })
    );
    const release = await acquireWorkspaceMutationShared('/ws');
    const token = workspaceMutationCapabilities.issue(state.sender!.id, '/ws', release);
    let settled = false;
    const reconstruction = indexWorkspaceHeadIntoCatalog(
      '/ws',
      async () => ({
        headCommit: 'head-selection',
        scannedFileCount: 1,
        visibleFileCount: 1,
        files: [
          {
            relPath: 'Selections/selected.wpselection.json',
            oid: 'selection-blob',
            sizeBytes: state.selectionBytes.length,
            modifiedAt: 1,
          },
        ],
      }),
      { mutationToken: token }
    ).finally(() => {
      settled = true;
    });
    try {
      await vi.waitFor(() =>
        expect(settled || workspaceMutationWaiterCountForTest('/ws') > 0).toBe(true)
      );
      expect(settled).toBe(true);
      expect(workspaceMutationWaiterCountForTest('/ws')).toBe(0);
      await expect(reconstruction).resolves.toMatchObject({ registered: 1, errors: [] });
      expect(
        state
          .db!.prepare(
            "SELECT entity_id,path,status FROM catalog_entity_files WHERE status='current'"
          )
          .all()
      ).toEqual([
        {
          entity_id: 'saved-selection',
          path: '/ws/Selections/selected.wpselection.json',
          status: 'current',
        },
      ]);
    } finally {
      workspaceMutationCapabilities.release(token, state.sender!.id);
      await reconstruction;
    }
  });

  it.each(['INSERT', 'UPDATE'] as const)(
    'rolls back sibling demotion and events when promotion %s aborts',
    async (operation) => {
      addBinding('old', '/ws/Before');
      if (operation === 'UPDATE')
        addBinding('destination', '/ws/After', {
          entityId: 'target',
          status: 'historical',
        });
      state
        .db!.prepare(
          `INSERT INTO catalog_entity_events(id,entity_id,event_type,actor,summary,payload,created_at)
       VALUES('retained-event','target','fixture','user','Retained event','{"retain":"these exact bytes"}',1)`
        )
        .run();
      const before = snapshot();
      state.db!
        .exec(`CREATE TEMP TRIGGER fail_catalog_promotion BEFORE ${operation} ON catalog_entity_files
      WHEN NEW.path = '/ws/After' AND NEW.status = 'current'
      BEGIN SELECT RAISE(ABORT, 'injected promotion failure'); END;`);

      await expect(
        bindCatalogEntityToFile({
          entityId: 'target',
          path: '/ws/After',
          workspaceRoot: '/ws',
          fileKind: 'waypoint-notebook',
        })
      ).rejects.toThrow(/injected promotion failure/);
      expect(snapshot()).toEqual(before);
    }
  );

  it('promotes the new current and records only committed demotion events', async () => {
    addBinding('old', '/ws/Before');
    const bound = await bindCatalogEntityToFile({
      entityId: 'target',
      path: '/ws/After',
      workspaceRoot: '/ws',
      fileKind: 'waypoint-notebook',
    });
    expect(bound).toMatchObject({
      entity_id: 'target',
      workspace_id: 7,
      path: '/ws/After',
      relative_path: 'After',
      status: 'current',
    });
    expect(
      state.db!.prepare("SELECT path FROM catalog_entity_files WHERE status='current'").all()
    ).toEqual([{ path: '/ws/After' }]);
    const [event] = state.db!.prepare('SELECT * FROM catalog_entity_events').all() as Array<{
      event_type: string;
      payload: string;
    }>;
    expect(event.event_type).toBe('file_historical');
    expect(JSON.parse(event.payload)).toEqual({
      path: '/ws/Before',
      reason: 'superseded-current-binding',
      fileKind: 'waypoint-notebook',
    });
    const repeated = await bindCatalogEntityToFile({
      entityId: 'target',
      path: '/ws/After',
      workspaceRoot: '/ws',
    });
    expect(repeated.id).toBe(bound.id);
    expect(repeated.object_uuid).toBe(bound.object_uuid);
    expect(state.db!.prepare('SELECT COUNT(*) AS count FROM catalog_entity_events').get()).toEqual({
      count: 1,
    });
  });

  it('rolls back demotion if writing its catalog event fails', async () => {
    addBinding('old', '/ws/Before');
    const before = snapshot();
    state.db!.exec(`CREATE TEMP TRIGGER fail_demotion_event BEFORE INSERT ON catalog_entity_events
      WHEN NEW.event_type = 'file_historical'
      BEGIN SELECT RAISE(ABORT, 'injected event failure'); END;`);
    await expect(
      bindCatalogEntityToFile({ entityId: 'target', path: '/ws/After', workspaceRoot: '/ws' })
    ).rejects.toThrow(/injected event failure/);
    expect(snapshot()).toEqual(before);
  });

  it('reuses exactly one missing same-workspace SHA256 row and its immutable object ID', async () => {
    addBinding('moved', '/ws/Before', { status: 'missing' });
    const result = await bindCatalogEntityToFile({
      entityId: 'target',
      path: '/ws/After',
      workspaceRoot: '/ws',
      contentHash: sha256,
    });
    expect(result).toMatchObject({
      id: 'moved',
      object_uuid: 'object-moved',
      path: '/ws/After',
      status: 'current',
    });
    expect(state.db!.prepare('SELECT COUNT(*) AS count FROM catalog_entity_files').get()).toEqual({
      count: 1,
    });
  });

  it.each([
    'ambiguous',
    'current-copy',
    'different-workspace',
    'git-hash',
    'legacy-no-object-id',
  ] as const)('does not adopt identity from %s evidence', async (caseName) => {
    addBinding('candidate', caseName === 'different-workspace' ? '/other/Before' : '/ws/Before', {
      status: caseName === 'current-copy' ? 'current' : 'missing',
      workspaceId: caseName === 'different-workspace' ? 8 : 7,
      hash: caseName === 'git-hash' ? 'git:aaaa' : sha256,
      uuid: caseName === 'legacy-no-object-id' ? null : 'candidate-object',
    });
    if (caseName === 'ambiguous')
      addBinding('other-candidate', '/ws/Another', { status: 'missing' });
    const result = await bindCatalogEntityToFile({
      entityId: 'target',
      path: '/ws/After',
      workspaceRoot: '/ws',
      contentHash: caseName === 'git-hash' ? 'git:aaaa' : sha256,
    });
    expect(result.id).not.toBe('candidate');
    expect(result.object_uuid).not.toBe('candidate-object');
    expect(
      state.db!.prepare('SELECT path FROM catalog_entity_files WHERE id = ?').get('candidate')
    ).toEqual({
      path: caseName === 'different-workspace' ? '/other/Before' : '/ws/Before',
    });
  });

  it('rejects stale catalog state after waiting without a mutation capability', async () => {
    const releaseWriter = await acquireWorkspaceSyncMutationLease('/ws');
    const binding = state.handlers.get('db:bindCatalogEntityFile')!(
      { sender: state.sender },
      {
        entityId: 'target',
        path: '/ws/After',
        workspaceRoot: '/ws',
      }
    );
    try {
      await vi.waitFor(() => expect(workspaceMutationWaiterCountForTest('/ws')).toBe(1));
      state
        .db!.prepare('UPDATE catalog_entities SET locator=?, updated_at=updated_at+1 WHERE id=?')
        .run('entity://page/replaced-target', 'target');
    } finally {
      releaseWriter();
    }
    await expect(binding).rejects.toThrow(/authority changed/);
    expect(state.db!.prepare('SELECT * FROM catalog_entity_files').all()).toEqual([]);
  });

  it('rejects a project ownership change made by the preceding workspace writer', async () => {
    const releaseWriter = await acquireWorkspaceSyncMutationLease('/ws');
    const binding = bindCatalogEntityToFile({
      entityId: 'target',
      path: '/ws/After',
      workspaceRoot: '/ws',
    });
    try {
      await vi.waitFor(() => expect(workspaceMutationWaiterCountForTest('/ws')).toBe(1));
      state.db!.prepare('UPDATE catalog_entities SET workspace_id=8 WHERE id=?').run('target');
    } finally {
      releaseWriter();
    }
    await expect(binding).rejects.toThrow(/authority changed|entity workspace owner/);
    expect(state.db!.prepare('SELECT * FROM catalog_entity_files').all()).toEqual([]);
  });

  it('rejects a queued binding when the project at its path is replaced', async () => {
    state
      .db!.prepare('UPDATE workspaces SET repo_uuid=? WHERE id=7')
      .run('11111111-1111-4111-8111-111111111111');
    const releaseWriter = await acquireWorkspaceSyncMutationLease('/ws');
    const binding = state.handlers.get('db:bindCatalogEntityFile')!(
      { sender: state.sender },
      {
        entityId: 'target',
        path: '/ws/After',
        workspaceRoot: '/ws',
      }
    );
    try {
      await vi.waitFor(() => expect(workspaceMutationWaiterCountForTest('/ws')).toBe(1));
      state
        .db!.prepare('UPDATE workspaces SET repo_uuid=? WHERE id=7')
        .run('22222222-2222-4222-8222-222222222222');
    } finally {
      releaseWriter();
    }
    await expect(binding).rejects.toThrow(/authority changed/);
    expect(state.db!.prepare('SELECT * FROM catalog_entity_files').all()).toEqual([]);
  });

  it('borrows a valid sender capability while a sync writer is queued', async () => {
    const release = await acquireWorkspaceMutationShared('/ws');
    const token = workspaceMutationCapabilities.issue(state.sender!.id, '/ws', release);
    const writer = acquireWorkspaceSyncMutationLease('/ws');
    try {
      const bound = await bindCatalogEntityToFile({
        entityId: 'target',
        path: '/ws/After',
        workspaceRoot: '/ws',
        mutationToken: token,
      });
      expect(bound).toMatchObject({ status: 'current', path: '/ws/After' });
    } finally {
      workspaceMutationCapabilities.release(token, state.sender!.id);
      (await writer)();
    }
  });

  it('admits a queued molecular binding after the active project owner reconciles its catalog', async () => {
    const entityId = 'ws7::514d4195-c1e3-4417-886b-6e487b778222';
    const registration = {
      id: entityId,
      type: 'molecular-document' as const,
      name: 'KcsA',
      locator: `entity://molecular-document/${entityId}`,
      storageType: 'file' as const,
      workspaceRoot: '/ws',
    };
    await registerCatalogEntity(registration);
    const request = {
      entityId,
      path: '/ws/KcsA.dnaforge-molecular.json',
      workspaceRoot: '/ws',
      fileKind: 'dnaforge-molecular-document',
      contentHash: sha256,
    };
    await bindCatalogEntityToFile(request);
    const release = await acquireWorkspaceMutationShared('/ws');
    const pending = bindCatalogEntityToFile(request);
    const settled = pending.then(
      () => undefined,
      () => undefined
    );
    try {
      await vi.waitFor(() => expect(workspaceMutationWaiterCountForTest('/ws')).toBe(1));
      await registerCatalogEntity({ ...registration, name: 'Reconciled KcsA' });
    } finally {
      release();
      await settled;
    }
    await expect(pending).resolves.toMatchObject({
      entity_id: entityId,
      workspace_id: 7,
      content_hash: sha256,
      status: 'current',
    });
    expect(state.db!.prepare('SELECT name FROM catalog_entities WHERE id=?').get(entityId)).toEqual(
      {
        name: 'Reconciled KcsA',
      }
    );
  });

  it('still refuses a stale direct binding admission after another owner changes its witness', async () => {
    addBinding('old', '/ws/Before');
    const release = await acquireWorkspaceMutationShared('/ws');
    const handler = state.handlers.get('db:bindCatalogEntityFile')!;
    const pending = Promise.resolve(
      handler(
        { sender: state.sender },
        { entityId: 'target', path: '/ws/Before', workspaceRoot: '/ws' }
      )
    );
    const settled = pending.then(
      () => undefined,
      () => undefined
    );
    let before: ReturnType<typeof snapshot> | undefined;
    try {
      await vi.waitFor(() => expect(workspaceMutationWaiterCountForTest('/ws')).toBe(1));
      await registerCatalogEntity({
        id: 'target',
        type: 'notebook',
        name: 'Reconciled notebook',
        locator: 'entity://page/target',
        storageType: 'database',
        workspaceRoot: '/ws',
      });
      before = snapshot();
    } finally {
      release();
      await settled;
    }
    await expect(pending).rejects.toThrow('Catalog binding authority changed while waiting');
    expect(snapshot()).toEqual(before);
  });

  it('rejects an invalid token and a mismatched declared workspace before changing bindings', async () => {
    addBinding('old', '/ws/Before');
    const before = snapshot();
    const handler = state.handlers.get('db:bindCatalogEntityFile')!;
    await expect(
      handler(
        { sender: state.sender },
        { entityId: 'target', path: '/ws/After', workspaceRoot: '/ws' },
        'invalid-token'
      )
    ).rejects.toThrow(/TOKEN_INVALID/);
    await expect(
      handler(
        { sender: state.sender },
        { entityId: 'target', path: '/other/After', workspaceRoot: '/ws' }
      )
    ).rejects.toThrow(/ROOT_MISMATCH|outside/);
    expect(snapshot()).toEqual(before);
  });

  it('borrows the active creation capability when a previously unknown parent folder needs a binding', async () => {
    const release = await acquireWorkspaceMutationShared('/ws');
    const token = workspaceMutationCapabilities.issue(state.sender!.id, '/ws', release);
    const writer = acquireWorkspaceSyncMutationLease('/ws');
    let settled = false;
    const creation = registerContextualCatalogEntity({
      id: 'target',
      type: 'notebook',
      name: 'Notebook',
      locator: 'entity://page/target',
      storageType: 'database',
      workspaceRoot: '/ws',
      context: { targetPath: '/ws/New folder', targetKind: 'folder' },
      mutationToken: token,
    }).finally(() => {
      settled = true;
    });
    try {
      await vi.waitFor(() =>
        expect(settled || workspaceMutationWaiterCountForTest('/ws') > 1).toBe(true)
      );
      expect(settled).toBe(true);
      await expect(creation).resolves.toMatchObject({ id: 'target' });
      expect(
        state.db!.prepare("SELECT path FROM catalog_entity_files WHERE status='current'").all()
      ).toEqual([{ path: '/ws/New folder' }]);
    } finally {
      workspaceMutationCapabilities.release(token, state.sender!.id);
      (await writer)();
      await creation;
    }
  });

  it('retains the missing loose-file identity when no workspace owns it', async () => {
    state.db!.prepare('UPDATE catalog_entities SET workspace_id = NULL WHERE id = ?').run('target');
    addBinding('loose', '/loose/Before', { status: 'missing', workspaceId: null });
    const bound = await bindCatalogEntityToFile({
      entityId: 'target',
      path: '/loose/After',
      contentHash: sha256,
    });
    expect(bound).toMatchObject({
      id: 'loose',
      object_uuid: 'object-loose',
      workspace_id: null,
      path: '/loose/After',
    });
  });

  it('waits for the project that owns the previous current when the new destination is a loose file', async () => {
    state.db!.prepare('UPDATE catalog_entities SET workspace_id = NULL WHERE id = ?').run('target');
    addBinding('old', '/other/Before', { workspaceId: 8 });
    const before = snapshot();
    const release = await acquireWorkspaceSyncMutationLease('/other');
    const binding = bindCatalogEntityToFile({ entityId: 'target', path: '/loose/After' });
    try {
      await vi.waitFor(() => expect(workspaceMutationWaiterCountForTest('/other')).toBe(1));
      expect(snapshot()).toEqual(before);
    } finally {
      release();
    }
    await expect(binding).resolves.toMatchObject({
      workspace_id: null,
      path: '/loose/After',
      status: 'current',
    });
  });

  it('protects a previous current binding in another workspace while that project is being replaced', async () => {
    addBinding('old', '/other/Before', { workspaceId: 8 });
    const before = snapshot();
    const release = await acquireWorkspaceSyncMutationLease('/other');
    const binding = bindCatalogEntityToFile({
      entityId: 'target',
      path: '/ws/After',
      workspaceRoot: '/ws',
    });
    try {
      await vi.waitFor(() => expect(workspaceMutationWaiterCountForTest('/other')).toBe(1));
      expect(snapshot()).toEqual(before);
      const releaseDestination = tryAcquireWorkspaceMutationShared('/ws');
      try {
        expect(releaseDestination).toBeTypeOf('function');
      } finally {
        releaseDestination?.();
      }
    } finally {
      release();
    }
    await expect(binding).resolves.toMatchObject({ status: 'current', workspace_id: 7 });
  });

  it('fails closed across busy projects when the destination capability is already held', async () => {
    addBinding('old', '/other/Before', { workspaceId: 8 });
    const before = snapshot();
    const releaseOther = await acquireWorkspaceMutationShared('/other');
    const releaseDestination = await acquireWorkspaceMutationShared('/ws');
    const token = workspaceMutationCapabilities.issue(state.sender!.id, '/ws', releaseDestination);
    try {
      await expect(
        bindCatalogEntityToFile({
          entityId: 'target',
          path: '/ws/After',
          workspaceRoot: '/ws',
          mutationToken: token,
        })
      ).rejects.toThrow(/WORKSPACE_MUTATION_ADDITIONAL_ROOT_BUSY/);
      expect(snapshot()).toEqual(before);
      expect(workspaceMutationWaiterCountForTest('/other')).toBe(0);
    } finally {
      releaseOther();
      workspaceMutationCapabilities.release(token, state.sender!.id);
    }
  });

  it('keeps path identity immutable and backfills a legacy null object identity', async () => {
    addBinding('legacy', '/ws/Legacy', { status: 'historical', uuid: null });
    const backfilled = await bindCatalogEntityToFile({
      entityId: 'target',
      path: '/ws/Legacy',
      workspaceRoot: '/ws',
      objectUuid: 'supplied-object',
    });
    expect(backfilled).toMatchObject({
      id: 'legacy',
      object_uuid: 'supplied-object',
      created_at: 1,
    });
    const repeated = await bindCatalogEntityToFile({
      entityId: 'target',
      path: '/ws/Legacy',
      workspaceRoot: '/ws',
      objectUuid: 'attempted-replacement',
    });
    expect(repeated.object_uuid).toBe('supplied-object');
  });

  it('retains committed catalog entities when a later request presents their ID or their exact file binding', async () => {
    addBinding('published', '/ws/Published');
    const db = state.db!;
    db.prepare(
      `INSERT INTO catalog_entity_events(id,entity_id,event_type,actor,created_at)
      VALUES('published-history','target','created','user',1)`
    ).run();
    const before = snapshot();
    const unbound = state.handlers.get('db:deleteCatalogEntityIfUnbound')!;
    const bound = state.handlers.get('db:deleteCatalogEntityWithExactBinding')!;
    const sender = { sender: state.sender };
    await expect(
      Promise.resolve().then(() =>
        bound(sender, {
          entityId: 'historical-owner',
          path: '/ws/Published',
          fileKind: 'waypoint-notebook',
        })
      )
    ).resolves.toBe(false);
    await expect(
      Promise.resolve().then(() =>
        bound(sender, {
          entityId: 'target',
          path: '/ws/Published',
          fileKind: 'waypoint-notebook',
        })
      )
    ).rejects.toThrow(/already committed/i);
    await expect(Promise.resolve().then(() => unbound(sender, 'historical-owner'))).rejects.toThrow(
      /already committed/i
    );
    expect(snapshot()).toEqual(before);
  });

  it('refuses a standalone workspace reset containing a published non-FASTA catalog', async () => {
    addBinding('published', '/ws/Published');
    state.db!.exec(`INSERT INTO catalog_entity_events(id,entity_id,event_type,actor,created_at)
      VALUES('published-event','target','created','user',1);
      INSERT INTO catalog_entity_links(id,source_entity_id,target_entity_id,relation,confidence,created_at,updated_at)
      VALUES('published-link','target','historical-owner','mentions','confirmed',1,1)`);
    const before = snapshot();
    const clear = state.handlers.get('db:clearCatalogProjection')!;
    const sender = { sender: state.sender };
    await expect(Promise.resolve().then(() => clear(sender, '/ws'))).rejects.toThrow(
      /populated catalog/i
    );
    expect(snapshot()).toEqual(before);
    expect(state.db!.prepare('SELECT id FROM catalog_entity_links').all()).toEqual([
      { id: 'published-link' },
    ]);
    expect(await clear(sender, '/other')).toEqual({
      workspaceId: 8,
      entities: 0,
      files: 0,
      links: 0,
      events: 0,
    });
  });

  it('atomically replays into an empty workspace and can retry after a mid-replay failure', async () => {
    const before = snapshot();
    const db = state.db!;
    const snapshotSource = vi.spyOn(projectMemory, 'readProjectMemory').mockResolvedValue({
      manifest: null,
      events: [],
      files: [],
      links: [],
      conflicts: [],
      entities: ['first', 'second'].map((id) => ({
        id,
        displayName: id,
        schema: 'waypoint.project-memory.entity.v1',
        kind: 'design',
        status: 'active',
        createdByEventId: id,
        updatedByEventId: id,
      })),
    });
    const desktop = vi.spyOn(environment, 'isDesktopRuntime').mockReturnValue(true);
    try {
      db.exec(`CREATE TRIGGER fail_second_replay BEFORE INSERT ON catalog_entities
        WHEN NEW.id='second' BEGIN SELECT RAISE(ABORT,'interrupted recovery'); END;`);
      const input = { workspaceRoot: '/other' };
      await expect(rebuildWorkspaceCatalogProjection(input)).rejects.toThrow(
        'interrupted recovery'
      );
      expect(snapshot()).toEqual(before);
      expect(db.inTransaction).toBe(false);
      db.exec('DROP TRIGGER fail_second_replay');
      const result = await rebuildWorkspaceCatalogProjection(input);
      expect(result.projectMemory.entities).toBe(2);
      expect(
        db.prepare('SELECT id FROM catalog_entities WHERE workspace_id=8 ORDER BY id').all()
      ).toEqual([{ id: 'first' }, { id: 'second' }]);
      const recovered = snapshot();
      await expect(
        rebuildWorkspaceCatalogProjection({ ...input, clearExisting: false })
      ).rejects.toThrow(/populated catalog/i);
      expect(snapshot()).toEqual(recovered);
    } finally {
      desktop.mockRestore();
      snapshotSource.mockRestore();
    }
  });

  it('rolls back only its own new catalog row when first binding fails', async () => {
    const db = state.db!;
    const before = snapshot();
    db.exec(`CREATE TRIGGER fail_new_binding BEFORE INSERT ON catalog_entity_files
      WHEN NEW.path='/ws/new.txt' BEGIN SELECT RAISE(ABORT,'simulated first binding failure'); END;`);
    await expect(
      registerWorkspaceFile({ path: '/ws/new.txt', workspaceRoot: '/ws', fileKind: 'file' })
    ).rejects.toThrow('simulated first binding failure');
    expect(snapshot()).toEqual(before);
    expect(
      db.prepare("SELECT id FROM catalog_entities WHERE locator='file:///ws/new.txt'").get()
    ).toBeUndefined();
  });

  it('obeys the renderer database fence without demoting any current binding', async () => {
    addBinding('old', '/ws/Before');
    const before = snapshot();
    const release = await acquireWorkspaceSyncDatabaseFence(state.db!);
    try {
      const handler = state.handlers.get('db:bindCatalogEntityFile')!;
      await expect(
        handler(
          { sender: state.sender },
          { entityId: 'target', path: '/ws/After', workspaceRoot: '/ws' }
        )
      ).rejects.toThrow(/database.*busy|Database.*busy|WORKSPACE_SYNC_DATABASE_BUSY/i);
      expect(snapshot()).toEqual(before);
    } finally {
      release();
    }
  });

  it('cannot join another renderer’s open transaction', async () => {
    addBinding('old', '/ws/Before');
    const before = snapshot();
    const execute = state.handlers.get('db:execute')!;
    const binding = state.handlers.get('db:bindCatalogEntityFile')!;
    const otherSender = Object.assign(new EventEmitter(), { id: state.sender!.id + 1 });
    await execute({ sender: state.sender }, 'BEGIN');
    try {
      await expect(
        binding(
          { sender: otherSender },
          { entityId: 'target', path: '/ws/After', workspaceRoot: '/ws' }
        )
      ).rejects.toThrow(/DATABASE_TRANSACTION_OWNED_BY_ANOTHER_RENDERER/);
      expect(snapshot()).toEqual(before);
    } finally {
      await execute({ sender: state.sender }, 'ROLLBACK');
    }
  });
});

it('lets a project rebuild register a file while an ordinary opener waits for its write lease', async () => {
  const root = '/ws';
  const ownerId = state.sender!.id;
  const release = await acquireWorkspaceMutationShared(root);
  const token = workspaceMutationCapabilities.issue(ownerId, root, release);
  const input = {
    path: '/ws/coordinates.cif',
    name: 'Coordinates',
    entityType: 'structure' as const,
    fileKind: 'cif',
    workspaceRoot: root,
    contentHash: sha256,
  };
  const ordinary = registerWorkspaceFile(input);
  const ordinarySettled = ordinary.then(
    () => undefined,
    () => undefined
  );
  let ownedSettled: Promise<unknown> | undefined;
  let ownerFinishedBeforeRelease = false;
  try {
    await vi.waitFor(() => expect(workspaceMutationWaiterCountForTest(root)).toBeGreaterThan(0));
    const owned = registerWorkspaceFile({ ...input, mutationToken: token });
    ownedSettled = owned.then(
      () => true,
      () => false
    );
    ownerFinishedBeforeRelease = await Promise.race([
      ownedSettled.then((value) => value === true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 150)),
    ]);
  } finally {
    workspaceMutationCapabilities.release(token, ownerId);
    await Promise.all([ordinarySettled, ownedSettled]);
  }
  expect(ownerFinishedBeforeRelease).toBe(true);
});
