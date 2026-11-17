import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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

for (const retained of [false, true]) {
  it(`repeated recovery start releases an existing lifecycle waiter after ${retained ? 'retained-draft refusal' : 'clean completion'}`, async () => {
    const owner = createNativeFileDocuments({
      db: () => db,
      workspaceRoots: () => [root],
      writableWorkspaceRoots: () => [root],
      profileDirectory: () => profile,
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let completed = false;
    let removalStarted = false;
    const removal = (() => {
      owner.beginLegacyMigration();
      return owner.withCleanPaths([root], async () => {
        removalStarted = true;
        return 'removed from active projects';
      });
    })().then(
      (result) => {
        completed = true;
        return { result };
      },
      (error: Error) => {
        completed = true;
        return { error };
      }
    );
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(completed).toBe(false);
      expect(removalStarted).toBe(false);
      owner.beginLegacyMigration();
      await owner.completeLegacyMigration(retained ? [join(root, 'experiment.txt')] : []);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await vi.waitFor(
        () =>
          expect(completed, 'completed transfer must release its existing lifecycle waiter').toBe(
            true
          ),
        { timeout: 250, interval: 5 }
      );
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
    } finally {
      await vi.runOnlyPendingTimersAsync();
      await removal;
      vi.useRealTimers();
      await owner.close();
    }
  });
}

it('a recovery transfer started after completion holds new lifecycle waiters until its own completion', async () => {
  const owner = createNativeFileDocuments({
    db: () => db,
    workspaceRoots: () => [root],
    writableWorkspaceRoots: () => [root],
    profileDirectory: () => profile,
  });
  owner.beginLegacyMigration();
  await owner.completeLegacyMigration([]);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  owner.beginLegacyMigration();
  let removalStarted = false;
  const removal = owner
    .withCleanPaths([root], async () => {
      removalStarted = true;
      return 'second transfer completed';
    })
    .then(
      (result) => ({ result }),
      (error: Error) => ({ error })
    );
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(removalStarted).toBe(false);
    await owner.completeLegacyMigration([]);
    await expect(removal).resolves.toEqual({ result: 'second transfer completed' });
    expect(removalStarted).toBe(true);
    expect(await readFile(join(root, 'experiment.txt'), 'utf8')).toBe('original experiment');
  } finally {
    await vi.runOnlyPendingTimersAsync();
    await removal;
    vi.useRealTimers();
    await owner.close();
  }
});
