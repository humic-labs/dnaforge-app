import { afterEach, expect, it, vi } from 'vitest';
import { createTestDb } from './test-db';
import {
  ManagedWorkspaceSyncWatcher,
  type WatchDirectoryCallback,
} from '../workspace-sync-watcher';

const fixtures: Array<{
  db: ReturnType<typeof createTestDb>;
  watcher: ManagedWorkspaceSyncWatcher;
  gates: Array<(value: string | null) => void>;
}> = [];

function fixture(debounceMs = 0) {
  const db = createTestDb();
  db.exec(
    "CREATE TABLE workspaces(id INTEGER, path TEXT, repo_uuid TEXT, archived_at INTEGER, trashed_at INTEGER); INSERT INTO workspaces VALUES (1, '/synthetic/A', 'A', NULL, NULL)"
  );
  const gates: Array<(value: string | null) => void> = [];
  const callbacks: WatchDirectoryCallback[] = [];
  const closes: Array<ReturnType<typeof vi.fn>> = [];
  const computeFingerprint = vi.fn(
    () => new Promise<string | null>((resolve) => gates.push(resolve))
  );
  const watchDirectory = vi.fn((_path: string, callback: WatchDirectoryCallback) => {
    callbacks.push(callback);
    const close = vi.fn();
    closes.push(close);
    return { close };
  });
  const setPollInterval = vi.fn((callback: () => void) => callback);
  const clearPollInterval = vi.fn();
  const onWorkspaceChanged = vi.fn();
  const watcher = new ManagedWorkspaceSyncWatcher(db, {
    watchDirectory,
    computeFingerprint,
    setPollInterval,
    clearPollInterval,
    onWorkspaceChanged,
    debounceMs,
  });
  const result = {
    db,
    watcher,
    gates,
    callbacks,
    closes,
    watchDirectory,
    computeFingerprint,
    setPollInterval,
    clearPollInterval,
    onWorkspaceChanged,
  };
  fixtures.push(result);
  return result;
}

afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.watcher.stopAll();
    f.gates.forEach((resolve) => resolve(null));
    f.db.close();
  }
  vi.useRealTimers();
});

it('stops ownership before the deferred initializer acquires any resources', async () => {
  const f = fixture();
  const pending = f.watcher.ensureWatching('A');
  f.watcher.stopWatching('A');
  await expect(pending).resolves.toMatchObject({
    nativeWatchActive: false,
    pollFallbackActive: false,
  });
  expect(f.watchDirectory).not.toHaveBeenCalled();
  expect(f.computeFingerprint).not.toHaveBeenCalled();
  expect(f.setPollInterval).not.toHaveBeenCalled();
});

it('keeps a joined caller pending until the shared initial fingerprint settles', async () => {
  const f = fixture();
  const first = f.watcher.ensureWatching('A');
  let joinedSettled = false;
  const joined = f.watcher.ensureWatching('A').then((state) => {
    joinedSettled = true;
    return state;
  });
  await Promise.resolve();
  expect(joinedSettled).toBe(false);
  expect(f.gates).toHaveLength(1);
  f.gates[0]('initial');
  await first;
  await expect(joined).resolves.toMatchObject({ reused: true, pollFallbackActive: true });
});

it('closes a handle returned after its factory synchronously retires the owner', async () => {
  const f = fixture();
  const close = vi.fn();
  f.watchDirectory.mockImplementation(() => {
    f.watcher.stopWatching('A');
    return { close };
  });
  await expect(f.watcher.ensureWatching('A')).resolves.toMatchObject({
    nativeWatchActive: false,
    pollFallbackActive: false,
  });
  expect(close).toHaveBeenCalledOnce();
  expect(f.computeFingerprint).not.toHaveBeenCalled();
  expect(f.setPollInterval).not.toHaveBeenCalled();
  expect(f.watcher.activeWatcherCount()).toBe(0);
});

it('clears an interval returned after its factory synchronously retires the owner', async () => {
  const f = fixture();
  const token = () => {};
  f.setPollInterval.mockImplementation(() => {
    f.watcher.stopWatching('A');
    return token;
  });
  const pending = f.watcher.ensureWatching('A');
  await Promise.resolve();
  f.gates[0]('initial');
  await expect(pending).resolves.toMatchObject({
    nativeWatchActive: false,
    pollFallbackActive: false,
  });
  expect(f.closes[0]).toHaveBeenCalledOnce();
  expect(f.clearPollInterval).toHaveBeenCalledExactlyOnceWith(token);
});

