import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  resolveWorkspaceRevealPath,
  useWorkspaceStore,
  workspaceScopeFromState,
} from './workspaceStore';

describe('workspaceStore', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      folders: [],
      lastRemovedFolderPath: null,
      activeWorkspaceFile: null,
      expandedPaths: new Set(),
      selectedPath: null,
      revealRequestId: 0,
      revealTargetPath: null,
      revealTargetPaths: [],
      isLoading: false,
      error: null,
    });
  });

  describe('initial state', () => {
    it('starts with empty folders', () => {
      const { folders } = useWorkspaceStore.getState();
      expect(folders).toEqual([]);
    });

    it('starts with no active workspace file', () => {
      const { activeWorkspaceFile } = useWorkspaceStore.getState();
      expect(activeWorkspaceFile).toBeNull();
    });

    it('starts with no expanded paths', () => {
      const { expandedPaths } = useWorkspaceStore.getState();
      expect(expandedPaths.size).toBe(0);
    });

    it('starts not loading', () => {
      const { isLoading } = useWorkspaceStore.getState();
      expect(isLoading).toBe(false);
    });

    it('starts with no error', () => {
      const { error } = useWorkspaceStore.getState();
      expect(error).toBeNull();
    });
  });

  describe('agent resource workspace ownership', () => {
    it('uses the pinned workspace file when one exists', () => {
      expect(
        workspaceScopeFromState({
          activeWorkspaceFile: '/lab/project.waypoint-workspace',
          folders: [{ name: 'Renamable', path: '/lab/project' }],
        })
      ).toBe('file:/lab/project.waypoint-workspace');
    });

    it('is stable across folder rename and reorder but changes with folder identity', () => {
      const first = workspaceScopeFromState({
        activeWorkspaceFile: null,
        folders: [
          { name: 'Alpha', path: '/lab/a' },
          { name: 'Beta', path: '/lab/b' },
        ],
      });
      const cosmeticChange = workspaceScopeFromState({
        activeWorkspaceFile: null,
        folders: [
          { name: 'Renamed Beta', path: '/lab/b' },
          { name: 'Renamed Alpha', path: '/lab/a' },
        ],
      });
      const differentWorkspace = workspaceScopeFromState({
        activeWorkspaceFile: null,
        folders: [{ name: 'Alpha', path: '/lab/a' }],
      });

      expect(cosmeticChange).toBe(first);
      expect(differentWorkspace).not.toBe(first);
      expect(workspaceScopeFromState({ activeWorkspaceFile: null, folders: [] })).toBeNull();
    });
  });

  describe('addFolder', () => {
    it('adds a folder to the workspace', () => {
      const { addFolder } = useWorkspaceStore.getState();

      addFolder('/path/to/project');

      const { folders } = useWorkspaceStore.getState();
      expect(folders).toHaveLength(1);
      expect(folders[0].path).toBe('/path/to/project');
    });

    it('extracts folder name from path when not provided', () => {
      const { addFolder } = useWorkspaceStore.getState();

      addFolder('/Users/lab/my-project');

      const { folders } = useWorkspaceStore.getState();
      expect(folders[0].name).toBe('my-project');
    });

    it('uses provided name when given', () => {
      const { addFolder } = useWorkspaceStore.getState();

      addFolder('/path/to/project', 'Custom Name');

      const { folders } = useWorkspaceStore.getState();
      expect(folders[0].name).toBe('Custom Name');
    });

    it('sets addedAt timestamp', () => {
      const before = Date.now();
      const { addFolder } = useWorkspaceStore.getState();

      addFolder('/path/to/project');

      const after = Date.now();
      const { folders } = useWorkspaceStore.getState();
      expect(folders[0].addedAt).toBeGreaterThanOrEqual(before);
      expect(folders[0].addedAt).toBeLessThanOrEqual(after);
    });

    it('does not add duplicate folders', () => {
      const { addFolder } = useWorkspaceStore.getState();

      addFolder('/path/to/project');
      addFolder('/path/to/project');
      addFolder('/path/to/project', 'Different Name');

      const { folders } = useWorkspaceStore.getState();
      expect(folders).toHaveLength(1);
    });

    it('does not mount separator aliases of the same project twice', () => {
      const { addFolder } = useWorkspaceStore.getState();

      addFolder('/path/to/project');
      addFolder('/path/to/project/');

      expect(useWorkspaceStore.getState().folders).toHaveLength(1);
    });

    it('can add multiple different folders', () => {
      const { addFolder } = useWorkspaceStore.getState();

      addFolder('/path/to/project1');
      addFolder('/path/to/project2');
      addFolder('/path/to/project3');

      const { folders } = useWorkspaceStore.getState();
      expect(folders).toHaveLength(3);
    });

    it('clears error when adding folder', () => {
      useWorkspaceStore.setState({ error: 'Previous error' });
      const { addFolder } = useWorkspaceStore.getState();

      addFolder('/path/to/project');

      const { error } = useWorkspaceStore.getState();
      expect(error).toBeNull();
    });
  });

  describe('removeFolder', () => {
    beforeEach(() => {
      const { addFolder } = useWorkspaceStore.getState();
      addFolder('/path/to/project1', 'Project 1');
      addFolder('/path/to/project2', 'Project 2');
    });

    it('removes a folder from the workspace', () => {
      const { removeFolder } = useWorkspaceStore.getState();

      removeFolder('/path/to/project1');

      const { folders } = useWorkspaceStore.getState();
      expect(folders).toHaveLength(1);
      expect(folders[0].path).toBe('/path/to/project2');
      expect(useWorkspaceStore.getState().lastRemovedFolderPath).toBe('/path/to/project1');
    });

    it('clears the removal marker when the same folder is explicitly reopened', () => {
      const { removeFolder } = useWorkspaceStore.getState();
      removeFolder('/path/to/project1');

      useWorkspaceStore.getState().addFolder('/path/to/project1', 'Project 1');

      expect(useWorkspaceStore.getState().lastRemovedFolderPath).toBeNull();
      expect(useWorkspaceStore.getState().folders).toContainEqual(
        expect.objectContaining({ path: '/path/to/project1', name: 'Project 1' })
      );
    });

    it('does nothing if folder does not exist', () => {
      const { removeFolder } = useWorkspaceStore.getState();

      removeFolder('/nonexistent/path');

      const { folders } = useWorkspaceStore.getState();
      expect(folders).toHaveLength(2);
    });

    it('cleans up expanded paths under removed folder', () => {
      useWorkspaceStore.setState({
        expandedPaths: new Set([
          '/path/to/project1',
          '/path/to/project1/src',
          '/path/to/project1/src/components',
          '/path/to/project2',
          '/path/to/project2/lib',
        ]),
      });

      const { removeFolder } = useWorkspaceStore.getState();
      removeFolder('/path/to/project1');

      const { expandedPaths } = useWorkspaceStore.getState();
      expect(expandedPaths.has('/path/to/project1')).toBe(false);
      expect(expandedPaths.has('/path/to/project1/src')).toBe(false);
      expect(expandedPaths.has('/path/to/project1/src/components')).toBe(false);
      expect(expandedPaths.has('/path/to/project2')).toBe(true);
      expect(expandedPaths.has('/path/to/project2/lib')).toBe(true);
    });
  });

  describe('renameFolder', () => {
    beforeEach(() => {
      const { addFolder } = useWorkspaceStore.getState();
      addFolder('/path/to/project', 'Original Name');
    });

    it('renames a folder', () => {
      const { renameFolder } = useWorkspaceStore.getState();

      renameFolder('/path/to/project', 'New Name');

      const { folders } = useWorkspaceStore.getState();
      expect(folders[0].name).toBe('New Name');
      expect(folders[0].path).toBe('/path/to/project');
    });

    it('does nothing if folder does not exist', () => {
      const { renameFolder, folders: foldersBefore } = useWorkspaceStore.getState();

      renameFolder('/nonexistent/path', 'New Name');

      const { folders: foldersAfter } = useWorkspaceStore.getState();
      expect(foldersAfter).toEqual(foldersBefore);
    });

    it('does not publish a new folder array when the requested name is already current', () => {
      const { renameFolder, folders: foldersBefore } = useWorkspaceStore.getState();

      renameFolder('/path/to/project', 'Original Name');

      expect(useWorkspaceStore.getState().folders).toBe(foldersBefore);
    });
  });

  describe('clearWorkspace', () => {
    beforeEach(() => {
      const { addFolder, expandPath } = useWorkspaceStore.getState();
      addFolder('/path/to/project1');
      addFolder('/path/to/project2');
      expandPath('/path/to/project1');
      useWorkspaceStore.setState({
        activeWorkspaceFile: '/path/to/workspace.waypoint-workspace',
        error: 'Some error',
      });
    });

    it('clears all folders', () => {
      const { clearWorkspace } = useWorkspaceStore.getState();

      clearWorkspace();

      const { folders } = useWorkspaceStore.getState();
      expect(folders).toEqual([]);
    });

    it('clears active workspace file', () => {
      const { clearWorkspace } = useWorkspaceStore.getState();

      clearWorkspace();

      const { activeWorkspaceFile } = useWorkspaceStore.getState();
      expect(activeWorkspaceFile).toBeNull();
    });

    it('clears expanded paths', () => {
      const { clearWorkspace } = useWorkspaceStore.getState();

      clearWorkspace();

      const { expandedPaths } = useWorkspaceStore.getState();
      expect(expandedPaths.size).toBe(0);
    });

    it('clears error', () => {
      const { clearWorkspace } = useWorkspaceStore.getState();

      clearWorkspace();

      const { error } = useWorkspaceStore.getState();
      expect(error).toBeNull();
    });
  });

  describe('expandPath', () => {
    it('adds path to expanded set', () => {
      const { expandPath } = useWorkspaceStore.getState();

      expandPath('/path/to/folder');

      const { expandedPaths } = useWorkspaceStore.getState();
      expect(expandedPaths.has('/path/to/folder')).toBe(true);
    });

    it('can expand multiple paths', () => {
      const { expandPath } = useWorkspaceStore.getState();

      expandPath('/path/to/folder1');
      expandPath('/path/to/folder2');
      expandPath('/path/to/folder3');

      const { expandedPaths } = useWorkspaceStore.getState();
      expect(expandedPaths.size).toBe(3);
    });

    it('is idempotent', () => {
      const { expandPath } = useWorkspaceStore.getState();

      expandPath('/path/to/folder');
      expandPath('/path/to/folder');
      expandPath('/path/to/folder');

      const { expandedPaths } = useWorkspaceStore.getState();
      expect(expandedPaths.size).toBe(1);
    });
  });

  describe('collapsePath', () => {
    beforeEach(() => {
      useWorkspaceStore.setState({
        expandedPaths: new Set(['/path/to/folder1', '/path/to/folder2']),
      });
    });

    it('removes path from expanded set', () => {
      const { collapsePath } = useWorkspaceStore.getState();

      collapsePath('/path/to/folder1');

      const { expandedPaths } = useWorkspaceStore.getState();
      expect(expandedPaths.has('/path/to/folder1')).toBe(false);
      expect(expandedPaths.has('/path/to/folder2')).toBe(true);
    });

    it('does nothing if path not expanded', () => {
      const { collapsePath } = useWorkspaceStore.getState();

      collapsePath('/nonexistent/path');

      const { expandedPaths } = useWorkspaceStore.getState();
      expect(expandedPaths.size).toBe(2);
    });
  });

  describe('togglePath', () => {
    it('expands collapsed path', () => {
      const { togglePath } = useWorkspaceStore.getState();

      togglePath('/path/to/folder');

      const { expandedPaths } = useWorkspaceStore.getState();
      expect(expandedPaths.has('/path/to/folder')).toBe(true);
    });

    it('collapses expanded path', () => {
      useWorkspaceStore.setState({
        expandedPaths: new Set(['/path/to/folder']),
      });
      const { togglePath } = useWorkspaceStore.getState();

      togglePath('/path/to/folder');

      const { expandedPaths } = useWorkspaceStore.getState();
      expect(expandedPaths.has('/path/to/folder')).toBe(false);
    });
  });

  describe('setActiveWorkspaceFile', () => {
    it('sets active workspace file path', () => {
      const { setActiveWorkspaceFile } = useWorkspaceStore.getState();

      setActiveWorkspaceFile('/path/to/workspace.waypoint-workspace');

      const { activeWorkspaceFile } = useWorkspaceStore.getState();
      expect(activeWorkspaceFile).toBe('/path/to/workspace.waypoint-workspace');
    });

    it('can clear active workspace file', () => {
      useWorkspaceStore.setState({
        activeWorkspaceFile: '/path/to/workspace.waypoint-workspace',
      });
      const { setActiveWorkspaceFile } = useWorkspaceStore.getState();

      setActiveWorkspaceFile(null);

      const { activeWorkspaceFile } = useWorkspaceStore.getState();
      expect(activeWorkspaceFile).toBeNull();
    });
  });

  describe('resolveWorkspaceRevealPath', () => {
    const folders = [
      {
        path: '/Users/scientist/workspace/replasmidgenotyping',
        name: 'replasmidgenotyping',
        addedAt: 0,
      },
      {
        path: '/Users/scientist/workspace/Dev Assets',
        name: 'Dev Assets',
        addedAt: 1,
        pinned: true,
      },
    ];

    it('passes absolute paths through as normalized workspace paths', () => {
      expect(
        resolveWorkspaceRevealPath(
          folders,
          '/Users/scientist/workspace/Dev Assets/data/../seqs/a.gb'
        )
      ).toBe('/Users/scientist/workspace/Dev Assets/seqs/a.gb');
    });

    it('resolves folder-name-prefixed paths for multi-root workspaces', () => {
      expect(resolveWorkspaceRevealPath(folders, 'Dev Assets/data/file.gb')).toBe(
        '/Users/scientist/workspace/Dev Assets/data/file.gb'
      );
    });

    it('matches folder names case-insensitively', () => {
      expect(resolveWorkspaceRevealPath(folders, 'dev assets/data/file.gb')).toBe(
        '/Users/scientist/workspace/Dev Assets/data/file.gb'
      );
    });

    it('resolves bare relative paths only when the workspace has one root', () => {
      expect(resolveWorkspaceRevealPath([folders[0]], 'data/file.gb')).toBe(
        '/Users/scientist/workspace/replasmidgenotyping/data/file.gb'
      );
    });

    it('does not guess a root for ambiguous bare relative paths', () => {
      expect(resolveWorkspaceRevealPath(folders, 'data/file.gb')).toBeNull();
    });

    it('does not guess between projects with the same display name', () => {
      expect(
        resolveWorkspaceRevealPath(
          [
            { path: '/projects/first', name: 'Shared', addedAt: 1 },
            { path: '/projects/second', name: 'Shared', addedAt: 2 },
          ],
          'Shared/data/file.gb'
        )
      ).toBeNull();
    });

    it('rejects folder-name-prefixed paths that escape the workspace root', () => {
      expect(resolveWorkspaceRevealPath(folders, 'Dev Assets/../other/file.gb')).toBeNull();
    });
  });

  describe('revealPath', () => {
    it('reveals a batch atomically across roots, expanding every ancestor and deduplicating targets', () => {
      useWorkspaceStore.setState({
        folders: [
          { path: '/projects/cloning', name: 'Cloning', addedAt: 0 },
          { path: '/projects/yeast', name: 'Yeast', addedAt: 1 },
        ],
        expandedPaths: new Set(['/unrelated']),
      });
      const first = '/projects/cloning/imports/plasmids/pUC19';
      const second = '/projects/yeast/experiments/2026/CDC28';
      useWorkspaceStore.getState().revealPaths([first, second, first]);
      const state = useWorkspaceStore.getState();
      expect(state.revealTargetPaths).toEqual([first, second]);
      expect(state.selectedPath).toBe(first);
      expect(state.revealTargetPath).toBe(first);
      expect(state.revealRequestId).toBe(1);
      expect([...state.expandedPaths]).toEqual([
        '/unrelated',
        '/projects/cloning',
        '/projects/cloning/imports',
        '/projects/cloning/imports/plasmids',
        '/projects/yeast',
        '/projects/yeast/experiments',
        '/projects/yeast/experiments/2026',
      ]);
      useWorkspaceStore.getState().revealPath(second);
      expect(useWorkspaceStore.getState().revealTargetPaths).toEqual([second]);
    });

    it('expands parents and selects absolute paths inside the workspace', () => {
      useWorkspaceStore.setState({
        folders: [{ path: '/workspace/project', name: 'project', addedAt: 0 }],
        expandedPaths: new Set(),
        selectedPath: null,
        revealRequestId: 0,
        revealTargetPath: null,
      });

      useWorkspaceStore.getState().revealPath('/workspace/project/src/data/plasmid.gb');

      const { expandedPaths, selectedPath, revealRequestId, revealTargetPath } =
        useWorkspaceStore.getState();
      expect(selectedPath).toBe('/workspace/project/src/data/plasmid.gb');
      expect(revealTargetPath).toBe('/workspace/project/src/data/plasmid.gb');
      expect(revealRequestId).toBe(1);
      expect(expandedPaths.has('/workspace/project')).toBe(true);
      expect(expandedPaths.has('/workspace/project/src')).toBe(true);
      expect(expandedPaths.has('/workspace/project/src/data')).toBe(true);
    });

    it('uses the most specific containing project instead of mount order', () => {
      useWorkspaceStore.setState({
        folders: [
          { path: '/projects', name: 'Projects', addedAt: 0 },
          { path: '/projects/nested', name: 'Nested', addedAt: 1 },
        ],
        expandedPaths: new Set(),
        selectedPath: null,
        revealRequestId: 0,
        revealTargetPath: null,
      });

      useWorkspaceStore.getState().revealPath('/projects/nested/data/file.gb');

      expect([...useWorkspaceStore.getState().expandedPaths]).toEqual([
        '/projects/nested',
        '/projects/nested/data',
      ]);
    });

    it('resolves Dev Assets display-name paths before selecting the file tree row', () => {
      useWorkspaceStore.setState({
        folders: [
          { path: '/workspace/project', name: 'project', addedAt: 0 },
          { path: '/workspace/wp-assets', name: 'Dev Assets', addedAt: 1, pinned: true },
        ],
        expandedPaths: new Set(),
        selectedPath: null,
        revealRequestId: 0,
        revealTargetPath: null,
      });

      useWorkspaceStore.getState().revealPath('Dev Assets/sequences/local/pUC19.gb');

      const { expandedPaths, selectedPath, revealRequestId, revealTargetPath } =
        useWorkspaceStore.getState();
      expect(selectedPath).toBe('/workspace/wp-assets/sequences/local/pUC19.gb');
      expect(revealTargetPath).toBe('/workspace/wp-assets/sequences/local/pUC19.gb');
      expect(revealRequestId).toBe(1);
      expect(expandedPaths.has('/workspace/wp-assets')).toBe(true);
      expect(expandedPaths.has('/workspace/wp-assets/sequences')).toBe(true);
      expect(expandedPaths.has('/workspace/wp-assets/sequences/local')).toBe(true);
      expect(expandedPaths.has('/workspace/project')).toBe(false);
    });

    it('warns without changing selection when a multi-root relative path is ambiguous', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      useWorkspaceStore.setState({
        folders: [
          { path: '/workspace/project', name: 'project', addedAt: 0 },
          { path: '/workspace/wp-assets', name: 'Dev Assets', addedAt: 1, pinned: true },
        ],
        expandedPaths: new Set(['/workspace/project']),
        selectedPath: '/workspace/project/existing.gb',
        revealRequestId: 3,
        revealTargetPath: '/workspace/project/existing.gb',
      });

      useWorkspaceStore.getState().revealPath('sequences/local/pUC19.gb');

      const { expandedPaths, selectedPath, revealRequestId, revealTargetPath } =
        useWorkspaceStore.getState();
      expect(selectedPath).toBe('/workspace/project/existing.gb');
      expect(revealTargetPath).toBe('/workspace/project/existing.gb');
      expect(revealRequestId).toBe(3);
      expect(Array.from(expandedPaths)).toEqual(['/workspace/project']);
      expect(warn).toHaveBeenCalledWith(
        '[WorkspaceStore] Could not resolve file path for workspace reveal:',
        'sequences/local/pUC19.gb'
      );
      warn.mockRestore();
    });
  });

  describe('addFolder with pinned option', () => {
    it('adds a folder with pinned flag', () => {
      const { addFolder } = useWorkspaceStore.getState();

      addFolder('/path/to/assets', 'Dev Assets', { pinned: true });

      const { folders } = useWorkspaceStore.getState();
      expect(folders).toHaveLength(1);
      expect(folders[0].pinned).toBe(true);
    });

    it('adds a folder without pinned flag by default', () => {
      const { addFolder } = useWorkspaceStore.getState();

      addFolder('/path/to/project');

      const { folders } = useWorkspaceStore.getState();
      expect(folders[0].pinned).toBeUndefined();
    });

    it('adds a folder with pinned: false equivalent when no options', () => {
      const { addFolder } = useWorkspaceStore.getState();

      addFolder('/path/to/project', 'Project', {});

      const { folders } = useWorkspaceStore.getState();
      expect(folders[0].pinned).toBeFalsy();
    });
  });

  describe('reorderFolders', () => {
    beforeEach(() => {
      const { addFolder } = useWorkspaceStore.getState();
      addFolder('/path/to/a', 'A');
      addFolder('/path/to/b', 'B');
      addFolder('/path/to/c', 'C');
    });

    it('moves a folder from one position to another', () => {
      const { reorderFolders } = useWorkspaceStore.getState();

      reorderFolders(0, 2);

      const { folders } = useWorkspaceStore.getState();
      expect(folders.map((f) => f.name)).toEqual(['B', 'C', 'A']);
    });

    it('moves a folder backward', () => {
      const { reorderFolders } = useWorkspaceStore.getState();

      reorderFolders(2, 0);

      const { folders } = useWorkspaceStore.getState();
      expect(folders.map((f) => f.name)).toEqual(['C', 'A', 'B']);
    });

    it('does nothing when from === to', () => {
      const { reorderFolders } = useWorkspaceStore.getState();

      reorderFolders(1, 1);

      const { folders } = useWorkspaceStore.getState();
      expect(folders.map((f) => f.name)).toEqual(['A', 'B', 'C']);
    });

    it('does nothing for out-of-bounds fromIndex', () => {
      const { reorderFolders } = useWorkspaceStore.getState();

      reorderFolders(-1, 1);
      reorderFolders(5, 1);

      const { folders } = useWorkspaceStore.getState();
      expect(folders.map((f) => f.name)).toEqual(['A', 'B', 'C']);
    });

    it('does nothing for out-of-bounds toIndex', () => {
      const { reorderFolders } = useWorkspaceStore.getState();

      reorderFolders(0, -1);
      reorderFolders(0, 5);

      const { folders } = useWorkspaceStore.getState();
      expect(folders.map((f) => f.name)).toEqual(['A', 'B', 'C']);
    });

    it('skips reorder if source folder is pinned', () => {
      useWorkspaceStore.setState({
        folders: useWorkspaceStore
          .getState()
          .folders.map((f, i) => (i === 0 ? { ...f, pinned: true } : f)),
      });

      const { reorderFolders } = useWorkspaceStore.getState();
      reorderFolders(0, 2);

      const { folders } = useWorkspaceStore.getState();
      expect(folders.map((f) => f.name)).toEqual(['A', 'B', 'C']);
    });

    it('skips reorder if target folder is pinned', () => {
      useWorkspaceStore.setState({
        folders: useWorkspaceStore
          .getState()
          .folders.map((f, i) => (i === 2 ? { ...f, pinned: true } : f)),
      });

      const { reorderFolders } = useWorkspaceStore.getState();
      reorderFolders(0, 2);

      const { folders } = useWorkspaceStore.getState();
      expect(folders.map((f) => f.name)).toEqual(['A', 'B', 'C']);
    });
  });

  describe('saveWorkspace (browser mode)', () => {
    beforeEach(() => {
      const { addFolder } = useWorkspaceStore.getState();
      addFolder('/path/to/project1', 'Project 1');
      addFolder('/path/to/project2', 'Project 2');
    });

    it('sets active workspace file in browser mode', async () => {
      const { saveWorkspace } = useWorkspaceStore.getState();

      await saveWorkspace('/path/to/workspace.waypoint-workspace');

      const { activeWorkspaceFile } = useWorkspaceStore.getState();
      expect(activeWorkspaceFile).toBe('/path/to/workspace.waypoint-workspace');
    });
  });

  describe('loadWorkspace (browser mode)', () => {
    it('loads mock folders in browser mode', async () => {
      const { loadWorkspace } = useWorkspaceStore.getState();

      await loadWorkspace('/path/to/workspace.waypoint-workspace');

      const { folders, activeWorkspaceFile } = useWorkspaceStore.getState();
      expect(folders).toHaveLength(2);
      expect(folders[0].path).toBe('/mock/project1');
      expect(folders[1].path).toBe('/mock/project2');
      expect(activeWorkspaceFile).toBe('/path/to/workspace.waypoint-workspace');
    });
  });
});
