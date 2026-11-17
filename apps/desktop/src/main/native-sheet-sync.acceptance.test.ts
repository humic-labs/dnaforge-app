/** @vitest-environment node */
import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';

const host = vi.hoisted(() => ({
  db: undefined as Database.Database | undefined,
  profile: undefined as string | undefined,
}));
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: () => host.profile ?? '/tmp', getVersion: () => 'test' },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('./ipc/database', () => ({ getDb: () => host.db }));

import { createTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { createNativeImportReviews } from './native-import-reviews';
import { registerSelectedLocalIndexedTrackPaths } from './local-indexed-track-authority';
import { assertProjectFilesystemMutationAllowed } from './project-filesystem-authority';
import { queryLimsEntitiesInDb, refineLimsSchemaInDb } from './lims';
import { listLimsEntitySchemasInDb } from './lims-engine-core';
import { parsePrimerArtifact } from '../shared/primer-artifacts/primer-artifact';
import { parseImportSetManifest } from '../shared/registry-artifacts/import-set-core';
import {
  parseSheetSyncSnapshot,
  type StoredSheetSyncConnection,
} from '../shared/registry-artifacts/sheet-sync/persistence';
import type { SheetSyncPrepared } from '../shared/registry-artifacts/sheet-sync/command';
import { ScientificObjectStore } from './scientific-object-store';
import { readScientificDocumentInMain } from './scientific-document-reader';
import { parseScientificDocumentIdentity, parseWorkspaceIdentity } from '@waypoint/domain-services';
import { workspaceScopeKey } from '../shared/workspace-scoped-identity';
import * as sidecarRuntime from './sidecar-session-runtime';

let directory: string;
let root: string;
let profile: string;
let master: string;
const bases = 'GTAAAACGACGGCCAGT';
const initialRows = [
  ['Stable ID', 'Name', 'Sequence', 'Notes'],
  ['001', 'Forward A', bases, 'first'],
  ['002', 'Forward B', bases, 'second'],
];
const localTmSettings = {
  userSetting: { kind: 'local' as const, algorithm: 'santalucia98' as const },
  userSettingIsExplicit: true,
  conditions: { monovalentMm: 50, divalentMm: 0, dntpMm: 0 },
  concNm: 500,
};
const database = () => host.db!;
const owner = () =>
  createNativeImportReviews({
    db: database,
    workspaceRoots: () => [root],
    profileDirectory: () => profile,
    authorizeAgent: async () => {},
  });
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

function source(path = master) {
  return {
    path,
    sheetName: 'Primers',
    keyColumn: 'Stable ID',
    forcedKind: 'oligo' as const,
    columnMappings: [
      { sourceColumn: 'Stable ID', mappingMode: 'source_only' as const },
      { sourceColumn: 'Name', mappedField: 'entity.name', mappingMode: 'mapped' as const },
      { sourceColumn: 'Sequence', mappedField: 'fields.sequence', mappingMode: 'mapped' as const },
      { sourceColumn: 'Notes', mappedField: 'fields.notes', mappingMode: 'mapped' as const },
    ],
  };
}

async function workbook(rows = initialRows, path = master) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), 'Primers');
  await writeFile(path, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
  return readFile(path);
}

async function prepare(service: ReturnType<typeof owner>, path = master) {
  const result = await service.sheetSync({
    workspaceRoot: root,
    command: {
      kind: 'prepare',
      source: source(path),
      destinationRelativePath: 'spreadsheets',
      primerTmSettings: localTmSettings,
    },
  });
  expect(result.kind).toBe('prepared');
  return result as SheetSyncPrepared;
}

async function inspect(service: ReturnType<typeof owner>, id: string) {
  const result = await service.sheetSync({ workspaceRoot: root, command: { kind: 'inspect', id } });
  expect(result.kind).toBe('connection');
  if (result.kind !== 'connection') throw new Error('Expected the retained connection.');
  return result.stored;
}

async function tree(path: string, prefix = ''): Promise<Array<[string, string]>> {
  const result: Array<[string, string]> = [];
  for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      result.push([`${relative}/`, 'directory']);
      result.push(...(await tree(join(path, entry.name), `${relative}/`)));
    } else result.push([relative, (await readFile(join(path, entry.name))).toString('base64')]);
  }
  return result;
}

