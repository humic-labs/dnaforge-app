/** @vitest-environment node */
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: () => '/tmp', getVersion: () => '1.0.0', on: vi.fn(), exit: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));

import { createTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { ensureWorkspaceOwnerInDb } from './catalog-projection-commands';
import { withRendererEntitySql } from './renderer-entity-sql';
import { renameManagedWorkspace } from './workspace-git/lifecycle';

let db: Database.Database;
beforeEach(() => {
  db = createTestDb();
  ensureSchema(db, ':memory:');
});
afterEach(() => db.close());

describe('native workspace opening authority', () => {
  it.each(['direct', 'trigger'] as const)(
    'refuses a %s renderer rewrite of the native project import source',
    (route) => {
      const workspaceId = ensureWorkspaceOwnerInDb(db, '/workspace');
      db.prepare('UPDATE workspaces SET repo_uuid=?,origin_path=? WHERE id=?').run(
        'project-identity',
        '/original-source',
        workspaceId
      );
      const direct = `UPDATE workspaces SET origin_path='/forged-source' WHERE id=${workspaceId}`;
      db.exec(`CREATE TABLE project_origin_sql_bridge(id INTEGER PRIMARY KEY, value TEXT);
        INSERT INTO project_origin_sql_bridge VALUES(1,'original');
        CREATE TRIGGER project_origin_sql_bridge_update AFTER UPDATE ON project_origin_sql_bridge
        BEGIN ${direct}; END;`);
      const statement =
        route === 'direct'
          ? direct
          : "UPDATE project_origin_sql_bridge SET value='changed' WHERE id=1";
      expect(() => withRendererEntitySql(db, statement, () => db.prepare(statement).run())).toThrow(
        /ENTITY_IDENTITY_REQUIRES_NATIVE_COMMAND/
      );
      expect(db.prepare('SELECT origin_path FROM workspaces WHERE id=?').get(workspaceId)).toEqual({
        origin_path: '/original-source',
      });
      db.prepare(direct).run();
      expect(db.prepare('SELECT origin_path FROM workspaces WHERE id=?').get(workspaceId)).toEqual({
        origin_path: '/forged-source',
      });
    }
  );

  it.each(['direct', 'trigger'] as const)(
    'refuses a %s renderer rename while retaining the native project rename command',
    async (route) => {
      const workspaceId = ensureWorkspaceOwnerInDb(db, '/workspace', 'writable', {
        name: 'Original project',
      });
      db.prepare('UPDATE workspaces SET repo_uuid=? WHERE id=?').run(
        'project-identity',
        workspaceId
      );
      const direct = `UPDATE workspaces SET name='repo' WHERE id=${workspaceId}`;
      db.exec(`CREATE TABLE project_name_sql_bridge(id INTEGER PRIMARY KEY, value TEXT);
        INSERT INTO project_name_sql_bridge VALUES(1,'original');
        CREATE TRIGGER project_name_sql_bridge_update AFTER UPDATE ON project_name_sql_bridge
        BEGIN ${direct}; END;`);
      const statement =
        route === 'direct'
          ? direct
          : "UPDATE project_name_sql_bridge SET value='changed' WHERE id=1";

      expect(() => withRendererEntitySql(db, statement, () => db.prepare(statement).run())).toThrow(
        /ENTITY_IDENTITY_REQUIRES_NATIVE_COMMAND/
      );
      expect(db.prepare('SELECT name FROM workspaces WHERE id=?').get(workspaceId)).toEqual({
        name: 'Original project',
      });
      await expect(
        renameManagedWorkspace(db, { repoPath: '/workspace', name: 'Native project name' })
      ).resolves.toEqual({ changed: 1 });
      expect(db.prepare('SELECT name FROM workspaces WHERE id=?').get(workspaceId)).toEqual({
        name: 'Native project name',
      });
    }
  );

  it.each(['direct', 'trigger'] as const)(
    'refuses a %s renderer write to the accepted scientific workspace identity',
    (route) => {
      const workspaceId = ensureWorkspaceOwnerInDb(db, '/workspace');
      db.prepare(
        'INSERT INTO scientific_workspace_identities(workspace_id,logical_workspace_id) VALUES (?,?)'
      ).run(workspaceId, 'original-owner');
      const direct = `UPDATE scientific_workspace_identities SET logical_workspace_id='forged-owner' WHERE workspace_id=${workspaceId}`;
      db.exec(`CREATE TABLE native_sql_bridge(id INTEGER PRIMARY KEY, value TEXT);
        INSERT INTO native_sql_bridge VALUES(1,'original');
        CREATE TRIGGER native_sql_bridge_update AFTER UPDATE ON native_sql_bridge
        BEGIN ${direct}; END;`);
      const statement =
        route === 'direct' ? direct : "UPDATE native_sql_bridge SET value='changed' WHERE id=1";
      expect(() => withRendererEntitySql(db, statement, () => db.prepare(statement).run())).toThrow(
        /SCIENTIFIC_AUTHORITY_REQUIRES_NATIVE_COMMAND/
      );
      expect(
        db
          .prepare(
            'SELECT logical_workspace_id FROM scientific_workspace_identities WHERE workspace_id=?'
          )
          .get(workspaceId)
      ).toEqual({ logical_workspace_id: 'original-owner' });
      db.prepare(direct).run();
      expect(
        db
          .prepare(
            'SELECT logical_workspace_id FROM scientific_workspace_identities WHERE workspace_id=?'
          )
          .get(workspaceId)
      ).toEqual({ logical_workspace_id: 'forged-owner' });
    }
  );

  it('opens through the native owner while refusing raw renderer registration', () => {
    const sql = 'INSERT INTO workspaces(name,path,created_at) VALUES(?,?,?)';
    expect(() =>
      withRendererEntitySql(db, sql, () => db.prepare(sql).run('Unowned', '/workspace', 1))
    ).toThrow(/REQUIRES_NATIVE_COMMAND/);
    const id = ensureWorkspaceOwnerInDb(db, '/workspace', 'reference', {
      name: 'Source sequences',
      recordOpen: true,
    });
    const before = db.prepare('SELECT * FROM workspaces WHERE id=?').get(id) as {
      name: string;
      access_mode: string;
      last_opened_at: number;
    };
    expect(before).toMatchObject({ name: 'Source sequences', access_mode: 'reference' });
    expect(before.last_opened_at).toBeGreaterThan(0);
    expect(
      ensureWorkspaceOwnerInDb(db, '/workspace', undefined, {
        name: 'repo',
        recordOpen: true,
      })
    ).toBe(id);
    expect(db.prepare('SELECT name,access_mode FROM workspaces WHERE id=?').get(id)).toEqual({
      name: 'Source sequences',
      access_mode: 'reference',
    });
  });

  it.each(['archived_at', 'trashed_at'] as const)(
    'refuses opening an owner with %s without changing its record',
    (column) => {
      const id = ensureWorkspaceOwnerInDb(db, '/workspace');
      db.prepare(`UPDATE workspaces SET ${column}=2,last_opened_at=1 WHERE id=?`).run(id);
      const before = db.prepare('SELECT * FROM workspaces WHERE id=?').get(id);
      expect(() =>
        ensureWorkspaceOwnerInDb(db, '/workspace', undefined, {
          name: 'Replacement',
          recordOpen: true,
        })
      ).toThrow(/Restore the owning project/);
      expect(db.prepare('SELECT * FROM workspaces WHERE id=?').get(id)).toEqual(before);
    }
  );

  it('does not let discovery metadata redefine workspace identity or authority', () => {
    expect(() =>
      ensureWorkspaceOwnerInDb(db, '/workspace', undefined, {
        name: 'Project',
        recordOpen: true,
        repoUuid: 'forged-owner',
      } as never)
    ).toThrow(/discovery metadata/);
    expect(db.prepare('SELECT COUNT(*) AS count FROM workspaces').get()).toEqual({ count: 0 });
  });
});
