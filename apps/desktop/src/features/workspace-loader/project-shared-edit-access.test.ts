import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deriveWorkspaceSyncStatus,
  type WorkspaceSyncAccessRole,
} from '../../shared/cloud-sync-status';
import type { WorkspaceSyncStatusEvent } from '../../shared/workspace-sync-ipc';
import {
  readProjectSharedEditAccess,
  subscribeProjectSharedEditAccess,
} from './project-shared-edit-access';

const mocks = vi.hoisted(() => ({ getStatus: vi.fn(), subscribeStatus: vi.fn() }));
vi.mock('../../platform', () => ({ platform: () => ({ cloudSync: mocks }) }));
const uuid = 'project-a';
function status(role: WorkspaceSyncAccessRole | null, offline = false) {
  return deriveWorkspaceSyncStatus({
    workspaceUuid: uuid,
    isManagedWorkspace: true,
    syncEnabled: role !== null,
    accessRole: role,
    offline,
  });
}
const stops: Array<() => void> = [];
let deliver: (event: WorkspaceSyncStatusEvent) => void;
let unsubscribe: ReturnType<typeof vi.fn>;
function event(role: WorkspaceSyncAccessRole | null, sequence: number) {
  deliver({
    workspaceUuid: uuid,
    status: status(role),
    reason: 'binding_changed',
    sequence,
    emittedAt: sequence,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  unsubscribe = vi.fn();
  mocks.subscribeStatus.mockImplementation((_uuid, callback) => {
    deliver = callback;
    return unsubscribe;
  });
  mocks.getStatus.mockResolvedValue(status('viewer'));
});
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

describe('shared project live edit access', () => {
  it('pools subscribers and releases native ownership only with the last consumer', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = subscribeProjectSharedEditAccess(uuid, first);
    const stopSecond = subscribeProjectSharedEditAccess(uuid, second);
    stops.push(stopFirst, stopSecond);
    await vi.waitFor(() =>
      expect(second).toHaveBeenLastCalledWith({ kind: 'ready', role: 'viewer' })
    );
    expect(mocks.getStatus).toHaveBeenCalledTimes(1);
    expect(mocks.subscribeStatus).toHaveBeenCalledTimes(1);
    stopFirst();
    expect(unsubscribe).not.toHaveBeenCalled();
    event('editor', 2);
    expect(second).toHaveBeenLastCalledWith({ kind: 'ready', role: 'editor' });
    stopSecond();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('does not let a late status read or older event undo promotion or demotion', async () => {
    let resolve!: (value: ReturnType<typeof status>) => void;
    mocks.getStatus.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const listener = vi.fn();
    stops.push(subscribeProjectSharedEditAccess(uuid, listener));
    event('editor', 3);
    resolve(status('viewer'));
    await Promise.resolve();
    expect(listener).toHaveBeenLastCalledWith({ kind: 'ready', role: 'editor' });
    event('viewer', 4);
    event('editor', 3);
    expect(listener).toHaveBeenLastCalledWith({ kind: 'ready', role: 'viewer' });
  });

  it('distinguishes a valid private project from unavailable metadata without disabling offline editors', async () => {
    mocks.getStatus.mockResolvedValueOnce(status(null));
    expect(await readProjectSharedEditAccess(uuid)).toEqual({ kind: 'ready', role: null });
    mocks.getStatus.mockRejectedValueOnce(new Error('IPC unavailable'));
    expect(await readProjectSharedEditAccess(uuid)).toEqual({ kind: 'unavailable' });
    mocks.getStatus.mockResolvedValueOnce(status('editor', true));
    expect(await readProjectSharedEditAccess(uuid)).toEqual({ kind: 'ready', role: 'editor' });
  });

  it('does not deliver an obsolete read or event after the final release and reacquisition', async () => {
    let resolve!: (value: ReturnType<typeof status>) => void;
    mocks.getStatus.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const old = vi.fn();
    const stop = subscribeProjectSharedEditAccess(uuid, old);
    const oldDeliver = deliver;
    stop();
    const fresh = vi.fn();
    stops.push(subscribeProjectSharedEditAccess(uuid, fresh));
    await vi.waitFor(() =>
      expect(fresh).toHaveBeenLastCalledWith({ kind: 'ready', role: 'viewer' })
    );
    const calls = fresh.mock.calls.length;
    resolve(status('owner'));
    oldDeliver({
      workspaceUuid: uuid,
      status: status('editor'),
      reason: 'binding_changed',
      sequence: 9,
      emittedAt: 9,
    });
    await Promise.resolve();
    expect(fresh).toHaveBeenCalledTimes(calls);
  });
});
