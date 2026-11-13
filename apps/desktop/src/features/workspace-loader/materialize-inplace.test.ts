import { beforeEach, describe, expect, it, vi } from 'vitest';

const importManaged = vi.fn();
const createEmptyWorkspace = vi.fn();
const canonicalPath = vi.fn();
vi.mock('../../platform', () => ({
  platform: () => ({ workspace: { importManaged, createEmptyWorkspace }, fs: { canonicalPath } }),
}));
vi.mock('./managed-workspaces-flag', () => ({
  isManagedWorkspacesEnabled: () => true,
  MANAGED_WORKSPACES_FLAG_KEY: 'waypoint:managed-workspaces',
}));

import { materializeWorkspaceSource } from './open-workspace-from-source';

describe('materializeWorkspaceSource — mount in place ', () => {
  beforeEach(() => {
    importManaged.mockReset();
    createEmptyWorkspace.mockReset();
    canonicalPath.mockReset().mockImplementation(async (path: string) => path);
  });

  it('mounts the REAL folder (no copy) when inPlace is requested, even with the managed flag ON', async () => {
    const instance = await materializeWorkspaceSource(
      { kind: 'local-folder', path: '/Users/me/my-lab/' },
      { inPlace: true }
    );
    expect(importManaged).not.toHaveBeenCalled();
    expect(instance.id).toBe('local-folder:/Users/me/my-lab');
    expect(instance.rootFolders).toEqual([{ path: '/Users/me/my-lab', name: 'my-lab' }]);
    expect(instance.writable).toBe(true);
    expect(instance.source).toEqual({ kind: 'local-folder', path: '/Users/me/my-lab/' });
  });

  it('keeps an authoritative display name when the physical folder is named repo', async () => {
    const instance = await materializeWorkspaceSource(
      {
        kind: 'local-folder',
        path: '/userData/managed-workspaces/workspace-1/repo',
        name: 'Sundew localization',
      },
      { inPlace: true }
    );

    expect(instance.displayName).toBe('Sundew localization');
    expect(instance.rootFolders).toEqual([
      {
        path: '/userData/managed-workspaces/workspace-1/repo',
        name: 'Sundew localization',
      },
    ]);
  });

  it('uses one physical project identity for an explicitly mounted alias', async () => {
    canonicalPath.mockResolvedValue('/Users/me/physical-lab');
    const instance = await materializeWorkspaceSource(
      { kind: 'local-folder', path: '/Users/me/lab-alias', name: 'My lab' },
      { inPlace: true }
    );
    expect(instance.id).toBe('local-folder:/Users/me/physical-lab');
    expect(instance.rootFolders).toEqual([{ path: '/Users/me/physical-lab', name: 'My lab' }]);
    expect(importManaged).not.toHaveBeenCalled();
  });

  it('does not mount a lexical fallback when native path admission fails', async () => {
    canonicalPath.mockRejectedValue(new Error('Native read admission refused'));
    await expect(
      materializeWorkspaceSource(
        { kind: 'local-folder', path: '/Users/me/lab-alias' },
        { inPlace: true }
      )
    ).rejects.toThrow('Native read admission refused');
    expect(importManaged).not.toHaveBeenCalled();
  });

  it('still imports into the managed container when inPlace is NOT requested (default stays safe)', async () => {
    importManaged.mockResolvedValue({
      workspaceUuid: 'u',
      repoPath: '/userData/managed-workspaces/u/repo',
      displayName: 'my-lab',
      originPath: '/Users/me/my-lab',
      createdAt: 1,
      reused: false,
    });
    const instance = await materializeWorkspaceSource({
      kind: 'local-folder',
      path: '/Users/me/my-lab',
    });
    expect(importManaged).toHaveBeenCalledWith({ sourcePath: '/Users/me/my-lab' });
    expect(instance.id).toBe('managed:u');
  });
});

describe('materializeWorkspaceSource — create empty workspace ', () => {
  beforeEach(() => {
    importManaged.mockReset();
    createEmptyWorkspace.mockReset();
  });

  it('creates an app-writable empty root via the createEmptyWorkspace IPC', async () => {
    createEmptyWorkspace.mockResolvedValue({
      rootPath: '/userData/empty-workspaces/new-uuid',
      displayName: 'Untitled workspace',
      createdAt: 7,
    });
    const instance = await materializeWorkspaceSource({
      kind: 'empty',
      name: 'Untitled workspace',
    });
    expect(createEmptyWorkspace).toHaveBeenCalledWith({ name: 'Untitled workspace' });
    expect(instance.rootFolders).toEqual([
      { path: '/userData/empty-workspaces/new-uuid', name: 'Untitled workspace' },
    ]);
    expect(instance.writable).toBe(true);
    expect(importManaged).not.toHaveBeenCalled();
  });
});
