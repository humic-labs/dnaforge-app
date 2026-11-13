import { afterEach, expect, it, vi } from 'vitest';
import { createTestDb } from './test-db';
import {
  ManagedWorkspaceSyncWatcher,
  type WatchDirectoryCallback,
} from '../workspace-sync-watcher';

const fixtures: ReturnType<typeof createFixture>[] = [];

function fixture() {
  const result = createFixture();
  fixtures.push(result);
  return result;
}

function createFixture() {
  const db = createTestDb();
  db.exec(
    "CREATE TABLE workspaces(id INTEGER, path TEXT, repo_uuid TEXT, archived_at INTEGER, trashed_at INTEGER); INSERT INTO workspaces VALUES (1, '/synthetic/A', 'A', NULL, NULL), (2, '/synthetic/B', 'B', NULL, NULL)"
  );
  const callbacks: WatchDirectoryCallback[] = [];
  const closes: Array<ReturnType<typeof vi.fn>> = [];
  const intervals: Array<() => void> = [];
  const gates: Array<{ resolve: (value: string | null) => void; reject: (error: Error) => void }> =
    [];
  const clearPollInterval = vi.fn();
  const onWorkspaceChanged = vi.fn();
  const computeFingerprint = vi.fn(
    () => new Promise<string | null>((resolve, reject) => gates.push({ resolve, reject }))
  );
  const watchDirectory = vi.fn((_path: string, callback: WatchDirectoryCallback) => {
    callbacks.push(callback);
    const close = vi.fn();
    closes.push(close);
    return { close };
  });
  const setPollInterval = vi.fn((callback: () => void) => {
    intervals.push(callback);
    return callback;
  });
  const watcher = new ManagedWorkspaceSyncWatcher(db, {
    watchDirectory,
    computeFingerprint,
    setPollInterval,
    clearPollInterval,
    onWorkspaceChanged,
    debounceMs: 0,
  });
  const result = {
    db,
    watcher,
    callbacks,
    closes,
    intervals,
    gates,
    clearPollInterval,
    onWorkspaceChanged,
    computeFingerprint,
    watchDirectory,
    setPollInterval,
  };
  return result;
}

afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.watcher.stopAll();
    f.gates.forEach((gate) => gate.resolve(null));
    f.db.close();
  }
});

it('joins overlapping starts before the initial fingerprint and closes one handle and timer', async () => {
  const f = fixture();
  const pending = Array.from({ length: 8 }, () => f.watcher.ensureWatching('A'));
  await vi.waitFor(() => expect(f.gates.length).toBeGreaterThan(0));
  const starts = f.watchDirectory.mock.calls.length;
  f.gates.forEach((gate) => gate.resolve('initial'));
  const states = await Promise.all(pending);
  f.watcher.stopAll();
  expect(starts).toBe(1);
  expect(f.computeFingerprint).toHaveBeenCalledTimes(1);
  expect(f.setPollInterval).toHaveBeenCalledTimes(1);
  expect(f.closes.every((close) => close.mock.calls.length === 1)).toBe(true);
  expect(f.clearPollInterval).toHaveBeenCalledTimes(1);
  expect(f.watcher.activeWatcherCount()).toBe(0);
  expect(states.map((state) => state.reused)).toEqual([
    false,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
  ]);
});

it('retires an initializing watcher immediately and never attaches its late timer', async () => {
  const f = fixture();
  const pending = f.watcher.ensureWatching('A');
  await vi.waitFor(() => expect(f.gates).toHaveLength(1));
  f.watcher.stopWatching('A');
  const closesAtStop = f.closes[0].mock.calls.length;
  f.gates[0].resolve('initial');
  const state = await pending;
  expect(closesAtStop).toBe(1);
  expect(f.setPollInterval).not.toHaveBeenCalled();
  expect(f.watcher.activeWatcherCount()).toBe(0);
  expect(state).toMatchObject({ nativeWatchActive: false, pollFallbackActive: false });
  f.watcher.stopAll();
  expect(f.closes[0]).toHaveBeenCalledTimes(1);
});

