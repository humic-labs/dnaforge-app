import { seedOriginalProjectFixture } from './original-project-fixture';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { registerLimsEntityInDb, repairLimsEntityProjectionFromAuditInDb } from '../lims';
import {
  assertLimsProjectionReplayParityInDb,
  rebuildLimsProjectionInDb,
  rebuildLimsProjectionFromAuditRowsInDb,
  verifyLimsAuditHashChainInDb,
} from '../lims-projection-rebuild';
import { ensureSchema } from '../schema';
import { createTestDb } from './test-db';
import type { LimsAuditRow } from '../../shared/lims';

let db: Database.Database;
const uuid = '39881590-6559-435c-b1b6-509695310c72';
const oldRoot = `/profiles/DNAForge/managed-workspaces/${uuid}/repo`;
const currentRoot = `/profiles/DNAForge-dev-1680/managed-workspaces/${uuid}/repo`;

beforeEach(() => {
  db = createTestDb();
  ensureSchema(db, ':memory:');
  seedOriginalProjectFixture(db);
  db.prepare('INSERT INTO workspaces (id,name,path,repo_uuid,created_at) VALUES (7,?,?,?,1)').run(
    'Relocated fixture',
    currentRoot,
    uuid
  );
});
afterEach(() => db.close());

function notebook(id: string, packagePath = `${oldRoot}/${id}`) {
  return registerLimsEntityInDb(db, {
    id,
    kind: 'notebook',
    name: id,
    fields: { packagePath },
    workspaceId: 7,
  });
}

function fields(id: string): Record<string, unknown> {
  const row = db.prepare('SELECT fields FROM lims_entity WHERE id=?').get(id) as { fields: string };
  return JSON.parse(row.fields) as Record<string, unknown>;
}

describe('verified Registry recovery under current file ownership', () => {
  it('rejects conflicting duplicate events before clearing the projection', () => {
    notebook('first');
    const rows = db.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all() as LimsAuditRow[];
    const before = db.prepare('SELECT * FROM lims_entity ORDER BY id').all();
    expect(() =>
      rebuildLimsProjectionFromAuditRowsInDb(db, [
        ...rows,
        { ...rows.at(-1)!, actor: 'conflicting' },
      ])
    ).toThrow(/conflicting event/);
    expect(db.prepare('SELECT * FROM lims_entity ORDER BY id').all()).toEqual(before);
  });
  it('rejects invalid history before recreating a missing entity', () => {
    notebook('missing');
    db.prepare("UPDATE lims_audit SET actor='tampered' WHERE subject_id='missing'").run();
    expect(verifyLimsAuditHashChainInDb(db).ok).toBe(false);
    db.prepare("DELETE FROM lims_entity WHERE id='missing'").run();
    const before = db.prepare('SELECT * FROM lims_entity ORDER BY id').all();
    expect(() => repairLimsEntityProjectionFromAuditInDb(db, 'missing')).toThrow(/hash|integrity/i);
    expect(db.prepare('SELECT * FROM lims_entity ORDER BY id').all()).toEqual(before);
  });

  it('rejects a broken predecessor hash before full replay and retains all projections', () => {
    notebook('first');
    notebook('second');
    db.prepare("UPDATE lims_audit SET prev_hash='broken' WHERE subject_id='second'").run();
    const before = db.prepare('SELECT * FROM lims_entity ORDER BY id').all();
    expect(() => rebuildLimsProjectionInDb(db)).toThrow(/hash|integrity/i);
    expect(db.prepare('SELECT * FROM lims_entity ORDER BY id').all()).toEqual(before);
  });

  it('repairs only the missing entity and does not rewind another existing projection', () => {
    notebook('missing');
    notebook('unrelated');
    db.prepare("UPDATE lims_entity SET fields=? WHERE id='unrelated'").run(
      JSON.stringify({ packagePath: `${currentRoot}/renamed-notebook`, retainedMetadata: 'keep' })
    );
    const unrelated = db.prepare("SELECT * FROM lims_entity WHERE id='unrelated'").get();
    const schemas = db.prepare('SELECT * FROM lims_schema ORDER BY id').all();
    db.prepare("DELETE FROM lims_entity WHERE id='missing'").run();
    expect(repairLimsEntityProjectionFromAuditInDb(db, 'missing')).toBe(true);
    expect(db.prepare("SELECT * FROM lims_entity WHERE id='unrelated'").get()).toEqual(unrelated);
    expect(db.prepare('SELECT * FROM lims_schema ORDER BY id').all()).toEqual(schemas);
    expect(fields('missing').packagePath).toBe(`${currentRoot}/missing`);
  });

  it('uses the current catalog notebook location when replaying older paths', () => {
    notebook('bound-notebook');
    db.prepare(
      `INSERT INTO catalog_entities
      (id,type,name,locator,storage_type,workspace_id,created_at,updated_at)
      VALUES ('bound-notebook','notebook','Notebook','entity://page/bound-notebook','database',7,1,1)`
    ).run();
    db.prepare(
      `INSERT INTO catalog_entity_files
      (id,entity_id,workspace_id,path,file_kind,status,created_at,updated_at)
      VALUES ('bound-file','bound-notebook',7,?,'waypoint-notebook','current',1,1)`
    ).run(`${currentRoot}/renamed-notebook`);
    db.prepare("UPDATE lims_entity SET fields=? WHERE id='bound-notebook'").run(
      JSON.stringify({ packagePath: `${currentRoot}/renamed-notebook` })
    );
    expect(() => assertLimsProjectionReplayParityInDb(db)).not.toThrow();
    expect(fields('bound-notebook').packagePath).toBe(`${currentRoot}/renamed-notebook`);
  });

  it('resolves a legacy ownerless file reference through its exact managed-workspace UUID', () => {
    registerLimsEntityInDb(db, {
      id: 'legacy-assembly',
      kind: 'plasmid',
      name: 'Legacy accepted assembly',
      fields: {
        sequence: {
          mode: 'file',
          relPath: `${oldRoot}/assemblies/accepted.gb`,
          topology: 'circular',
          length: 10,
          contentHash: `sha256:${'a'.repeat(64)}`,
          sourceFormat: 'gb',
        },
      },
    });
    const currentFields = fields('legacy-assembly');
    currentFields.sequence = {
      ...(currentFields.sequence as Record<string, unknown>),
      relPath: `${currentRoot}/assemblies/accepted.gb`,
    };
    db.prepare("UPDATE lims_entity SET fields=? WHERE id='legacy-assembly'").run(
      JSON.stringify(currentFields)
    );
    expect(() => assertLimsProjectionReplayParityInDb(db)).not.toThrow();
    expect((fields('legacy-assembly').sequence as Record<string, unknown>).relPath).toBe(
      `${currentRoot}/assemblies/accepted.gb`
    );
  });

  it('does not infer a managed location for an external file or an unknown UUID', () => {
    notebook('external', '/external/reference-notebook');
    rebuildLimsProjectionInDb(db);
    expect(fields('external').packagePath).toBe('/external/reference-notebook');
    notebook('unknown-uuid', '/profiles/Old/managed-workspaces/unknown/repo/notebook');
    rebuildLimsProjectionInDb(db);
    expect(fields('unknown-uuid').packagePath).toBe(
      '/profiles/Old/managed-workspaces/unknown/repo/notebook'
    );
  });
});
