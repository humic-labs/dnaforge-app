// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useFileWatcher } from './useFileWatcher';
import { useSequenceStore } from '../store';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import {
  beginWorkspaceSyncRendererGeneration,
  finishWorkspaceSyncRendererGeneration,
  resetWorkspaceSyncRendererGenerationsForTest,
} from '../../../services/workspace-sync-renderer-generation';

let fileChangedListeners: Array<(...args: unknown[]) => void> = [];
const h = vi.hoisted(() => ({
  readTextFile: vi.fn().mockResolvedValue('LOCUS test\nORIGIN\n        1 atcg\n//'),
}));

vi.mock('../../../platform', () => ({
  platform: () => ({
    fs: {
      watchFile: vi.fn().mockResolvedValue(undefined),
      unwatchFile: vi.fn().mockResolvedValue(undefined),
      readTextFile: h.readTextFile,
    },
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'file-changed') {
        fileChangedListeners.push(listener);
      }
      return () => {
        fileChangedListeners = fileChangedListeners.filter((l) => l !== listener);
      };
    }),
  }),
}));

vi.mock('../../../shared/parse-sequence-file', () => ({
  isBinarySequencePath: vi.fn(() => false),
  parseTextSequenceFileAsAnnotated: vi.fn().mockReturnValue({
    format: 'genbank',
    sequence: {
      name: 'test',
      sequence: 'atcg',
      length: 4,
      circular: false,
      annotations: [],
    },
  }),
}));

describe('useFileWatcher', () => {
  beforeEach(() => {
    fileChangedListeners = [];
    useSequenceStore.getState().clearAll();
    useWorkspaceStore.setState({ folders: [{ path: '/test', name: 'test', addedAt: 1 }] });
    h.readTextFile.mockResolvedValue('LOCUS test\nORIGIN\n        1 atcg\n//');
  });

  afterEach(() => {
    resetWorkspaceSyncRendererGenerationsForTest();
    vi.clearAllMocks();
  });

  it('suppressNextChange prevents reload on our own file write', async () => {
    const onReload = vi.fn();
    const { result } = renderHook(() =>
      useFileWatcher({
        filePath: '/test/file.gb',
        documentId: 'sequence-file',
        isDirty: false,
        onReload,
      })
    );

    act(() => {
      result.current.suppressNextChange();
    });

    act(() => {
      for (const listener of fileChangedListeners) {
        listener('/test/file.gb');
      }
    });

    expect(onReload).not.toHaveBeenCalled();
    expect(result.current.showExternalChangeToast).toBe(false);
  });

  it('suppresses EVERY echo of one self-write within the window, then resumes (dual-watcher)', () => {
    vi.useFakeTimers();
    try {
      const onReload = vi.fn();
      const { result, rerender } = renderHook(
        ({ isDirty }: { isDirty: boolean }) =>
          useFileWatcher({
            filePath: '/test/file.gb',
            documentId: 'sequence-file',
            isDirty,
            onReload,
          }),
        { initialProps: { isDirty: false } }
      );

      act(() => {
        result.current.suppressNextChange();
      });

      act(() => {
        for (const listener of fileChangedListeners) listener('/test/file.gb');
      });
      act(() => {
        vi.advanceTimersByTime(700);
        for (const listener of fileChangedListeners) listener('/test/file.gb');
      });
      expect(onReload).not.toHaveBeenCalled();
      expect(result.current.showExternalChangeToast).toBe(false);

      rerender({ isDirty: true });
      act(() => {
        vi.advanceTimersByTime(1300);
      });
      act(() => {
        for (const listener of fileChangedListeners) listener('/test/file.gb');
      });
      expect(result.current.showExternalChangeToast).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows toast for external changes when dirty', () => {
    const onReload = vi.fn();
    const { result } = renderHook(() =>
      useFileWatcher({
        filePath: '/test/file.gb',
        documentId: 'sequence-file',
        isDirty: true,
        onReload,
      })
    );

    act(() => {
      for (const listener of fileChangedListeners) {
        listener('/test/file.gb');
      }
    });

    expect(result.current.showExternalChangeToast).toBe(true);
    expect(onReload).not.toHaveBeenCalled();
  });

  it('ignores changes for different file paths', () => {
    const onReload = vi.fn();
    const { result } = renderHook(() =>
      useFileWatcher({
        filePath: '/test/file.gb',
        documentId: 'sequence-file',
        isDirty: false,
        onReload,
      })
    );

    act(() => {
      for (const listener of fileChangedListeners) {
        listener('/test/other-file.gb');
      }
    });

    expect(onReload).not.toHaveBeenCalled();
    expect(result.current.showExternalChangeToast).toBe(false);
  });

  it('discards a watcher read that crosses a replica install and reloads the new generation', async () => {
    let releaseOldRead!: (content: string) => void;
    h.readTextFile
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            releaseOldRead = resolve;
          })
      )
      .mockResolvedValueOnce('LOCUS remote\nORIGIN\n        1 gggg\n//');
    const onReload = vi.fn();
    renderHook(() =>
      useFileWatcher({
        filePath: '/test/file.gb',
        documentId: 'sequence-file',
        isDirty: false,
        onReload,
      })
    );

    act(() => {
      for (const listener of fileChangedListeners) listener('/test/file.gb');
    });
    await waitFor(() => expect(h.readTextFile).toHaveBeenCalledTimes(1));

    beginWorkspaceSyncRendererGeneration('/test', 'delivery-1');
    releaseOldRead('LOCUS stale\nORIGIN\n        1 aaaa\n//');
    await Promise.resolve();
    expect(onReload).not.toHaveBeenCalled();

    finishWorkspaceSyncRendererGeneration('/test', 'delivery-1');
    await waitFor(() => expect(onReload).toHaveBeenCalledTimes(1));
    expect(h.readTextFile).toHaveBeenCalledTimes(2);
  });

  it('does not report an error when the watched file is gone by the time it reads', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.readTextFile.mockRejectedValueOnce(
      new Error("Error invoking remote method 'fs:readTextFile': Error: ENOENT: no such file")
    );
    const onReload = vi.fn();
    renderHook(() =>
      useFileWatcher({
        filePath: '/test/file.gb',
        documentId: 'sequence-file',
        isDirty: false,
        onReload,
      })
    );

    act(() => {
      for (const listener of fileChangedListeners) listener('/test/file.gb');
    });
    await waitFor(() => expect(h.readTextFile).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(error).not.toHaveBeenCalled());
    expect(onReload).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('still reports a real read failure', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.readTextFile.mockRejectedValueOnce(new Error('EACCES: permission denied'));
    renderHook(() =>
      useFileWatcher({ filePath: '/test/file.gb', documentId: 'sequence-file', isDirty: false })
    );

    act(() => {
      for (const listener of fileChangedListeners) listener('/test/file.gb');
    });
    await waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    error.mockRestore();
  });
});
