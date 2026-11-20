import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
  readdir,
  stat,
  utimes,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { serializeGenBank } from '@waypoint/sequence-utils';

const ipc = vi.hoisted(() => ({
  databases: new Map<string, Database.Database>(),
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
  getDb: () => {
    const db = ipc.databases.get('current');
    if (!db) throw new Error('The test database is unavailable.');
    return db;
  },
}));

import { createFileTestDb } from './test-db';
import { ensureSchema } from '../schema';
import { createLimsBridgeForDb } from './lims-bridge-for-db';
import { registerLimsIpcHandlers } from '../lims';
import {
  buildSequencePackageDocument,
  parseSequencePackageDocument,
  sequencePackagePaths,
  serializeSequencePackageDocument,
} from '../../db/sequence-package';
import { BUILTIN_SEQUENCE_SCHEMA_SNAPSHOT } from '../../shared/sequence-entity-schema';
import * as atomic from '../primer-artifact-files';
import { registerDatabaseHandlers } from '../ipc/database';
import { workspaceMutationCapabilities } from '../ipc/workspace-mutation-capability';
import {
  acquireWorkspaceMutationShared,
  workspaceMutationRootIdentity,
} from '../workspace-sync-mutation-lease';
import { acquireWorkspaceSyncDatabaseFence } from '../workspace-sync-database-fence';
import { legacySequenceMetadataTransactionPath } from '../sequence-package-legacy-metadata-journal';

let fixture: ReturnType<typeof createFileTestDb>;
let root: string;
let metadataPath: string;
let productPath: string;
let original: string;
let product: string;
let registryId: string | null;
const packageId = 'legacy-plasmid';
const sender = Object.assign(new EventEmitter(), { id: 947 });
const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex');

function sourceRequest() {
  return {
    workspaceId: 7,
    packageId,
    metadataPath,
    expectedMetadataSha256: digest(original),
    expectedProductSha256: digest(product),
  };
}

function invoke(request: unknown = sourceRequest(), token?: unknown) {
  const handler = ipc.handlers.get('lims:reconstructLegacyAcceptedPlasmid');
  if (!handler) throw new Error('The checked legacy Plasmid reconstruction IPC is missing.');
  return Promise.resolve(handler({ sender }, request, token));
}

beforeEach(async () => {
  fixture = createFileTestDb('legacy-plasmid-reconstruction');
  ensureSchema(fixture.db, fixture.dbPath);
  ipc.databases.set('current', fixture.db);
  root = await mkdtemp(join(tmpdir(), 'legacy-plasmid-reconstruction-'));
  const packageRoot = join(root, 'Accepted');
  metadataPath = sequencePackagePaths(packageRoot).metaPath;
  productPath = join(packageRoot, 'accepted.gb');
  await mkdir(sequencePackagePaths(packageRoot).metaDir, { recursive: true });
  fixture.db
    .prepare(
      "INSERT INTO workspaces(id,name,path,repo_uuid,created_at) VALUES(7,'Legacy source',?,'legacy-scope',1)"
    )
    .run(root);
  const bridge = createLimsBridgeForDb(fixture.db);
  const entity = await bridge.registerEntity({
    id: packageId,
    kind: 'plasmid',
    name: 'Legacy accepted plasmid',
    fields: { cloningMethod: 'gibson', notes: 'Registry note', assemblyBookkeeping: 'excluded' },
    registrationStatus: 'registered',
    domainStatus: 'ready',
    workspaceId: 7,
  });
  registryId = entity.registryId;
  fixture.db
    .prepare(
      "INSERT INTO catalog_entities(id,type,name,locator,storage_type,workspace_id,created_at,updated_at) VALUES(?,'sequence','Legacy source',?,'file',7,1,1) ON CONFLICT(id) DO UPDATE SET type='sequence',locator=excluded.locator,storage_type='file',workspace_id=7"
    )
    .run(packageId, productPath);
  fixture.db
    .prepare(
      "INSERT INTO catalog_entity_files(id,entity_id,workspace_id,path,file_kind,created_at,updated_at) VALUES('legacy-product',?,7,?,'waypoint-sequence',1,1)"
    )
    .run(packageId, productPath);
  fixture.db
    .prepare(
      "INSERT INTO workspace_sync_bindings(workspace_id,workspace_uuid,owner_account_id,remote_workspace_id,enabled,access_role,created_at,updated_at) VALUES(7,'legacy-scope','account-a','remote-a',0,'viewer',1,1)"
    )
    .run();
  const document = buildSequencePackageDocument({
    id: packageId,
    name: 'Legacy accepted plasmid',
    product: { file: 'accepted.gb', topology: 'circular' },
    assembly: { accepted: { type: 'accepted_assembly', acceptedAssemblyVersionId: packageId } },
    entity: {
      schema: BUILTIN_SEQUENCE_SCHEMA_SNAPSHOT,
      fields: { description: 'Package-only metadata' },
      registrationStatus: 'tracked',
      domainStatus: null,
      registryId: null,
      relationships: [],
      source: { experiment: 'preserve-source' },
    },
  });
  original = serializeSequencePackageDocument(document);
  product = serializeGenBank({
    id: packageId,
    name: 'Legacy accepted plasmid',
    sequence: 'ACGTACGT',
    length: 8,
    circular: true,
    annotations: [],
    description: '',
  });
  await writeFile(metadataPath, original);
  await writeFile(productPath, product);
  ipc.handlers.clear();
  registerLimsIpcHandlers();
});

