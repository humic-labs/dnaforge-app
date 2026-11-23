import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createFileTestDb, openFileTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import {
  listSavedEntityRowVersions,
  recoverSavedEntityRowVersion,
  savedRowRecoveryGenerations,
} from './saved-entity-row-recovery';
import { registerLimsEntityInDb, updateLimsEntityInDb } from './lims';
import { rebuildLimsProjectionInDb } from './lims-projection-rebuild';
import {
  createEntityReferenceInDb,
  deleteEntityReferenceInDb,
  recordEntityReferenceRevisionInDb,
} from './entity-reference-commands';
import { prepareEntityReferenceRow } from '../shared/entity-reference-ipc';
import { withRendererEntitySql } from './renderer-entity-sql';
import { resetIsolatedDatabase } from './database-recovery';
import { ComputeJobRegistry } from './compute/jobs';
import { MolecularCatalogService } from './molecular-catalog/service';
import * as coordinateWorker from './molecular-catalog/inventory-worker';
import { parseCoordinateInventory } from './molecular-catalog/coordinate-inventory';
import { registerCatalogEntityInDb } from './catalog-entity-registration';
import { ensureWorkspaceOwnerInDb } from './catalog-projection-commands';
import { rememberOriginalDefaultProject } from './original-default-project';
import type { SavedEntityRowSource } from '../shared/saved-entity-row-version';
import { mutateLegacyNotebookPageInDb } from './notebook-projection-authority';
import { notebookProjectionFingerprint } from '../shared/notebook-projection';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('./analytics', () => ({ trackEvent: vi.fn() }));

let fixture: ReturnType<typeof createFileTestDb>;
beforeEach(() => {
  fixture = createFileTestDb('saved-entity-row-versions');
  ensureSchema(fixture.db, fixture.dbPath);
});
afterEach(() => fixture.cleanup());

it('retains the original bytes of a database-only notebook on first save and on every edit', () => {
  const { db } = fixture;
  const content = (text: string) => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });
  const first = mutateLegacyNotebookPageInDb(db, {
    operation: 'create',
    id: 'legacy',
    title: 'Notes',
    content: content('First entry'),
    updatedAt: 1,
    expectedProjectionFingerprint: null,
  })!;
  const second = mutateLegacyNotebookPageInDb(db, {
    operation: 'upsert',
    id: first.id,
    title: 'Notes',
    content: content('Revised entry'),
    updatedAt: 2,
    expectedProjectionFingerprint: notebookProjectionFingerprint(first.title, first.content),
  })!;
  const fresh = openFileTestDb(fixture.dbPath);
  try {
    const versions = fresh
      .prepare(
        "SELECT json_extract(payload,'$.content') AS content FROM saved_entity_row_versions WHERE source_table='pages' AND identity=? ORDER BY version"
      )
      .all(JSON.stringify([first.id]));
    expect(versions).toEqual([{ content: first.content }, { content: second.content }]);
  } finally {
    fresh.close();
  }
});

function restored(source: SavedEntityRowSource, revisionId: string, generation?: string) {
  const { path } = recoverSavedEntityRowVersion(
    fixture.db,
    { source, revisionId, generation },
    fixture.tmpDir,
    openFileTestDb
  );
  const db = openFileTestDb(path);
  try {
    return db
      .prepare('SELECT * FROM "' + source + '"')
      .safeIntegers()
      .get();
  } finally {
    db.close();
  }
}

