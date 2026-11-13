import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from './__tests__/test-db';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRegisteredProjectPath } from './project-path-identity';

describe('native project path identity', () => {
  let db: Database.Database;
  let temporary: string;
  let root: string;
  let alias: string;
  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'dnaforge-project-path-'));
    root = join(temporary, 'physical');
    alias = join(temporary, 'alias');
    await mkdir(root);
    await symlink(root, alias, 'dir');
    await writeFile(join(root, 'source.gb'), 'SYNTHETIC_PATH_IDENTITY_FIXTURE');
    db = createTestDb();
    db.exec(`CREATE TABLE workspaces(path TEXT UNIQUE);
      CREATE TABLE catalog_entities(id TEXT PRIMARY KEY, status TEXT);
      CREATE TABLE catalog_entity_files(entity_id TEXT, path TEXT UNIQUE, status TEXT);`);
    db.prepare('INSERT INTO catalog_entities VALUES (?,?)').run('stable-sequence', 'active');
  });
  afterEach(async () => {
    db?.close();
    await rm(temporary, { recursive: true, force: true });
  });
  const input = () => ({ db, admit: realpath });
  it('maps a new alias to the enrolled physical project and existing sequence without changing records', async () => {
    const physical = await realpath(root);
    db.prepare('INSERT INTO workspaces VALUES (?)').run(physical);
    db.prepare('INSERT INTO catalog_entity_files VALUES (?,?,?)').run(
      'stable-sequence',
      join(physical, 'source.gb'),
      'current'
    );
    expect(await resolveRegisteredProjectPath(alias, input())).toBe(physical);
    expect(await resolveRegisteredProjectPath(join(alias, 'source.gb'), input())).toBe(
      join(physical, 'source.gb')
    );
    expect(db.prepare('SELECT COUNT(*) AS count FROM workspaces').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT entity_id FROM catalog_entity_files').all()).toEqual([
      { entity_id: 'stable-sequence' },
    ]);
  });
  it('preserves an older enrolled alias and its catalog UUID when opened by physical path', async () => {
    db.prepare('INSERT INTO workspaces VALUES (?)').run(alias);
    db.prepare('INSERT INTO catalog_entity_files VALUES (?,?,?)').run(
      'stable-sequence',
      join(alias, 'source.gb'),
      'current'
    );
    expect(await resolveRegisteredProjectPath(root, input())).toBe(alias);
    expect(await resolveRegisteredProjectPath(join(root, 'source.gb'), input())).toBe(
      join(alias, 'source.gb')
    );
    expect(db.prepare('SELECT path FROM workspaces').all()).toEqual([{ path: alias }]);
    expect(db.prepare('SELECT entity_id,path FROM catalog_entity_files').all()).toEqual([
      { entity_id: 'stable-sequence', path: join(alias, 'source.gb') },
    ]);
  });
  it('refuses ambiguous legacy aliases and preserves both existing identities', async () => {
    const second = join(temporary, 'second');
    const third = join(temporary, 'third');
    await symlink(root, second, 'dir');
    await symlink(root, third, 'dir');
    db.prepare('INSERT INTO workspaces VALUES (?)').run(alias);
    db.prepare('INSERT INTO workspaces VALUES (?)').run(second);
    await expect(resolveRegisteredProjectPath(third, input())).rejects.toThrow(
      'More than one stored project'
    );
    expect(await resolveRegisteredProjectPath(alias, input())).toBe(alias);
    expect(db.prepare('SELECT COUNT(*) AS count FROM workspaces').get()).toEqual({ count: 2 });
  });
});