afterEach(async () => {
  vi.restoreAllMocks();
  workspaceMutationCapabilities.releaseOwner(sender.id);
  workspaceMutationCapabilities.releaseOwner(sender.id + 1);
  ipc.databases.clear();
  await rm(root, { recursive: true, force: true });
  fixture.cleanup();
});

async function unchangedSource() {
  expect(await readFile(metadataPath, 'utf8')).toBe(original);
  expect(await readFile(productPath, 'utf8')).toBe(product);
  expect(await readdir(sequencePackagePaths(join(root, 'Accepted')).metaDir)).toEqual([
    'plasmid.json',
  ]);
}

it.each(['content', 'actor', 'workspaceRoot'])(
  'rejects renderer replacement authority in %s',
  async (key) => {
    await expect(invoke({ ...sourceRequest(), [key]: 'renderer-controlled' })).rejects.toThrow(
      /bounded source identity/
    );
    await unchangedSource();
  }
);

it.each(['metadata', 'product', 'package'])(
  'refuses a mismatching observed %s identity',
  async (identity) => {
    const request = sourceRequest();
    if (identity === 'metadata') request.expectedMetadataSha256 = '0'.repeat(64);
    if (identity === 'product') request.expectedProductSha256 = '0'.repeat(64);
    if (identity === 'package') request.packageId = 'other-package';
    await expect(invoke(request)).rejects.toThrow(/changed|identity/);
    await unchangedSource();
  }
);

it.each(['reference', 'archived', 'wrong-owner', 'wrong-file', 'developer-source'])(
  'refuses %s without altering the source or audit',
  async (condition) => {
    if (condition === 'reference')
      fixture.db.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=7").run();
    if (condition === 'archived')
      fixture.db.prepare('UPDATE workspaces SET archived_at=2 WHERE id=7').run();
    if (condition === 'wrong-owner') {
      fixture.db
        .prepare("INSERT INTO workspaces(id,name,path,created_at) VALUES(8,'Other',?,1)")
        .run(join(root, 'other'));
      fixture.db.prepare('UPDATE catalog_entities SET workspace_id=8 WHERE id=?').run(packageId);
    }
    if (condition === 'wrong-file')
      fixture.db
        .prepare('UPDATE catalog_entity_files SET path=? WHERE entity_id=?')
        .run(`${productPath}.other`, packageId);
    if (condition === 'developer-source')
      fixture.db
        .prepare(
          "INSERT INTO settings(key,value,updated_at) VALUES('developer-import-source-roots',?,1)"
        )
        .run(JSON.stringify([root]));
    const audits = fixture.db.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all();
    await expect(invoke()).rejects.toThrow();
    await unchangedSource();
    expect(fixture.db.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all()).toEqual(audits);
  }
);

it('accepts the sender-owned canonical token and refuses foreign or invalid tokens', async () => {
  const foreign = workspaceMutationCapabilities.issue(
    sender.id + 1,
    workspaceMutationRootIdentity(root),
    () => {}
  );
  for (const token of [foreign, 'missing-token', '', null]) {
    await expect(invoke(sourceRequest(), token)).rejects.toThrow(
      'WORKSPACE_MUTATION_TOKEN_INVALID'
    );
    await unchangedSource();
  }
  const token = workspaceMutationCapabilities.issue(
    sender.id,
    workspaceMutationRootIdentity(root),
    await acquireWorkspaceMutationShared(root)
  );
  await expect(invoke(sourceRequest(), token)).resolves.toMatchObject({ kind: 'published' });
});