it('recovers custom schema definitions and original fields after a real Registry edit and rebuild', () => {
  const { db } = fixture;
  const workspaceId = ensureWorkspaceOwnerInDb(db, fixture.tmpDir);
  db.prepare('UPDATE workspaces SET repo_uuid=? WHERE id=?').run('test-project', workspaceId);
  rememberOriginalDefaultProject(db, workspaceId);
  const schema = {
    schemaId: 'review',
    schemaRevisionId: 'review-v1',
    name: 'review',
    displayName: 'Review',
    description: '',
    baseKind: 'record' as const,
    version: 1,
    fields: [{ key: 'value', label: 'Value', type: 'text' as const }],
  };
  const entity = registerLimsEntityInDb(db, {
    kind: schema.name,
    workspaceId,
    name: 'Initial',
    fields: { value: 'Original' },
    schemaRevisionId: schema.schemaRevisionId,
    schemaSnapshot: schema,
  });
  const query = { source: 'lims_entity' as const, identity: [entity.id] };
  const [original] = listSavedEntityRowVersions(db, query);
  updateLimsEntityInDb(db, { id: entity.id, name: 'Edited', fields: { value: 'Updated' } });
  rebuildLimsProjectionInDb(db);
  expect(restored('lims_entity', original.revisionId)).toMatchObject({
    id: entity.id,
    name: 'Initial',
    fields: expect.stringContaining('Original'),
    schema_revision_id: schema.schemaRevisionId,
  });
  expect(db.prepare('SELECT name,fields FROM lims_entity WHERE id=?').get(entity.id)).toMatchObject(
    { name: 'Edited', fields: expect.stringContaining('Updated') }
  );
  for (const [source, id] of [
    ['lims_schema', schema.schemaId],
    ['lims_schema_revision', schema.schemaRevisionId],
  ] as const) {
    const [saved] = listSavedEntityRowVersions(db, { source, identity: [id] });
    expect(restored(source, saved.revisionId)).toMatchObject({
      id,
      fields: expect.stringContaining('Value'),
    });
  }
});

it('recovers a cleaned-up reference, its cascaded revisions and a saved compute import independently', () => {
  const { db } = fixture;
  const ref = createEntityReferenceInDb(
    db,
    prepareEntityReferenceRow({
      entityType: 'external',
      displayLabel: 'Source',
      locator: 'https://example.org/x',
      data: { value: 'Result' },
      deepLinkParams: null,
      source: 'user',
      workspaceScope: null,
      workspaceRootPath: null,
    })
  );
  const revision = recordEntityReferenceRevisionInDb(db, {
    referenceId: ref.id,
    changedBy: 'user',
    changeType: 'note',
    previousState: null,
    newState: { note: 'History' },
  });
  deleteEntityReferenceInDb(db, ref.id);
  for (const [source, id, expected] of [
    [
      'entity_references',
      ref.id,
      { display_label: 'Source', data: JSON.stringify({ value: 'Result' }) },
    ],
    [
      'entity_reference_revisions',
      revision.id,
      { reference_id: ref.id, new_state: JSON.stringify({ note: 'History' }) },
    ],
  ] as const) {
    const [saved] = listSavedEntityRowVersions(db, { source, identity: [id] });
    expect(restored(source, saved.revisionId)).toMatchObject(expected);
  }
  const jobs = new ComputeJobRegistry({
    db: () => db,
    sidecarFetch: vi.fn(),
    readCredential: async () => null,
    grantedCapabilities: () => [],
  });
  const job = jobs.recordIntent({
    provider: 'tamarind',
    toolId: 'test',
    label: 'Job',
    settings: { input: 'previous value' },
    costEstimate: 0.125,
    costEstimateUnit: null,
    workspaceRoot: null,
    termsSnapshot: null,
  });
  jobs.markImported(job.id, ['result.dat']);
  const versions = listSavedEntityRowVersions(db, { source: 'compute_jobs', identity: [job.id] });
  expect(versions).toHaveLength(2);
  expect(restored('compute_jobs', versions[1].revisionId)).toMatchObject({
    id: job.id,
    state: 'intent',
    cost_estimate: 0.125,
    settings_json: expect.stringContaining('previous value'),
  });
  expect(restored('compute_jobs', versions[0].revisionId)).toMatchObject({
    id: job.id,
    state: 'imported',
    imported_paths_json: '["result.dat"]',
  });
});

