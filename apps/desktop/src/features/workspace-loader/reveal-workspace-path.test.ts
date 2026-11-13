import { describe, expect, it, vi } from 'vitest';
import { revealWorkspacePath } from './reveal-workspace-path';

function dependencies() {
  return {
    getMountedFolders: vi.fn(() => [{ path: '/mounted', name: 'Mounted', addedAt: 1 }]),
    listWorkspaceLibrary: vi.fn(async () => ({
      active: [
        {
          repoUuid: 'closed-uuid',
          name: 'Closed project',
          repoPath: '/managed/closed',
          originPath: null,
          lastOpenedAt: null,
          archivedAt: null,
          trashedAt: null,
        },
      ],
      archived: [],
      trashed: [],
    })),
    openWorkspaceSource: vi.fn(async () => true),
    resolveVisibleTreePath: vi.fn((targetPath: string) => targetPath),
    revealPath: vi.fn(),
    showExplorer: vi.fn(),
    reportUnavailable: vi.fn(),
  };
}

describe('revealWorkspacePath', () => {
  it('mounts the active catalog workspace that owns an unmounted target before revealing it', async () => {
    const deps = dependencies();
    const targetPath = '/managed/closed/sequences/pUC19/pUC19.gb';
    deps.getMountedFolders
      .mockReturnValueOnce([{ path: '/mounted', name: 'Mounted', addedAt: 1 }])
      .mockReturnValue([
        { path: '/mounted', name: 'Mounted', addedAt: 1 },
        { path: '/managed/closed', name: 'Closed project', addedAt: 2 },
      ]);

    await expect(revealWorkspacePath(targetPath, deps)).resolves.toBe('mounted-and-revealed');

    expect(deps.showExplorer).toHaveBeenCalledOnce();
    expect(deps.listWorkspaceLibrary).toHaveBeenCalledOnce();
    expect(deps.openWorkspaceSource).toHaveBeenCalledWith(
      { kind: 'local-folder', path: '/managed/closed', name: 'Closed project' },
      { inPlace: true, replaceCurrent: false, telemetrySource: 'unknown' }
    );
    expect(deps.revealPath).toHaveBeenCalledWith(targetPath);
    expect(deps.reportUnavailable).not.toHaveBeenCalled();
    expect(deps.openWorkspaceSource.mock.invocationCallOrder[0]).toBeLessThan(
      deps.revealPath.mock.invocationCallOrder[0]
    );
  });

  it('reveals an already-mounted target without querying or mounting the library', async () => {
    const deps = dependencies();
    const targetPath = '/mounted/deep/target.gb';

    await expect(revealWorkspacePath(targetPath, deps)).resolves.toBe('revealed');

    expect(deps.showExplorer).toHaveBeenCalledOnce();
    expect(deps.revealPath).toHaveBeenCalledWith(targetPath);
    expect(deps.listWorkspaceLibrary).not.toHaveBeenCalled();
    expect(deps.openWorkspaceSource).not.toHaveBeenCalled();
  });

  it('preserves folder-name-prefixed mounted reveal paths', async () => {
    const deps = dependencies();

    await expect(revealWorkspacePath('Mounted/deep/target.txt', deps)).resolves.toBe('revealed');

    expect(deps.resolveVisibleTreePath).toHaveBeenCalledWith('/mounted/deep/target.txt');
    expect(deps.revealPath).toHaveBeenCalledWith('/mounted/deep/target.txt');
    expect(deps.listWorkspaceLibrary).not.toHaveBeenCalled();
  });

  it('reveals the package row when the target is a product hidden inside that collapsed package', async () => {
    const deps = dependencies();
    const productPath = '/mounted/pUC19/pUC19.gb';
    deps.resolveVisibleTreePath.mockResolvedValue('/mounted/pUC19');

    await expect(revealWorkspacePath(productPath, deps)).resolves.toBe('revealed');

    expect(deps.resolveVisibleTreePath).toHaveBeenCalledWith(productPath);
    expect(deps.revealPath).toHaveBeenCalledWith('/mounted/pUC19');
  });

  it('fails visibly without mounting an archived, trashed, or unknown workspace', async () => {
    const deps = dependencies();
    deps.listWorkspaceLibrary.mockResolvedValue({
      active: [],
      archived: [
        {
          repoUuid: 'archived-uuid',
          name: 'Archived project',
          repoPath: '/managed/closed',
          originPath: null,
          lastOpenedAt: null,
          archivedAt: 1,
          trashedAt: null,
        },
      ],
      trashed: [],
    });

    await expect(revealWorkspacePath('/managed/closed/sequences/pUC19.gb', deps)).resolves.toBe(
      'unavailable'
    );

    expect(deps.openWorkspaceSource).not.toHaveBeenCalled();
    expect(deps.revealPath).not.toHaveBeenCalled();
    expect(deps.reportUnavailable).toHaveBeenCalledOnce();
  });

  it('does not report a reveal after the owning workspace fails to mount', async () => {
    const deps = dependencies();
    deps.openWorkspaceSource.mockResolvedValue(false);

    await expect(revealWorkspacePath('/managed/closed/sequences/pUC19.gb', deps)).resolves.toBe(
      'unavailable'
    );

    expect(deps.revealPath).not.toHaveBeenCalled();
  });
});
