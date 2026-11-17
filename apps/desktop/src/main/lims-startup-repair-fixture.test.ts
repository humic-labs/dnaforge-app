/** @vitest-environment node */
import type Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
  db: undefined as Database.Database | undefined,
  profile: '',
  packaged: false,
}));
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: {
    getPath: (name: string) => (name === 'userData' ? host.profile : tmpdir()),
    getVersion: () => 'test',
    getAppPath: () => process.cwd(),
    get isPackaged() {
      return host.packaged;
    },
  },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('./ipc/database', () => ({ getDb: () => host.db }));
vi.mock('./auth/session-store', () => ({ getActiveStoredSession: async () => null }));
vi.mock('./analytics', () => ({ trackEvent: vi.fn() }));

import { ipcMain } from 'electron';
import { createFileTestDb, openFileTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import {
  buildSequencePackageDocument,
  sequencePackagePaths,
  serializeSequencePackageDocument,
} from '../db/sequence-package';
import { MANAGED_SEQUENCE_DOCUMENT_FIELD } from '../shared/managed-sequence-document';
import { MANAGED_SEQUENCE_PROJECTION_VERSION_FIELD } from '../shared/managed-sequence-registry-projection';
import { workspaceScopeKey } from '../shared/workspace-scoped-identity';
import {
  NATIVE_ENTITY_PROJECTION_VERSIONS,
  readCanonicalFileRegistryProjection,
  resolveNativeProjectionSourceOwner,
} from './entity-projection-receipts';
import { reconstructFileBackedRegistryEntity } from './file-backed-registry-mutation';
import { archiveLimsEntityInDb, registerLimsIpcHandlers } from './lims';
import { repairMissingAuthoritySequenceArchives } from './lims-missing-authority-repair';
import { prepareDisposableScenarioProfile } from './scenario-profile';
import { admitRegisteredProjectRootInMain } from './project-root-admission';
import { ScientificObjectStore } from './scientific-object-store';
import { defineScientificDocument } from '@waypoint/scientific-objects';
import {
  parseOperationId,
  parseResourceId,
  parseWorkspacePath,
} from '@waypoint/workspace-revisions';

const entityId = 'e2e-startup-repaired-sequence';
const name = 'E2E startup repaired sequence';
const packageRelativeRoot = 'sequences/startup-repair';
const channel = 'internalFixtures:seedMissingAuthorityArchive';
const sender = Object.assign(new EventEmitter(), { id: 8531, isDestroyed: () => false });
let fixture: ReturnType<typeof createFileTestDb>;
let root: string;
let packageRoot: string;
let paths: ReturnType<typeof sequencePackagePaths>;
let originalMarker: string;
let originalProduct: string;

const database = () => host.db!;
const request = () => ({ workspaceRoot: root, packageRelativeRoot, expectedPackageId: entityId });

function handler(channelName: string) {
  const found = new Map(vi.mocked(ipcMain.handle).mock.calls).get(channelName);
  expect(found, `The actual typed IPC handler ${channelName} must be registered`).toBeTypeOf(
    'function'
  );
  return found!;
}

function invoke(input: ReturnType<typeof request>) {
  return handler(channel)({ sender } as unknown as Electron.IpcMainInvokeEvent, input) as Promise<{
    entityId: string;
    workspaceId: number;
    archiveEventSeq: number;
  }>;
}

async function canonical() {
  const source = resolveNativeProjectionSourceOwner(database(), {
    adapterKind: 'sequence',
    entityId,
    workspaceKey: `scope:${workspaceScopeKey(null, 7)}`,
    relativePath: relative(root, paths.metaPath).replace(/\\/g, '/'),
    projectionVersion: NATIVE_ENTITY_PROJECTION_VERSIONS.sequence,
  });
  return (await readCanonicalFileRegistryProjection(database(), source, (work) => work()))
    .canonical;
}

async function registerCanonical() {
  const projected = await canonical();
  const result = await reconstructFileBackedRegistryEntity(
    database(),
    {
      action: 'register',
      input: {
        id: entityId,
        kind: projected.kind,
        name: projected.name,
        fields: projected.fields,
        workspaceId: 7,
        schemaRevisionId: projected.schemaSnapshot!.schemaRevisionId,
        schemaSnapshot: projected.schemaSnapshot,
        registrationStatus: projected.registrationStatus,
        domainStatus: projected.domainStatus,
        actor: 'ownership-control',
      },
    },
    (work) => work()
  );
  expect(result?.id).toBe(entityId);
  return result!;
}

async function tree(path: string, prefix = ''): Promise<Array<[string, string]>> {
  const result: Array<[string, string]> = [];
  for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    const child = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      result.push([`${child}/`, 'directory']);
      result.push(...(await tree(join(path, entry.name), `${child}/`)));
    } else result.push([child, (await readFile(join(path, entry.name))).toString('base64')]);
  }
  return result;
}

