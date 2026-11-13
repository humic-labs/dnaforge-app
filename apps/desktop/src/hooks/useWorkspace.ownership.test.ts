// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspace } from './useWorkspace';
const ports = vi.hoisted(() => ({
  read: vi.fn(),
  projects: vi.fn(),
  write: vi.fn(),
  remove: vi.fn(),
  ensure: vi.fn(),
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
      insert: () => ({ values: () => ({ onConflictDoUpdate: ports.write }) }),
      delete: () => ({ where: ports.remove }),
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
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
describe('active workspace request ownership', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    ports.projects.mockResolvedValue([{ path: '/old-project' }]);
    ports.write.mockResolvedValue(undefined);
    ports.remove.mockResolvedValue(undefined);
    ports.ensure.mockResolvedValue(undefined);
  });
  it.each(['activate', 'clear', 'failure'] as const)(
    'retires initialization after %s',
    async (action) => {
      const read = deferred<{ value: string }[]>();
      ports.read.mockReturnValue(read.promise);
      const { result } = renderHook(() => useWorkspace());
      await act(async () => {
        if (action === 'clear') await result.current.clearWorkspace();
        else await result.current.setWorkspacePath('/new-project');
      });
      await act(async () => {
        if (action === 'failure') read.reject(new Error('old startup failure'));
        else read.resolve([{ value: '/old-project' }]);
      });
      expect(result.current.path).toBe(action === 'clear' ? null : '/new-project');
      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBeNull();
    }
  );
  it('does not delete the current setting when retired project validation returns missing', async () => {
    const validation = deferred<{ path: string }[]>();
    ports.read.mockResolvedValue([{ value: '/old-project' }]);
    ports.projects.mockReturnValue(validation.promise);
    const { result } = renderHook(() => useWorkspace());
    await act(async () => {
      await Promise.resolve();
    });
    expect(ports.projects).toHaveBeenCalledOnce();
    await act(async () => {
      await result.current.setWorkspacePath('/new-project');
    });
    await act(async () => {
      validation.resolve([]);
    });
    expect(ports.remove).not.toHaveBeenCalled();
    expect(result.current.path).toBe('/new-project');
  });
});