it('cleans up a failed poll registration and permits a fresh generation', async () => {
  const f = fixture();
  f.setPollInterval.mockImplementationOnce(() => {
    throw new Error('interval unavailable');
  });
  const pending = f.watcher.ensureWatching('A');
  const rejection = expect(pending).rejects.toThrow('interval unavailable');
  await Promise.resolve();
  f.gates[0]('initial');
  await rejection;
  expect(f.closes[0]).toHaveBeenCalledOnce();
  expect(f.watcher.activeWatcherCount()).toBe(0);
  const fresh = f.watcher.ensureWatching('A');
  await Promise.resolve();
  f.gates[1]('fresh');
  await expect(fresh).resolves.toMatchObject({ nativeWatchActive: true, pollFallbackActive: true });
  expect(f.closes[1]).not.toHaveBeenCalled();
});

it('discards an old poll result without replacing the new generation fingerprint', async () => {
  const f = fixture();
  const first = f.watcher.ensureWatching('A');
  await Promise.resolve();
  f.gates[0]('initial');
  await first;
  const oldPoll = f.watcher.pollNow('A');
  await Promise.resolve();
  f.watcher.stopWatching('A');
  const fresh = f.watcher.ensureWatching('A');
  await Promise.resolve();
  f.gates[2]('fresh');
  await fresh;
  f.gates[1]('old changed');
  await expect(oldPoll).resolves.toBe(false);
  const freshPoll = f.watcher.pollNow('A');
  await Promise.resolve();
  f.gates[3]('fresh');
  await expect(freshPoll).resolves.toBe(false);
  expect(f.onWorkspaceChanged).not.toHaveBeenCalled();
});

it('cancels pending debounce and refuses new debounce work from retired callbacks', async () => {
  vi.useFakeTimers();
  const f = fixture(25);
  const pending = f.watcher.ensureWatching('A');
  await Promise.resolve();
  f.gates[0]('initial');
  await pending;
  f.callbacks[0]({ eventType: 'change', filename: 'sequence.gb' });
  expect(vi.getTimerCount()).toBe(1);
  f.watcher.stopWatching('A');
  expect(vi.getTimerCount()).toBe(0);
  f.callbacks[0]({ eventType: 'change', filename: 'sequence.gb' });
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(100);
  expect(f.computeFingerprint).toHaveBeenCalledOnce();
});

it('defers synchronous native callbacks until initialization is ready', async () => {
  const f = fixture();
  const close = vi.fn();
  f.watchDirectory.mockImplementation((_path, callback) => {
    callback({ eventType: 'change', filename: 'sequence.gb' });
    return { close };
  });
  const pending = f.watcher.ensureWatching('A');
  await Promise.resolve();
  expect(f.computeFingerprint).toHaveBeenCalledOnce();
  f.gates[0]('initial');
  await pending;
  await Promise.resolve();
  expect(f.computeFingerprint).toHaveBeenCalledTimes(2);
  f.gates[1]('changed');
  await vi.waitFor(() => expect(f.onWorkspaceChanged).toHaveBeenCalledOnce());
});

it('settles callbacks waiting on an initialization that fails to register polling', async () => {
  const f = fixture();
  f.watchDirectory.mockImplementation((_path, callback) => {
    callback({ eventType: 'change', filename: 'sequence.gb' });
    return { close: vi.fn() };
  });
  f.setPollInterval.mockImplementationOnce(() => {
    throw new Error('interval unavailable');
  });
  const pending = f.watcher.ensureWatching('A');
  const rejection = expect(pending).rejects.toThrow('interval unavailable');
  await Promise.resolve();
  const polling = f.watcher.pollNow('A');
  f.gates[0]('initial');
  await rejection;
  await expect(polling).resolves.toBe(false);
  expect(f.computeFingerprint).toHaveBeenCalledOnce();
  expect(f.onWorkspaceChanged).not.toHaveBeenCalled();
  expect(f.watcher.activeWatcherCount()).toBe(0);
});