async function effects() {
  const tables = database()
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND
       (name LIKE 'lims_%' OR name LIKE 'scientific_%' OR name LIKE 'catalog_%'
        OR name IN ('primers', 'settings', 'native_catalog_publication_outbox')) ORDER BY name`
    )
    .all() as Array<{ name: string }>;
  return {
    files: await tree(root),
    rows: Object.fromEntries(
      tables.map(({ name }) => [name, database().prepare(`SELECT * FROM "${name}"`).all()])
    ),
  };
}

async function assertPublished(stored: StoredSheetSyncConnection, names: string[]) {
  expect(stored.connection.pending).toBeNull();
  expect(stored.connection.checkpoints.map((checkpoint) => checkpoint.key)).toEqual(['001', '002']);
  const records = queryLimsEntitiesInDb(database(), { workspaceId: 7, kind: 'oligo' });
  expect(records).toHaveLength(2);
  for (const [index, checkpoint] of stored.connection.checkpoints.entries()) {
    const path = join(root, checkpoint.artifactRelativePath);
    const content = await readFile(path, 'utf8');
    const artifact = parsePrimerArtifact(content);
    expect(artifact).toMatchObject({
      id: checkpoint.entityId,
      name: names[index],
      sequence: { bases, length: bases.length, contentHash: digest(bases) },
      registry: { entityId: checkpoint.entityId, kind: 'oligo' },
      computed: {
        tmCalculation: {
          model: localTmSettings.userSetting,
          source: 'user-setting',
          status: 'local',
        },
      },
    });
    expect(Number.isFinite(artifact.computed.tmCalculation?.valueC)).toBe(true);
    const record = records.find((candidate) => candidate.id === checkpoint.entityId);
    expect(record).toMatchObject({
      name: names[index],
      workspaceId: 7,
      schemaRevisionId: artifact.entity?.schema.schemaRevisionId,
      fields: { artifact: { relativePath: checkpoint.artifactRelativePath } },
    });
    expect(
      database()
        .prepare(
          'SELECT entity_id,workspace_id,relative_path,status FROM catalog_entity_files WHERE path=?'
        )
        .get(path)
    ).toMatchObject({
      entity_id: checkpoint.entityId,
      workspace_id: 7,
      relative_path: checkpoint.artifactRelativePath,
      status: 'current',
    });
    const accepted = await readScientificDocumentInMain(
      {
        operationId: randomUUID(),
        workspaceRoot: root,
        workspace: parseWorkspaceIdentity(workspaceScopeKey(null, 7)),
        document: parseScientificDocumentIdentity(checkpoint.artifactRelativePath),
      },
      { database: database() }
    );
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error('Expected the saved scientific document.');
    expect(accepted.document.content).toBe(content);
    expect(accepted.document.revision).toMatchObject({ kind: 'local-file' });
  }
  const manifestPath = join(
    root,
    '.waypoint',
    'import-sets',
    stored.connection.importSetId,
    'manifest.json'
  );
  const manifest = parseImportSetManifest(await readFile(manifestPath, 'utf8'));
  expect(manifest.source).toMatchObject({
    type: 'connector',
    connectionId: stored.connection.id,
    revisionToken: stored.connection.revision,
  });
  expect(manifest.partitions.flatMap((partition) => partition.members)).toEqual(
    stored.connection.checkpoints.map((checkpoint) =>
      expect.objectContaining({
        sourceRecordId: `sheet-sync:${stored.connection.id}:${checkpoint.key}`,
        entityId: checkpoint.entityId,
        artifactRelativePath: checkpoint.artifactRelativePath,
      })
    )
  );
  const store = new ScientificObjectStore(database(), 7);
  expect(store.catalog()).toEqual({ head: null, entries: [] });
  const blobs = database()
    .prepare(
      'SELECT blob_hash,byte_length,bytes FROM scientific_revision_blobs WHERE workspace_id=7'
    )
    .all() as Array<{ blob_hash: string; byte_length: number; bytes: Buffer }>;
  expect(blobs).toEqual([]);
}

beforeEach(async () => {
  vi.spyOn(sidecarRuntime, 'nativeDocumentFetch').mockRejectedValue(
    new Error('Unexpected external computation for explicit local Tm settings.')
  );
  directory = await mkdtemp(join(tmpdir(), 'native-sheet-sync-acceptance-'));
  root = join(directory, 'project');
  profile = join(directory, 'profile');
  master = join(directory, 'master.xlsx');
  await mkdir(root);
  await mkdir(profile);
  root = await realpath(root);
  profile = await realpath(profile);
  host.profile = profile;
  host.db = createTestDb();
  ensureSchema(database(), ':memory:');
  database()
    .prepare('INSERT INTO workspaces(id,name,path,created_at) VALUES(7,?,?,1)')
    .run('Spreadsheet project', root);
  await workbook();
});

afterEach(async () => {
  vi.restoreAllMocks();
  host.db?.close();
  host.db = undefined;
  host.profile = undefined;
  await rm(directory, { recursive: true, force: true });
});

describe('native spreadsheet connection acceptance', () => {
  it('publishes through the semantic owner while generic metadata writes remain refused, retaining rows across pulls and owner restart', async () => {
    const managedRoot = join(profile, 'managed-workspaces');
    for (const path of [
      '.waypoint/import-sets/unowned/manifest.json',
      '.waypoint/sheet-sync/unowned.json',
      '.waypoint/sheet-sync/snapshots/unowned.json',
    ]) {
      await expect(
        assertProjectFilesystemMutationAllowed(database(), [join(root, path)], managedRoot)
      ).rejects.toThrow('PROJECT_FILESYSTEM_AUTHORITY_REQUIRED');
    }
    const ordinary = join(root, 'ordinary.txt');
    await assertProjectFilesystemMutationAllowed(database(), [ordinary], managedRoot);
    await writeFile(ordinary, 'Ordinary project content.');
    const originalBytes = await readFile(master);
    registerSelectedLocalIndexedTrackPaths([master]);
    const service = owner();
    const prepared = await prepare(service);
    expect(prepared.sourceRevision).toBe(`sha256:${digest(originalBytes)}`);
    expect(prepared.plan.records).toHaveLength(2);
    const connectRequest = {
      workspaceRoot: root,
      command: {
        kind: 'connect' as const,
        preparedId: prepared.preparedId,
        requestId: 'picked-master',
      },
    };
    const connected = await service.sheetSync(connectRequest);
    expect(connected.kind).toBe('connected');
    if (connected.kind !== 'connected') throw new Error(JSON.stringify(connected));
    expect(await service.sheetSync(connectRequest)).toEqual(connected);
    expect(
      await service.sheetSync({
        workspaceRoot: root,
        command: {
          kind: 'pull',
          id: connected.connectionId,
          primerTmSettings: localTmSettings,
        },
      })
    ).toMatchObject({ kind: 'pulled', summary: { created: 2, updated: 0 } });
    const initial = await inspect(service, connected.connectionId);
    await assertPublished(initial, ['Forward A', 'Forward B']);
    expect(await readFile(master)).toEqual(originalBytes);
    const snapshots = await readdir(join(root, '.waypoint', 'sheet-sync', 'snapshots'));
    expect(snapshots).toHaveLength(1);
    const snapshotPath = join(root, '.waypoint', 'sheet-sync', 'snapshots', snapshots[0]);
    const snapshotContent = await readFile(snapshotPath, 'utf8');
    expect(snapshots[0]).toBe(`${digest(snapshotContent)}.json`);
    const snapshot = parseSheetSyncSnapshot(snapshotContent);
    expect(snapshot.sourceRevision).toBe(prepared.sourceRevision);
    expect(snapshot.rows.map((row) => [row.key, row.values])).toEqual([
      ['001', { 'Stable ID': '001', Name: 'Forward A', Sequence: bases, Notes: 'first' }],
      ['002', { 'Stable ID': '002', Name: 'Forward B', Sequence: bases, Notes: 'second' }],
    ]);
    const identities = initial.connection.checkpoints.map(
      ({ key, entityId, artifactRelativePath }) => ({ key, entityId, artifactRelativePath })
    );
    const initialSchemas = await Promise.all(
      initial.connection.checkpoints.map(
        async (checkpoint) =>
          parsePrimerArtifact(await readFile(join(root, checkpoint.artifactRelativePath), 'utf8'))
            .entity?.schema
      )
    );
    const reopened = owner();
    expect((await inspect(reopened, connected.connectionId)).content).toBe(initial.content);
    expect(
      await reopened.sheetSync({
        workspaceRoot: root,
        command: {
          kind: 'authorization',
          id: connected.connectionId,
        },
      })
    ).toEqual({ kind: 'authorization', state: 'authorized' });
    expect(
      await reopened.sheetSync({
        workspaceRoot: root,
        command: {
          kind: 'pull',
          id: connected.connectionId,
          primerTmSettings: localTmSettings,
        },
      })
    ).toMatchObject({ kind: 'pulled', summary: { created: 0, updated: 0, unchanged: 2 } });
    const updatedBytes = await workbook([
      initialRows[0],
      ['001', 'Forward A revised', bases, 'revised note'],
      initialRows[2],
    ]);
    expect(
      await reopened.sheetSync({
        workspaceRoot: root,
        command: {
          kind: 'pull',
          id: connected.connectionId,
          primerTmSettings: localTmSettings,
        },
      })
    ).toMatchObject({ kind: 'pulled', summary: { created: 0, updated: 1, unchanged: 1 } });
    const updated = await inspect(reopened, connected.connectionId);
    expect(
      updated.connection.checkpoints.map(({ key, entityId, artifactRelativePath }) => ({
        key,
        entityId,
        artifactRelativePath,
      }))
    ).toEqual(identities);
    expect(updated.connection.revision).toBe(`sha256:${digest(updatedBytes)}`);
    await assertPublished(updated, ['Forward A revised', 'Forward B']);
    expect(
      await Promise.all(
        updated.connection.checkpoints.map(
          async (checkpoint) =>
            parsePrimerArtifact(await readFile(join(root, checkpoint.artifactRelativePath), 'utf8'))
              .entity?.schema
        )
      )
    ).toEqual(initialSchemas);
    expect(await readFile(snapshotPath, 'utf8')).toBe(snapshotContent);
    expect(await readFile(master)).toEqual(updatedBytes);
    expect(await readFile(ordinary, 'utf8')).toBe('Ordinary project content.');
    expect(
      (await readdir(join(root, '.waypoint', 'sheet-sync'))).filter((name) =>
        name.endsWith('.json')
      )
    ).toEqual([`${connected.connectionId}.json`]);
    expect(sidecarRuntime.nativeDocumentFetch).not.toHaveBeenCalled();
  });

  it('refuses an unpicked source, missing agent capability and protected destination before effects', async () => {
    const service = owner();
    const unpicked = await effects();
    await expect(prepare(service)).rejects.toThrow('not granted');
    expect(await effects()).toEqual(unpicked);
    registerSelectedLocalIndexedTrackPaths([master]);
    const prepared = await prepare(service);
    const before = await effects();
    await expect(
      service.executeAgent(
        {
          project: root,
          operation: {
            kind: 'sheet-sync',
            command: {
              kind: 'connect',
              preparedId: prepared.preparedId,
              requestId: 'ungranted-agent',
            },
          },
        },
        { identityId: 'read-only-agent', capabilities: ['read-workspace'] }
      )
    ).rejects.toMatchObject({ code: 'IMPORT_REVIEW_CAPABILITY_DENIED', stateChanged: false });
    await expect(
      service.sheetSync({
        workspaceRoot: root,
        command: {
          kind: 'prepare',
          source: source(),
          destinationRelativePath: '.waypoint',
        },
      })
    ).rejects.toThrow('metadata');
    expect(await effects()).toEqual(before);
  });

  it('refuses replaced preview source and schema with exact publication state unchanged', async () => {
    registerSelectedLocalIndexedTrackPaths([master]);
    const service = owner();
    const staleSource = await prepare(service);
    await workbook([
      initialRows[0],
      ['001', 'Changed after preview', bases, 'changed'],
      initialRows[2],
    ]);
    const beforeSource = await effects();
    expect(
      await service.sheetSync({
        workspaceRoot: root,
        command: {
          kind: 'connect',
          preparedId: staleSource.preparedId,
          requestId: 'stale-source',
        },
      })
    ).toMatchObject({
      kind: 'partial',
      stored: null,
      message: expect.stringMatching(/changed.*preview/i),
    });
    expect(await effects()).toEqual(beforeSource);
    const staleSchema = await prepare(service);
    const current = listLimsEntitySchemasInDb(database()).find(
      (schema) => schema.entityKind === 'oligo'
    )!;
    refineLimsSchemaInDb(database(), {
      schemaId: current.schemaId,
      expectedRevisionId: current.currentRevisionId,
      fields: [...current.fields, { key: 'reviewNote', label: 'Review note', type: 'text' }],
    });
    const beforeSchema = await effects();
    expect(
      await service.sheetSync({
        workspaceRoot: root,
        command: {
          kind: 'connect',
          preparedId: staleSchema.preparedId,
          requestId: 'stale-schema',
        },
      })
    ).toMatchObject({
      kind: 'partial',
      stored: null,
      message: expect.stringMatching(/record definition changed/i),
    });
    expect(await effects()).toEqual(beforeSchema);
  });
});
