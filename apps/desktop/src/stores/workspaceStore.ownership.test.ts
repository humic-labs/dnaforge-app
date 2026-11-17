import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceStore } from './workspaceStore';
const fs = vi.hoisted(() => ({ readTextFile: vi.fn() }));
const ensure = vi.hoisted(() => vi.fn());
vi.mock('../utils/environment', () => ({
  isBrowserOnly: () => false,
  isHostedBrowserRuntime: () => false,
}));
vi.mock('../platform', () => ({ platform: () => ({ fs, db: { ensureWorkspaceOwner: ensure } }) }));
vi.mock('../db', () => ({
  db: {
    delete: () => ({ where: async () => {} }),
    insert: () => ({ values: () => ({ onConflictDoUpdate: async () => {} }) }),
  },
  settings: { key: 'key' },
  workspaces: { path: 'path', archivedAt: 'archivedAt', trashedAt: 'trashedAt' },
}));
vi.mock('../db/connection', async () => ({ db: (await import('../db')).db }));
vi.mock('../db/schema', async () => {
  const { settings, workspaces } = await import('../db');
  return { settings, workspaces };
});

vi.mock('drizzle-orm', () => ({ and: vi.fn(), eq: vi.fn(), isNull: vi.fn() }));
function delayed() {
  let finish!: (value: string) => void;
  const promise = new Promise<string>((resolve) => {
    finish = resolve;
  });
  return { promise, finish };
}
describe('workspace collection restore ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspaceStore.getState().clearWorkspace();
  });
  it('does not resurrect a removed root after a pending workspace-file read', async () => {
    const read = delayed();
    fs.readTextFile.mockReturnValueOnce(read.promise);
    useWorkspaceStore.getState().addFolder('/a');
    const pending = useWorkspaceStore.getState().loadWorkspace('/session.waypoint-workspace');
    useWorkspaceStore.getState().removeFolder('/a');
    read.finish(JSON.stringify({ folders: [{ path: '/a', name: 'A' }] }));
    await pending;
    expect(useWorkspaceStore.getState().folders).toEqual([]);
    expect(useWorkspaceStore.getState().isLoading).toBe(false);
  });
  it('retains the newer workspace-file request when the older read completes later', async () => {
    const read = delayed();
    fs.readTextFile
      .mockReturnValueOnce(read.promise)
      .mockResolvedValueOnce(JSON.stringify({ folders: [] }));
    const pending = useWorkspaceStore.getState().loadWorkspace('/old.waypoint-workspace');
    await useWorkspaceStore.getState().loadWorkspace('/new.waypoint-workspace');
    read.finish(JSON.stringify({ folders: [{ path: '/old', name: 'Old' }] }));
    await pending;
    expect(useWorkspaceStore.getState().folders).toEqual([]);
    expect(useWorkspaceStore.getState().activeWorkspaceFile).toBe('/new.waypoint-workspace');
  });
});

it('retires an unmounted pending activation when a newer collection is committed', async () => {
  useWorkspaceStore.getState().clearWorkspace();
  await useWorkspaceStore.getState().activateWorkspace('/a', { addToRecents: false });
  const registration = delayed();
  ensure.mockReturnValueOnce(registration.promise);
  const pending = useWorkspaceStore.getState().activateWorkspace('/b');
  useWorkspaceStore.getState().commitMountedFolders({
    folders: [{ path: '/a', name: 'A', addedAt: 1 }],
    expandedPaths: new Set(),
    activeWorkspaceFile: null,
  });
  await useWorkspaceStore.getState().acceptMountedWorkspaceSelection();
  registration.finish('owner');
  await pending;
  expect(useWorkspaceStore.getState().folders.map((root) => root.path)).toEqual(['/a']);
  expect(useWorkspaceStore.getState().workspaceSelection.path).toBe('/a');
});
