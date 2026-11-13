import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetFile, mockFolders } = vi.hoisted(() => ({
  mockGetFile: vi.fn(),
  mockFolders: { current: [] as { path: string; name: string; pinned?: boolean }[] },
}));

vi.mock('../../../db/workspace-catalog', () => ({
  getCurrentCatalogFileForEntity: mockGetFile,
}));

vi.mock('../../../stores/workspaceStore', () => ({
  useWorkspaceStore: (selector: (s: unknown) => unknown) =>
    selector({ folders: mockFolders.current }),
}));

import { useOwningReferenceContext } from './useOwningReferenceContext';

describe('useOwningReferenceContext', () => {
  it('does not reuse the previous page owner while the next page is resolving', async () => {
    mockGetFile.mockResolvedValueOnce({ path: '/ws/alpha/Notes.md' });
    const { result, rerender } = renderHook(({ pageId }) => useOwningReferenceContext(pageId), {
      initialProps: { pageId: 'alpha::page-a' },
    });
    await waitFor(() => expect(result.current?.owningRoot).toBe('/ws/alpha'));
    const pending = Promise.withResolvers<{ path: string }>();
    mockGetFile.mockReturnValueOnce(pending.promise);
    rerender({ pageId: 'beta::page-b' });
    expect(result.current).toBeNull();
    pending.resolve({ path: '/ws/beta/Notes.md' });
    await waitFor(() => expect(result.current?.owningRoot).toBe('/ws/beta'));
  });
  beforeEach(() => {
    mockGetFile.mockReset();
    mockFolders.current = [
      { path: '/ws/alpha', name: 'alpha' },
      { path: '/ws/beta', name: 'beta' },
    ];
  });

  it('resolves the root containing the page file', async () => {
    mockGetFile.mockResolvedValue({ path: '/ws/beta/notes/e.forge/notebook.json' });

    const { result } = renderHook(() => useOwningReferenceContext('scope-beta::nb-1'));

    await waitFor(() =>
      expect(result.current).toEqual({
        owningRoot: '/ws/beta',
        workspaceScopeKey: 'scope-beta',
      })
    );
  });

  it('excludes PINNED roots from ownership', async () => {
    mockFolders.current = [
      { path: '/ws/devtools', name: 'devtools', pinned: true },
      { path: '/ws/beta', name: 'beta' },
    ];
    mockGetFile.mockResolvedValue({ path: '/ws/devtools/notes/e.forge/notebook.json' });

    const { result } = renderHook(() => useOwningReferenceContext('scope::nb-1'));

    await waitFor(() => expect(mockGetFile).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });

  it('is null when the catalog knows no file for the page', async () => {
    mockGetFile.mockResolvedValue(null);

    const { result } = renderHook(() => useOwningReferenceContext('scope-beta::nb-1'));

    await waitFor(() => expect(mockGetFile).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });

  it('is null — not a fallback root — when the lookup fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockGetFile.mockRejectedValue(new Error('db gone'));

    const { result } = renderHook(() => useOwningReferenceContext('scope-beta::nb-1'));

    await waitFor(() => expect(error).toHaveBeenCalled());
    expect(result.current).toBeNull();
    error.mockRestore();
  });

  it('does not set state after unmount', async () => {
    let release: (v: unknown) => void = () => {};
    mockGetFile.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      })
    );

    const { unmount } = renderHook(() => useOwningReferenceContext('scope::nb-1'));
    unmount();
    release({ path: '/ws/beta/x.forge/notebook.json' });

    await Promise.resolve();
  });

  it('re-resolves when the mounted roots change', async () => {
    mockGetFile.mockResolvedValue({ path: '/ws/beta/notes/e.forge/notebook.json' });

    const { result, rerender } = renderHook(() => useOwningReferenceContext('scope-beta::nb-1'));
    await waitFor(() => expect(result.current).not.toBeNull());

    mockFolders.current = [{ path: '/ws/alpha', name: 'alpha' }];
    rerender();

    await waitFor(() => expect(result.current).toBeNull());
  });
});
