import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MANAGED_WORKSPACE_MARKER } from '../shared/workspace-git-types';
import { createTestDb } from './__tests__/test-db';
import {
  migrateClonedDevProfileWorkspacePaths,
  managedWorkspaceProfileRoot,
} from './dev-profile-workspace-path-migration';

const WORKSPACE_UUID = '11111111-2222-4333-8444-555555555555';

let root = '';
let oldUserData = '';
let currentUserData = '';
let db: Database.Database;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dnaforge-dev-profile-paths-'));
  oldUserData = join(root, 'DNAForge-dev-1468');
  currentUserData = join(root, 'DNAForge-dev-1472');
  mkdirSync(oldUserData, { recursive: true });
  mkdirSync(currentUserData, { recursive: true });
  db = createTestDb();
  createPathSchema(db);
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('migrateClonedDevProfileWorkspacePaths', () => {
  it('recognizes only the UUID-bound managed path shape for profile ownership', () => {
    expect(
      managedWorkspaceProfileRoot({ path: managedRepoPath(oldUserData), repo_uuid: WORKSPACE_UUID })
    ).toBe(oldUserData);
    expect(
      managedWorkspaceProfileRoot({ path: managedRepoPath(oldUserData), repo_uuid: 'another-uuid' })
    ).toBeNull();
    expect(
      managedWorkspaceProfileRoot({
        path: join(root, 'managed-workspaces', 'user-research', 'repo'),
        repo_uuid: WORKSPACE_UUID,
      })
    ).toBeNull();
    expect(
      managedWorkspaceProfileRoot({
        path: join(root, 'managed-workspaces', WORKSPACE_UUID, 'user-research'),
        repo_uuid: WORKSPACE_UUID,
      })
    ).toBeNull();
    expect(
      managedWorkspaceProfileRoot({ path: managedRepoPath(oldUserData), repo_uuid: null })
    ).toBeNull();
  });
  it('atomically rebinds a cloned managed workspace and every workspace-rooted projection', () => {
    const oldRepo = managedRepoPath(oldUserData);
    const currentRepo = seedManagedRepo(currentUserData);
    const oldOrigin = join(oldUserData, 'Sample Workspaces', 'standard-samples', 'v2', 'workspace');
    const currentOrigin = join(
      currentUserData,
      'Sample Workspaces',
      'standard-samples',
      'v2',
      'workspace'
    );
    mkdirSync(currentOrigin, { recursive: true });
    seedWorkspaceProjection(db, oldRepo, oldOrigin);

    const result = migrateClonedDevProfileWorkspacePaths(db, currentUserData);

    expect(result).toMatchObject({ action: 'migrated', migratedWorkspaces: 1 });
    expect(result.migratedRows).toEqual({
      workspaces: 1,
      workspaceOrigins: 1,
      indexedFiles: 1,
      catalogEntities: 2,
      catalogEntityFiles: 2,
      catalogEntityEvents: 1,
      conversations: 1,
      agentOutputArtifacts: 1,
      settings: 1,
    });
    expect(workspaceRow(db)).toEqual({ path: currentRepo, origin_path: currentOrigin });
    expect(pathValues(db, 'indexed_files')).toEqual([join(currentRepo, 'reads.bam')]);
    expect(pathValues(db, 'catalog_entity_files')).toEqual([
      currentRepo,
      join(currentRepo, 'annotations', 'scene.raster'),
    ]);
    expect(singleValue(db, "SELECT locator AS value FROM catalog_entities WHERE id = 'root'")).toBe(
      `file://${currentRepo}`
    );
    expect(
      JSON.parse(
        singleValue(db, "SELECT metadata AS value FROM catalog_entities WHERE id = 'raster'") ??
          '{}'
      )
    ).toMatchObject({
      path: join(currentRepo, 'annotations', 'scene.raster'),
      nested: { workspaceRoot: currentRepo },
    });
    expect(
      JSON.parse(singleValue(db, 'SELECT payload AS value FROM catalog_entity_events') ?? '{}')
    ).toEqual({
      generated: [join(currentRepo, 'annotations', 'scene.raster')],
    });
    expect(singleValue(db, 'SELECT workspace_path AS value FROM conversations')).toBe(currentRepo);
    expect(singleValue(db, 'SELECT path AS value FROM agent_output_artifacts')).toBe(
      join(currentRepo, 'reports', 'summary.md')
    );
    expect(singleValue(db, "SELECT value FROM settings WHERE key = 'current_workspace_path'")).toBe(
      currentRepo
    );
  });

  it('is idempotent after the cloned paths have been rebound', () => {
    const oldRepo = managedRepoPath(oldUserData);
    const currentRepo = seedManagedRepo(currentUserData);
    seedWorkspaceProjection(db, oldRepo, null);

    expect(migrateClonedDevProfileWorkspacePaths(db, currentUserData).action).toBe('migrated');
    const second = migrateClonedDevProfileWorkspacePaths(db, currentUserData);

    expect(second).toMatchObject({ action: 'none', migratedWorkspaces: 0, skipped: [] });
    expect(workspaceRow(db).path).toBe(currentRepo);
  });

  it('does nothing when every managed row already belongs to the current profile', () => {
    const currentRepo = seedManagedRepo(currentUserData);
    seedWorkspaceProjection(db, currentRepo, null);

    expect(migrateClonedDevProfileWorkspacePaths(db, currentUserData)).toMatchObject({
      action: 'none',
      migratedWorkspaces: 0,
      skipped: [],
    });
  });

  it('fails closed when the copied managed repository is missing', () => {
    const oldRepo = managedRepoPath(oldUserData);
    seedWorkspaceProjection(db, oldRepo, null);

    const result = migrateClonedDevProfileWorkspacePaths(db, currentUserData);

    expect(result.action).toBe('none');
    expect(result.skipped).toEqual([{ workspaceId: 1, reason: 'counterpart-missing' }]);
    expect(workspaceRow(db).path).toBe(oldRepo);
  });

  it('fails closed when the copied marker UUID does not match the database identity', () => {
    const oldRepo = managedRepoPath(oldUserData);
    seedManagedRepo(currentUserData, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    seedWorkspaceProjection(db, oldRepo, null);

    const result = migrateClonedDevProfileWorkspacePaths(db, currentUserData);

    expect(result.skipped).toEqual([{ workspaceId: 1, reason: 'identity-mismatch' }]);
    expect(workspaceRow(db).path).toBe(oldRepo);
  });

  it('leaves the entire projection untouched when a target catalog path would conflict', () => {
    const oldRepo = managedRepoPath(oldUserData);
    const currentRepo = seedManagedRepo(currentUserData);
    seedWorkspaceProjection(db, oldRepo, null);
    db.prepare('INSERT INTO catalog_entity_files (id, workspace_id, path) VALUES (?, NULL, ?)').run(
      'conflict',
      join(currentRepo, 'annotations', 'scene.raster')
    );

    const result = migrateClonedDevProfileWorkspacePaths(db, currentUserData);

    expect(result.skipped).toEqual([{ workspaceId: 1, reason: 'path-conflict' }]);
    expect(workspaceRow(db).path).toBe(oldRepo);
    expect(pathValues(db, 'indexed_files')).toEqual([join(oldRepo, 'reads.bam')]);
    expect(singleValue(db, "SELECT value FROM settings WHERE key = 'current_workspace_path'")).toBe(
      oldRepo
    );
  });

  it('never rewrites an external managed row that is not rooted in a sibling dev profile', () => {
    const externalRepo = join(root, 'external', 'managed-workspaces', WORKSPACE_UUID, 'repo');
    seedManagedRepo(currentUserData);
    seedWorkspaceProjection(db, externalRepo, null);

    const result = migrateClonedDevProfileWorkspacePaths(db, currentUserData);

    expect(result).toMatchObject({ action: 'none', migratedWorkspaces: 0, skipped: [] });
    expect(workspaceRow(db).path).toBe(externalRepo);
  });

  it('rejects a copied UUID directory whose symlink escapes the current managed root', () => {
    const oldRepo = managedRepoPath(oldUserData);
    const outsideRepo = join(root, 'outside-repo');
    mkdirSync(outsideRepo, { recursive: true });
    writeMarker(outsideRepo, WORKSPACE_UUID);
    const managedRoot = join(currentUserData, 'managed-workspaces');
    mkdirSync(managedRoot, { recursive: true });
    symlinkSync(outsideRepo, join(managedRoot, WORKSPACE_UUID), 'dir');
    seedWorkspaceProjection(db, oldRepo, null);

    const result = migrateClonedDevProfileWorkspacePaths(db, currentUserData);

    expect(result.skipped).toEqual([{ workspaceId: 1, reason: 'counterpart-escaped-root' }]);
    expect(workspaceRow(db).path).toBe(oldRepo);
  });

  it('does not run for a packaged or otherwise non-dev userData directory', () => {
    const packagedUserData = join(root, 'DNAForge');
    mkdirSync(packagedUserData, { recursive: true });
    seedWorkspaceProjection(db, managedRepoPath(oldUserData), null);

    expect(migrateClonedDevProfileWorkspacePaths(db, packagedUserData)).toMatchObject({
      action: 'not-dev-profile',
      migratedWorkspaces: 0,
    });
  });

  it('is wired after schema creation and before IPC registration in the main bootstrap', () => {
    const mainSource = readFileSync(join(__dirname, 'index.ts'), 'utf8');
    const schemaIndex = mainSource.indexOf('ensureSchemaForBuild(database, getDbPath(), {');
    const migrationIndex = mainSource.indexOf(
      'migrateClonedDevProfileWorkspacePaths(getDb(), app.getPath'
    );
    const ipcIndex = mainSource.indexOf('registerAllIpcHandlers({');

    expect(schemaIndex).toBeGreaterThan(-1);
    expect(migrationIndex).toBeGreaterThan(schemaIndex);
    expect(ipcIndex).toBeGreaterThan(migrationIndex);
  });
});

function managedRepoPath(userData: string): string {
  return join(userData, 'managed-workspaces', WORKSPACE_UUID, 'repo');
}

function seedManagedRepo(userData: string, markerUuid = WORKSPACE_UUID): string {
  const repoPath = managedRepoPath(userData);
  mkdirSync(join(repoPath, '.git'), { recursive: true });
  writeMarker(repoPath, markerUuid);
  return repoPath;
}

function writeMarker(repoPath: string, markerUuid: string): void {
  writeFileSync(
    join(repoPath, MANAGED_WORKSPACE_MARKER),
    `${JSON.stringify({ schema: 1, workspaceUuid: markerUuid })}\n`,
    'utf8'
  );
}

function createPathSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE workspaces (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      repo_uuid TEXT,
      origin_path TEXT
    );
    CREATE TABLE indexed_files (
      id INTEGER PRIMARY KEY,
      workspace_id INTEGER NOT NULL,
      path TEXT NOT NULL
    );
    CREATE TABLE catalog_entity_files (
      id TEXT PRIMARY KEY,
      workspace_id INTEGER,
      path TEXT NOT NULL UNIQUE
    );
    CREATE TABLE catalog_entities (
      id TEXT PRIMARY KEY,
      workspace_id INTEGER,
      locator TEXT NOT NULL UNIQUE,
      metadata TEXT
    );
    CREATE TABLE catalog_entity_events (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      payload TEXT
    );
    CREATE TABLE conversations (id TEXT PRIMARY KEY, workspace_path TEXT);
    CREATE TABLE agent_output_artifacts (id TEXT PRIMARY KEY, path TEXT NOT NULL);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
  `);
}

function seedWorkspaceProjection(
  database: Database.Database,
  workspacePath: string,
  originPath: string | null
): void {
  database
    .prepare(
      `INSERT INTO workspaces (id, name, path, repo_uuid, origin_path)
       VALUES (1, 'Cloned workspace', ?, ?, ?)`
    )
    .run(workspacePath, WORKSPACE_UUID, originPath);
  database
    .prepare('INSERT INTO indexed_files (id, workspace_id, path) VALUES (1, 1, ?)')
    .run(join(workspacePath, 'reads.bam'));
  database
    .prepare('INSERT INTO catalog_entity_files (id, workspace_id, path) VALUES (?, 1, ?)')
    .run('root', workspacePath);
  database
    .prepare('INSERT INTO catalog_entity_files (id, workspace_id, path) VALUES (?, 1, ?)')
    .run('raster', join(workspacePath, 'annotations', 'scene.raster'));
  database
    .prepare(
      'INSERT INTO catalog_entities (id, workspace_id, locator, metadata) VALUES (?, 1, ?, ?)'
    )
    .run(
      'root',
      `file://${workspacePath}`,
      JSON.stringify({ path: workspacePath, relativePath: '' })
    );
  database
    .prepare(
      'INSERT INTO catalog_entities (id, workspace_id, locator, metadata) VALUES (?, 1, ?, ?)'
    )
    .run(
      'raster',
      `file://${join(workspacePath, 'annotations', 'scene.raster')}`,
      JSON.stringify({
        path: join(workspacePath, 'annotations', 'scene.raster'),
        nested: { workspaceRoot: workspacePath },
      })
    );
  database
    .prepare('INSERT INTO catalog_entity_events (id, entity_id, payload) VALUES (?, ?, ?)')
    .run(
      'event',
      'raster',
      JSON.stringify({ generated: [join(workspacePath, 'annotations', 'scene.raster')] })
    );
  database
    .prepare('INSERT INTO conversations (id, workspace_path) VALUES (?, ?)')
    .run('conversation', workspacePath);
  database
    .prepare('INSERT INTO agent_output_artifacts (id, path) VALUES (?, ?)')
    .run('artifact', join(workspacePath, 'reports', 'summary.md'));
  database
    .prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, 1)')
    .run('current_workspace_path', workspacePath);
}

function workspaceRow(database: Database.Database): { path: string; origin_path: string | null } {
  return database.prepare('SELECT path, origin_path FROM workspaces WHERE id = 1').get() as {
    path: string;
    origin_path: string | null;
  };
}

function pathValues(database: Database.Database, table: string): string[] {
  return (
    database.prepare(`SELECT path FROM ${table} ORDER BY path`).all() as Array<{ path: string }>
  ).map((row) => row.path);
}

function singleValue(database: Database.Database, sql: string): string | null {
  return (database.prepare(sql).get() as { value: string | null }).value;
}
