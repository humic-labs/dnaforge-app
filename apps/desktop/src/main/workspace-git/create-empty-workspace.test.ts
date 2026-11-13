import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(), getVersion: vi.fn(() => '1.0.0') },
}));

import type Database from 'better-sqlite3';
import { createTestDb } from '../__tests__/test-db';
import { ensureSchema } from '../schema';
import {
  activatePreparedQuickLookDestinationWorkspace,
  createEmptyManagedWorkspace,
  discardPreparedQuickLookDestinationWorkspace,
  MANAGED_WORKSPACE_MARKER,
  prepareQuickLookDestinationWorkspace,
  recoverQuickLookDestinationWorkspaces,
} from './import';
import { resolveHeadCommit } from './index';
import { resolveOriginalDefaultProject } from '../original-default-project';

describe('createEmptyManagedWorkspace  onboarding)', () => {
  let db: Database.Database;
  let tmp: string;
  let managedRoot: string;

  beforeEach(() => {
    db = createTestDb();
    ensureSchema(db, ':memory:');
    tmp = mkdtempSync(join(tmpdir(), 'wp-empty-ws-'));
    managedRoot = join(tmp, 'managed');
  });
  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('creates the original project when only the bundled Samples project has landed', async () => {
    const samples = await createEmptyManagedWorkspace('DNAForge Samples', {
      db,
      managedRootDir: managedRoot,
    });
    db.prepare('UPDATE workspaces SET origin_path = ? WHERE repo_uuid = ?').run(
      join(tmp, 'Sample Workspaces', 'standard-samples', 'v6', 'repo'),
      samples.workspaceUuid
    );
    const original = await createEmptyManagedWorkspace(
      'My Project',
      { db, managedRootDir: managedRoot },
      { originalDefaultProject: true }
    );
    expect(original.workspaceUuid).not.toBe(samples.workspaceUuid);
    expect(resolveOriginalDefaultProject(db)).toMatchObject({
      status: 'ready',
      project: { repoUuid: original.workspaceUuid },
    });
  });

  it('does not invent an original project for a historical profile containing unassigned primers', async () => {
    db.prepare(
      `INSERT INTO primers (id, catalog_number, name, sequence, length, gc_percent, origin, created_at, updated_at)
      VALUES ('historical-primer', 'OLD-1', 'Historical primer', 'ACGTTGCAAGTCCTGATCGA', 20, 50, 'import', 1, 1)`
    ).run();
    await expect(
      createEmptyManagedWorkspace(
        'My Project',
        { db, managedRootDir: managedRoot },
        { originalDefaultProject: true }
      )
    ).rejects.toThrow(/original My Project has not been identified/i);
    expect(db.prepare('SELECT count(*) AS count FROM workspaces').get()).toEqual({ count: 0 });
  });

  it('creates an empty managed workspace with a real initial commit + a workspaces row', async () => {
    const res = await createEmptyManagedWorkspace('My Workspace', {
      db,
      managedRootDir: managedRoot,
    });

    expect(res.displayName).toBe('My Workspace');
    expect(existsSync(join(res.repoPath, MANAGED_WORKSPACE_MARKER))).toBe(true);
    expect(await resolveHeadCommit(res.repoPath)).toMatch(/^[0-9a-f]{40}$/);

    const row = db
      .prepare('SELECT name, path, repo_uuid, origin_path FROM workspaces WHERE path = ?')
      .get(res.repoPath) as { name: string; repo_uuid: string | null; origin_path: string | null };
    expect(row.name).toBe('My Workspace');
    expect(row.repo_uuid).toBeTruthy();
    expect(row.origin_path).toBeNull();
  });

  it('defaults the name when given an empty string', async () => {
    const res = await createEmptyManagedWorkspace('', { db, managedRootDir: managedRoot });
    expect(res.displayName).toBe('My Project');
  });

  it('records the native retry identity atomically with the new project row', async () => {
    const created = await createEmptyManagedWorkspace('Recovery destination', {
      db,
      managedRootDir: managedRoot,
      recordCreatedInsideTx(identity) {
        expect(db.inTransaction).toBe(true);
        expect(
          db
            .prepare('SELECT repo_uuid FROM workspaces WHERE repo_uuid=?')
            .get(identity.workspaceUuid)
        ).toBeDefined();
        db.prepare('INSERT INTO settings(key,value,updated_at) VALUES (?,?,?)').run(
          'recovery-target',
          JSON.stringify(identity),
          Date.now()
        );
      },
    });
    expect(
      JSON.parse(
        (
          db.prepare('SELECT value FROM settings WHERE key=?').get('recovery-target') as {
            value: string;
          }
        ).value
      )
    ).toEqual({ workspaceUuid: created.workspaceUuid, repoPath: created.repoPath });
  });

  it('creates a distinct repo each call', async () => {
    const a = await createEmptyManagedWorkspace('One', { db, managedRootDir: managedRoot });
    const b = await createEmptyManagedWorkspace('Two', { db, managedRootDir: managedRoot });
    expect(a.repoPath).not.toBe(b.repoPath);
  });

  it('records and reuses the original My Project across renames and other project creation', async () => {
    const first = await createEmptyManagedWorkspace(
      'My Project',
      { db, managedRootDir: managedRoot },
      { originalDefaultProject: true }
    );
    db.prepare('UPDATE workspaces SET name = ? WHERE repo_uuid = ?').run(
      'Renamed original',
      first.workspaceUuid
    );
    await createEmptyManagedWorkspace('My Project', { db, managedRootDir: managedRoot });
    const repeat = await createEmptyManagedWorkspace(
      'My Project',
      { db, managedRootDir: managedRoot },
      { originalDefaultProject: true }
    );

    expect(repeat.workspaceUuid).toBe(first.workspaceUuid);
    expect(repeat.repoPath).toBe(first.repoPath);
    expect(repeat.displayName).toBe('Renamed original');
    expect(repeat.reused).toBe(true);
    expect(resolveOriginalDefaultProject(db)).toMatchObject({
      status: 'ready',
      project: { repoUuid: first.workspaceUuid },
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM workspaces').get()).toEqual({ count: 2 });
  });

  it('does not invent a replacement original when an existing profile has no default evidence', async () => {
    await createEmptyManagedWorkspace('Existing project', { db, managedRootDir: managedRoot });
    await expect(
      createEmptyManagedWorkspace(
        'My Project',
        { db, managedRootDir: managedRoot },
        { originalDefaultProject: true }
      )
    ).rejects.toThrow(/original My Project.*identified/i);
    expect(db.prepare('SELECT COUNT(*) AS count FROM workspaces').get()).toEqual({ count: 1 });
  });

  it('does not mistake a developer source folder for an existing original project', async () => {
    db.prepare('INSERT INTO workspaces (name, path, created_at) VALUES (?, ?, 1)').run(
      'Test fixtures',
      join(tmp, 'test-fixtures')
    );
    const original = await createEmptyManagedWorkspace(
      'My Project',
      { db, managedRootDir: managedRoot },
      { originalDefaultProject: true }
    );
    expect(resolveOriginalDefaultProject(db)).toMatchObject({
      status: 'ready',
      project: { repoUuid: original.workspaceUuid },
    });
  });

  it('coalesces concurrent first-window requests into one original project', async () => {
    const [first, second] = await Promise.all([
      createEmptyManagedWorkspace(
        'My Project',
        { db, managedRootDir: managedRoot },
        { originalDefaultProject: true }
      ),
      createEmptyManagedWorkspace(
        'My Project',
        { db, managedRootDir: managedRoot },
        { originalDefaultProject: true }
      ),
    ]);
    expect(second.workspaceUuid).toBe(first.workspaceUuid);
    expect(second.repoPath).toBe(first.repoPath);
    expect(db.prepare('SELECT COUNT(*) AS count FROM workspaces').get()).toEqual({ count: 1 });
  });

  it('keeps a Quick Look destination out of the workspace library until activation', async () => {
    const deps = {
      db,
      managedRootDir: managedRoot,
      preparationJournalRoot: join(tmp, 'workspace-preparations'),
      packagePromotionJournalRoot: join(tmp, 'package-promotions'),
    };
    const prepared = await prepareQuickLookDestinationWorkspace('Imported Sequence', deps);
    expect(await resolveHeadCommit(prepared.repoPath)).toMatch(/^[0-9a-f]{40}$/);
    const pending = db
      .prepare('SELECT id FROM workspaces WHERE repo_uuid = ?')
      .get(prepared.workspaceUuid);
    expect(pending).toBeUndefined();
    expect(existsSync(prepared.repoPath)).toBe(true);

    await activatePreparedQuickLookDestinationWorkspace(prepared, deps);
    prepared.releaseMutationBlock();

    const active = db
      .prepare('SELECT trashed_at FROM workspaces WHERE repo_uuid = ?')
      .get(prepared.workspaceUuid) as { trashed_at: number | null };
    expect(active.trashed_at).toBeNull();
    expect(
      existsSync(join(prepared.workspaceContainerPath, '.dnaforge-quick-look-workspace.json'))
    ).toBe(false);
  });

  it('discards only the exact owned unpublished Quick Look workspace', async () => {
    const deps = {
      db,
      managedRootDir: managedRoot,
      preparationJournalRoot: join(tmp, 'workspace-preparations'),
      packagePromotionJournalRoot: join(tmp, 'package-promotions'),
    };
    const prepared = await prepareQuickLookDestinationWorkspace('Canceled Import', deps);

    await discardPreparedQuickLookDestinationWorkspace(prepared, deps);
    prepared.releaseMutationBlock();

    expect(existsSync(prepared.workspaceContainerPath)).toBe(false);
    expect(
      db
        .prepare('SELECT COUNT(*) AS count FROM workspaces WHERE repo_uuid = ?')
        .get(prepared.workspaceUuid)
    ).toEqual({ count: 0 });
  });

  it('retires a multi-record package journal when its unpublished workspace is discarded', async () => {
    const deps = {
      db,
      managedRootDir: managedRoot,
      preparationJournalRoot: join(tmp, 'workspace-preparations'),
      packagePromotionJournalRoot: join(tmp, 'package-promotions'),
    };
    const prepared = await prepareQuickLookDestinationWorkspace('Canceled Set Import', deps);
    const groupRoot = join(prepared.repoPath, 'assembly');
    mkdirSync(groupRoot);
    mkdirSync(deps.packagePromotionJournalRoot, { recursive: true });
    const identity = lstatSync(groupRoot, { bigint: true });
    const recordKey = 'f'.repeat(64);
    const journalPath = join(deps.packagePromotionJournalRoot, `set-${recordKey}.json`);
    writeFileSync(
      journalPath,
      `${JSON.stringify({
        schema: 'dnaforge.quick-look-set-promotion.v1',
        state: 'active',
        recordKey,
        token: 'canceled-set-token',
        realTarget: realpathSync(prepared.repoPath),
        stagingRoot: realpathSync(groupRoot),
        finalRoot: realpathSync(groupRoot),
        device: identity.dev.toString(),
        inode: identity.ino.toString(),
        sourceFileName: 'assembly.gbk',
        records: [],
        committed: false,
      })}\n`
    );

    await discardPreparedQuickLookDestinationWorkspace(prepared, deps);
    prepared.releaseMutationBlock();

    expect(existsSync(journalPath)).toBe(false);
    expect(existsSync(prepared.workspaceContainerPath)).toBe(false);
  });

  it('recovers an exact owned unpublished workspace after a simulated restart', async () => {
    const deps = {
      db,
      managedRootDir: managedRoot,
      preparationJournalRoot: join(tmp, 'workspace-preparations'),
      packagePromotionJournalRoot: join(tmp, 'package-promotions'),
    };
    const prepared = await prepareQuickLookDestinationWorkspace('Interrupted Import', deps);
    prepared.releaseMutationBlock();

    await recoverQuickLookDestinationWorkspaces(deps);

    expect(existsSync(prepared.workspaceContainerPath)).toBe(false);
    expect(existsSync(prepared.journalPath)).toBe(false);
  });

  it('retains a substituted destination and its private journal instead of deleting user data', async () => {
    const deps = {
      db,
      managedRootDir: managedRoot,
      preparationJournalRoot: join(tmp, 'workspace-preparations'),
      packagePromotionJournalRoot: join(tmp, 'package-promotions'),
    };
    const prepared = await prepareQuickLookDestinationWorkspace('Substitution Guard', deps);
    const original = `${prepared.workspaceContainerPath}-original`;
    renameSync(prepared.workspaceContainerPath, original);
    mkdirSync(prepared.workspaceContainerPath, { recursive: true });
    writeFileSync(join(prepared.workspaceContainerPath, 'user-data.txt'), 'must survive');

    await expect(discardPreparedQuickLookDestinationWorkspace(prepared, deps)).rejects.toThrow(
      'replaced Quick Look destination project'
    );
    prepared.releaseMutationBlock();

    await recoverQuickLookDestinationWorkspaces(deps);

    expect(existsSync(join(prepared.workspaceContainerPath, 'user-data.txt'))).toBe(true);
    expect(existsSync(prepared.journalPath)).toBe(true);
    expect(
      db.prepare('SELECT id FROM workspaces WHERE repo_uuid = ?').get(prepared.workspaceUuid)
    ).toBeUndefined();
  });
});