it.each(['old-first', 'new-first'] as const)(
  'keeps the new generation when scans settle %s',
  async (order) => {
    const f = fixture();
    const old = f.watcher.ensureWatching('A');
    await vi.waitFor(() => expect(f.gates).toHaveLength(1));
    f.watcher.stopWatching('A');
    const current = f.watcher.ensureWatching('A');
    await vi.waitFor(() => expect(f.gates).toHaveLength(2));
    if (order === 'old-first') {
      f.gates[0].resolve('old');
      await old;
      f.gates[1].resolve('new');
    } else {
      f.gates[1].resolve('new');
      await current;
      f.gates[0].resolve('old');
    }
    await Promise.all([old, current]);
    expect(f.watcher.activeWatcherCount()).toBe(1);
    expect(f.setPollInterval).toHaveBeenCalledTimes(1);
    expect(f.closes[0]).toHaveBeenCalledTimes(1);
    expect(f.closes[1]).not.toHaveBeenCalled();
    f.watcher.stopAll();
    expect(f.closes[1]).toHaveBeenCalledTimes(1);
    expect(f.clearPollInterval).toHaveBeenCalledTimes(1);
    expect(f.onWorkspaceChanged).not.toHaveBeenCalled();
  }
);

it('ignores callbacks retained by a retired native handle and timer', async () => {
  const f = fixture();
  const first = f.watcher.ensureWatching('A');
  await vi.waitFor(() => expect(f.gates).toHaveLength(1));
  f.gates[0].resolve('old');
  await first;
  f.watcher.stopWatching('A');
  const second = f.watcher.ensureWatching('A');
  await vi.waitFor(() => expect(f.gates).toHaveLength(2));
  f.gates[1].resolve('new');
  await second;
  f.callbacks[0]({ eventType: 'change', filename: 'changed.gb' });
  f.intervals[0]();
  await Promise.resolve();
  expect(f.computeFingerprint).toHaveBeenCalledTimes(2);
  expect(f.onWorkspaceChanged).not.toHaveBeenCalled();
});

it('keeps one polling fallback after a failed initial fingerprint and unavailable native watch', async () => {
  const f = fixture();
  f.watchDirectory.mockImplementation(() => {
    throw new Error('native unavailable');
  });
  const first = f.watcher.ensureWatching('A');
  const second = f.watcher.ensureWatching('A');
  await vi.waitFor(() => expect(f.gates.length).toBeGreaterThan(0));
  f.gates.forEach((gate) => gate.reject(new Error('scan unavailable')));
  const states = await Promise.all([first, second]);
  expect(f.watchDirectory).toHaveBeenCalledTimes(1);
  expect(f.computeFingerprint).toHaveBeenCalledTimes(1);
  expect(f.setPollInterval).toHaveBeenCalledTimes(1);
  expect(states.every((state) => !state.nativeWatchActive && state.pollFallbackActive)).toBe(true);
  f.watcher.stopAll();
  expect(f.clearPollInterval).toHaveBeenCalledTimes(1);
});

it('does not serialize initialization of unrelated workspace roots', async () => {
  const f = fixture();
  const first = f.watcher.ensureWatching('A');
  const second = f.watcher.ensureWatching('B');
  await vi.waitFor(() => expect(f.gates).toHaveLength(2));
  f.gates[1].resolve('B');
  await expect(second).resolves.toMatchObject({ workspaceUuid: 'B', nativeWatchActive: true });
  expect(f.setPollInterval).toHaveBeenCalledTimes(1);
  f.gates[0].resolve('A');
  await first;
  f.watcher.stopAll();
  expect(f.closes.every((close) => close.mock.calls.length === 1)).toBe(true);
  expect(f.clearPollInterval).toHaveBeenCalledTimes(2);
});