it('recovers exact binary, signed 64-bit and embedded-NUL text through replacement, deletion and profile reset', () => {
  const { db } = fixture;
  const bytes = Buffer.from([0, 255, 0, 65, 192, 3]);
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO molecular_catalog_coordinates(id,format,sha256,byte_count,bytes,inventory_counts_json,created_at) VALUES('bin','bcif',?, ?, ?, ?, ?)"
  );
  const big = 9223372036854775807n;
  stmt.run('a'.repeat(64), bytes.length, bytes, 'π\0x', big);
  db.prepare(
    "UPDATE molecular_catalog_coordinates SET inventory_counts_json=CAST(X'80FF0041' AS TEXT) WHERE id='bin'"
  ).run();
  const [malformed, old] = listSavedEntityRowVersions(db, {
    source: 'molecular_catalog_coordinates',
    identity: ['bin'],
  });
  stmt.run('b'.repeat(64), 1, Buffer.from([8]), '{}', 2);
  db.prepare("DELETE FROM molecular_catalog_coordinates WHERE id='bin'").run();
  db.close();
  resetIsolatedDatabase(fixture.dbPath);
  fixture.db = openFileTestDb(fixture.dbPath);
  ensureSchema(fixture.db, fixture.dbPath);
  const generation = savedRowRecoveryGenerations(fixture.db).find((name) =>
    name.startsWith('dnaforge.db.pre-reset-')
  );
  expect(generation).toBeDefined();
  const versions = listSavedEntityRowVersions(
    fixture.db,
    { source: 'molecular_catalog_coordinates', identity: ['bin'], generation },
    openFileTestDb
  );
  expect(versions).toHaveLength(3);
  const result = recoverSavedEntityRowVersion(
    fixture.db,
    { source: 'molecular_catalog_coordinates', revisionId: malformed.revisionId, generation },
    fixture.tmpDir,
    openFileTestDb
  );
  const exact = openFileTestDb(result.path);
  try {
    expect(
      exact
        .prepare('SELECT hex(inventory_counts_json) FROM molecular_catalog_coordinates')
        .pluck()
        .get()
    ).toBe('80FF0041');
  } finally {
    exact.close();
  }
  expect(restored('molecular_catalog_coordinates', old.revisionId, generation)).toMatchObject({
    id: 'bin',
    bytes,
    created_at: big,
    inventory_counts_json: 'π\0x',
  });
});

it('rolls the source back on retention failure and rejects archive replacement through renderer and native SQL', () => {
  const { db } = fixture;
  const doc = { type: 'doc', content: [] };
  db.exec(
    "CREATE TEMP TRIGGER refuse_history BEFORE INSERT ON saved_entity_row_versions WHEN NEW.source_table='pages' BEGIN SELECT RAISE(ABORT,'archive unavailable'); END;"
  );
  expect(() =>
    mutateLegacyNotebookPageInDb(db, {
      operation: 'create',
      id: 'note',
      title: 'Never saved',
      content: doc,
      updatedAt: 1,
      expectedProjectionFingerprint: null,
    })
  ).toThrow('archive unavailable');
  expect(db.prepare("SELECT 1 FROM pages WHERE id='note'").get()).toBeUndefined();
  db.exec('DROP TRIGGER refuse_history');
  db.exec(
    "CREATE TEMP TRIGGER skip_history BEFORE INSERT ON saved_entity_row_versions WHEN NEW.source_table='pages' BEGIN SELECT RAISE(IGNORE); END;"
  );
  expect(() =>
    mutateLegacyNotebookPageInDb(db, {
      operation: 'create',
      id: 'note',
      title: 'Never saved',
      content: doc,
      updatedAt: 1,
      expectedProjectionFingerprint: null,
    })
  ).toThrow(/retained before saving/);
  expect(db.prepare("SELECT 1 FROM pages WHERE id='note'").get()).toBeUndefined();
  db.exec('DROP TRIGGER skip_history');
  mutateLegacyNotebookPageInDb(db, {
    operation: 'create',
    id: 'note',
    title: 'Original',
    content: doc,
    updatedAt: 1,
    expectedProjectionFingerprint: null,
  });
  const [saved] = listSavedEntityRowVersions(db, { source: 'pages', identity: ['note'] });
  const replace =
    'INSERT OR REPLACE INTO saved_entity_row_versions SELECT * FROM saved_entity_row_versions WHERE version=?';
  expect(() => db.prepare(replace).run(saved.version)).toThrow(/cannot be replaced/);
  expect(() =>
    db.prepare('DELETE FROM saved_entity_row_versions WHERE version=?').run(saved.version)
  ).toThrow(/retained/);
  expect(() =>
    withRendererEntitySql(db, replace, () => db.prepare(replace).run(saved.version))
  ).toThrow(/recovery command/);
});

it('adopts historical, unprojected rows at upgrade without creating duplicate history across restarts', () => {
  const { db } = fixture;
  db.exec(
    'DROP TRIGGER retain_primers_insert; DROP TRIGGER retain_primers_update; PRAGMA user_version=49'
  );
  db.prepare(
    "INSERT INTO primers(id,name,sequence,length,notes,created_at,updated_at) VALUES('legacy','Stored record','ACGT',4,'µ legacy',1,2)"
  ).run();
  ensureSchema(db, fixture.dbPath);
  ensureSchema(db, fixture.dbPath);
  const versions = listSavedEntityRowVersions(db, { source: 'primers', identity: ['legacy'] });
  expect(versions).toHaveLength(1);
  expect(restored('primers', versions[0].revisionId)).toMatchObject({
    id: 'legacy',
    name: 'Stored record',
    sequence: 'ACGT',
    notes: 'µ legacy',
  });
  db.prepare("UPDATE primers SET name='Edited' WHERE id='legacy'").run();
  expect(listSavedEntityRowVersions(db, { source: 'primers', identity: ['legacy'] })).toHaveLength(
    2
  );
});

