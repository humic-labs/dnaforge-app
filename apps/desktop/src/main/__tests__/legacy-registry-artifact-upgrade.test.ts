import { EventEmitter } from 'node:events';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
  truncate,
  stat,
} from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

const ipc = vi.hoisted(() => ({
  db: null as Database.Database | null,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      ipc.handlers.set(channel, handler),
  },
  app: { getPath: () => '/tmp', getVersion: () => '1.0.0', exit: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('../ipc/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ipc/database')>()),
  getDb: () => ipc.db,
}));

import { createFileTestDb } from './test-db';
import { ensureSchema } from '../schema';
import { registerDatabaseHandlers } from '../ipc/database';
import { createLimsBridgeForDb } from './lims-bridge-for-db';
import { registerLimsIpcHandlers } from '../lims';
import { workspaceMutationCapabilities } from '../ipc/workspace-mutation-capability';
import {
  acquireWorkspaceMutationShared,
  workspaceMutationRootIdentity,
} from '../workspace-sync-mutation-lease';
import { acquireWorkspaceSyncDatabaseFence } from '../workspace-sync-database-fence';
import * as atomic from '../primer-artifact-files';
import {
  entityArtifactSchemaSnapshot,
  parseEntityArtifact,
  ENTITY_ARTIFACT_SCHEMA,
  ENTITY_ARTIFACT_CURRENT_SCHEMA,
} from '../../shared/entity-artifact';
import type { LegacyRegistryArtifactUpgradeInput } from '../../shared/legacy-registry-artifact-upgrade';
import { MAX_WORKSPACE_BINARY_WRITE_BYTES } from '../../shared/workspace-file-atomic';

const sender = Object.assign(new EventEmitter(), { id: 731 });
let fileDb: ReturnType<typeof createFileTestDb>;
let root: string;
let token: string;
let input: LegacyRegistryArtifactUpgradeInput;
let original: string;
let bridge: ReturnType<typeof createLimsBridgeForDb>;

function invoke(request: unknown = input, capability: unknown = token, caller = sender) {
  const handler = ipc.handlers.get('lims:upgradeLegacyEntityArtifact');
  if (!handler) throw new Error('Registry upgrade IPC is not registered.');
  return Promise.resolve(handler({ sender: caller }, request, capability));
}

beforeEach(async () => {
  fileDb = createFileTestDb('registry-format-upgrade');
  ipc.db = fileDb.db;
  ensureSchema(fileDb.db, fileDb.dbPath);
  root = await mkdtemp(join(tmpdir(), 'registry-format-source-'));
  fileDb.db
    .prepare(
      `INSERT INTO workspaces(id,name,path,repo_uuid,created_at,last_opened_at) VALUES(7,'Registry source',?,'source-owner',1,1)`
    )
    .run(root);
  bridge = createLimsBridgeForDb(fileDb.db);
  const schema = (await bridge.listSchemas()).find((schema) => schema.entityKind === 'strain');
  if (!schema) throw new Error('Strain schema is missing.');
  const snapshot = entityArtifactSchemaSnapshot(schema);
  const fields = {
    genotypeCanonical: 'recA1',
    artifact: { schema: ENTITY_ARTIFACT_SCHEMA, relativePath: 'records/legacy.entity.json' },
  };
  const registered = await bridge.registerEntity({
    id: 'legacy-owned',
    kind: 'strain',
    name: 'Legacy owned strain',
    fields,
    schemaRevisionId: snapshot.schemaRevisionId,
    schemaSnapshot: snapshot,
    workspaceId: 7,
  });
  await bridge.refineSchema({
    schemaId: schema.schemaId,
    fields: [
      ...schema.fields,
      { key: 'laterRequired', label: 'Later required', type: 'text', required: true },
    ],
  });
  original = JSON.stringify({
    schema: ENTITY_ARTIFACT_SCHEMA,
    id: 'legacy-owned',
    kind: 'strain',
    name: 'Legacy owned strain',
    fields,
    registrationStatus: registered.registrationStatus,
    domainStatus: null,
    relationships: [],
    topExtension: { preserved: true },
    source: { type: 'manual', values: {}, sourceExtension: ['original'] },
  });
  input = {
    workspaceId: 7,
    workspaceRoot: root,
    path: join(root, fields.artifact.relativePath),
    entityId: 'legacy-owned',
    expectedContentHash: await atomic.sha256Text(original),
  };
  await mkdir(dirname(input.path), { recursive: true });
  await writeFile(input.path, original);
  fileDb.db
    .prepare(
      `INSERT INTO workspace_sync_bindings(workspace_id,workspace_uuid,owner_account_id,remote_workspace_id,enabled,access_role,created_at,updated_at) VALUES(7,'source-owner','account-a','remote-a',0,'viewer',1,1)`
    )
    .run();
  token = workspaceMutationCapabilities.issue(
    sender.id,
    workspaceMutationRootIdentity(root),
    await acquireWorkspaceMutationShared(root)
  );
  ipc.handlers.clear();
  registerLimsIpcHandlers();
});

