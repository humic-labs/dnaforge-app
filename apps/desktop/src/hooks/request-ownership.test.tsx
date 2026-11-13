// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileContent } from './useFileContent';
import { notifyGitStatusChanged, useGitStatus } from './useGitStatus';
import { useWorkspaceStore } from '../stores/workspaceStore';
import type { GitFileStatus } from '../features/workspace/git';

const io = vi.hoisted(() => ({ readTextFile: vi.fn(), isGitRepo: vi.fn(), gitStatus: vi.fn() }));
vi.mock('./useMockedFileSystem', () => ({ getFileSystem: async () => io }));
vi.mock('./resolveFilePath', () => ({ resolveFilePathWithFallback: (path: string) => path }));
vi.mock('../features/workspace/git', () => ({ isGitRepo: io.isGitRepo, gitStatus: io.gitStatus }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetAllMocks();
  useWorkspaceStore.setState({ folders: [] });
  io.isGitRepo.mockResolvedValue(true);
});
afterEach(cleanup);

const sequenceA = '>sequence-a\nACGT\n';
const sequenceB = '>sequence-b\nGGGG\n';
const changesA = () => new Map<string, GitFileStatus>([['a.fa', 'modified']]);
const changesB = () => new Map<string, GitFileStatus>([['b.fa', 'untracked']]);

describe('file read request ownership', () => {
  it('retires a pending read and clears loading when the file becomes null', async () => {
    const pending = deferred<string>();
    io.readTextFile.mockReturnValue(pending.promise);
    const hook = renderHook(({ file }: { file: string | null }) => useFileContent(file), {
      initialProps: { file: '/project/a.fa' as string | null },
    });
    await waitFor(() => expect(io.readTextFile).toHaveBeenCalledTimes(1));
    expect(hook.result.current.loading).toBe(true);
    hook.rerender({ file: null });
    expect(hook.result.current.loading).toBe(false);
    await act(async () => {
      pending.resolve(sequenceA);
    });
    expect(hook.result.current.sequence).toBeNull();
    expect(hook.result.current.rawContent).toBeNull();
    expect(hook.result.current.acceptedRevision).toBeNull();
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.format).toBeNull();
  });

  it('ignores a retired read failure after clearing the file', async () => {
    const pending = deferred<string>();
    io.readTextFile.mockReturnValue(pending.promise);
    const hook = renderHook(({ file }: { file: string | null }) => useFileContent(file), {
      initialProps: { file: '/project/a.fa' as string | null },
    });
    await waitFor(() => expect(io.readTextFile).toHaveBeenCalledTimes(1));
    hook.rerender({ file: null });
    await act(async () => {
      pending.reject(new Error('Old read failed'));
    });
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.errorClass).toBeNull();
    expect(hook.result.current.loading).toBe(false);
  });

  it('does not expose the previous file while its replacement is loading', async () => {
    const next = deferred<string>();
    io.readTextFile.mockResolvedValueOnce(sequenceA).mockReturnValueOnce(next.promise);
    const hook = renderHook(({ file }) => useFileContent(file), {
      initialProps: { file: '/project/a.fa' },
    });
    await waitFor(() => expect(hook.result.current.sequence?.sequence).toBe('ACGT'));
    hook.rerender({ file: '/project/b.fa' });
    expect(hook.result.current.sequence).toBeNull();
    expect(hook.result.current.rawContent).toBeNull();
    await act(async () => {
      next.resolve(sequenceB);
    });
    expect(hook.result.current.sequence?.sequence).toBe('GGGG');
  });

  it('keeps the latest same-file reload when earlier completion arrives last', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    io.readTextFile.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const hook = renderHook(() => useFileContent('/project/a.fa'));
    await waitFor(() => expect(io.readTextFile).toHaveBeenCalledTimes(1));
    let reloading!: Promise<void>;
    await act(async () => {
      reloading = hook.result.current.reload();
    });
    await waitFor(() => expect(io.readTextFile).toHaveBeenCalledTimes(2));
    await act(async () => {
      second.resolve(sequenceB);
      await reloading;
    });
    await act(async () => {
      first.resolve(sequenceA);
    });
    expect(hook.result.current.sequence?.sequence).toBe('GGGG');
    expect(hook.result.current.loading).toBe(false);
  });
});

describe('Git status request ownership', () => {
  it('keeps project B when a project A status read finishes last', async () => {
    const first = deferred<Map<string, GitFileStatus>>();
    const second = deferred<Map<string, GitFileStatus>>();
    io.gitStatus.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const hook = renderHook(({ folder }) => useGitStatus(folder), {
      initialProps: { folder: '/a' },
    });
    await waitFor(() => expect(io.gitStatus).toHaveBeenCalledWith('/a'));
    hook.rerender({ folder: '/b' });
    await waitFor(() => expect(io.gitStatus).toHaveBeenCalledWith('/b'));
    await act(async () => {
      second.resolve(changesB());
    });
    await act(async () => {
      first.resolve(changesA());
    });
    expect([...hook.result.current.statusMap]).toEqual([...changesB()]);
    expect(hook.result.current.isTracked).toBe(true);
  });

  it('retires status reads and clears display when no project is selected', async () => {
    const pending = deferred<Map<string, GitFileStatus>>();
    io.gitStatus.mockReturnValue(pending.promise);
    const hook = renderHook(({ folder }: { folder: string | null }) => useGitStatus(folder), {
      initialProps: { folder: '/a' as string | null },
    });
    await waitFor(() => expect(io.gitStatus).toHaveBeenCalledTimes(1));
    hook.rerender({ folder: null });
    await act(async () => {
      pending.resolve(changesA());
    });
    expect(hook.result.current.isTracked).toBe(false);
    expect(hook.result.current.statusMap.size).toBe(0);
  });

  it('ignores an older failure after a same-project notification refresh succeeds', async () => {
    const first = deferred<Map<string, GitFileStatus>>();
    const second = deferred<Map<string, GitFileStatus>>();
    io.gitStatus.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const hook = renderHook(() => useGitStatus('/a'));
    await waitFor(() => expect(io.gitStatus).toHaveBeenCalledTimes(1));
    act(() => notifyGitStatusChanged('/a'));
    await waitFor(() => expect(io.gitStatus).toHaveBeenCalledTimes(2));
    await act(async () => {
      second.resolve(changesB());
    });
    await act(async () => {
      first.reject(new Error('Old status read failed'));
    });
    expect(hook.result.current.isTracked).toBe(true);
    expect([...hook.result.current.statusMap]).toEqual([...changesB()]);
  });

  it('does not start Git status after the repository probe is retired by unmount', async () => {
    const probe = deferred<boolean>();
    io.isGitRepo.mockReturnValue(probe.promise);
    const hook = renderHook(() => useGitStatus('/a'));
    await waitFor(() => expect(io.isGitRepo).toHaveBeenCalledTimes(1));
    hook.unmount();
    await act(async () => {
      probe.resolve(true);
    });
    expect(io.gitStatus).not.toHaveBeenCalled();
  });
});