it('recovers rows from an older preserved profile with stable generation-bound IDs and leaves its bytes untouched', () => {
  const legacyPath = join(fixture.tmpDir, 'dnaforge-preRestore-v48-1234.db');
  const legacy = openFileTestDb(legacyPath);
  legacy.exec(
    "CREATE TABLE primers(id TEXT PRIMARY KEY,name TEXT,sequence TEXT); INSERT INTO primers VALUES('orphan','Saved record','ACGT')"
  );
  legacy.close();
  const before = readFileSync(legacyPath);
  const query = {
    source: 'primers' as const,
    identity: ['orphan'],
    generation: basename(legacyPath),
  };
  const [version] = listSavedEntityRowVersions(fixture.db, query, openFileTestDb);
  const [again] = listSavedEntityRowVersions(fixture.db, query, openFileTestDb);
  expect(again.revisionId).toBe(version.revisionId);
  expect(restored('primers', version.revisionId, query.generation)).toEqual({
    id: 'orphan',
    name: 'Saved record',
    sequence: 'ACGT',
  });
  expect(() => restored('primers', version.revisionId)).toThrow('Unknown saved entity version');
  expect(readFileSync(legacyPath)).toEqual(before);
});

it('recovers saved selection coordinates and a natively imported molecular record after removing its working source', async () => {
  const { db, tmpDir } = fixture;
  ensureWorkspaceOwnerInDb(db, tmpDir);
  registerCatalogEntityInDb(db, {
    id: 'target',
    type: 'sequence',
    name: 'Target',
    locator: 'entity://sequence/target',
    storageType: 'file',
    workspaceRoot: tmpDir,
  });
  const region = createEntityReferenceInDb(
    db,
    prepareEntityReferenceRow({
      entityType: 'sequence_region',
      displayLabel: 'Saved region',
      locator: 'target',
      deepLinkParams: { start: 2, end: 8 },
      data: { documentId: 'target' },
      source: 'user',
      workspaceScope: null,
      workspaceRootPath: tmpDir,
    })
  );
  const [saved] = listSavedEntityRowVersions(db, {
    source: 'entity_references',
    identity: [region.id],
  });
  expect(restored('entity_references', saved.revisionId)).toMatchObject({
    id: region.id,
    locator: 'target',
    deep_link_params: JSON.stringify({ start: 2, end: 8 }),
  });
  const file = join(tmpDir, 'receipt.pdb');
  const bytes = Buffer.from(
    'HEADER    RECORD\nATOM      1  N   ALA A   1      11.104  13.207   7.216  1.00 20.00           N\nATOM      2  CA  ALA A   1      12.560  13.207   7.216  1.00 20.00           C\nTER\nEND\n'
  );
  writeFileSync(file, bytes);
  const jobs = new ComputeJobRegistry({
    db: () => db,
    sidecarFetch: vi.fn(),
    readCredential: async () => null,
    grantedCapabilities: () => [],
  });
  const worker = vi
    .spyOn(coordinateWorker, 'inventoryCoordinatesInWorker')
    .mockImplementation(parseCoordinateInventory);
  try {
    const match = await new MolecularCatalogService(() => db, jobs).register({
      workspaceRoot: tmpDir,
      filePath: 'receipt.pdb',
      source: { kind: 'import' },
    });
    unlinkSync(file);
    const [observation] = listSavedEntityRowVersions(db, {
      source: 'molecular_catalog_observations',
      identity: [match.observation.id],
    });
    expect(restored('molecular_catalog_observations', observation.revisionId)).toMatchObject({
      id: match.observation.id,
      source_kind: 'import',
    });
    const [coordinates] = listSavedEntityRowVersions(db, {
      source: 'molecular_catalog_coordinates',
      identity: [match.observation.coordinateId],
    });
    expect(restored('molecular_catalog_coordinates', coordinates.revisionId)).toMatchObject({
      id: match.observation.coordinateId,
      bytes,
    });
  } finally {
    worker.mockRestore();
  }
});
