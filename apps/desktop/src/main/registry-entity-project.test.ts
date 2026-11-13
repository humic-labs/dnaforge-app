import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '1.0.0'), exit: vi.fn() },
}));

import { createLimsTestBridge } from './__tests__/lims-bridge-for-db';
import {
  registerLimsEntityInDb,
  updateLimsEntityInDb,
  restoreLimsEntityInDb,
  revertLimsEntityInDb,
  seedLimsBuiltinsInDb,
  queryLimsEntitiesInDb,
  repairLimsEntityProjectionFromAuditInDb,
} from './lims';
import {
  insertAuditEvent,
  nextEventSeq,
  upsertLimsEntityProjectionInsideTx,
} from './lims-engine-core';
import {
  ORIGINAL_DEFAULT_PROJECT_SETTING,
  rememberOriginalDefaultProject,
} from './original-default-project';

let db: Database.Database;
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fixture-entity-project-'));
  db = createLimsTestBridge({ withOriginalProject: false }).db;
  for (const [id, uuid, name] of [
    [41, 'original-project', 'Renamed original'],
    [42, 'other-project', 'My Project'],
  ] as const) {
    const path = join(root, uuid);
    mkdirSync(path);
    db.prepare(
      `INSERT INTO workspaces (id, name, path, repo_uuid, created_at, access_mode)
      VALUES (?, ?, ?, ?, ?, 'writable')`
    ).run(id, name, path, uuid, id);
  }
  rememberOriginalDefaultProject(db, 41);
  db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
    'active_workspace_path',
    join(root, 'other-project'),
    Date.now()
  );
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const record = () => ({ kind: 'strain', name: 'Project-owned record', fields: {} });

function legacyRecord(archived = false) {
  seedLimsBuiltinsInDb(db);
  const schema = db
    .prepare("SELECT id, current_revision_id FROM lims_schema WHERE name = 'strain'")
    .get() as { id: string; current_revision_id: string };
  db.prepare(
    `INSERT INTO lims_entity (id, kind, schema_id, schema_revision_id, name, registry_id, fields,
    registration_status, domain_status, workspace_id, actor, event_seq, tombstone, created_at, updated_at, archived_at)
    VALUES ('legacy-record', 'strain', ?, ?, 'Historical record', 'OLD-001', '{}', 'registered',
      NULL, NULL, 'legacy-import', NULL, ?, 1, 1, ?)`
  ).run(schema.id, schema.current_revision_id, archived ? 1 : 0, archived ? 1 : null);
  return 'legacy-record';
}

