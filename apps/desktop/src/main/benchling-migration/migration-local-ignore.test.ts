import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { commitAllIfDirty, initManagedRepo, listFilesAtHead } from '../workspace-git';
import { MIGRATION_LOCAL_IGNORE_BLOCK, mergeMigrationLocalIgnore } from './migration-local-ignore';

describe('migration local ignore', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('appends one managed block without changing user rules', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dnaforge-migration-ignore-'));
    roots.push(root);
    await writeFile(join(root, '.gitignore'), '# My rules\n*.local\n', 'utf8');

    await mergeMigrationLocalIgnore(root);
    const once = await readFile(join(root, '.gitignore'), 'utf8');
    await mergeMigrationLocalIgnore(root);
    const twice = await readFile(join(root, '.gitignore'), 'utf8');

    expect(once).toBe(`# My rules\n*.local\n\n${MIGRATION_LOCAL_IGNORE_BLOCK}\n`);
    expect(twice).toBe(once);
  });

  it('covers every local migration artifact without an absolute source path', () => {
    expect(MIGRATION_LOCAL_IGNORE_BLOCK).toContain('.dnaforge/migration/migration.sqlite-wal');
    expect(MIGRATION_LOCAL_IGNORE_BLOCK).toContain('.dnaforge/migration/migration.sqlite-shm');
    expect(MIGRATION_LOCAL_IGNORE_BLOCK).toContain('.dnaforge/migration/external-sources/');
    expect(MIGRATION_LOCAL_IGNORE_BLOCK).toContain('.dnaforge/migration/action-journals/');
    expect(MIGRATION_LOCAL_IGNORE_BLOCK).toContain('.dnaforge/migration/projection-staging/');
    expect(MIGRATION_LOCAL_IGNORE_BLOCK).toContain('.dnaforge/migration/tmp/');
    expect(MIGRATION_LOCAL_IGNORE_BLOCK).toContain('.dnaforge/migration/rollback/');
    expect(MIGRATION_LOCAL_IGNORE_BLOCK).not.toMatch(/^\//mu);
  });

  it('keeps later managed commits from capturing migration state or source locators', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dnaforge-migration-ignore-git-'));
    roots.push(root);
    await initManagedRepo(root);
    await mergeMigrationLocalIgnore(root);
    await writeFile(join(root, 'design.gb'), 'LOCUS       design\nORIGIN\n//\n', 'utf8');
    await mkdir(join(root, '.dnaforge', 'migration', 'external-sources'), { recursive: true });
    await writeFile(join(root, '.dnaforge', 'migration', 'migration.sqlite'), 'private', 'utf8');
    await writeFile(
      join(root, '.dnaforge', 'migration', 'external-sources', 'source.json'),
      JSON.stringify({ path: '/Users/scientist/Downloads/private-export.zip' }),
      'utf8'
    );

    await commitAllIfDirty(root, 'Capture workspace content');

    expect(await listFilesAtHead(root)).toEqual(['.gitignore', 'design.gb']);
  });
});