async function state() {
  const tables = database()
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table'
    AND (name LIKE 'lims_%' OR name LIKE 'catalog_%' OR name LIKE 'scientific_%'
      OR name LIKE 'org_registry_%' OR name='workspaces') ORDER BY name`
    )
    .all() as { name: string }[];
  return {
    files: await tree(root),
    tables: Object.fromEntries(
      tables.map(({ name: table }) => [table, database().prepare(`SELECT * FROM "${table}"`).all()])
    ),
  };
}

function row() {
  return database().prepare('SELECT * FROM lims_entity WHERE id=?').get(entityId) as {
    id: string;
    name: string;
    workspace_id: number;
    fields: string;
    tombstone: number;
    schema_revision_id: string;
    event_seq: number;
  };
}

function history() {
  return database()
    .prepare(
      `SELECT event_type,actor,event_seq FROM lims_audit
    WHERE subject_table='lims_entity' AND subject_id=? ORDER BY event_seq`
    )
    .all(entityId);
}

beforeEach(async () => {
  fixture = createFileTestDb('canonical-startup-fixture');
  host.db = fixture.db;
  root = join(fixture.tmpDir, 'project');
  host.profile = join(fixture.tmpDir, 'profile');
  await mkdir(root);
  await mkdir(host.profile);
  root = await realpath(root);
  host.profile = await realpath(host.profile);
  expect(
    prepareDisposableScenarioProfile({
      requested: true,
      argv: [`--user-data-dir=${host.profile}`],
      defaultUserData: host.profile,
    })
  ).toBe(host.profile);
  host.packaged = false;
  vi.stubEnv('DNAFORGE_ALLOW_SCENARIO_MUTATION', '1');
  vi.stubGlobal('__INTERNAL_FIXTURES_ENABLED__', true);
  ensureSchema(database(), fixture.dbPath);
  database()
    .prepare('INSERT INTO workspaces(id,name,path,created_at) VALUES(7,?,?,1)')
    .run('Startup repair project', root);
  admitRegisteredProjectRootInMain(root, {
    db: database(),
    managedRootDir: join(host.profile, 'managed-workspaces'),
  });
  packageRoot = join(root, packageRelativeRoot);
  paths = sequencePackagePaths(packageRoot);
  await mkdir(paths.metaDir, { recursive: true });
  originalMarker = serializeSequencePackageDocument(
    buildSequencePackageDocument({
      id: entityId,
      name,
      product: { file: paths.productPath.split('/').pop()! },
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
  );
  originalProduct =
    'LOCUS       STARTUP                  32 bp    DNA     circular\nORIGIN\n        1 acgtacgtac gtacgtacgt acgtacgtac gt\n//\n';
  await writeFile(paths.metaPath, originalMarker);
  await writeFile(paths.productPath, originalProduct);
  vi.mocked(ipcMain.handle).mockClear();
  registerLimsIpcHandlers();
  const { registerInternalFixtureHandlers } = await import('./ipc/internal-fixtures');
  registerInternalFixtureHandlers();
});

afterEach(() => {
  host.db?.close();
  host.db = undefined;
  fixture.cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('canonical historical startup archive fixture', () => {
  it('preserves the original malformed Register refusal and its files/audit unchanged', async () => {
    const before = await state();
    await expect(
      handler('lims:registerEntity')({ sender } as unknown as Electron.IpcMainInvokeEvent, {
        id: entityId,
        kind: 'sequence',
        name,
        workspaceId: 7,
        fields: {
          [MANAGED_SEQUENCE_DOCUMENT_FIELD]: {
            kind: 'managed-sequence',
            packageId: entityId,
            packageRoot,
          },
        },
      })
    ).rejects.toThrow('Registry mutation differs from its actual canonical file projection');
    expect(await state()).toEqual(before);
  });

  it('derives the real canonical projection, seeds only the historical archive, and restores the exact ID once after reopening SQLite', async () => {
    const projected = await canonical();
    expect(projected.fields[MANAGED_SEQUENCE_PROJECTION_VERSION_FIELD]).toBe(3);
    const result = await invoke(request());
    expect(result).toEqual({ entityId, workspaceId: 7, archiveEventSeq: row().event_seq });
    expect(row()).toMatchObject({
      id: entityId,
      name,
      workspace_id: 7,
      tombstone: 1,
      schema_revision_id: projected.fields.schemaRevisionId,
    });
    expect(JSON.parse(row().fields)).toEqual(projected.fields);
    expect(history()).toEqual([
      {
        event_type: 'entity_registered',
        actor: 'e2e-startup-repair-seed',
        event_seq: expect.any(Number),
      },
      {
        event_type: 'entity_archived',
        actor: 'workspace-reconcile-missing-authority',
        event_seq: result.archiveEventSeq,
      },
    ]);
    expect(await readFile(paths.metaPath, 'utf8')).toBe(originalMarker);
    expect(await readFile(paths.productPath, 'utf8')).toBe(originalProduct);
    database().close();
    host.db = openFileTestDb(fixture.dbPath);
    expect(repairMissingAuthoritySequenceArchives(database())).toEqual({
      candidates: 1,
      restored: 1,
      skippedMissingAuthority: 0,
      skippedIdentityMismatch: 0,
      skippedInvalidPackage: 0,
    });
    expect(row()).toMatchObject({ id: entityId, name, workspace_id: 7, tombstone: 0 });
    expect(JSON.parse(row().fields)).toEqual(projected.fields);
    expect(history().at(-1)).toMatchObject({
      event_type: 'entity_restored',
      actor: 'workspace-reconcile-missing-authority-repair',
    });
    const restored = await state();
    expect(repairMissingAuthoritySequenceArchives(database()).candidates).toBe(0);
    expect(await state()).toEqual(restored);
    expect(await readFile(paths.metaPath, 'utf8')).toBe(originalMarker);
    expect(await readFile(paths.productPath, 'utf8')).toBe(originalProduct);
  });

  it('refuses wrong identity and source selectors before any effect', async () => {
    for (const input of [
      { ...request(), expectedPackageId: 'different-stable-id' },
      { ...request(), packageRelativeRoot: '../outside-project' },
      { ...request(), packageRelativeRoot: 'sequences/missing-source' },
    ]) {
      const before = await state();
      await expect(invoke(input)).rejects.toThrow();
      expect(await state()).toEqual(before);
    }
    await rm(paths.productPath);
    const withoutProduct = await state();
    await expect(invoke(request())).rejects.toThrow();
    expect(await state()).toEqual(withoutProduct);
  });

  it('keeps packaged, unapproved profile and reference project admission closed', async () => {
    const before = await state();
    host.packaged = true;
    await expect(invoke(request())).rejects.toThrow();
    host.packaged = false;
    expect(await state()).toEqual(before);
    const approved = host.profile;
    host.profile = join(fixture.tmpDir, 'unapproved');
    await mkdir(host.profile);
    await expect(invoke(request())).rejects.toThrow();
    host.profile = approved;
    expect(await state()).toEqual(before);
    database().prepare("UPDATE workspaces SET access_mode='reference' WHERE id=7").run();
    const reference = await state();
    await expect(invoke(request())).rejects.toThrow();
    expect(await state()).toEqual(reference);
  });

  it('refuses a real accepted scientific owner without changing its accepted state or files', async () => {
    const resource = parseResourceId(entityId),
      path = parseWorkspacePath('accepted-sequence.json'),
      operation = parseOperationId('accepted-owner');
    if (!resource.ok || !path.ok || !operation.ok)
      throw new Error('Invalid synthetic accepted owner.');
    const document = defineScientificDocument({
      formatVersion: 1,
      kind: 'sequence',
      name,
      molecule: 'DNA',
      bases: 'ACGTACGT',
      topology: 'linear',
      annotations: [],
      fields: {},
    });
    const store = new ScientificObjectStore(database(), 7);
    expect(
      store.submit({
        operationId: operation.value,
        expectedHead: null,
        mutations: [
          {
            kind: 'create-resource',
            resourceId: resource.value,
            path: path.value,
            state: document.state,
            origin: { kind: 'created' },
          },
        ],
        blobs: [new TextEncoder().encode(document.text)],
      }).kind
    ).toBe('changed');
    const before = await state();
    await expect(invoke(request())).rejects.toThrow();
    expect(await state()).toEqual(before);
  });

  it('preserves the real registered sequence lifecycle guard and refuses its organization binding', async () => {
    const registered = await registerCanonical();
    database()
      .prepare(
        `INSERT INTO org_registry_local_records
      (org_id,account_id,entity_id,client_id,workspace_id,workspace_uuid,home_workspace_id,kind,
       local_schema_revision_id,authority_kind,schema_id,schema_revision_id,claim_mutation_id,
       claim_source_revision,claim_local_event_seq,created_at,updated_at)
      VALUES('fixture-org','fixture-account',?,'fixture-client',7,'fixture-workspace','fixture-home',
       'sequence',?,'sequence_package','fixture-schema','fixture-revision','fixture-claim',?, ?,1,1)`
      )
      .run(entityId, registered.schemaRevisionId, 'a'.repeat(64), registered.eventSeq);
    const before = await state();
    expect(() => archiveLimsEntityInDb(database(), { id: entityId, actor: 'local-user' })).toThrow(
      'registered sequence'
    );
    expect(await state()).toEqual(before);
    await expect(invoke(request())).rejects.toThrow();
    expect(await state()).toEqual(before);
  });

  it('does not replace a later user archive with the historical actor', async () => {
    const registered = await registerCanonical();
    archiveLimsEntityInDb(database(), {
      id: entityId,
      expectedEventSeq: registered.eventSeq,
      actor: 'local-user',
    });
    const before = await state();
    await expect(invoke(request())).rejects.toThrow();
    expect(await state()).toEqual(before);
    expect(repairMissingAuthoritySequenceArchives(database()).candidates).toBe(0);
  });
});
