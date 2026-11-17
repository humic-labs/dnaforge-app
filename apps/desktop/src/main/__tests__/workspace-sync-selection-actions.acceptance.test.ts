import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MANAGED_WORKSPACE_MARKER } from '../../shared/workspace-git-types';
import { ensureSchema } from '../schema';
import { initManagedRepo } from '../workspace-git';
import { recordWorkspaceSyncReplicaFiles } from '../workspace-sync-replica-files';
import { updateWorkspaceSyncSelection } from '../workspace-sync-selection-actions';
import {
  buildWorkspaceSyncUploadCapture,
  previewWorkspaceSyncUpload,
} from '../workspace-sync-snapshotter';
import { createTestDb } from './test-db';

vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(), getVersion: vi.fn(() => '1.0.0') },
}));

const workspaceUuid = 'selection-actions-project';
const storagePolicy = {
  schemaVersion: 1 as const,
  policyKey: 'selection-actions-test',
  revision: 1,
  maxFileBytes: 1024 * 1024,
  maxProjectBytes: 4 * 1024 * 1024,
  maxFiles: 2000,
  storageQuotaBytes: 8 * 1024 * 1024,
};

describe('shared project file selection commands', () => {
  let db: Database.Database;
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dnaforge-selection-actions-'));
    db = createTestDb();
    ensureSchema(db, ':memory:');
    db.prepare(
      `INSERT INTO workspaces (id, name, path, repo_uuid, created_at, last_opened_at)
       VALUES (1, 'Selection project', ?, ?, 1, 1)`
    ).run(root, workspaceUuid);
    await initManagedRepo(root);
    await writeFile(join(root, MANAGED_WORKSPACE_MARKER), '{}');
    await writeFile(join(root, 'shared.txt'), 'Accepted project note.\n');
    const { app } = await import('electron');
    vi.mocked(app.getPath).mockReturnValue(root);
  });

  afterEach(async () => {
    db?.close();
    if (root) await rm(root, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  const preview = () => previewWorkspaceSyncUpload(db, { workspaceUuid, storagePolicy });
  const capture = () =>
    buildWorkspaceSyncUploadCapture(db, {
      workspaceUuid,
      storagePolicy,
      appVersion: '1.0.0',
    });
  const approve = (expectedRevision: string) =>
    updateWorkspaceSyncSelection(db, {
      workspaceUuid,
      storagePolicy,
      request: { kind: 'approve', expectedRevision },
    });
  const save = (expectedRevision: string, rootGitignore: string) =>
    updateWorkspaceSyncSelection(db, {
      workspaceUuid,
      storagePolicy,
      request: { kind: 'save-rules', expectedRevision, rootGitignore },
    });

  function bind(knownPaths = true) {
    db.prepare(
      `INSERT INTO workspace_sync_bindings
       (workspace_id, workspace_uuid, owner_account_id, remote_workspace_id, enabled,
        remote_latest_version_id, access_role, created_at, updated_at)
       VALUES (1, ?, 'account-a', 'remote-a', 1, 'version-a', 'editor', 1, 1)`
    ).run(workspaceUuid);
    if (knownPaths)
      recordWorkspaceSyncReplicaFiles(db, {
        workspaceUuid,
        remoteWorkspaceId: 'remote-a',
        remoteVersionId: 'version-a',
        paths: ['shared.txt', MANAGED_WORKSPACE_MARKER],
        nowMs: 1,
      });
  }

  it('saves rules as pending and publishes only the explicitly approved selection', async () => {
    await writeFile(join(root, 'local.txt'), 'Never upload this.\n');
    const initial = await preview();
    const pending = await save(initial.selection.revision, '/local.txt\n');
    expect(pending.selection.state).toBe('review-required');
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('/local.txt\n');
    expect((await preview()).selection.state).toBe('review-required');
    await expect(capture()).rejects.toMatchObject({ code: 'SELECTION_REVIEW_REQUIRED' });
    await expect(approve(initial.selection.revision)).rejects.toMatchObject({
      code: 'SELECTION_REVIEW_REQUIRED',
    });
    const active = await approve(pending.selection.revision);
    expect(active.selection.state).toBe('active');
    const captured = await capture();
    expect(captured.selection?.version).toBe(1);
    expect(captured.manifest.files.map((file) => file.path)).toEqual(
      expect.arrayContaining(['shared.txt', '.gitignore'])
    );
    expect(captured.manifest.files.map((file) => file.path)).not.toContain('local.txt');
    expect(await readFile(join(root, 'local.txt'), 'utf8')).toBe('Never upload this.\n');
  });

  it('requires review before adding files previously hidden by legacy folder filters', async () => {
    bind();
    await mkdir(join(root, 'build'));
    await writeFile(join(root, 'build', 'results.txt'), 'Newly visible results.\n');
    const pending = await preview();
    expect(pending.selection.state).toBe('review-required');
    expect(pending.selection.newlyIncludedPaths).toContain('build/results.txt');
    await expect(capture()).rejects.toMatchObject({ code: 'SELECTION_REVIEW_REQUIRED' });
    await approve(pending.selection.revision);
    expect((await capture()).manifest.files.map((file) => file.path)).toContain(
      'build/results.txt'
    );
  });

  it('keeps accepted files included and requires approval again after an external rule edit', async () => {
    bind();
    await writeFile(join(root, 'local.txt'), 'Local note.\n');
    const pending = await save((await preview()).selection.revision, '/local.txt\n/shared.txt\n');
    expect(pending.includedFiles.map((file) => file.relativePath)).toContain('shared.txt');
    await approve(pending.selection.revision);
    expect((await capture()).manifest.files.map((file) => file.path)).toContain('shared.txt');
    await writeFile(join(root, '.gitignore'), '/shared.txt\n');
    const changed = await preview();
    expect(changed.selection.state).toBe('review-required');
    await expect(capture()).rejects.toMatchObject({ code: 'SELECTION_REVIEW_REQUIRED' });
    await expect(approve(pending.selection.revision)).rejects.toMatchObject({
      code: 'SELECTION_REVIEW_REQUIRED',
    });
    await approve(changed.selection.revision);
    expect((await capture()).manifest.files.map((file) => file.path)).toEqual(
      expect.arrayContaining(['shared.txt', 'local.txt'])
    );
  });

  it('rejects stale Save and Apply requests after the selected files change', async () => {
    const pending = await save((await preview()).selection.revision, '/local.txt\n');
    await writeFile(join(root, 'new.txt'), 'Added after preview.\n');
    await expect(approve(pending.selection.revision)).rejects.toMatchObject({
      code: 'SELECTION_REVIEW_REQUIRED',
    });
    await expect(save(pending.selection.revision, '/shared.txt\n')).rejects.toMatchObject({
      code: 'SELECTION_REVIEW_REQUIRED',
    });
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('/local.txt\n');
    expect((await preview()).selection.state).toBe('review-required');
  });

  it('does not approve a project until its accepted remote file list is recovered', async () => {
    bind(false);
    const pending = await preview();
    expect(pending.selection.state).toBe('review-required');
    await expect(approve(pending.selection.revision)).rejects.toMatchObject({
      code: 'SELECTION_REVIEW_REQUIRED',
    });
    await expect(capture()).rejects.toMatchObject({ code: 'SELECTION_REVIEW_REQUIRED' });
  });

  it.each(['viewer', 'detached'] as const)(
    'rejects shared rule mutations for a %s project',
    async (access) => {
      bind();
      if (access === 'viewer')
        db.prepare("UPDATE workspace_sync_bindings SET access_role = 'viewer'").run();
      else
        db.prepare("UPDATE workspace_sync_bindings SET detached_reason = 'access_removed'").run();
      const current = await preview();
      await expect(save(current.selection.revision, '/shared.txt\n')).rejects.toMatchObject({
        code: 'SELECTION_REVIEW_REQUIRED',
      });
      await expect(approve(current.selection.revision)).rejects.toMatchObject({
        code: 'SELECTION_REVIEW_REQUIRED',
      });
      await expect(readFile(join(root, '.gitignore'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
  );
});
