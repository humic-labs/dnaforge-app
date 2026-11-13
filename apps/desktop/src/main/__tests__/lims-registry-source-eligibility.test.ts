/** @vitest-environment node */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '1.0.0'), exit: vi.fn() },
}));

import { createTestDb } from './test-db';
import { ensureSchema } from '../schema';
import { registerLimsEntityInsideTx, seedLimsBuiltinsInDb } from '../lims-engine-core';
import {
  getRegistryCandidateEntities,
  queryLimsRegistrySummariesInDb,
} from '../lims-registry-projection';
import { countLimsEntitiesByKindInDb, queryLimsEntitiesInDb } from '../lims';
import {
  developerImportSourceRootsInDb,
  rememberDeveloperImportSourceRootsInDb,
} from '../registry-source-eligibility';

const sourceRoot = '/development/wp-assets';
let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
  ensureSchema(db, ':memory:');
  seedLimsBuiltinsInDb(db);
  db.prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?)').run(
    'developer-import-source-roots',
    JSON.stringify([sourceRoot]),
    Date.now()
  );
});
afterEach(() => db.close());

function workspace(path: string, access: 'writable' | 'reference' = 'writable'): number {
  return Number(
    db
      .prepare('INSERT INTO workspaces(name,path,created_at,access_mode) VALUES(?,?,?,?)')
      .run(path, path, Date.now(), access).lastInsertRowid
  );
}

function sequence(name: string, origin: number, packageRoot: string) {
  const id = randomUUID();
  return db.transaction(() =>
    registerLimsEntityInsideTx(db, {
      id,
      kind: 'sequence',
      name,
      workspaceId: origin,
      fields: {
        schemaId: 'schema-entity-sequence',
        schemaRevisionId: 'schema-entity-sequence-v1',
        packageKind: 'sequence',
        _managedSequenceDocument: { kind: 'managed-sequence', packageId: id, packageRoot },
        _managedSequenceContent: { length: 4, topology: 'linear', geneticCode: 1 },
      },
    })
  )();
}

function bind(id: string, path: string, owner: number): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO catalog_entities(id,type,name,locator,storage_type,workspace_id,created_at,updated_at)
     VALUES(?, 'sequence', ?, ?, 'file', ?, ?, ?)`
  ).run(id, id, `file://${path}`, owner, now, now);
  db.prepare(
    `INSERT INTO catalog_entity_files(id,entity_id,workspace_id,path,file_kind,status,created_at,updated_at)
     VALUES(?,?,?,?, 'waypoint-sequence', 'current', ?, ?)`
  ).run(randomUUID(), id, owner, path, now, now);
}

