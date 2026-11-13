/** @vitest-environment jsdom */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { deriveWorkspaceSyncStatus } from '../../shared/cloud-sync-status';
import type { WorkspaceSyncStatusEvent } from '../../shared/workspace-sync-ipc';
import { managedSequenceEditAccess } from '../lims/public/registry-record-edit-access';
import { useProjectEditFolders } from './use-project-edit-folders';
const mocks = vi.hoisted(() => ({ list: vi.fn(), getStatus: vi.fn(), subscribeStatus: vi.fn() }));
vi.mock('../../platform', () => ({ platform: () => ({ cloudSync: mocks }) }));
vi.mock('./project-edit-folders', async (original) => ({
  ...(await original<typeof import('./project-edit-folders')>()),
  listProjectEditFolders: mocks.list,
}));
const project = {
  path: '/projects/shared',
  repoUuid: 'shared-a',
  lifecycle: 'active' as const,
  sharedEditAccess: { kind: 'ready' as const, role: 'viewer' as const },
};
const ownerPaths = ['/projects/shared/sequence-package'];
const listeners = new Map<string, (event: WorkspaceSyncStatusEvent) => void>();
const unsubscribes = new Map<string, ReturnType<typeof vi.fn>>();
function deliver(role: 'viewer' | 'editor', sequence: number) {
  listeners.get('shared-a')?.({
    workspaceUuid: 'shared-a',
    sequence,
    reason: 'binding_changed',
    emittedAt: sequence,
    status: deriveWorkspaceSyncStatus({
      workspaceUuid: 'shared-a',
      isManagedWorkspace: true,
      syncEnabled: true,
      accessRole: role,
      offline: true,
    }),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  listeners.clear();
  unsubscribes.clear();
  useWorkspaceStore.setState({ folders: [], fileTreeRefreshToken: 0 });
  mocks.list.mockResolvedValue([
    project,
    { path: '/inactive', repoUuid: 'inactive-b', sharedEditAccess: { kind: 'ready', role: null } },
  ]);
  mocks.getStatus.mockImplementation(async (uuid) =>
    deriveWorkspaceSyncStatus({
      workspaceUuid: uuid,
      isManagedWorkspace: true,
      syncEnabled: true,
      accessRole: 'viewer',
    })
  );
  mocks.subscribeStatus.mockImplementation((uuid, callback) => {
    listeners.set(uuid, callback);
    const stop = vi.fn();
    unsubscribes.set(uuid, stop);
    return stop;
  });
});
afterEach(() => vi.restoreAllMocks());
it('updates the same open owner through viewer/editor transitions while sharing one native subscription and excluding inactive projects', async () => {
  const first = renderHook(() => useProjectEditFolders(ownerPaths));
  const second = renderHook(() => useProjectEditFolders(ownerPaths));
  await waitFor(() =>
    expect(managedSequenceEditAccess(ownerPaths[0], first.result.current)).toMatchObject({
      canEdit: false,
      reason: 'viewer',
    })
  );
  expect(mocks.subscribeStatus).toHaveBeenCalledTimes(1);
  expect(mocks.subscribeStatus).toHaveBeenCalledWith('shared-a', expect.any(Function));
  act(() => deliver('editor', 2));
  expect(managedSequenceEditAccess(ownerPaths[0], first.result.current).canEdit).toBe(true);
  expect(managedSequenceEditAccess(ownerPaths[0], second.result.current).canEdit).toBe(true);
  act(() => deliver('viewer', 3));
  expect(managedSequenceEditAccess(ownerPaths[0], first.result.current)).toMatchObject({
    canEdit: false,
    reason: 'viewer',
  });
  first.unmount();
  expect(unsubscribes.get('shared-a')).not.toHaveBeenCalled();
  second.unmount();
  expect(unsubscribes.get('shared-a')).toHaveBeenCalledTimes(1);
});
it('keeps reference pinning after live promotion and releases obsolete owners on project switch', async () => {
  mocks.list.mockResolvedValue([
    { ...project, pinned: true },
    { path: '/other', repoUuid: 'other-c' },
  ]);
  const view = renderHook(({ paths }) => useProjectEditFolders(paths), {
    initialProps: { paths: ownerPaths },
  });
  await waitFor(() => expect(listeners.has('shared-a')).toBe(true));
  act(() => deliver('editor', 8));
  expect(managedSequenceEditAccess(ownerPaths[0], view.result.current)).toMatchObject({
    canEdit: false,
    reason: 'reference',
  });
  view.rerender({ paths: ['/other/document'] });
  await waitFor(() => expect(unsubscribes.get('shared-a')).toHaveBeenCalledTimes(1));
  expect(listeners.has('other-c')).toBe(true);
  view.unmount();
});

it('keeps unbound legacy local identifiers editable without asking the shared-project IPC parser to accept them', async () => {
  mocks.list.mockResolvedValue([
    {
      path: '/legacy',
      repoUuid: 'old local/path identifier',
      sharedEditAccess: { kind: 'ready', role: null },
    },
  ]);
  const paths = ['/legacy/package'];
  const view = renderHook(() => useProjectEditFolders(paths));
  await waitFor(() =>
    expect(managedSequenceEditAccess(paths[0], view.result.current).canEdit).toBe(true)
  );
  expect(mocks.getStatus).not.toHaveBeenCalled();
  expect(mocks.subscribeStatus).not.toHaveBeenCalled();
  view.unmount();
});
it('uses a fresh private projection after a binding is removed instead of retaining its prior viewer cache', async () => {
  const first = renderHook(() => useProjectEditFolders(ownerPaths));
  const second = renderHook(() => useProjectEditFolders(ownerPaths));
  await waitFor(() =>
    expect(managedSequenceEditAccess(ownerPaths[0], first.result.current)).toMatchObject({
      reason: 'viewer',
    })
  );
  mocks.list.mockResolvedValue([{ ...project, sharedEditAccess: { kind: 'ready', role: null } }]);
  act(() => useWorkspaceStore.getState().bumpFileTreeRefresh());
  await waitFor(() =>
    expect(managedSequenceEditAccess(ownerPaths[0], first.result.current).canEdit).toBe(true)
  );
  expect(managedSequenceEditAccess(ownerPaths[0], second.result.current).canEdit).toBe(true);
  first.unmount();
  second.unmount();
});