describe('mandatory project ownership for saved Registry entities', () => {
  it.each([true, false])(
    'uses the actual registered file project before indexing (original identified: %s)',
    (identified) => {
      if (!identified)
        db.prepare('DELETE FROM settings WHERE key = ?').run(ORIGINAL_DEFAULT_PROJECT_SETTING);
      const path = join(root, 'other-project', 'not-indexed-yet.gb');
      writeFileSync(path, 'LOCUS unindexed\n//\n');
      const fields = {
        sequence: {
          mode: 'file',
          relPath: path,
          topology: 'linear',
          length: 20,
          contentHash: `sha256:${'a'.repeat(64)}`,
          sourceFormat: 'gb',
        },
      };
      expect(
        registerLimsEntityInDb(db, { kind: 'sequence', name: 'Unindexed document', fields })
          .workspaceId
      ).toBe(42);
    }
  );

  it('refuses ambiguous physical file ownership instead of choosing the original project', () => {
    const path = join(root, 'other-project', 'not-indexed-yet.gb');
    writeFileSync(path, 'LOCUS unindexed\n//\n');
    const alias = join(root, 'alias');
    symlinkSync(join(root, 'other-project'), alias, 'dir');
    db.prepare(
      "INSERT INTO workspaces (id, name, path, repo_uuid, created_at) VALUES (43, 'Alias', ?, 'alias', 1)"
    ).run(alias);
    expect(() =>
      registerLimsEntityInDb(db, {
        kind: 'sequence',
        name: 'Ambiguous document',
        fields: {
          sequence: {
            mode: 'file',
            relPath: path,
            topology: 'linear',
            length: 20,
            contentHash: `sha256:${'a'.repeat(64)}`,
            sourceFormat: 'gb',
          },
        },
      })
    ).toThrow(/conflicting project ownership/);
    expect(db.prepare('SELECT COUNT(*) AS count FROM lims_entity').get()).toEqual({ count: 0 });
  });

  it('can recover verified historical data without inventing a project, while its next save still requires one', () => {
    const id = legacyRecord();
    const [entity] = queryLimsEntitiesInDb(db, { id, includeArchived: true });
    entity.eventSeq = nextEventSeq(db);
    db.prepare('UPDATE lims_entity SET event_seq = ? WHERE id = ?').run(entity.eventSeq, id);
    insertAuditEvent(db, {
      eventSeq: entity.eventSeq,
      eventType: 'entity_registered',
      subjectTable: 'lims_entity',
      subjectId: id,
      workspaceId: null,
      actor: entity.actor,
      after: entity,
    });
    const before = db.prepare('SELECT * FROM lims_entity WHERE id = ?').get(id);
    const history = db.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all();
    db.prepare('DELETE FROM settings WHERE key = ?').run(ORIGINAL_DEFAULT_PROJECT_SETTING);
    db.prepare('DELETE FROM lims_entity WHERE id = ?').run(id);
    expect(repairLimsEntityProjectionFromAuditInDb(db, id)).toBe(true);
    expect(db.prepare('SELECT * FROM lims_entity WHERE id = ?').get(id)).toEqual(before);
    expect(() => updateLimsEntityInDb(db, { id, name: 'New edit' })).toThrow(
      /original My Project/i
    );
    expect(db.prepare('SELECT * FROM lims_entity WHERE id = ?').get(id)).toEqual(before);
    expect(db.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all()).toEqual(history);
  });

  it('can index an entity in a registered reference project without requiring permission to edit its source', () => {
    db.prepare("UPDATE workspaces SET access_mode = 'reference' WHERE id = 42").run();
    expect(registerLimsEntityInDb(db, { ...record(), workspaceId: 42 }).workspaceId).toBe(42);
  });
  it('restores an older unassigned record into the original project', () => {
    expect(restoreLimsEntityInDb(db, { id: legacyRecord(true) }).workspaceId).toBe(41);
  });

  it('keeps the newly assigned project when undoing an older metadata edit', () => {
    const id = legacyRecord();
    expect(updateLimsEntityInDb(db, { id, name: 'Changed name' }).workspaceId).toBe(41);
    const result = revertLimsEntityInDb(db, { id });
    expect(result.entity).toMatchObject({ workspaceId: 41, name: 'Historical record' });
  });

  it('keeps an older archived record unchanged when its original project cannot be identified', () => {
    const id = legacyRecord(true);
    db.prepare('DELETE FROM settings WHERE key = ?').run(ORIGINAL_DEFAULT_PROJECT_SETTING);
    expect(() => restoreLimsEntityInDb(db, { id })).toThrow(/original My Project/i);
    expect(
      db.prepare('SELECT tombstone, workspace_id FROM lims_entity WHERE id = ?').get(id)
    ).toEqual({ tombstone: 1, workspace_id: null });
  });

  it('rejects projectless writes from another projection producer instead of trusting each caller', () => {
    const entity = registerLimsEntityInDb(db, { ...record(), workspaceId: 42 });
    expect(() =>
      db.transaction(() =>
        upsertLimsEntityProjectionInsideTx(db, { ...entity, workspaceId: null })
      )()
    ).toThrow(/project/i);
    expect(db.prepare('SELECT workspace_id FROM lims_entity WHERE id = ?').get(entity.id)).toEqual({
      workspace_id: 42,
    });
  });

  it('uses the verified original project for a new unassigned entity, independently of names and selection', () => {
    const entity = registerLimsEntityInDb(db, record());
    expect(entity.workspaceId).toBe(41);
    expect(db.prepare('SELECT workspace_id FROM lims_entity WHERE id = ?').get(entity.id)).toEqual({
      workspace_id: 41,
    });
  });

  it('preserves an explicitly assigned existing project', () => {
    expect(registerLimsEntityInDb(db, { ...record(), workspaceId: 42 }).workspaceId).toBe(42);
  });

  it('refuses an unknown original before creating an unassigned entity', () => {
    db.prepare('DELETE FROM settings WHERE key = ?').run(ORIGINAL_DEFAULT_PROJECT_SETTING);
    expect(() => registerLimsEntityInDb(db, record())).toThrow(/original My Project/i);
    expect(db.prepare('SELECT COUNT(*) AS count FROM lims_entity').get()).toEqual({ count: 0 });
  });

  it('refuses a nonexistent project before creating an entity', () => {
    expect(() => registerLimsEntityInDb(db, { ...record(), workspaceId: 999 })).toThrow(/project/i);
    expect(db.prepare('SELECT COUNT(*) AS count FROM lims_entity').get()).toEqual({ count: 0 });
  });

  it('does not let an update remove an existing project assignment', () => {
    const entity = registerLimsEntityInDb(db, { ...record(), workspaceId: 42 });
    expect(() => updateLimsEntityInDb(db, { id: entity.id, workspaceId: null })).toThrow(
      /project/i
    );
    expect(db.prepare('SELECT workspace_id FROM lims_entity WHERE id = ?').get(entity.id)).toEqual({
      workspace_id: 42,
    });
  });
});
