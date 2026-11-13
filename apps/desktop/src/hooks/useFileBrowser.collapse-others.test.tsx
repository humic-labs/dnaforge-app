import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useFileBrowser } from './useFileBrowser';
import { readExpandedPaths, writeExpandedPaths } from '../shared/ui-persistence';

const listing = vi.hoisted(() => vi.fn());
vi.mock('../platform', () => ({
  platform: () => ({ workspace: { listChildren: listing }, fs: { exists: async () => false } }),
}));

const paths = [
  '/lab/alpha',
  '/lab/alpha/nested',
  '/lab/alpha/nested/deep',
  '/lab/alphabet',
  '/lab/beta',
];
beforeEach(() => {
  localStorage.clear();
  listing.mockImplementation(async ({ parentRelativePath }: { parentRelativePath: string }) => ({
    workspaceId: 1,
    parentRelativePath,
    entries: paths
      .filter(
        (path) =>
          path.slice(0, path.lastIndexOf('/')) ===
          `/lab${parentRelativePath ? `/${parentRelativePath}` : ''}`
      )
      .map((path) => ({
        kind: 'filesystem',
        entryId: `filesystem:${path}`,
        path,
        name: path.split('/').at(-1),
        isDirectory: true,
        isFile: false,
      })),
    partialError: null,
  }));
  writeExpandedPaths('/lab', paths);
});

it('keeps the selected folder, ancestors and descendants and persists other collapses', async () => {
  const { result, unmount } = renderHook(() => useFileBrowser('/lab', true));
  await waitFor(() => expect(result.current.loading).toBe(false));
  act(() => result.current.collapseOtherDirectories('/lab/alpha/nested'));
  expect([...result.current.expandedPaths]).toEqual(paths.slice(0, 3));
  await waitFor(() => expect(readExpandedPaths('/lab')).toEqual(paths.slice(0, 3)));
  await act(() => result.current.refresh());
  expect([...result.current.expandedPaths]).toEqual(paths.slice(0, 3));
  unmount();
  const reopened = renderHook(() => useFileBrowser('/lab', true));
  await waitFor(() => expect(reopened.result.current.loading).toBe(false));
  expect([...reopened.result.current.expandedPaths]).toEqual(paths.slice(0, 3));
});

it('clears every folder in another project and allows subsequent expansion', async () => {
  const { result } = renderHook(() => useFileBrowser('/lab', true));
  await waitFor(() => expect(result.current.loading).toBe(false));
  act(() => result.current.collapseOtherDirectories('/elsewhere/project'));
  expect(result.current.expandedPaths.size).toBe(0);
  await act(() => result.current.expandDirectory('/lab/beta'));
  expect([...result.current.expandedPaths]).toEqual(['/lab/beta']);
});
