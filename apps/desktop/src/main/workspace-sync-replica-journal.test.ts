import {
  existsSync,
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

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureSchema } from './schema';
import {
  commitAllIfDirty,
  hasWorkingChanges,
  initManagedRepo,
  resolveHeadCommit,
} from './workspace-git';
import {
  createReplicaPullJournal,
  createReplicaPullStagingJournal,
  reconcileInterruptedReplicaPulls,
  replicaPullStagingPrefix,
  replicaJournalHash,
} from './workspace-sync-replica-journal';
import { createTestDb } from './__tests__/test-db';

describe('workspace sync replica recovery journal', () => {
  let db: Database.Database;
  let root: string;
  let repoPath: string;
  let oldHead: string;

  beforeEach(async () => {
    db = createTestDb();
    ensureSchema(db, ':memory:');
    root = mkdtempSync(join(tmpdir(), 'dnaforge-replica-journal-'));
    repoPath = join(root, 'repo');
    mkdirSync(repoPath);
    await initManagedRepo(repoPath);
    writeFileSync(join(repoPath, 'design.txt'), 'OLD\n', 'utf8');
    oldHead = (await commitAllIfDirty(repoPath, 'old replica'))!;
    seedBinding(db, repoPath, oldHead, 'version-old', 3);
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('hashes replica evidence as exact bytes rather than replacement-decoded text', () => {
    const first = Buffer.from([0xff, 0x00, 0x80]);
    const second = Buffer.from([0xfe, 0x00, 0x80]);
    expect(first.toString('utf8')).toBe(second.toString('utf8'));
    expect(replicaJournalHash(first)).not.toBe(replicaJournalHash(second));
  });

  it('recovers a legacy version-1 journal using its original UTF-8 hash semantics', async () => {
    const relativePath = 'legacy-binary.bin';
    const oldBytes = Buffer.from([0xff, 0x00, 0x80]);
    const newBytes = Buffer.from([0xfe, 0x01, 0x81]);
    writeFileSync(join(repoPath, relativePath), oldBytes);
    oldHead = (await commitAllIfDirty(repoPath, 'legacy binary replica'))!;
    db.prepare(
      `UPDATE workspace_sync_bindings
       SET last_acked_local_head_sha = ?
       WHERE workspace_id = 1`
    ).run(oldHead);

    const stagingRoot = join(root, `${replicaPullStagingPrefix('workspace-a')}legacy-binary`);
    const backupRoot = join(stagingRoot, '.backup');
    mkdirSync(backupRoot, { recursive: true });
    renameSync(join(repoPath, relativePath), join(backupRoot, relativePath));
    writeFileSync(join(repoPath, relativePath), newBytes);
    writeFileSync(
      join(stagingRoot, 'replica-pull-journal.json'),
      `${JSON.stringify({
        version: 1,
        phase: 'files_installed',
        repoPath: realpathSync(repoPath),
        workspaceUuid: 'workspace-a',
        oldHead,
        newHead: null,
        targetRemoteVersionId: 'version-new',
        targetRemoteVersionNumber: 4,
        operationPaths: [relativePath],
        backups: [
          {
            relativePath,
            sha256: replicaJournalHash(oldBytes.toString('utf8')),
          },
        ],
        installs: [
          {
            relativePath,
            sha256: replicaJournalHash(newBytes.toString('utf8')),
          },
        ],
      })}\n`,
      'utf8'
    );

    await expect(reconcileInterruptedReplicaPulls(db)).resolves.toEqual({
      recovered: 1,
      completed: 0,
      quarantined: [],
    });
    expect(readFileSync(join(repoPath, relativePath))).toEqual(oldBytes);
    expect(await resolveHeadCommit(repoPath)).toBe(oldHead);
    expect(existsSync(stagingRoot)).toBe(false);
  });

  it('restores the acknowledged files and Git state after restart during installation', async () => {
    const stagingRoot = join(root, '.dnaforge-sync-pull-interrupted');
    const backupPath = join(stagingRoot, '.backup', 'design.txt');
    mkdirSync(join(stagingRoot, '.backup'), { recursive: true });
    const journal = createReplicaPullJournal(stagingRoot, {
      repoPath,
      workspaceUuid: 'workspace-a',
      oldHead,
      targetRemoteVersionId: 'version-new',
      targetRemoteVersionNumber: 4,
      operationPaths: ['design.txt'],
      backups: [{ relativePath: 'design.txt', sha256: replicaJournalHash('OLD\n') }],
      installs: [{ relativePath: 'design.txt', sha256: replicaJournalHash('NEW\n') }],
    });
    renameSync(join(repoPath, 'design.txt'), backupPath);
    writeFileSync(join(repoPath, 'design.txt'), 'NEW\n', 'utf8');
    journal.markFilesInstalled();

    await expect(reconcileInterruptedReplicaPulls(db)).resolves.toEqual({
      recovered: 1,
      completed: 0,
      quarantined: [],
    });

    expect(readFileSync(join(repoPath, 'design.txt'), 'utf8')).toBe('OLD\n');
    expect(await resolveHeadCommit(repoPath)).toBe(oldHead);
    expect(await hasWorkingChanges(repoPath)).toBe(false);
    expect(existsSync(stagingRoot)).toBe(false);
  });

  it('removes an owned staging tree after exit before replica bytes reach the live repo', async () => {
    const stagingRoot = join(root, `${replicaPullStagingPrefix('workspace-a')}allocated`);
    mkdirSync(stagingRoot);
    createReplicaPullStagingJournal(stagingRoot, {
      repoPath,
      workspaceUuid: 'workspace-a',
      oldHead,
      targetRemoteVersionId: 'version-new',
      targetRemoteVersionNumber: 4,
    });
    writeFileSync(join(stagingRoot, 'partially-copied-private-data.txt'), 'PRIVATE\n', 'utf8');

    writeFileSync(join(repoPath, 'later-user-work.txt'), 'LOCAL\n', 'utf8');
    const laterHead = (await commitAllIfDirty(repoPath, 'later user work'))!;

    await expect(reconcileInterruptedReplicaPulls(db)).resolves.toEqual({
      recovered: 1,
      completed: 0,
      quarantined: [],
    });

    expect(existsSync(stagingRoot)).toBe(false);
    expect(await resolveHeadCommit(repoPath)).toBe(laterHead);
    expect(readFileSync(join(repoPath, 'later-user-work.txt'), 'utf8')).toBe('LOCAL\n');
  });

  it('keeps the committed replica when SQLite and Git both acknowledge the target', async () => {
    const stagingRoot = join(root, '.dnaforge-sync-pull-committed');
    const backupPath = join(stagingRoot, '.backup', 'design.txt');
    mkdirSync(join(stagingRoot, '.backup'), { recursive: true });
    const journal = createReplicaPullJournal(stagingRoot, {
      repoPath,
      workspaceUuid: 'workspace-a',
      oldHead,
      targetRemoteVersionId: 'version-new',
      targetRemoteVersionNumber: 4,
      operationPaths: ['design.txt'],
      backups: [{ relativePath: 'design.txt', sha256: replicaJournalHash('OLD\n') }],
      installs: [{ relativePath: 'design.txt', sha256: replicaJournalHash('NEW\n') }],
    });
    renameSync(join(repoPath, 'design.txt'), backupPath);
    writeFileSync(join(repoPath, 'design.txt'), 'NEW\n', 'utf8');
    journal.markFilesInstalled();
    const newHead = (await commitAllIfDirty(repoPath, 'new replica'))!;
    journal.markGitCommitted(newHead);
    db.prepare(
      `UPDATE workspace_sync_bindings
       SET remote_latest_version_id = 'version-new',
           remote_latest_version_number = 4,
           last_acked_local_head_sha = ?
       WHERE workspace_id = 1`
    ).run(newHead);

    await expect(reconcileInterruptedReplicaPulls(db)).resolves.toEqual({
      recovered: 0,
      completed: 1,
      quarantined: [],
    });

    expect(readFileSync(join(repoPath, 'design.txt'), 'utf8')).toBe('NEW\n');
    expect(await resolveHeadCommit(repoPath)).toBe(newHead);
    expect(await hasWorkingChanges(repoPath)).toBe(false);
    expect(existsSync(stagingRoot)).toBe(false);
  });

  it('treats a terminal SQLite journal as cleanup-only after later workspace progress', async () => {
    const stagingRoot = join(root, '.dnaforge-sync-pull-terminal-commit');
    mkdirSync(join(stagingRoot, '.backup'), { recursive: true });
    const journal = createReplicaPullJournal(stagingRoot, {
      repoPath,
      workspaceUuid: 'workspace-a',
      oldHead,
      targetRemoteVersionId: 'version-new',
      targetRemoteVersionNumber: 4,
      operationPaths: ['design.txt'],
      backups: [{ relativePath: 'design.txt', sha256: replicaJournalHash('OLD\n') }],
      installs: [{ relativePath: 'design.txt', sha256: replicaJournalHash('NEW\n') }],
    });
    writeFileSync(join(repoPath, 'design.txt'), 'NEW\n', 'utf8');
    await commitAllIfDirty(repoPath, 'new replica');
    const pulledHead = (await resolveHeadCommit(repoPath))!;
    journal.markFilesInstalled();
    journal.markGitCommitted(pulledHead);
    journal.markSqliteCommitted();

    writeFileSync(join(repoPath, 'later.txt'), 'LATER\n', 'utf8');
    const laterHead = (await commitAllIfDirty(repoPath, 'later user work'))!;
    db.prepare(
      `UPDATE workspace_sync_bindings
       SET remote_latest_version_id = 'version-later',
           remote_latest_version_number = 5,
           last_acked_local_head_sha = ?
       WHERE workspace_id = 1`
    ).run(laterHead);

    await expect(reconcileInterruptedReplicaPulls(db)).resolves.toEqual({
      recovered: 0,
      completed: 1,
      quarantined: [],
    });
    expect(await resolveHeadCommit(repoPath)).toBe(laterHead);
    expect(readFileSync(join(repoPath, 'later.txt'), 'utf8')).toBe('LATER\n');
    expect(existsSync(stagingRoot)).toBe(false);
  });

  it('treats a terminal rollback journal as cleanup-only after a later local commit', async () => {
    const stagingRoot = join(root, '.dnaforge-sync-pull-terminal-rollback');
    mkdirSync(stagingRoot, { recursive: true });
    const journal = createReplicaPullJournal(stagingRoot, {
      repoPath,
      workspaceUuid: 'workspace-a',
      oldHead,
      targetRemoteVersionId: 'version-new',
      targetRemoteVersionNumber: 4,
      operationPaths: ['design.txt'],
      backups: [{ relativePath: 'design.txt', sha256: replicaJournalHash('OLD\n') }],
      installs: [{ relativePath: 'design.txt', sha256: replicaJournalHash('NEW\n') }],
    });
    await journal.rollback(async () => {});
    await journal.finishRollback(async () => {});
    writeFileSync(join(repoPath, 'later.txt'), 'LOCAL\n', 'utf8');
    const laterHead = (await commitAllIfDirty(repoPath, 'later local work'))!;

    await expect(reconcileInterruptedReplicaPulls(db)).resolves.toEqual({
      recovered: 0,
      completed: 1,
      quarantined: [],
    });
    expect(await resolveHeadCommit(repoPath)).toBe(laterHead);
    expect(readFileSync(join(repoPath, 'later.txt'), 'utf8')).toBe('LOCAL\n');
    expect(existsSync(stagingRoot)).toBe(false);
  });

  it('infers the managed commit when the process exits before the Git phase reaches the journal', async () => {
    const stagingRoot = join(root, '.dnaforge-sync-pull-before-journal-update');
    const backupPath = join(stagingRoot, '.backup', 'design.txt');
    mkdirSync(join(stagingRoot, '.backup'), { recursive: true });
    const journal = createReplicaPullJournal(stagingRoot, {
      repoPath,
      workspaceUuid: 'workspace-a',
      oldHead,
      targetRemoteVersionId: 'version-new',
      targetRemoteVersionNumber: 4,
      operationPaths: ['design.txt'],
      backups: [{ relativePath: 'design.txt', sha256: replicaJournalHash('OLD\n') }],
      installs: [{ relativePath: 'design.txt', sha256: replicaJournalHash('NEW\n') }],
    });
    renameSync(join(repoPath, 'design.txt'), backupPath);
    writeFileSync(join(repoPath, 'design.txt'), 'NEW\n', 'utf8');
    journal.markFilesInstalled();
    const newHead = (await commitAllIfDirty(repoPath, 'new replica before journal update'))!;
    db.prepare(
      `UPDATE workspace_sync_bindings
       SET remote_latest_version_id = 'version-new',
           remote_latest_version_number = 4,
           last_acked_local_head_sha = ?
       WHERE workspace_id = 1`
    ).run(newHead);

    await expect(reconcileInterruptedReplicaPulls(db)).resolves.toEqual({
      recovered: 0,
      completed: 1,
      quarantined: [],
    });

    expect(readFileSync(join(repoPath, 'design.txt'), 'utf8')).toBe('NEW\n');
    expect(await resolveHeadCommit(repoPath)).toBe(newHead);
    expect(existsSync(stagingRoot)).toBe(false);
  });

  it('recovers two sibling workspaces without treating the other journal as corruption', async () => {
    const repoPathB = join(root, 'repo-b');
    mkdirSync(repoPathB);
    await initManagedRepo(repoPathB);
    writeFileSync(join(repoPathB, 'design.txt'), 'B OLD\n', 'utf8');
    const oldHeadB = (await commitAllIfDirty(repoPathB, 'old replica B'))!;
    db.prepare(
      `INSERT INTO workspaces (id, name, path, repo_uuid, created_at, last_opened_at)
       VALUES (2, 'Journal test B', ?, 'workspace-b', 1, 1)`
    ).run(repoPathB);
    db.prepare(
      `INSERT INTO workspace_sync_bindings (
         workspace_id, workspace_uuid, owner_account_id, remote_workspace_id, enabled,
         remote_latest_version_id, remote_latest_version_number, remote_latest_content_sha256,
         last_acked_local_head_sha, created_at, updated_at
       ) VALUES (2, 'workspace-b', 'account-a', 'remote-b', 1, 'version-old-b', 8, ?, ?, 1, 1)`
    ).run('b'.repeat(64), oldHeadB);

    const stagingA = join(root, '.dnaforge-sync-pull-workspace-a');
    const stagingB = join(root, '.dnaforge-sync-pull-workspace-b');
    mkdirSync(stagingA);
    mkdirSync(stagingB);
    const journalA = createReplicaPullJournal(stagingA, {
      repoPath,
      workspaceUuid: 'workspace-a',
      oldHead,
      targetRemoteVersionId: 'version-new-a',
      targetRemoteVersionNumber: 4,
      operationPaths: [],
      backups: [],
      installs: [],
    });
    await journalA.rollback(async () => {});
    await journalA.finishRollback(async () => {});
    const journalB = createReplicaPullJournal(stagingB, {
      repoPath: repoPathB,
      workspaceUuid: 'workspace-b',
      oldHead: oldHeadB,
      targetRemoteVersionId: 'version-new-b',
      targetRemoteVersionNumber: 9,
      operationPaths: [],
      backups: [],
      installs: [],
    });
    await journalB.rollback(async () => {});
    await journalB.finishRollback(async () => {});

    await expect(reconcileInterruptedReplicaPulls(db)).resolves.toEqual({
      recovered: 0,
      completed: 2,
      quarantined: [],
    });
    expect(existsSync(stagingA)).toBe(false);
    expect(existsSync(stagingB)).toBe(false);
  });

  it('quarantines only the owner of a malformed sibling journal', async () => {
    const repoPathB = join(root, 'repo-b');
    mkdirSync(repoPathB);
    await initManagedRepo(repoPathB);
    writeFileSync(join(repoPathB, 'design.txt'), 'B OLD\n', 'utf8');
    const oldHeadB = (await commitAllIfDirty(repoPathB, 'old replica B'))!;
    db.prepare(
      `INSERT INTO workspaces (id, name, path, repo_uuid, created_at, last_opened_at)
       VALUES (2, 'Journal test B', ?, 'workspace-b', 1, 1)`
    ).run(repoPathB);
    db.prepare(
      `INSERT INTO workspace_sync_bindings (
         workspace_id, workspace_uuid, owner_account_id, remote_workspace_id, enabled,
         remote_latest_version_id, remote_latest_version_number, remote_latest_content_sha256,
         last_acked_local_head_sha, created_at, updated_at
       ) VALUES (2, 'workspace-b', 'account-a', 'remote-b', 1, 'version-old-b', 8, ?, ?, 1, 1)`
    ).run('b'.repeat(64), oldHeadB);

    const stagingB = join(root, `${replicaPullStagingPrefix('workspace-b')}broken`);
    mkdirSync(stagingB);
    writeFileSync(join(stagingB, 'replica-pull-journal.json'), '{not-json', 'utf8');

    await expect(reconcileInterruptedReplicaPulls(db)).resolves.toMatchObject({
      recovered: 0,
      completed: 0,
      quarantined: [
        expect.objectContaining({
          workspaceId: 2,
          workspaceUuid: 'workspace-b',
          errorMessage: expect.stringMatching(/unreadable/i),
        }),
      ],
    });
    expect(existsSync(stagingB)).toBe(true);
  });

  it('does not guess an owner for an unreadable legacy staging journal', async () => {
    const stagingRoot = join(root, '.dnaforge-sync-pull-legacy-unowned');
    mkdirSync(stagingRoot);
    writeFileSync(join(stagingRoot, 'replica-pull-journal.json'), '{not-json', 'utf8');

    await expect(reconcileInterruptedReplicaPulls(db)).resolves.toEqual({
      recovered: 0,
      completed: 0,
      quarantined: [],
    });
    expect(existsSync(stagingRoot)).toBe(true);
  });

  it('rejects a traversal path before creating a durable intent', () => {
    const stagingRoot = join(root, '.dnaforge-sync-pull-malicious');
    mkdirSync(stagingRoot);

    expect(() =>
      createReplicaPullJournal(stagingRoot, {
        repoPath,
        workspaceUuid: 'workspace-a',
        oldHead,
        targetRemoteVersionId: 'version-new',
        targetRemoteVersionNumber: 4,
        operationPaths: ['../outside.txt'],
        backups: [],
        installs: [],
      })
    ).toThrow('operationPaths is invalid');
  });

  it('refuses recovery through an ancestor directory symlink', async () => {
    const stagingRoot = join(root, '.dnaforge-sync-pull-symlink-ancestor');
    mkdirSync(stagingRoot, { recursive: true });
    const outsideRoot = join(root, 'outside');
    mkdirSync(outsideRoot);
    writeFileSync(join(outsideRoot, 'victim.txt'), 'REMOTE\n', 'utf8');
    const journal = createReplicaPullJournal(stagingRoot, {
      repoPath,
      workspaceUuid: 'workspace-a',
      oldHead,
      targetRemoteVersionId: 'version-new',
      targetRemoteVersionNumber: 4,
      operationPaths: ['linked/victim.txt'],
      backups: [],
      installs: [{ relativePath: 'linked/victim.txt', sha256: replicaJournalHash('REMOTE\n') }],
    });
    symlinkSync(outsideRoot, join(repoPath, 'linked'));
    journal.markFilesInstalled();

    await expect(reconcileInterruptedReplicaPulls(db)).resolves.toMatchObject({
      recovered: 0,
      completed: 0,
      quarantined: [
        expect.objectContaining({
          workspaceId: 1,
          workspaceUuid: 'workspace-a',
          errorMessage: expect.stringMatching(/unsafe ancestor/i),
        }),
      ],
    });
    expect(readFileSync(join(outsideRoot, 'victim.txt'), 'utf8')).toBe('REMOTE\n');
  });
});

function seedBinding(
  db: Database.Database,
  repoPath: string,
  head: string,
  remoteVersionId: string,
  remoteVersionNumber: number
): void {
  db.prepare(
    `INSERT INTO workspaces (id, name, path, repo_uuid, created_at, last_opened_at)
     VALUES (1, 'Journal test', ?, 'workspace-a', 1, 1)`
  ).run(repoPath);
  db.prepare(
    `INSERT INTO workspace_sync_bindings (
       workspace_id, workspace_uuid, owner_account_id, remote_workspace_id, enabled,
       remote_latest_version_id, remote_latest_version_number, remote_latest_content_sha256,
       last_acked_local_head_sha, created_at, updated_at
     ) VALUES (1, 'workspace-a', 'account-a', 'remote-a', 1, ?, ?, ?, ?, 1, 1)`
  ).run(remoteVersionId, remoteVersionNumber, 'a'.repeat(64), head);
}
