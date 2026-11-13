/** @vitest-environment jsdom */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ list: vi.fn(), registered: vi.fn() }));
vi.mock('../features/workspace-loader/workspace-library', () => ({
  listWorkspaceLibrary: mocks.list,
  normalizeWorkspaceTimestamp: (x: number) => x,
}));
vi.mock('../features/workspace-loader/project-edit-folders', () => ({
  listProjectEditFolders: mocks.registered,
}));
vi.mock('../utils/environment', () => ({ isDesktopRuntime: () => true }));
import { useWorkspaceLibrary, type WorkspaceLibrary } from './useWorkspaceLibrary';
const snapshot = (name: string): WorkspaceLibrary => ({
  active: [
    {
      repoUuid: name,
      name,
      repoPath: '/fixture/' + name,
      originPath: null,
      lastOpenedAt: 1,
      archivedAt: null,
      trashedAt: null,
    },
  ],
  archived: [],
  trashed: [],
});
const options = {
  shellPrepared: true,
  workspacePath: null,
  folders: [],
  fileTreeRefreshToken: 0,
  projectHomePath: null,
  renameFolder: vi.fn(),
};
describe('project library current read ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.registered.mockResolvedValue([]);
  });
  it('ignores an older read after a newer refresh commits', async () => {
    let finish!: (value: WorkspaceLibrary) => void;
    mocks.list
      .mockReturnValueOnce(
        new Promise<WorkspaceLibrary>((r) => {
          finish = r;
        })
      )
      .mockResolvedValueOnce(snapshot('new'));
    const { result } = renderHook(() => useWorkspaceLibrary(options));
    await waitFor(() => expect(mocks.list).toHaveBeenCalledOnce());
    await act(async () => result.current.refreshWorkspaceLibrary());
    await act(async () => finish(snapshot('old')));
    expect(result.current.workspaceLibrary).toEqual(snapshot('new'));
  });
  it('a later committed library mutation defeats an outstanding read', async () => {
    let finish!: (value: WorkspaceLibrary) => void;
    mocks.list.mockReturnValueOnce(
      new Promise<WorkspaceLibrary>((r) => {
        finish = r;
      })
    );
    const { result } = renderHook(() => useWorkspaceLibrary(options));
    await waitFor(() => expect(mocks.list).toHaveBeenCalledOnce());
    act(() => result.current.setWorkspaceLibrary(snapshot('committed')));
    await act(async () => finish(snapshot('old')));
    expect(result.current.workspaceLibrary).toEqual(snapshot('committed'));
  });
  it('failed refresh retains the confirmed snapshot and retry recovers', async () => {
    mocks.list
      .mockResolvedValueOnce(snapshot('confirmed'))
      .mockRejectedValueOnce(new Error('controlled refusal'))
      .mockResolvedValueOnce(snapshot('recovered'));
    const { result } = renderHook(() => useWorkspaceLibrary(options));
    await waitFor(() => expect(result.current.libraryLoaded).toBe(true));
    await act(async () => result.current.refreshWorkspaceLibrary());
    expect(result.current.workspaceLibrary).toEqual(snapshot('confirmed'));
    expect(result.current.libraryLoadError).toBeTruthy();
    await act(async () => result.current.refreshWorkspaceLibrary());
    expect(result.current.workspaceLibrary).toEqual(snapshot('recovered'));
    expect(result.current.libraryLoadError).toBeNull();
  });
});

describe('project actions library value', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.registered.mockResolvedValue([]);
  });

  it('carries the same six fields the hook returns individually', async () => {
    mocks.list.mockResolvedValue(snapshot('alpha'));
    const { result } = renderHook(() => useWorkspaceLibrary(options));
    await waitFor(() => expect(result.current.libraryLoaded).toBe(true));
    const { library } = result.current;
    expect(library).toEqual({
      workspaceLibrary: result.current.workspaceLibrary,
      registeredProjectFolders: result.current.registeredProjectFolders,
      setWorkspaceLibrary: result.current.setWorkspaceLibrary,
      libraryLoaded: result.current.libraryLoaded,
      refreshWorkspaceLibrary: result.current.refreshWorkspaceLibrary,
      workspaceLibraryEntries: result.current.workspaceLibraryEntries,
    });
    expect(library.setWorkspaceLibrary).toBe(result.current.setWorkspaceLibrary);
    expect(library.refreshWorkspaceLibrary).toBe(result.current.refreshWorkspaceLibrary);
  });

  it('keeps its identity across renders until one of its fields changes', async () => {
    mocks.list.mockResolvedValue(snapshot('alpha'));
    const { result, rerender } = renderHook(
      ({ renameFolder }) => useWorkspaceLibrary({ ...options, renameFolder }),
      { initialProps: { renameFolder: vi.fn() } }
    );
    await waitFor(() => expect(result.current.libraryLoaded).toBe(true));
    const loaded = result.current.library;
    rerender({ renameFolder: vi.fn() });
    rerender({ renameFolder: vi.fn() });
    expect(result.current.library).toBe(loaded);
    act(() => result.current.setWorkspaceLibrary(snapshot('beta')));
    expect(result.current.library).not.toBe(loaded);
    expect(result.current.library.workspaceLibrary).toEqual(snapshot('beta'));
  });
});
