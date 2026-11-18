import { act, renderHook, waitFor } from '@testing-library/react';
import { useFileBrowser } from './useFileBrowser';
const mocks = vi.hoisted(() => ({ listChildren: vi.fn() }));
vi.mock('../platform', () => ({
  platform: () => ({
    fs: { exists: async () => false },
    workspace: { listChildren: mocks.listChildren },
  }),
}));
it('retains a child when its expansion and an earlier root refresh publish in one batch', async () => {
  let holdRoot = false;
  let releaseRoot!: () => void;
  let releaseChild!: () => void;
  mocks.listChildren.mockImplementation(
    async ({ parentRelativePath: path }: { parentRelativePath: string }) => {
      if (!path && holdRoot)
        await new Promise<void>((r) => {
          releaseRoot = r;
        });
      if (path)
        await new Promise<void>((r) => {
          releaseChild = r;
        });
      return {
        workspaceId: 1,
        parentRelativePath: path,
        partialError: null,
        entries: [
          {
            kind: 'filesystem',
            entryId: path ? 'file' : 'folder',
            name: path ? 'readiness.txt' : 'Startup fixture',
            path: path ? '/lab/Startup fixture/readiness.txt' : '/lab/Startup fixture',
            isDirectory: !path,
            isFile: !!path,
          },
        ],
      };
    }
  );
  const { result } = renderHook(() => useFileBrowser('/lab'));
  await waitFor(() => expect(result.current.entries).toHaveLength(1));
  holdRoot = true;
  let refreshing!: Promise<void>;
  act(() => {
    refreshing = result.current.refresh();
  });
  let expanding!: Promise<void>;
  act(() => {
    expanding = result.current.expandDirectory('/lab/Startup fixture');
  });
  await act(async () => {
    releaseChild();
    releaseRoot();
    await Promise.all([expanding, refreshing]);
  });
  expect(result.current.expandedPaths.has('/lab/Startup fixture')).toBe(true);
  expect(result.current.entries[0].children?.[0].name).toBe('readiness.txt');
});
