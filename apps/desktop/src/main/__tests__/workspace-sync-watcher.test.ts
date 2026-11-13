import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(), getVersion: vi.fn(() => '1.0.0') },
}));

import { ensureSchema } from '../schema';
import {
  computeWorkspaceTreeFingerprint,
  ManagedWorkspaceSyncWatcher,
  ManagedWorkspaceSyncWatcherError,
  type WatchDirectoryCallback,
} from '../workspace-sync-watcher';
import { createTestDb } from './test-db';

describe('managed workspace sync watcher', () => {
  let db: Database.Database;
  let watchDirectory: ReturnType<typeof vi.fn>;
  let watchCallbacks: WatchDirectoryCallback[];
  let closeNativeWatch: ReturnType<typeof vi.fn>;
  let computeFingerprint: ReturnType<typeof vi.fn>;
  let onWorkspaceChanged: ReturnType<typeof vi.fn>;
  let invalidateStatus: ReturnType<typeof vi.fn>;
  let intervals: Array<() => void>;
  let clearedIntervals: unknown[];

  beforeEach(() => {
    db = createTestDb();
    ensureSchema(db, ':memory:');
    seedWorkspace(db, {
      id: 1,
      repoUuid: 'workspace-a',
      path: '/managed/workspace-a/repo',
    });
    watchCallbacks = [];
    closeNativeWatch = vi.fn();
    watchDirectory = vi.fn((_root: string, callback: WatchDirectoryCallback) => {
      watchCallbacks.push(callback);
      return { close: closeNativeWatch };
    });
    computeFingerprint = vi.fn(async () => 'fingerprint-a');
    onWorkspaceChanged = vi.fn();
    invalidateStatus = vi.fn();
    intervals = [];
    clearedIntervals = [];
  });

  it('watches each managed repo_uuid once and invalidates status on filesystem events', async () => {
    const watcher = makeWatcher();

    await expect(watcher.ensureWatching('workspace-a')).resolves.toMatchObject({
      workspaceUuid: 'workspace-a',
      workspaceId: 1,
      repoPath: '/managed/workspace-a/repo',
      nativeWatchActive: true,
      pollFallbackActive: true,
      reused: false,
    });
    await expect(watcher.ensureWatching('workspace-a')).resolves.toMatchObject({ reused: true });

    expect(watchDirectory).toHaveBeenCalledTimes(1);
    expect(watchDirectory).toHaveBeenCalledWith('/managed/workspace-a/repo', expect.any(Function));
    expect(watcher.activeWatcherCount()).toBe(1);

    computeFingerprint.mockResolvedValueOnce('fingerprint-b');
    watchCallbacks[0]({ eventType: 'change', filename: 'sequences/a.gb' });

    await vi.waitFor(() => expect(onWorkspaceChanged).toHaveBeenCalledTimes(1));
    expect(onWorkspaceChanged).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceUuid: 'workspace-a',
        workspaceId: 1,
        repoPath: '/managed/workspace-a/repo',
        reason: 'fs_event',
      })
    );
    expect(invalidateStatus).toHaveBeenCalledWith('workspace-a', 'workspace_changed');
  });

  it('keeps polling when native directory watching cannot attach', async () => {
    watchDirectory.mockImplementationOnce(() => {
      throw new Error('watch unavailable');
    });
    computeFingerprint
      .mockResolvedValueOnce('fingerprint-a')
      .mockResolvedValueOnce('fingerprint-b');

    const watcher = makeWatcher();
    await expect(watcher.ensureWatching('workspace-a')).resolves.toMatchObject({
      nativeWatchActive: false,
      pollFallbackActive: true,
    });

    await expect(watcher.pollNow('workspace-a')).resolves.toBe(true);

    expect(onWorkspaceChanged).toHaveBeenCalledTimes(1);
    expect(onWorkspaceChanged).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceUuid: 'workspace-a', reason: 'poll_changed' })
    );
    expect(invalidateStatus).toHaveBeenCalledWith('workspace-a', 'workspace_changed');
  });

  it('does not publish local Registry and restored resource bookkeeping events', async () => {
    const watcher = makeWatcher();
    await watcher.ensureWatching('workspace-a');

    for (const filename of [
      '.waypoint/lims/log/2026-10.jsonl',
      '.waypoint/lims/manifest.json',
      '.waypoint/lims/sheets/oligos.csv',
      '.dnaforge/hosted-resource-bindings.json',
    ]) {
      watchCallbacks[0]({ eventType: 'rename', filename });
    }

    expect(onWorkspaceChanged).not.toHaveBeenCalled();
    expect(invalidateStatus).not.toHaveBeenCalled();
    watcher.stopAll();
  });

  it('uses only DB-resolved managed roots and rejects missing, archived, or trashed workspaces', async () => {
    seedWorkspace(db, {
      id: 2,
      repoUuid: 'archived-a',
      path: '/managed/archived-a/repo',
      archivedAt: 10,
    });
    seedWorkspace(db, {
      id: 3,
      repoUuid: 'trashed-a',
      path: '/managed/trashed-a/repo',
      trashedAt: 10,
    });
    const watcher = makeWatcher();

    for (const workspaceUuid of ['missing-a', 'archived-a', 'trashed-a']) {
      await expect(watcher.ensureWatching(workspaceUuid)).rejects.toBeInstanceOf(
        ManagedWorkspaceSyncWatcherError
      );
    }

    expect(watchDirectory).not.toHaveBeenCalled();
    expect(watcher.activeWatcherCount()).toBe(0);
  });

  it('closes the native watcher and poll interval exactly once when stopped', async () => {
    const watcher = makeWatcher();
    await watcher.ensureWatching('workspace-a');

    watcher.stopWatching('workspace-a');
    watcher.stopWatching('workspace-a');

    expect(closeNativeWatch).toHaveBeenCalledTimes(1);
    expect(clearedIntervals).toEqual([intervals[0]]);
    expect(watcher.activeWatcherCount()).toBe(0);
  });

  it('fingerprints workspace content while ignoring git metadata and symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-sync-watch-'));
    try {
      await writeFile(join(root, 'a.txt'), 'a', 'utf8');
      const first = await computeWorkspaceTreeFingerprint(root);

      await mkdir(join(root, '.git'));
      await writeFile(join(root, '.git', 'ignored'), 'ignored', 'utf8');
      await symlink(join(root, 'a.txt'), join(root, 'a-link.txt'));
      expect(await computeWorkspaceTreeFingerprint(root)).toBe(first);

      await writeFile(join(root, 'a.txt'), 'changed-content', 'utf8');
      expect(await computeWorkspaceTreeFingerprint(root)).not.toBe(first);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('ignores restored local Registry trees but detects sequence edits and excluded imports', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-sync-watch-restore-'));
    let watcher: ManagedWorkspaceSyncWatcher | undefined;
    try {
      await mkdir(join(root, 'pUC19', '.forge'), { recursive: true });
      await writeFile(join(root, 'pUC19', '.forge', 'plasmid.json'), '{"name":"original"}');
      const restored = await computeWorkspaceTreeFingerprint(root);
      db.prepare('UPDATE workspaces SET path = ? WHERE repo_uuid = ?').run(root, 'workspace-a');
      computeFingerprint = vi.fn(computeWorkspaceTreeFingerprint);
      watcher = makeWatcher();
      await watcher.ensureWatching('workspace-a');

      await mkdir(join(root, '.waypoint', 'lims', 'log'), { recursive: true });
      await mkdir(join(root, '.waypoint', 'lims', 'sheets'), { recursive: true });
      await writeFile(
        join(root, '.waypoint', 'lims', 'log', '2026-10.jsonl'),
        '{"event":"seed"}\n'
      );
      await writeFile(join(root, '.waypoint', 'lims', 'manifest.json'), '{"version":1}');
      await writeFile(join(root, '.waypoint', 'lims', 'sheets', 'oligos.csv'), 'id,name\n');
      await mkdir(join(root, '.dnaforge'), { recursive: true });
      await writeFile(join(root, '.dnaforge', 'hosted-resource-bindings.json'), '{"bindings":[]}');
      expect(await computeWorkspaceTreeFingerprint(root)).toBe(restored);
      watchCallbacks[0]({ eventType: 'rename', filename: '.waypoint' });
      watchCallbacks[0]({ eventType: 'rename', filename: '.dnaforge' });
      await Promise.all(computeFingerprint.mock.results.map((result) => result.value));
      expect(onWorkspaceChanged).not.toHaveBeenCalled();
      expect(await watcher.pollNow('workspace-a')).toBe(false);

      await writeFile(join(root, 'pUC19', '.forge', 'plasmid.json'), '{"name":"real saved edit"}');
      const edited = await computeWorkspaceTreeFingerprint(root);
      expect(edited).not.toBe(restored);
      watchCallbacks[0]({ eventType: 'change', filename: 'pUC19/.forge/plasmid.json' });
      await vi.waitFor(() => expect(onWorkspaceChanged).toHaveBeenCalledTimes(1));
      await writeFile(join(root, 'unsupported.bin'), new Uint8Array([0, 1, 2]));
      expect(await computeWorkspaceTreeFingerprint(root)).not.toBe(edited);
      watchCallbacks[0]({ eventType: 'rename', filename: 'unsupported.bin' });
      await vi.waitFor(() => expect(onWorkspaceChanged).toHaveBeenCalledTimes(2));
      expect(onWorkspaceChanged).toHaveBeenLastCalledWith(
        expect.objectContaining({ workspaceUuid: 'workspace-a', reason: 'fs_event' })
      );
    } finally {
      watcher?.stopAll();
      await rm(root, { recursive: true, force: true });
    }
  });

  function makeWatcher(): ManagedWorkspaceSyncWatcher {
    return new ManagedWorkspaceSyncWatcher(db, {
      watchDirectory,
      computeFingerprint,
      onWorkspaceChanged,
      statusPublisher: { invalidate: invalidateStatus },
      debounceMs: 0,
      pollIntervalMs: 1000,
      setPollInterval: (callback) => {
        intervals.push(callback);
        return callback;
      },
      clearPollInterval: (handle) => {
        clearedIntervals.push(handle);
      },
      nowMs: () => 100,
    });
  }
});

function seedWorkspace(
  db: Database.Database,
  input: {
    id: number;
    repoUuid: string | null;
    path: string;
    archivedAt?: number | null;
    trashedAt?: number | null;
  }
): void {
  db.prepare(
    `INSERT INTO workspaces (
      id, name, path, repo_uuid, created_at, last_opened_at, archived_at, trashed_at
    ) VALUES (?, ?, ?, ?, 1, 1, ?, ?)`
  ).run(
    input.id,
    input.repoUuid ?? `workspace-${input.id}`,
    input.path,
    input.repoUuid,
    input.archivedAt ?? null,
    input.trashedAt ?? null
  );
}
