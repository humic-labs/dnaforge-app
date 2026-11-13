// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useGitHistory } from './useGitHistory';
const ports = vi.hoisted(() => ({
  gitRepoRoot: vi.fn(),
  gitFileLog: vi.fn(),
  gitShowCommit: vi.fn(),
  gitCommitFile: vi.fn(),
  gitRevertFile: vi.fn(),
}));
vi.mock('../../workspace/public/git', () => ports);
vi.mock('@waypoint/sequence-utils', () => ({ parseGenBankFull: () => ({ sequence: 'AAAA' }) }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const entry = { hash: 'old', message: 'initial', date: '', relativeDate: '' };
describe('Git history request ownership', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    ports.gitRepoRoot.mockResolvedValue('/repo');
    ports.gitFileLog.mockResolvedValue([entry]);
  });
  it.each(['clear', 'toggle', 'file change', 'null'] as const)(
    'retires a pending comparison on %s',
    async (action) => {
      const read = deferred<string>();
      ports.gitShowCommit.mockReturnValue(read.promise);
      const { result, rerender } = renderHook(
        ({ filePath }) => useGitHistory({ filePath, readOnly: true }),
        { initialProps: { filePath: '/repo/a.gb' as string | null } }
      );
      await waitFor(() => expect(result.current.log).toHaveLength(1));
      let pending!: unknown;
      act(() => {
        pending = result.current.selectCommit('old');
      });
      if (action === 'clear') act(() => result.current.clearSelection());
      if (action === 'toggle')
        act(() => {
          void result.current.selectCommit('old');
        });
      if (action === 'file change') rerender({ filePath: '/repo/b.gb' });
      if (action === 'null') rerender({ filePath: null });
      await act(async () => {
        read.resolve('old content');
        await pending;
      });
      expect(result.current.selectedCommitHash).toBeNull();
      expect(result.current.selectedCommitSequence).toBeNull();
    }
  );
  it('does not replace the new file log with an older file completion', async () => {
    const oldLog = deferred<(typeof entry)[]>();
    ports.gitFileLog
      .mockReturnValueOnce(oldLog.promise)
      .mockResolvedValueOnce([{ ...entry, hash: 'new' }]);
    const { result, rerender } = renderHook(
      ({ filePath }) => useGitHistory({ filePath, readOnly: true }),
      { initialProps: { filePath: '/repo/a.gb' } }
    );
    await waitFor(() => expect(ports.gitFileLog).toHaveBeenCalledTimes(1));
    rerender({ filePath: '/repo/b.gb' });
    await waitFor(() => expect(result.current.log[0]?.hash).toBe('new'));
    await act(async () => {
      oldLog.resolve([entry]);
    });
    expect(result.current.log[0]?.hash).toBe('new');
  });
});
