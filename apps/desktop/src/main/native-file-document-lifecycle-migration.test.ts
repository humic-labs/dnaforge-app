import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { createNativeFileDocuments } from './native-file-documents';

let db: Database.Database;
let directory: string;
let root: string;
let profile: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'project-lifecycle-migration-'));
  root = join(directory, 'project');
  profile = join(directory, 'profile');
  await mkdir(root);
  await writeFile(join(root, 'experiment.txt'), 'original experiment');
  db = createTestDb();
  ensureSchema(db, ':memory:');
});

afterEach(async () => {
  db.close();
  await rm(directory, { recursive: true, force: true });
});

for (const retained of [false, true]) {
  it(`waits for an active recovery transfer before ${retained ? 'refusing a retained draft' : 'allowing project removal'}`, async () => {
    const owner = createNativeFileDocuments({
      db: () => db,
      workspaceRoots: () => [root],
      writableWorkspaceRoots: () => [root],
      profileDirectory: () => profile,
    });
    owner.beginLegacyMigration();
    let completed = false;
    let removalStarted = false;
    const removal = owner
      .withCleanPaths([root], async () => {
        removalStarted = true;
        return 'removed from active projects';
      })
      .then(
        (result) => {
          completed = true;
          return { result };
        },
        (error: Error) => {
          completed = true;
          return { error };
        }
      );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(completed).toBe(false);
    expect(removalStarted).toBe(false);
    await owner.completeLegacyMigration(retained ? [join(root, 'experiment.txt')] : []);
    const outcome = await removal;
    if (retained) {
      expect(outcome).toMatchObject({
        error: expect.objectContaining({
          message: expect.stringContaining('LEGACY_FILE_DRAFT_MIGRATION_REQUIRED'),
        }),
      });
      expect(removalStarted).toBe(false);
    } else {
      expect(outcome).toEqual({ result: 'removed from active projects' });
      expect(removalStarted).toBe(true);
    }
    expect(await readFile(join(root, 'experiment.txt'), 'utf8')).toBe('original experiment');
    await owner.close();
  });
}
