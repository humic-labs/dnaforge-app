// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useGitHistory } from './useGitHistory';

vi.mock('../../workspace/git', () => ({
  gitFileLog: vi.fn(),
  gitShowCommit: vi.fn(),
  gitRevertFile: vi.fn(),
  gitCommitFile: vi.fn(),
  gitRepoRoot: vi.fn(),
}));

vi.mock('@waypoint/sequence-utils', () => ({
  parseGenBankFull: vi.fn(),
}));

import {
  gitFileLog,
  gitShowCommit,
  gitRevertFile,
  gitCommitFile,
  gitRepoRoot,
} from '../../workspace/git';
import { parseGenBankFull } from '@waypoint/sequence-utils';

const mockGitFileLog = vi.mocked(gitFileLog);
const mockGitShowCommit = vi.mocked(gitShowCommit);
const mockGitRevertFile = vi.mocked(gitRevertFile);
const mockGitCommitFile = vi.mocked(gitCommitFile);
const mockGitRepoRoot = vi.mocked(gitRepoRoot);
const mockParseGenBankFull = vi.mocked(parseGenBankFull);

const MOCK_LOG_ENTRIES = [
  {
    hash: 'abc123',
    message: 'Add promoter',
    date: '2026-03-20T10:00:00Z',
    relativeDate: '1 hour ago',
  },
  {
    hash: 'def456',
    message: 'Initial commit',
    date: '2026-03-19T08:00:00Z',
    relativeDate: '1 day ago',
  },
];

const MOCK_GENBANK_CONTENT = 'LOCUS test\nORIGIN\n        1 atcgatcg\n//';

const MOCK_ANNOTATED_SEQUENCE = {
  name: 'test',
  sequence: 'atcgatcg',
  length: 8,
  circular: false,
  annotations: [
    { name: 'Promoter', type: 'promoter', start: 1, end: 4, direction: 1 as const, color: '#00f' },
  ],
};

