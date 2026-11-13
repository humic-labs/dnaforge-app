import { seedOriginalProjectFixture } from './original-project-fixture';
/** @vitest-environment node */
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '1.0.0'), exit: vi.fn() },
}));

import { createTestDb } from './test-db';
import { ensureSchema } from '../schema';
import {
  countLimsEntitiesByKindInDb,
  archiveLimsEntityInDb,
  defineLimsSchemaInDb,
  queryLimsEntitiesInDb,
} from '../lims';
import { registerLimsEntityInsideTx } from '../lims-engine-core';
import { rememberDeveloperImportSourceRootsInDb } from '../registry-source-eligibility';
import { LIMS_ENTITY_KINDS } from '../../shared/lims';

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
  ensureSchema(db, ':memory:');
  seedOriginalProjectFixture(db);
  defineLimsSchemaInDb(db, {
    id: 'schema-entity-audit_specimen',
    kind: 'entity',
    name: 'audit_specimen',
    displayName: 'Audit specimen',
    baseKind: 'record',
    fields: [{ key: 'note', label: 'Note', type: 'text' }],
  });
});

afterEach(() => db.close());

describe('Registry counts under schema-defined kinds', () => {
  it('counts custom kinds across real workspaces, retains built-in zeros, and excludes archived rows', () => {
    db.prepare('INSERT INTO workspaces(id,name,path,created_at) VALUES(?,?,?,?)').run(
      7,
      'One',
      '/projects/count-test-one',
      1
    );
    db.prepare('INSERT INTO workspaces(id,name,path,created_at) VALUES(?,?,?,?)').run(
      8,
      'Two',
      '/projects/count-test-two',
      1
    );
    db.transaction(() => {
      for (const [id, workspaceId] of [
        ['custom-one', 7],
        ['custom-two', 8],
      ] as const) {
        registerLimsEntityInsideTx(db, {
          id,
          kind: 'audit_specimen',
          name: id,
          fields: { note: 'Custom schema row' },
          workspaceId,
        });
      }
      registerLimsEntityInsideTx(db, {
        id: 'archived-custom',
        kind: 'audit_specimen',
        name: 'Archived custom',
        fields: {},
      });
    })();
    archiveLimsEntityInDb(db, { id: 'archived-custom' });

    const counts = countLimsEntitiesByKindInDb(db);
    expect(counts.audit_specimen).toBe(2);
    for (const kind of LIMS_ENTITY_KINDS) expect(counts[kind]).toBe(0);
    expect(queryLimsEntitiesInDb(db, { kind: 'audit_specimen' })).toHaveLength(2);
  });

  it('applies developer-source exclusions while retaining application-owned custom records', () => {
    const sourceRoot = '/development/count-test-assets';
    rememberDeveloperImportSourceRootsInDb(db, [sourceRoot]);
    db.prepare('INSERT INTO workspaces(id,name,path,created_at) VALUES(?,?,?,?)').run(
      7,
      'Developer import source',
      sourceRoot,
      1
    );
    db.transaction(() => {
      registerLimsEntityInsideTx(db, {
        id: 'source-custom',
        kind: 'audit_specimen',
        name: 'Source custom',
        fields: {},
        workspaceId: 7,
      });
      registerLimsEntityInsideTx(db, {
        id: 'application-custom',
        kind: 'audit_specimen',
        name: 'Application custom',
        fields: {},
        workspaceId: 7,
      });
    })();
    db.prepare(
      `INSERT INTO catalog_entities(id,type,name,locator,storage_type,workspace_id,created_at,updated_at)
       VALUES(?, 'record', ?, ?, 'file', 7, 1, 1)`
    ).run('source-custom', 'Source custom', `file://${sourceRoot}/Source.entity.json`);
    db.prepare(
      `INSERT INTO catalog_entity_files(id,entity_id,workspace_id,path,file_kind,status,created_at,updated_at)
       VALUES(?, ?, 7, ?, 'waypoint-entity', 'current', 1, 1)`
    ).run('source-binding', 'source-custom', `${sourceRoot}/Source.entity.json`);

    expect(countLimsEntitiesByKindInDb(db).audit_specimen).toBe(1);
    expect(queryLimsEntitiesInDb(db, { kind: 'audit_specimen' }).map((row) => row.id)).toEqual([
      'application-custom',
    ]);
  });
});
