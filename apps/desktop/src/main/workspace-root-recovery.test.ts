import type Database from 'better-sqlite3';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { MANAGED_WORKSPACE_MARKER } from '../shared/workspace-git-types';
import { listWorkspaceRootStatus, relinkWorkspaceRoot } from './workspace-root-recovery';

let db: Database.Database;
let root: string;
let oldRoot: string;
let movedRoot: string;
const uuid = '11111111-2222-4333-8444-555555555555';
function makeProject(path: string, identity = uuid) {
  mkdirSync(join(path, '.git'), { recursive: true });
  writeFileSync(
    join(path, MANAGED_WORKSPACE_MARKER),
    JSON.stringify({ schema: 1, workspaceUuid: identity })
  );
  writeFileSync(join(path, 'experiment.txt'), 'Original experiment bytes.\n');
}
function workspace() {
  return db.prepare('SELECT * FROM workspaces WHERE id=1').get();
}
function relink(selectedPath = movedRoot) {
  return relinkWorkspaceRoot(db, { repoPath: oldRoot, selectedPath });
}
beforeEach(() => {
  db = createTestDb();
  ensureSchema(db, ':memory:');
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dnaforge-root-relink-')));
  oldRoot = join(root, 'original');
  movedRoot = join(root, 'moved');
  makeProject(oldRoot);
  db.prepare(
    'INSERT INTO workspaces(id,name,path,repo_uuid,created_at,last_opened_at) VALUES(1,?,?,?,?,?)'
  ).run('Experiment', oldRoot, uuid, 1, 1);
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('missing workspace root recovery', () => {
  it('keeps the same owner and original bytes while rebinding live references atomically', () => {
    db.prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,1)').run(
      'current_workspace_path',
      oldRoot
    );
    db.prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,1)').run(
      'default_workspace_path',
      oldRoot
    );
    db.prepare(
      "INSERT INTO entity_references(id,entity_type,display_label,locator,workspace_root_path,workspace_scope,deep_link_params,source,created_at,updated_at) VALUES('ref','file','Experiment',?,?,?,?, 'native',1,1)"
    ).run(
      `file://${oldRoot}/experiment.txt`,
      oldRoot,
      `folders:${JSON.stringify([oldRoot])}`,
      JSON.stringify({ path: join(oldRoot, 'experiment.txt') })
    );
    const before = workspace();
    renameSync(oldRoot, movedRoot);
    expect(listWorkspaceRootStatus(db)).toEqual([{ repoPath: oldRoot, state: 'missing' }]);
    expect(relink()).toEqual({ status: 'relinked', workspaceId: 1, repoPath: movedRoot });
    expect(workspace()).toEqual({ ...(before as object), path: movedRoot });
    expect(readFileSync(join(movedRoot, 'experiment.txt'), 'utf8')).toBe(
      'Original experiment bytes.\n'
    );
    expect(db.prepare('SELECT value FROM settings ORDER BY key').all()).toEqual([
      { value: movedRoot },
      { value: movedRoot },
    ]);
    expect(
      db
        .prepare(
          'SELECT locator,workspace_root_path,workspace_scope,deep_link_params FROM entity_references'
        )
        .get()
    ).toEqual({
      locator: `file://${movedRoot}/experiment.txt`,
      workspace_root_path: movedRoot,
      workspace_scope: `folders:${JSON.stringify([movedRoot])}`,
      deep_link_params: JSON.stringify({ path: join(movedRoot, 'experiment.txt') }),
    });
  });
  it('rejects a different project, a symlink, and a still-present original without changing records', () => {
    makeProject(movedRoot, 'another-project');
    const before = workspace();
    expect(relink()).toEqual({ status: 'rejected', reason: 'source-present' });
    renameSync(oldRoot, join(root, 'retained-original'));
    expect(relink()).toEqual({ status: 'rejected', reason: 'identity-mismatch' });
    const link = join(root, 'link');
    symlinkSync(join(root, 'retained-original'), link);
    expect(relink(link)).toEqual({ status: 'rejected', reason: 'invalid-target' });
    expect(workspace()).toEqual(before);
    expect(readFileSync(join(movedRoot, 'experiment.txt'), 'utf8')).toBe(
      'Original experiment bytes.\n'
    );
  });
  it('rejects an already registered target without merging either project', () => {
    renameSync(oldRoot, movedRoot);
    db.prepare('INSERT INTO workspaces(id,name,path,created_at) VALUES(2,?,?,1)').run(
      'Other',
      movedRoot
    );
    const before = db.prepare('SELECT * FROM workspaces ORDER BY id').all();
    expect(relink()).toEqual({ status: 'rejected', reason: 'path-conflict' });
    expect(db.prepare('SELECT * FROM workspaces ORDER BY id').all()).toEqual(before);
  });
  it('rolls back earlier path changes when a later projection cannot be rebound', () => {
    renameSync(oldRoot, movedRoot);
    db.exec(
      "CREATE TRIGGER stop_rebind BEFORE UPDATE OF value ON settings BEGIN SELECT RAISE(ABORT,'retained projection'); END"
    );
    db.prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,1)').run(
      'default_workspace_path',
      oldRoot
    );
    const before = workspace();
    expect(() => relink()).toThrow('retained projection');
    expect(workspace()).toEqual(before);
  });
  it('preserves completed compute receipts and refuses to relink their bound root', () => {
    renameSync(oldRoot, movedRoot);
    db.prepare(
      "INSERT INTO compute_jobs(id,provider,tool_id,settings_hash,settings_json,state,workspace_root,created_at,updated_at) VALUES('job','local','example','accepted-hash','{}','completed',?,1,1)"
    ).run(oldRoot);
    const before = workspace();
    const job = db.prepare('SELECT * FROM compute_jobs').get();
    expect(relink()).toEqual({ status: 'rejected', reason: 'compute-dependency' });
    expect(workspace()).toEqual(before);
    expect(db.prepare('SELECT * FROM compute_jobs').get()).toEqual(job);
  });
  it('preserves unfinished sync delivery records and refuses to relink their root', () => {
    renameSync(oldRoot, movedRoot);
    db.prepare(
      "INSERT INTO workspace_sync_renderer_deliveries(id,workspace_id,payload_version,state,created_at,updated_at) VALUES('delivery',1,1,'pending',1,1)"
    ).run();
    const before = workspace();
    expect(relink()).toEqual({ status: 'rejected', reason: 'pending-sync-delivery' });
    expect(workspace()).toEqual(before);
  });
});