describe('useGitHistory', () => {
  beforeEach(() => {
    mockGitRepoRoot.mockResolvedValue('/repo');
    mockGitFileLog.mockResolvedValue(MOCK_LOG_ENTRIES);
    mockGitShowCommit.mockResolvedValue(MOCK_GENBANK_CONTENT);
    mockParseGenBankFull.mockReturnValue(MOCK_ANNOTATED_SEQUENCE);
    mockGitCommitFile.mockResolvedValue(undefined);
    mockGitRevertFile.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('never creates a baseline, commits, or reverts during a read-only preview', async () => {
    mockGitFileLog.mockResolvedValue([]);
    const { result } = renderHook(() =>
      useGitHistory({ filePath: '/repo/import-source.gb', readOnly: true })
    );
    await waitFor(() => expect(mockGitFileLog).toHaveBeenCalled());
    await act(async () => {
      await result.current.commitFile('Accidental commit');
      await result.current.revertFile();
    });
    expect(mockGitCommitFile).not.toHaveBeenCalled();
    expect(mockGitRevertFile).not.toHaveBeenCalled();
  });

  it('fetches repo root and log on mount when filePath is provided', async () => {
    const { result } = renderHook(() => useGitHistory({ filePath: '/repo/sequence.gb' }));

    await waitFor(() => expect(result.current.log).toHaveLength(2));

    expect(mockGitRepoRoot).toHaveBeenCalledWith('/repo/sequence.gb');
    expect(mockGitFileLog).toHaveBeenCalledWith('/repo/sequence.gb', '/repo');
    expect(result.current.log).toEqual(MOCK_LOG_ENTRIES);
    expect(result.current.isGitRepo).toBe(true);
  });

  it('sets isLoading true during fetch and false after', async () => {
    let resolveLog!: (entries: typeof MOCK_LOG_ENTRIES) => void;
    mockGitFileLog.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLog = resolve;
        })
    );

    const { result } = renderHook(() => useGitHistory({ filePath: '/repo/sequence.gb' }));

    await waitFor(() => expect(result.current.isLoading).toBe(true));

    await act(async () => {
      resolveLog(MOCK_LOG_ENTRIES);
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.log).toEqual(MOCK_LOG_ENTRIES);
  });

  it('does not call any git functions when filePath is null', async () => {
    const { result } = renderHook(() => useGitHistory({ filePath: null }));

    await new Promise((r) => setTimeout(r, 50));

    expect(mockGitRepoRoot).not.toHaveBeenCalled();
    expect(mockGitFileLog).not.toHaveBeenCalled();
    expect(result.current.log).toEqual([]);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.selectedCommitHash).toBeNull();
    expect(result.current.selectedCommitSequence).toBeNull();
  });

  it('does not fetch log when gitRepoRoot returns null, isGitRepo is false', async () => {
    mockGitRepoRoot.mockResolvedValue(null);

    const { result } = renderHook(() => useGitHistory({ filePath: '/not-a-repo/file.gb' }));

    await waitFor(() => expect(mockGitRepoRoot).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));

    expect(mockGitFileLog).not.toHaveBeenCalled();
    expect(result.current.log).toEqual([]);
    expect(result.current.isGitRepo).toBe(false);
  });

  it('sets selectedCommitHash and fetches+parses sequence on selectCommit', async () => {
    const { result } = renderHook(() => useGitHistory({ filePath: '/repo/sequence.gb' }));

    await waitFor(() => expect(result.current.log).toHaveLength(2));

    await act(async () => {
      await result.current.selectCommit('abc123');
    });

    expect(result.current.selectedCommitHash).toBe('abc123');
    expect(mockGitShowCommit).toHaveBeenCalledWith('/repo/sequence.gb', 'abc123', '/repo');
    expect(mockParseGenBankFull).toHaveBeenCalledWith(MOCK_GENBANK_CONTENT);
    expect(result.current.selectedCommitSequence).toEqual(MOCK_ANNOTATED_SEQUENCE);
  });

  it('toggles off when selectCommit is called with the same hash', async () => {
    const { result } = renderHook(() => useGitHistory({ filePath: '/repo/sequence.gb' }));

    await waitFor(() => expect(result.current.log).toHaveLength(2));

    await act(async () => {
      await result.current.selectCommit('abc123');
    });
    expect(result.current.selectedCommitHash).toBe('abc123');

    await act(async () => {
      await result.current.selectCommit('abc123');
    });
    expect(result.current.selectedCommitHash).toBeNull();
    expect(result.current.selectedCommitSequence).toBeNull();
  });

  it('switches selection when selecting a different commit', async () => {
    const { result } = renderHook(() => useGitHistory({ filePath: '/repo/sequence.gb' }));

    await waitFor(() => expect(result.current.log).toHaveLength(2));

    await act(async () => {
      await result.current.selectCommit('abc123');
    });
    expect(result.current.selectedCommitHash).toBe('abc123');

    const differentSequence = { ...MOCK_ANNOTATED_SEQUENCE, name: 'v2' };
    mockParseGenBankFull.mockReturnValue(differentSequence);

    await act(async () => {
      await result.current.selectCommit('def456');
    });
    expect(result.current.selectedCommitHash).toBe('def456');
    expect(mockGitShowCommit).toHaveBeenCalledWith('/repo/sequence.gb', 'def456', '/repo');
    expect(result.current.selectedCommitSequence).toEqual(differentSequence);
  });

  it('clearSelection resets both hash and sequence', async () => {
    const { result } = renderHook(() => useGitHistory({ filePath: '/repo/sequence.gb' }));

    await waitFor(() => expect(result.current.log).toHaveLength(2));

    await act(async () => {
      await result.current.selectCommit('abc123');
    });
    expect(result.current.selectedCommitHash).toBe('abc123');
    expect(result.current.selectedCommitSequence).not.toBeNull();

    act(() => {
      result.current.clearSelection();
    });

    expect(result.current.selectedCommitHash).toBeNull();
    expect(result.current.selectedCommitSequence).toBeNull();
  });

  it('commitFile calls gitCommitFile, refreshes log, and calls onCommit', async () => {
    const onCommit = vi.fn();

    const { result } = renderHook(() => useGitHistory({ filePath: '/repo/sequence.gb', onCommit }));

    await waitFor(() => expect(result.current.log).toHaveLength(2));

    const updatedLog = [
      {
        hash: 'ghi789',
        message: 'New commit',
        date: '2026-03-21T12:00:00Z',
        relativeDate: 'just now',
      },
      ...MOCK_LOG_ENTRIES,
    ];
    mockGitFileLog.mockResolvedValue(updatedLog);

    await act(async () => {
      await result.current.commitFile('feat: add terminator');
    });

    expect(mockGitCommitFile).toHaveBeenCalledWith(
      '/repo/sequence.gb',
      'feat: add terminator',
      '/repo'
    );
    await waitFor(() => expect(result.current.log).toEqual(updatedLog));
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('commitFile does nothing when filePath is null', async () => {
    const onCommit = vi.fn();

    const { result } = renderHook(() => useGitHistory({ filePath: null, onCommit }));

    await new Promise((r) => setTimeout(r, 50));

    await act(async () => {
      await result.current.commitFile('should not run');
    });

    expect(mockGitCommitFile).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('revertFile calls gitRevertFile, calls onRevert, and refreshes log', async () => {
    const onRevert = vi.fn();

    const { result } = renderHook(() => useGitHistory({ filePath: '/repo/sequence.gb', onRevert }));

    await waitFor(() => expect(result.current.log).toHaveLength(2));

    await act(async () => {
      await result.current.revertFile();
    });

    expect(mockGitRevertFile).toHaveBeenCalledWith('/repo/sequence.gb', '/repo');
    expect(onRevert).toHaveBeenCalledTimes(1);
    expect(mockGitFileLog).toHaveBeenCalledTimes(2);
  });

  it('revertFile does nothing when filePath is null', async () => {
    const onRevert = vi.fn();

    const { result } = renderHook(() => useGitHistory({ filePath: null, onRevert }));

    await new Promise((r) => setTimeout(r, 50));

    await act(async () => {
      await result.current.revertFile();
    });

    expect(mockGitRevertFile).not.toHaveBeenCalled();
    expect(onRevert).not.toHaveBeenCalled();
  });

  it('sets selectedCommitSequence to null when gitShowCommit returns null', async () => {
    mockGitShowCommit.mockResolvedValue(null);

    const { result } = renderHook(() => useGitHistory({ filePath: '/repo/sequence.gb' }));

    await waitFor(() => expect(result.current.log).toHaveLength(2));

    await act(async () => {
      await result.current.selectCommit('abc123');
    });

    expect(result.current.selectedCommitHash).toBe('abc123');
    expect(result.current.selectedCommitSequence).toBeNull();
    expect(mockParseGenBankFull).not.toHaveBeenCalled();
  });

  it('sets selectedCommitSequence to null when parseGenBankFull throws', async () => {
    mockParseGenBankFull.mockImplementation(() => {
      throw new Error('Parse error: malformed GenBank');
    });

    const { result } = renderHook(() => useGitHistory({ filePath: '/repo/sequence.gb' }));

    await waitFor(() => expect(result.current.log).toHaveLength(2));

    await act(async () => {
      await result.current.selectCommit('abc123');
    });

    expect(result.current.selectedCommitHash).toBe('abc123');
    expect(result.current.selectedCommitSequence).toBeNull();
  });

  it('refreshLog re-fetches the log', async () => {
    const { result } = renderHook(() => useGitHistory({ filePath: '/repo/sequence.gb' }));

    await waitFor(() => expect(result.current.log).toHaveLength(2));
    expect(mockGitFileLog).toHaveBeenCalledTimes(1);

    const updatedLog = [
      {
        hash: 'new111',
        message: 'Fresh commit',
        date: '2026-03-21T14:00:00Z',
        relativeDate: 'just now',
      },
    ];
    mockGitFileLog.mockResolvedValue(updatedLog);

    await act(async () => {
      result.current.refreshLog();
    });

    await waitFor(() => expect(result.current.log).toEqual(updatedLog));
    expect(mockGitFileLog).toHaveBeenCalledTimes(2);
  });

  it('caches repo root — does not call gitRepoRoot on every operation', async () => {
    const { result } = renderHook(() => useGitHistory({ filePath: '/repo/sequence.gb' }));

    await waitFor(() => expect(result.current.log).toHaveLength(2));

    const rootCallsAfterInit = mockGitRepoRoot.mock.calls.length;

    await act(async () => {
      await result.current.selectCommit('abc123');
    });

    await act(async () => {
      await result.current.commitFile('test commit');
    });

    await act(async () => {
      await result.current.revertFile();
    });

    await act(async () => {
      result.current.refreshLog();
    });

    await waitFor(() => expect(mockGitFileLog).toHaveBeenCalled());

    expect(mockGitRepoRoot.mock.calls.length).toBeLessThanOrEqual(rootCallsAfterInit);
  });

  it('re-fetches log when filePath changes', async () => {
    const { result, rerender } = renderHook(({ filePath }) => useGitHistory({ filePath }), {
      initialProps: { filePath: '/repo/file1.gb' as string | null },
    });

    await waitFor(() => expect(result.current.log).toHaveLength(2));
    expect(mockGitFileLog).toHaveBeenCalledWith('/repo/file1.gb', '/repo');

    const newLog = [
      {
        hash: 'zzz999',
        message: 'Other file history',
        date: '2026-03-18T06:00:00Z',
        relativeDate: '3 days ago',
      },
    ];
    mockGitFileLog.mockResolvedValue(newLog);

    rerender({ filePath: '/repo/file2.gb' });

    await waitFor(() => expect(result.current.log).toEqual(newLog));
    expect(mockGitFileLog).toHaveBeenCalledWith('/repo/file2.gb', '/repo');
  });

  it('works correctly when onCommit and onRevert are not provided', async () => {
    const { result } = renderHook(() => useGitHistory({ filePath: '/repo/sequence.gb' }));

    await waitFor(() => expect(result.current.log).toHaveLength(2));

    await act(async () => {
      await result.current.commitFile('test');
    });
    expect(mockGitCommitFile).toHaveBeenCalled();

    await act(async () => {
      await result.current.revertFile();
    });
    expect(mockGitRevertFile).toHaveBeenCalled();
  });

  it('selectCommit is a no-op if repoRoot has not been resolved', async () => {
    mockGitRepoRoot.mockReturnValue(new Promise(() => {}));
    mockGitFileLog.mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useGitHistory({ filePath: '/repo/sequence.gb' }));

    await new Promise((r) => setTimeout(r, 50));

    await act(async () => {
      await result.current.selectCommit('abc123');
    });

    expect(mockGitShowCommit).not.toHaveBeenCalled();
    expect(result.current.selectedCommitHash).toBeNull();
  });
});
