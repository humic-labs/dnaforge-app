import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspace } from './useWorkspace';
import { useWorkspaceStore } from '../stores/workspaceStore';

const ports = vi.hoisted(() => ({
  read: vi.fn(),
  projects: vi.fn(),
  write: vi.fn(),
  remove: vi.fn(),
  ensure: vi.fn(),
  persisted: null as string | null,
}));
vi.mock('../db', () => {
  const settings = { key: 'key' };
  return {
    settings,
    workspaces: { path: 'path', archivedAt: 'archivedAt', trashedAt: 'trashedAt' },
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: () => (table === settings ? ports.read() : ports.projects()),
        }),
      }),
      insert: () => ({
        values: ({ value }: { value: string }) => ({
          onConflictDoUpdate: async () => {
            await ports.write(value);
            ports.persisted = value;
          },
        }),
      }),
      delete: () => ({
        where: async () => {
          await ports.remove();
          ports.persisted = null;
        },
      }),
    },
  };
});
vi.mock('drizzle-orm', () => ({ and: vi.fn(), eq: vi.fn(), isNull: vi.fn() }));
vi.mock('../platform', () => ({
  platform: () => ({ db: { ensureWorkspaceOwner: ports.ensure } }),
}));
vi.mock('../utils/environment', () => ({
  isBrowserOnly: () => false,
  isHostedBrowserRuntime: () => false,
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('workspace session authority', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    ports.persisted = null;
    ports.read.mockResolvedValue([]);
    ports.projects.mockResolvedValue([]);
    ports.ensure.mockResolvedValue(1);
    ports.write.mockResolvedValue(undefined);
    ports.remove.mockResolvedValue(undefined);
    useWorkspaceStore.getState().clearWorkspace();
  });

  it('shares one active selection across independently mounted consumers', async () => {
    const first = renderHook(() => useWorkspace());
    const second = renderHook(() => useWorkspace());
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    await act(async () => {
      await first.result.current.setWorkspacePath('/project/a');
    });
    expect(second.result.current.path).toBe('/project/a');
    expect(useWorkspaceStore.getState().folders.map((folder) => folder.path)).toContain(
      '/project/a'
    );
    expect(ports.persisted).toBe('/project/a');
  });

  it('settles a delayed activation before the newer clear persistence', async () => {
    const first = renderHook(() => useWorkspace());
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    const write = deferred();
    ports.write.mockReturnValueOnce(write.promise);
    let activation!: Promise<void>;
    act(() => {
      activation = first.result.current.setWorkspacePath('/project/a');
    });
    await waitFor(() => expect(ports.write).toHaveBeenCalled());
    let cleared!: Promise<void>;
    act(() => {
      cleared = first.result.current.clearWorkspace();
    });
    await act(async () => {
      write.resolve();
      await Promise.all([activation, cleared]);
    });
    expect(first.result.current.path).toBeNull();
    expect(ports.persisted).toBeNull();
  });

  it('removing a root retires its pending activation without resurrecting it', async () => {
    const first = renderHook(() => useWorkspace());
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    act(() => useWorkspaceStore.getState().addFolder('/project/a'));
    const write = deferred();
    ports.write.mockReturnValueOnce(write.promise);
    let activation!: Promise<void>;
    act(() => {
      activation = first.result.current.setWorkspacePath('/project/a');
    });
    await waitFor(() => expect(ports.write).toHaveBeenCalled());
    act(() => useWorkspaceStore.getState().removeFolder('/project/a'));
    await act(async () => {
      write.resolve();
      await activation;
    });
    await waitFor(() => expect(ports.persisted).toBeNull());
    expect(first.result.current.path).toBeNull();
    expect(useWorkspaceStore.getState().folders).toEqual([]);
  });
});
