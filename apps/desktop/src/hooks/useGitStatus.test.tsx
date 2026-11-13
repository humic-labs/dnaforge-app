/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { notifyGitStatusChanged, useGitStatus } from './useGitStatus';
import type { GitFileStatus } from '../features/workspace/git';

const gitMocks = vi.hoisted(() => ({
  isGitRepo: vi.fn(),
  gitStatus: vi.fn(),
}));

vi.mock('../features/workspace/git', () => ({
  isGitRepo: gitMocks.isGitRepo,
  gitStatus: gitMocks.gitStatus,
}));

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useGitStatus', () => {
  it('refreshes subscribers when a folder becomes git-tracked', async () => {
    const folderPath = '/Users/lab/new-workspace';
    gitMocks.isGitRepo.mockResolvedValueOnce(false);

    const { result } = renderHook(() => useGitStatus(folderPath));

    await waitFor(() => {
      expect(gitMocks.isGitRepo).toHaveBeenCalledTimes(1);
    });
    expect(result.current.isTracked).toBe(false);
    expect(result.current.statusMap.size).toBe(0);

    gitMocks.isGitRepo.mockResolvedValue(true);
    gitMocks.gitStatus.mockResolvedValue(
      new Map<string, GitFileStatus>([['new-sequence.gb', 'untracked']])
    );

    notifyGitStatusChanged(folderPath);

    await waitFor(() => {
      expect(result.current.isTracked).toBe(true);
      expect(result.current.statusMap.get('new-sequence.gb')).toBe('untracked');
    });
  });

  it('clears stale statuses when a folder stops being git-tracked', async () => {
    const folderPath = '/Users/lab/tracked-workspace';
    gitMocks.isGitRepo.mockResolvedValue(true);
    gitMocks.gitStatus.mockResolvedValue(
      new Map<string, GitFileStatus>([['tracked.gb', 'modified']])
    );

    const { result } = renderHook(() => useGitStatus(folderPath));

    await waitFor(() => {
      expect(result.current.statusMap.get('tracked.gb')).toBe('modified');
    });

    gitMocks.isGitRepo.mockResolvedValue(false);
    notifyGitStatusChanged(folderPath);

    await waitFor(() => {
      expect(result.current.isTracked).toBe(false);
      expect(result.current.statusMap.size).toBe(0);
    });
  });
});
