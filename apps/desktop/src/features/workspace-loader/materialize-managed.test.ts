import { beforeEach, describe, expect, it, vi } from 'vitest';

const importManaged = vi.fn();
vi.mock('../../platform', () => ({
  platform: () => ({ workspace: { importManaged } }),
}));
vi.mock('./managed-workspaces-flag', () => ({
  isManagedWorkspacesEnabled: () => true,
  MANAGED_WORKSPACES_FLAG_KEY: 'waypoint:managed-workspaces',
}));

import { materializeWorkspaceSource } from './open-workspace-from-source';

describe('materializeWorkspaceSource — managed-workspaces flag ON', () => {
  beforeEach(() => importManaged.mockReset());

  it('imports a local folder into the managed container and opens the private copy', async () => {
    importManaged.mockResolvedValue({
      workspaceUuid: 'abc-uuid',
      repoPath: '/userData/managed-workspaces/abc-uuid/repo',
      displayName: 'my-lab',
      originPath: '/Users/me/my-lab',
      createdAt: 42,
      reused: false,
    });

    const instance = await materializeWorkspaceSource({
      kind: 'local-folder',
      path: '/Users/me/my-lab/',
    });

    expect(importManaged).toHaveBeenCalledWith({ sourcePath: '/Users/me/my-lab' });
    expect(instance.id).toBe('managed:abc-uuid');
    expect(instance.rootFolders).toEqual([
      { path: '/userData/managed-workspaces/abc-uuid/repo', name: 'my-lab' },
    ]);
    expect(instance.createdAt).toBe(42);
    expect(instance.writable).toBe(true);
  });
});