it('rejects same-renderer uncommitted Plasmid data and succeeds after rollback', async () => {
  registerDatabaseHandlers(() => fixture.db);
  const execute = ipc.handlers.get('db:execute');
  if (!execute) throw new Error('The real database execute IPC is missing.');
  await execute({ sender }, 'BEGIN');
  try {
    await expect(
      execute(
        { sender },
        "UPDATE lims_entity SET fields=json_set(fields,'$.notes','Uncommitted replacement') WHERE id=?",
        [packageId]
      )
    ).rejects.toThrow(/REGISTRY_AUTHORITY_REQUIRES_NATIVE_COMMAND/);
    await expect(invoke()).rejects.toThrow(
      /DATABASE_(?:TRANSACTION_OWNED_BY_ANOTHER_RENDERER|UNCOMMITTED_AUTHORITY_READ)/
    );
    await unchangedSource();
  } finally {
    await execute({ sender }, 'ROLLBACK');
  }
  await expect(invoke()).resolves.toMatchObject({ kind: 'published' });
  expect(
    parseSequencePackageDocument(await readFile(metadataPath, 'utf8')).entity.fields.notes
  ).toBe('Registry note');
});

it('respects the canonical database fence before reading publication authority', async () => {
  const release = await acquireWorkspaceSyncDatabaseFence(fixture.db);
  try {
    await expect(invoke()).rejects.toThrow('WORKSPACE_SYNC_DATABASE_BUSY');
    await unchangedSource();
  } finally {
    release();
  }
});

it.each(['project', 'account', 'schema', 'fields', 'file-owner'])(
  'rechecks %s immediately before durable publication',
  async (race) => {
    const write = atomic.writeWorkspaceTextFileAtomicInMain;
    vi.spyOn(atomic, 'writeWorkspaceTextFileAtomicInMain').mockImplementationOnce(
      (request, options) =>
        write(request, {
          ...options,
          beforePublish: (stagedPath) => {
            if (race === 'project')
              fixture.db.prepare("UPDATE workspaces SET repo_uuid='replacement' WHERE id=7").run();
            if (race === 'account')
              fixture.db
                .prepare(
                  "UPDATE workspace_sync_bindings SET owner_account_id='replacement' WHERE workspace_id=7"
                )
                .run();
            if (race === 'schema')
              fixture.db
                .prepare(
                  "UPDATE lims_schema SET version=version+1 WHERE kind='entity' AND name='plasmid'"
                )
                .run();
            if (race === 'fields')
              fixture.db
                .prepare(
                  "UPDATE lims_entity SET fields=json_set(fields,'$.notes','Replacement') WHERE id=?"
                )
                .run(packageId);
            if (race === 'file-owner')
              fixture.db
                .prepare('UPDATE catalog_entity_files SET path=? WHERE entity_id=?')
                .run(`${productPath}.replacement`, packageId);
            options?.beforePublish?.(stagedPath);
          },
        })
    );
    await expect(invoke()).rejects.toThrow(/authority changed|matching current file owner/);
    await unchangedSource();
  }
);

it('refuses a same-size product replacement with its original mtime restored', async () => {
  const before = await stat(productPath);
  const newer = product.replace(/acgtacgt/i, 'ACGTACGA');
  expect(newer).not.toBe(product);
  const write = atomic.writeWorkspaceTextFileAtomicInMain;
  vi.spyOn(atomic, 'writeWorkspaceTextFileAtomicInMain').mockImplementationOnce(
    async (request, options) => {
      await writeFile(productPath, newer);
      await utimes(productPath, before.atime, before.mtime);
      return write(request, options);
    }
  );
  await expect(invoke()).rejects.toThrow(/source generation changed/);
  expect(await readFile(metadataPath, 'utf8')).toBe(original);
  expect(await readFile(productPath, 'utf8')).toBe(newer);
});

