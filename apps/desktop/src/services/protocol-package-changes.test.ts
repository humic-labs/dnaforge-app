import { expect, it, vi } from 'vitest';
import type { NativeProtocolPackageChanged } from '../shared/protocol-packages';

const state = vi.hoisted(() => ({
  listener: null as null | ((change: NativeProtocolPackageChanged) => void),
  refresh: vi.fn(),
  unsubscribe: vi.fn(),
  folders: [{ path: '/project/', name: 'Project' }],
}));
vi.mock('../platform', () => ({
  platform: () => ({
    protocols: {
      onChanged: (listener: (change: NativeProtocolPackageChanged) => void) => {
        state.listener = listener;
        return state.unsubscribe;
      },
    },
  }),
}));
vi.mock('../stores/workspaceStore', () => ({
  useWorkspaceStore: {
    getState: () => ({ folders: state.folders, bumpFileTreeRefresh: state.refresh }),
  },
}));
import { installProtocolPackageChanges } from './protocol-package-changes';

it('refreshes Files for a committed package in a currently mounted project', () => {
  const stop = installProtocolPackageChanges();
  state.listener?.({
    projectId: 'project',
    entityId: 'project::run',
    workspaceRoot: '/project',
    path: '/project/Run/.forge/protocol-run.json',
    operation: 'create',
  });
  expect(state.refresh).toHaveBeenCalledTimes(1);
  state.listener?.({
    projectId: 'other',
    entityId: 'other::run',
    workspaceRoot: '/other',
    path: '/other/Run/.forge/protocol-run.json',
    operation: 'save',
  });
  expect(state.refresh).toHaveBeenCalledTimes(1);
  state.folders = [];
  state.listener?.({
    projectId: 'project',
    entityId: 'project::run',
    workspaceRoot: '/project',
    path: '/project/Run/.forge/protocol-run.json',
    operation: 'save',
  });
  expect(state.refresh).toHaveBeenCalledTimes(1);
  stop();
  expect(state.unsubscribe).toHaveBeenCalledTimes(1);
});
