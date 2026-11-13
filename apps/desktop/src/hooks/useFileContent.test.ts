/** @vitest-environment jsdom */

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  readTextFile: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock('./useMockedFileSystem', () => ({
  getFileSystem: vi.fn(async () => ({
    readTextFile: h.readTextFile,
    readFile: h.readFile,
  })),
}));

vi.mock('./resolveFilePath', () => ({
  resolveFilePathWithFallback: (path: string) => path,
}));

vi.mock('../shared/parse-sequence-file', () => ({
  parseTextSequenceFileAsAnnotated: (content: string) => ({
    format: 'genbank',
    sequence: {
      name: content.includes('remote') ? 'remote' : 'stale',
      sequence: content.includes('remote') ? 'GGGG' : 'AAAA',
      length: 4,
      circular: false,
      annotations: [],
    },
  }),
  parseBinarySequenceFileAsAnnotated: vi.fn(),
}));

import { useWorkspaceStore } from '../stores/workspaceStore';
import {
  beginWorkspaceSyncRendererGeneration,
  finishWorkspaceSyncRendererGeneration,
  resetWorkspaceSyncRendererGenerationsForTest,
} from '../services/workspace-sync-renderer-generation';
import { useFileContent } from './useFileContent';

describe('useFileContent replica generation safety', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ folders: [{ path: '/workspace/a', name: 'a', addedAt: 1 }] });
    h.readTextFile.mockReset();
    h.readFile.mockReset();
  });

  afterEach(() => {
    resetWorkspaceSyncRendererGenerationsForTest();
  });

  it('discards a file-tree read that crosses replica replacement', async () => {
    let releaseOldRead!: (content: string) => void;
    h.readTextFile
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            releaseOldRead = resolve;
          })
      )
      .mockResolvedValueOnce('LOCUS remote\nORIGIN\n        1 gggg\n//');

    const { result } = renderHook(() => useFileContent('/workspace/a/sequence.gb'));
    await waitFor(() => expect(h.readTextFile).toHaveBeenCalledTimes(1));

    act(() => beginWorkspaceSyncRendererGeneration('/workspace/a', 'delivery-1'));
    releaseOldRead('LOCUS stale\nORIGIN\n        1 aaaa\n//');
    await Promise.resolve();
    expect(result.current.sequence).toBeNull();

    act(() => finishWorkspaceSyncRendererGeneration('/workspace/a', 'delivery-1'));
    await waitFor(() => expect(result.current.sequence?.name).toBe('remote'));
    expect(result.current.sequence?.sequence).toBe('GGGG');
    expect(h.readTextFile).toHaveBeenCalledTimes(2);
  });
});