it('allows routine timestamps and sync progress to advance before publication', async () => {
  const write = atomic.writeWorkspaceTextFileAtomicInMain;
  vi.spyOn(atomic, 'writeWorkspaceTextFileAtomicInMain').mockImplementationOnce(
    (request, options) =>
      write(request, {
        ...options,
        beforePublish: (stagedPath) => {
          fixture.db.prepare('UPDATE lims_entity SET updated_at=999 WHERE id=?').run(packageId);
          fixture.db
            .prepare('UPDATE catalog_entities SET updated_at=999 WHERE id=?')
            .run(packageId);
          fixture.db
            .prepare('UPDATE workspace_sync_bindings SET updated_at=999 WHERE workspace_id=7')
            .run();
          options?.beforePublish?.(stagedPath);
        },
      })
  );
  await expect(invoke()).resolves.toMatchObject({ kind: 'published' });
});

it('retains a pending legacy metadata journal without performing a second reconstruction', async () => {
  const journal = legacySequenceMetadataTransactionPath(join(root, 'Accepted'));
  const bytes = JSON.stringify({
    schema: 'waypoint.sequence-metadata-transaction.v1',
    state: 'pending',
    packageId,
    targetDocument: parseSequencePackageDocument(original),
  });
  await writeFile(journal, bytes);
  await expect(invoke()).rejects.toThrow(/pending|recovery/i);
  expect(await readFile(journal, 'utf8')).toBe(bytes);
  expect(await readFile(metadataPath, 'utf8')).toBe(original);
  expect(await readFile(productPath, 'utf8')).toBe(product);
});

it('propagates failed revision recovery and retains the journal and original sources', async () => {
  const journal = sequencePackagePaths(join(root, 'Accepted')).revisionJournalPath;
  const bytes = '{"retained-invalid-revision-journal":true}';
  await writeFile(journal, bytes);
  await expect(invoke()).rejects.toMatchObject({ name: 'SequencePackagePublicationRecoveryError' });
  expect(await readFile(journal, 'utf8')).toBe(bytes);
  expect(await readFile(metadataPath, 'utf8')).toBe(original);
  expect(await readFile(productPath, 'utf8')).toBe(product);
});

it('lets a viewer reconstruct only the actual historical Plasmid metadata once', async () => {
  const audits = fixture.db.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all();
  const result = await invoke();
  const bytes = await readFile(metadataPath, 'utf8');
  expect(result).toEqual({ kind: 'published', metadataSha256: digest(bytes) });
  const adopted = parseSequencePackageDocument(bytes);
  expect(adopted.entity.schema.name).toBe('plasmid');
  expect(adopted.entity.registryId).toBe(registryId);
  expect(adopted.entity.registrationStatus).toBe('registered');
  expect(adopted.entity.domainStatus).toBe('ready');
  expect(adopted.entity.fields).toEqual({
    description: 'Package-only metadata',
    cloningMethod: 'gibson',
    notes: 'Registry note',
  });
  expect(adopted.entity.source).toEqual({ experiment: 'preserve-source' });
  expect(adopted.entity.relationships).toEqual(
    parseSequencePackageDocument(original).entity.relationships
  );
  expect(await readFile(productPath, 'utf8')).toBe(product);
  expect(fixture.db.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all()).toEqual(audits);
  await expect(
    invoke({ ...sourceRequest(), expectedMetadataSha256: digest(bytes) })
  ).resolves.toEqual({
    kind: 'not-applicable',
  });
  expect(await readFile(metadataPath, 'utf8')).toBe(bytes);
});

it('uses the actual workspace identity when its stored root is an alias', async () => {
  const alias = join(root, 'root-alias');
  await symlink(root, alias, 'dir');
  fixture.db.prepare('UPDATE workspaces SET path=? WHERE id=7').run(alias);
  await expect(
    invoke({ ...sourceRequest(), metadataPath: await realpath(metadataPath) })
  ).resolves.toMatchObject({
    kind: 'published',
  });
  expect(
    parseSequencePackageDocument(await readFile(metadataPath, 'utf8')).entity.schema.name
  ).toBe('plasmid');
  expect(await readFile(productPath, 'utf8')).toBe(product);
});

it('refuses a marker symlink without modifying its retained target', async () => {
  const retained = `${metadataPath}.retained`;
  await rename(metadataPath, retained);
  await symlink(retained, metadataPath);
  await expect(invoke()).rejects.toThrow(/symbolic links|regular source/);
  expect(await readFile(retained, 'utf8')).toBe(original);
  expect(await readFile(productPath, 'utf8')).toBe(product);
});
