// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useFileBrowser } from './useFileBrowser';

const mocks = vi.hoisted(() => ({ listChildren: vi.fn() }));
vi.mock('../platform', () => ({
  platform: () => ({
    fs: { exists: async () => false },
    workspace: { listChildren: mocks.listChildren },
  }),
}));

it('overlaps expanded folder reads with a bound and replays parents before children', async () => {
  const folders = ['a', 'b', 'c', 'd', 'e', 'f'];
  const releases = new Map<string, () => void>();
  let hold = false;
  mocks.listChildren.mockImplementation(
    async ({ parentRelativePath: path }: { parentRelativePath: string }) => {
      if (hold && path)
        await new Promise<void>((resolve) => {
          releases.set(path, resolve);
        });
      const names = !path ? folders : path === 'a' ? ['child'] : ['latest.txt'];
      return {
        workspaceId: 1,
        parentRelativePath: path,
        partialError: null,
        entries: names.map((name) => ({
          kind: 'filesystem',
          entryId: `${path}/${name}`,
          name,
          path: `/lab/${path ? `${path}/` : ''}${name}`,
          isDirectory: name !== 'latest.txt',
          isFile: name === 'latest.txt',
        })),
      };
    }
  );
  const { result } = renderHook(() => useFileBrowser('/lab'));
  await waitFor(() => expect(result.current.entries).toHaveLength(6));
  for (const folder of [...folders, 'a/child']) {
    await act(async () => {
      await result.current.expandDirectory(`/lab/${folder}`);
    });
  }
  hold = true;
  let refreshing!: Promise<void>;
  act(() => {
    refreshing = result.current.refresh();
  });
  await vi.waitFor(() => expect(releases.size).toBe(4));
  for (const release of [...releases.values()].reverse()) release();
  await vi.waitFor(() => expect(releases.size).toBe(7));
  await act(async () => {
    for (const release of [...releases.values()].reverse()) release();
    await refreshing;
  });
  expect(result.current.entries.map((entry) => entry.name)).toEqual(folders);
  expect(result.current.entries[0].children?.[0].children?.[0].name).toBe('latest.txt');
  expect(result.current.expandedPaths.size).toBe(7);
  expect(result.current.error).toBeNull();
});
