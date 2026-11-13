import type { NotebookDocumentSnapshot } from '../shared/notebook-document';
import { expect, it, vi } from 'vitest';
import { installNativeNotebookCatalogPublisher } from './native-notebook-catalog-publisher';

const state = vi.hoisted(() => ({
  changed: undefined as
    | ((
        snapshot: Pick<
          NotebookDocumentSnapshot,
          'documentId' | 'workspaceRoot' | 'path' | 'title'
        > & { revision?: string }
      ) => void)
    | undefined,
  bump: vi.fn(),
  stop: vi.fn(),
}));
vi.mock('../platform', () => ({
  platform: () => ({
    notebook: {
      onChanged: (listener: typeof state.changed) => {
        state.changed = listener;
        return state.stop;
      },
    },
  }),
}));
vi.mock('../stores/workspaceStore', () => ({
  useWorkspaceStore: {
    getState: () => ({ folders: [{ path: '/project' }], bumpFileTreeRefresh: state.bump }),
  },
}));

it('refreshes a mounted notebook creation and rename without refreshing every edit', () => {
  const stop = installNativeNotebookCatalogPublisher();
  const snapshot = {
    documentId: 'book',
    workspaceRoot: '/project',
    path: '/project/Book',
    title: 'Book',
  };
  state.changed!(snapshot);
  expect(state.bump).toHaveBeenCalledTimes(1);
  state.changed!({ ...snapshot, revision: 'next edit' });
  expect(state.bump).toHaveBeenCalledTimes(1);
  state.changed!({ ...snapshot, path: '/project/Renamed', title: 'Renamed' });
  expect(state.bump).toHaveBeenCalledTimes(2);
  state.changed!({ ...snapshot, workspaceRoot: '/unmounted' });
  expect(state.bump).toHaveBeenCalledTimes(2);
  stop();
  expect(state.stop).toHaveBeenCalledOnce();
});