describe('Registry developer import-source eligibility', () => {
  it.each(['waypoint.entity.v1', 'waypoint.entity.v2'])(
    'excludes a retained %s source file with only a workspace-relative locator',
    (schema) => {
      const origin = workspace(sourceRoot, 'reference');
      const entity = db.transaction(() =>
        registerLimsEntityInsideTx(db, {
          kind: 'strain',
          name: 'Source strain',
          workspaceId: origin,
          fields: {
            genotypeCanonical: 'recA1',
            artifact: {
              schema,
              relativePath: 'records/strain/source.entity.json',
            },
          },
        })
      )();
      const before = db.prepare('SELECT * FROM lims_entity WHERE id=?').get(entity.id);
      const history = db.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all();
      expect(getRegistryCandidateEntities(db, true)).toEqual([]);
      expect(queryLimsRegistrySummariesInDb(db, { search: 'Source strain' })).toMatchObject({
        summaries: [],
        totalCount: 0,
      });
      expect(queryLimsEntitiesInDb(db, { id: entity.id })).toEqual([]);
      expect(
        db.prepare('SELECT id FROM catalog_entities WHERE id=?').get(entity.id)
      ).toBeUndefined();
      expect(countLimsEntitiesByKindInDb(db).strain).toBe(0);
      expect(db.prepare('SELECT * FROM lims_entity WHERE id=?').get(entity.id)).toEqual(before);
      expect(db.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all()).toEqual(history);
    }
  );

  it.each([
    'owned-current-copy',
    'owned-relative-file',
    'record-only',
    'unknown-artifact',
    'unsafe-locator',
  ])('keeps %s eligible without inferring source ownership from origin alone', (caseName) => {
    const origin = workspace(sourceRoot, 'reference');
    const project = workspace('/projects/owned');
    const entity = db.transaction(() =>
      registerLimsEntityInsideTx(db, {
        kind: 'strain',
        name: 'Application strain',
        workspaceId: caseName === 'owned-relative-file' ? project : origin,
        fields: {
          genotypeCanonical: 'recA1',
          sourcePath: `${sourceRoot}/input.csv`,
          ...(caseName === 'record-only'
            ? {}
            : {
                artifact: {
                  schema: caseName === 'unknown-artifact' ? 'unknown' : 'waypoint.entity.v2',
                  relativePath:
                    caseName === 'unsafe-locator'
                      ? '../outside.entity.json'
                      : 'records/strain/owned.entity.json',
                },
              }),
        },
      })
    )();
    if (caseName === 'owned-current-copy')
      bind(entity.id, '/projects/owned/records/strain/owned.entity.json', project);
    expect(queryLimsEntitiesInDb(db, { id: entity.id }).map((row) => row.id)).toEqual([entity.id]);
    expect(queryLimsRegistrySummariesInDb(db).totalCount).toBe(1);
    expect(countLimsEntitiesByKindInDb(db).strain).toBe(1);
  });

  it('remembers known sources when they are no longer mounted or compiled into the current build', () => {
    rememberDeveloperImportSourceRootsInDb(db, ['/development/other-import-source']);
    rememberDeveloperImportSourceRootsInDb(db, []);
    expect(developerImportSourceRootsInDb(db)).toEqual([
      sourceRoot,
      '/development/other-import-source',
    ]);
    const origin = workspace('/development/other-import-source');
    const entity = sequence('Previously mounted source', origin, `${sourceRoot}/old`);
    bind(entity.id, '/development/other-import-source/Old', origin);
    expect(getRegistryCandidateEntities(db)).toEqual([]);
  });

  it('excludes stored source-only packages without deleting their projection or history', () => {
    const origin = workspace(sourceRoot, 'reference');
    const entity = sequence('pDEMO421', origin, `${sourceRoot}/pDEMO421`);
    bind(entity.id, `${sourceRoot}/pDEMO421`, origin);
    const before = db.prepare('SELECT * FROM lims_entity WHERE id=?').get(entity.id);
    const historyBefore = db.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all();

    expect(getRegistryCandidateEntities(db)).toEqual([]);
    const page = queryLimsRegistrySummariesInDb(db, { search: 'pDEMO421' });
    expect(page.summaries).toEqual([]);
    expect(page.totalCount).toBe(0);
    expect(queryLimsEntitiesInDb(db, { id: entity.id })).toEqual([]);
    expect(countLimsEntitiesByKindInDb(db).sequence).toBe(0);
    expect(db.prepare('SELECT * FROM lims_entity WHERE id=?').get(entity.id)).toEqual(before);
    expect(db.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all()).toEqual(historyBefore);
  });

  it('keeps a real project copy eligible when origin and old package metadata point to the source', () => {
    const origin = workspace(sourceRoot, 'reference');
    const project = workspace('/projects/imported');
    const entity = sequence('Intentionally imported pDEMO421', origin, `${sourceRoot}/pDEMO421`);
    bind(entity.id, '/projects/imported/pDEMO421', project);

    expect(getRegistryCandidateEntities(db).map((record) => record.id)).toEqual([entity.id]);
    expect(queryLimsEntitiesInDb(db, { id: entity.id }).map((record) => record.id)).toEqual([
      entity.id,
    ]);
    expect(countLimsEntitiesByKindInDb(db).sequence).toBe(1);
  });

  it('preserves record-only application data regardless of source provenance', () => {
    const origin = workspace(sourceRoot, 'reference');
    const entity = db.transaction(() =>
      registerLimsEntityInsideTx(db, {
        kind: 'oligo',
        name: 'Application-owned primer',
        workspaceId: origin,
        fields: {
          sequence: { mode: 'inline', bases: 'ACGT', topology: 'linear', length: 4 },
          sourcePath: `${sourceRoot}/primers.csv`,
        },
      })
    )();

    expect(getRegistryCandidateEntities(db).map((record) => record.id)).toEqual([entity.id]);
    expect(queryLimsRegistrySummariesInDb(db).totalCount).toBe(1);
  });

  it('keeps the global view across real projects, including a project with reference editing access', () => {
    const first = workspace('/projects/one');
    const second = workspace('/projects/two', 'reference');
    const a = sequence('One', first, '/projects/one/One');
    const b = sequence('Two', second, '/projects/two/Two');
    bind(a.id, '/projects/one/One', first);
    bind(b.id, '/projects/two/Two', second);

    expect(
      queryLimsRegistrySummariesInDb(db)
        .summaries.map((record) => record.id)
        .sort()
    ).toEqual([a.id, b.id].sort());
  });

  it('does not confuse neighboring paths with the developer source root', () => {
    const project = workspace(`${sourceRoot}-real-project`);
    const entity = sequence('Real project', project, `${sourceRoot}-real-project/Real`);
    bind(entity.id, `${sourceRoot}-real-project/Real`, project);

    expect(getRegistryCandidateEntities(db).map((record) => record.id)).toEqual([entity.id]);
  });

  it('excludes an old source-backed package without a current binding but preserves record-only rows', () => {
    const origin = workspace(sourceRoot, 'reference');
    sequence('Old source package', origin, `${sourceRoot}/old`);

    expect(getRegistryCandidateEntities(db)).toEqual([]);
    expect(getRegistryCandidateEntities(db, true)).toEqual([]);
  });
});
