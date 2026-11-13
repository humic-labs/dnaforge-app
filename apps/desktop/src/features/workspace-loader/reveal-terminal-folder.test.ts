import { describe, expect, it, vi } from 'vitest';
import { revealWorkspacePath } from './reveal-workspace-path';
import type { WorkspaceSource, OpenWorkspaceOptions } from './types';

function fixture() {
  let folders = [{ path: '/mounted', name: 'Mounted', addedAt: 1 }];
  const deps = {
    getMountedFolders: () => folders,
    listWorkspaceLibrary: vi.fn(async () => ({ active: [], archived: [], trashed: [] })),
    resolveOutsideFolder: vi.fn(
      async (_path: string): Promise<string | null> => '/outside/real-folder'
    ),
    openWorkspaceSource: vi.fn(async (source: WorkspaceSource, _options?: OpenWorkspaceOptions) => {
      if (source.kind !== 'local-folder')
        throw new Error('Expected the existing local-folder loader.');
      folders = [...folders, { path: source.path, name: 'Outside', addedAt: 2 }];
      return true;
    }),
    resolveVisibleTreePath: (path: string) => path,
    revealPath: vi.fn(),
    showExplorer: vi.fn(),
    reportUnavailable: vi.fn(),
  };
  return deps;
}

describe('terminal outside-folder reveal', () => {
  it('mounts only an explicit directory-link intent through the canonical in-place loader', async () => {
    const deps = fixture();
    expect(await revealWorkspacePath('/outside/alias', deps)).toBe('unavailable');
    expect(deps.resolveOutsideFolder).not.toHaveBeenCalled();
    expect(deps.openWorkspaceSource).not.toHaveBeenCalled();
    expect(await revealWorkspacePath('/outside/alias', deps, { openOutsideFolder: true })).toBe(
      'mounted-and-revealed'
    );
    expect(deps.resolveOutsideFolder).toHaveBeenCalledWith('/outside/alias');
    expect(deps.openWorkspaceSource).toHaveBeenCalledExactlyOnceWith(
      { kind: 'local-folder', path: '/outside/real-folder' },
      { inPlace: true, replaceCurrent: false, telemetrySource: 'unknown' }
    );
    expect(deps.revealPath).toHaveBeenCalledWith('/outside/real-folder');
    expect(deps.getMountedFolders().map((folder) => folder.path)).toEqual([
      '/mounted',
      '/outside/real-folder',
    ]);
  });
  it('does not turn an ordinary file into a folder project', async () => {
    const deps = fixture();
    deps.resolveOutsideFolder.mockResolvedValue(null);
    expect(await revealWorkspacePath('/outside/notes.txt', deps, { openOutsideFolder: true })).toBe(
      'unavailable'
    );
    expect(deps.openWorkspaceSource).not.toHaveBeenCalled();
    expect(deps.reportUnavailable).toHaveBeenCalledOnce();
  });
  it('does not reopen archived or trashed projects through the unowned-folder route', async () => {
    const deps = fixture();
    const blocked = {
      repoUuid: 'archived',
      name: 'Archived',
      repoPath: '/outside/archived',
      originPath: null,
      lastOpenedAt: null,
      archivedAt: 1,
      trashedAt: null,
    };
    const withLibrary = {
      ...deps,
      listWorkspaceLibrary: async () => ({ active: [], archived: [blocked], trashed: [] }),
    };
    expect(
      await revealWorkspacePath('/outside/archived', withLibrary, { openOutsideFolder: true })
    ).toBe('unavailable');
    expect(deps.resolveOutsideFolder).not.toHaveBeenCalled();
    expect(deps.openWorkspaceSource).not.toHaveBeenCalled();
  });
});
