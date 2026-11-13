import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from './__tests__/test-db';
import { registerScenarioFixtureFiles } from './scenario-fixture-files';
import { ensureSchema } from './schema';

describe('registering scenario fixture files', () => {
  let root: string;
  let project: string;
  let db: Database.Database;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'scenario-fixture-files-')));
    project = join(root, 'repo');
    await mkdir(join(project, 'input'), { recursive: true });
    await writeFile(join(project, 'input', 'vector.fa'), '>vector\nACGT\n');
    await writeFile(join(project, 'input', 'insert.fa'), '>insert\nGGCC\n');
    db = createTestDb();
    ensureSchema(db, ':memory:');
    db.prepare(
      "INSERT INTO workspaces (name, path, created_at, last_opened_at, access_mode) VALUES ('Scenario', ?, 1, 1, 'writable')"
    ).run(project);
  });

  afterEach(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  const manifest = async () =>
    JSON.parse(await readFile(join(project, '.forge', 'catalog.json'), 'utf8')) as {
      entities: Array<{ id: string; type: string; name: string; placement: unknown }>;
    };

  it('lists loose scenario files as file placements and keeps their identities on a repeat', async () => {
    const files = [
      { relativePath: 'input/vector.fa', name: 'vector.fa', fileKind: 'fasta' as const },
      { relativePath: 'input/insert.fa', name: 'insert.fa', fileKind: 'fasta' as const },
    ];
    await registerScenarioFixtureFiles({ db, workspaceRoot: project, files });
    const first = await manifest();
    expect(first.entities).toEqual(
      files.map((file) => ({
        id: expect.any(String),
        type: 'file',
        name: file.name,
        placement: { kind: 'file', relativePath: file.relativePath, fileKind: 'fasta' },
      }))
    );

    await registerScenarioFixtureFiles({ db, workspaceRoot: project, files });
    expect((await manifest()).entities).toEqual(first.entities);
  });

  it('refuses paths outside the project and projects that are not writable', async () => {
    await expect(
      registerScenarioFixtureFiles({
        db,
        workspaceRoot: project,
        files: [{ relativePath: '../outside.fa', name: 'outside.fa', fileKind: 'fasta' }],
      })
    ).rejects.toThrow(/inside the project/);
    await expect(
      registerScenarioFixtureFiles({
        db,
        workspaceRoot: project,
        files: [{ relativePath: '.forge/catalog.json', name: 'catalog.json', fileKind: 'fasta' }],
      })
    ).rejects.toThrow(/inside the project/);
    db.prepare("UPDATE workspaces SET access_mode = 'reference' WHERE path = ?").run(project);
    await expect(
      registerScenarioFixtureFiles({
        db,
        workspaceRoot: project,
        files: [{ relativePath: 'input/vector.fa', name: 'vector.fa', fileKind: 'fasta' }],
      })
    ).rejects.toThrow(/active writable project/);
  });
});