afterEach(async () => {
  vi.restoreAllMocks();
  workspaceMutationCapabilities.releaseOwner(sender.id);
  await rm(root, { recursive: true, force: true });
  fileDb.cleanup();
  ipc.db = null;
});

async function state() {
  return {
    preview: await bridge.getRegistryPreview({ entityId: input.entityId }),
    audit: fileDb.db.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all(),
    outbox: fileDb.db.prepare('SELECT * FROM native_catalog_publication_outbox').all(),
  };
}

describe('checked main-owned Registry format reconstruction over real SQLite, files and IPC', () => {
  it('refuses an uncommitted archive upgrade from the same renderer token owner', async () => {
    const before = await state();
    registerDatabaseHandlers(() => fileDb.db);
    const execute = ipc.handlers.get('db:execute');
    if (!execute) throw new Error('Production database execute IPC is unavailable.');
    await execute({ sender }, 'BEGIN');
    let outcome: unknown;
    try {
      await expect(
        execute({ sender }, 'UPDATE lims_entity SET tombstone=1,archived_at=1 WHERE id=?', [
          input.entityId,
        ])
      ).rejects.toThrow(/REGISTRY_AUTHORITY_REQUIRES_NATIVE_COMMAND/);
      try {
        outcome = await invoke();
      } catch (error) {
        outcome = { refused: String(error) };
      }
    } finally {
      await execute({ sender }, 'ROLLBACK');
    }
    expect({
      outcome,
      unchangedSource: (await readFile(input.path, 'utf8')) === original,
    }).toMatchObject({
      outcome: {
        refused: expect.stringMatching(
          /DATABASE_(?:TRANSACTION_OWNED_BY_ANOTHER_RENDERER|UNCOMMITTED_AUTHORITY_READ)/
        ),
      },
      unchangedSource: true,
    });
    expect(await state()).toEqual(before);
  });

  it('accepts the canonical production token for a registered whole-workspace alias', async () => {
    const alias = join(fileDb.tmpDir, 'workspace-alias');
    await symlink(root, alias, 'dir');
    fileDb.db.prepare('UPDATE workspaces SET path=? WHERE id=7').run(alias);
    input = { ...input, workspaceRoot: alias, path: join(alias, 'records/legacy.entity.json') };
    const before = await state();
    expect(await invoke()).toEqual({ published: true });
    expect(parseEntityArtifact(await readFile(input.path, 'utf8'))).toMatchObject({
      schema: ENTITY_ARTIFACT_CURRENT_SCHEMA,
      schemaSnapshot: before.preview.schemaSnapshot,
      fields: before.preview.entity.fields,
    });
    expect(await state()).toEqual(before);
  });

  it.each([false, true])(
    'upgrades a viewer source with its frozen schema and unchanged archive/history (%s)',
    async (archived) => {
      if (archived) await bridge.archiveEntity({ id: input.entityId });
      const before = await state();
      expect(await invoke()).toEqual({ published: true });
      const saved = parseEntityArtifact(await readFile(input.path, 'utf8'));
      expect(saved).toMatchObject({
        schema: ENTITY_ARTIFACT_CURRENT_SCHEMA,
        schemaSnapshot: before.preview.schemaSnapshot,
        schemaRevisionId: before.preview.entity.schemaRevisionId,
        archived,
        fields: before.preview.entity.fields,
        topExtension: { preserved: true },
        source: { sourceExtension: ['original'] },
      });
      expect(await state()).toEqual(before);
      expect(await readdir(dirname(input.path))).toEqual(['legacy.entity.json']);
      expect(
        await invoke({
          ...input,
          expectedContentHash: await atomic.sha256Text(await readFile(input.path, 'utf8')),
        })
      ).toEqual({ published: false });
      expect(await state()).toEqual(before);
    }
  );

  it.each([
    'missing',
    'invalid',
    'foreign-sender',
    'different-root',
    'replacement-content',
  ] as const)('refuses %s without writing or changing history', async (failure) => {
    const before = await state();
    const request =
      failure === 'different-root'
        ? { ...input, workspaceRoot: dirname(root) }
        : failure === 'replacement-content'
          ? { ...input, content: 'arbitrary replacement' }
          : input;
    const capability =
      failure === 'missing' ? null : failure === 'invalid' ? 'not-a-capability' : token;
    const caller =
      failure === 'foreign-sender' ? Object.assign(new EventEmitter(), { id: 732 }) : sender;
    await expect(invoke(request, capability, caller)).rejects.toThrow();
    expect(await readFile(input.path, 'utf8')).toBe(original);
    expect(await state()).toEqual(before);
  });

  it.each([
    'reference',
    'archived',
    'trashed',
    'developer',
    'wrong-workspace',
    'wrong-binding',
    'divergent-fields',
    'divergent-relationships',
  ] as const)('preserves the source for %s authority', async (failure) => {
    if (failure === 'reference')
      fileDb.db.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=7").run();
    if (failure === 'archived')
      fileDb.db.prepare('UPDATE workspaces SET archived_at=1 WHERE id=7').run();
    if (failure === 'trashed')
      fileDb.db.prepare('UPDATE workspaces SET trashed_at=1 WHERE id=7').run();
    if (failure === 'developer')
      fileDb.db
        .prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,1)')
        .run('developer-import-source-roots', JSON.stringify([root]));
    if (failure === 'wrong-workspace') input.workspaceId = 8;
    if (failure === 'wrong-binding') {
      fileDb.db.prepare("DELETE FROM catalog_entities WHERE id='legacy-owned'").run();
      fileDb.db
        .prepare(
          `INSERT INTO catalog_entities(id,type,name,workspace_id,storage_type,locator,created_at,updated_at) VALUES('legacy-owned','lims-entity','Legacy owned strain',7,'file',?,1,1)`
        )
        .run(`file://${input.path}`);
      fileDb.db
        .prepare(
          `INSERT INTO catalog_entity_files(id,entity_id,workspace_id,path,file_kind,status,created_at,updated_at) VALUES('legacy-file','legacy-owned',7,?,'lims-entity','current',1,1)`
        )
        .run(join(root, 'other.entity.json'));
    }
    if (failure === 'divergent-fields') original = original.replace('recA1', 'different');
    if (failure === 'divergent-relationships') {
      const document = JSON.parse(original);
      document.relationships = [
        { type: 'derives_from', fromEntityId: input.entityId, toEntityId: 'another', payload: {} },
      ];
      original = JSON.stringify(document);
    }
    await writeFile(input.path, original);
    input.expectedContentHash = await atomic.sha256Text(original);
    const before = await state();
    expect(await invoke()).toEqual({ published: false });
    expect(await readFile(input.path, 'utf8')).toBe(original);
    expect(await state()).toEqual(before);
  });

  it('refuses escaping symlinks without changing the target or projection', async () => {
    const outside = join(fileDb.tmpDir, 'outside.entity.json');
    await writeFile(outside, original);
    await rm(input.path);
    await symlink(outside, input.path);
    const before = await state();
    await expect(invoke()).rejects.toThrow(/symbolic|inside/i);
    expect(await readFile(outside, 'utf8')).toBe(original);
    expect(await state()).toEqual(before);
  });

  it('refuses oversized source files before allocating or parsing their payload', async () => {
    await truncate(input.path, MAX_WORKSPACE_BINARY_WRITE_BYTES + 1);
    const before = await state();
    await expect(invoke()).rejects.toThrow(/Files size bound/);
    expect((await stat(input.path)).size).toBe(MAX_WORKSPACE_BINARY_WRITE_BYTES + 1);
    expect(await state()).toEqual(before);
    expect(await readdir(dirname(input.path))).toEqual(['legacy.entity.json']);
  });

  it('rejects stale source hashes before publication', async () => {
    const newer = original.replace('Legacy owned strain', 'External change');
    await writeFile(input.path, newer);
    const before = await state();
    await expect(invoke()).rejects.toThrow(/changed/);
    expect(await readFile(input.path, 'utf8')).toBe(newer);
    expect(await state()).toEqual(before);
  });

  it('preserves a concurrent external revision between inspection and CAS publication', async () => {
    const newer = original.replace('Legacy owned strain', 'Concurrent external revision');
    const write = atomic.writeWorkspaceTextFileAtomicInMain;
    vi.spyOn(atomic, 'writeWorkspaceTextFileAtomicInMain').mockImplementationOnce(
      async (request, options) => {
        await writeFile(request.path, newer);
        return write(request, options);
      }
    );
    const before = await state();
    await expect(invoke()).rejects.toThrow(/changed/);
    expect(await readFile(input.path, 'utf8')).toBe(newer);
    expect(await state()).toEqual(before);
    expect(await readdir(dirname(input.path))).toEqual(['legacy.entity.json']);
  });

  it('rejects a source whose embedded entity identity differs from the checked owner', async () => {
    const other = original.replace('legacy-owned', 'another-identity');
    await writeFile(input.path, other);
    input.expectedContentHash = await atomic.sha256Text(other);
    const before = await state();
    await expect(invoke()).rejects.toThrow(/identity/);
    expect(await readFile(input.path, 'utf8')).toBe(other);
    expect(await state()).toEqual(before);
  });

  it.each(['workspace-owner', 'remote-owner', 'projection'] as const)(
    'rechecks %s after staging and refuses without partial publication',
    async (race) => {
      const write = atomic.writeWorkspaceTextFileAtomicInMain;
      vi.spyOn(atomic, 'writeWorkspaceTextFileAtomicInMain').mockImplementationOnce(
        (request, options) =>
          write(request, {
            ...options,
            beforePublish: (stagedPath) => {
              if (race === 'workspace-owner')
                fileDb.db.prepare("UPDATE workspaces SET repo_uuid='replacement' WHERE id=7").run();
              if (race === 'remote-owner')
                fileDb.db
                  .prepare(
                    "UPDATE workspace_sync_bindings SET owner_account_id='replacement' WHERE workspace_id=7"
                  )
                  .run();
              if (race === 'projection')
                fileDb.db
                  .prepare("UPDATE lims_entity SET name='Replacement projection' WHERE id=?")
                  .run(input.entityId);
              options?.beforePublish?.(stagedPath);
            },
          })
      );
      await expect(invoke()).rejects.toThrow(/authority changed/);
      expect(await readFile(input.path, 'utf8')).toBe(original);
      expect(await readdir(dirname(input.path))).toEqual(['legacy.entity.json']);
    }
  );

  it('respects the renderer database fence before any source change', async () => {
    const release = await acquireWorkspaceSyncDatabaseFence(fileDb.db);
    try {
      await expect(invoke()).rejects.toThrow('WORKSPACE_SYNC_DATABASE_BUSY');
      expect(await readFile(input.path, 'utf8')).toBe(original);
    } finally {
      release();
    }
  });
});
