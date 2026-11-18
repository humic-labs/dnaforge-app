/** @vitest-environment jsdom */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { contentFingerprint } from '../../../db/entity-substrate/adapter';
import { FileWatchConsumers } from '../../../main/ipc/file-watch-consumers';
import {
  __resetReferenceGenerationForTests,
  bumpReferenceGeneration,
} from '../entity-ref/reference-generation';
import { useNotebookFileWatcher } from './useNotebookFileWatcher';
import { sanitizeClosedBetaProperties } from '../../../shared/analytics-allowlist';

let markdown = 'original markdown';
let listeners: Array<(...args: unknown[]) => void> = [];
const notebookContent = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});
const resolvedNotebook = (text: string, authority: string) => ({
  entity: { id: 'page-1' },
  artifact: {
    title: 'Notebook',
    content: notebookContent(text),
  },
  authorityFingerprint: contentFingerprint(authority),
});
const {
  getCurrentCatalogFileForEntity,
  upsertPageFromArtifact,
  setDirty,
  resolveArtifactFile,
  withWorkspaceArtifactOpen,
  trackRendererEvent,
  watchFile,
  unwatchFile,
  readTextFile,
  readCanonicalNotebookPackage,
} = vi.hoisted(() => ({
  getCurrentCatalogFileForEntity: vi.fn(),
  upsertPageFromArtifact: vi.fn().mockResolvedValue(undefined),
  setDirty: vi.fn(),
  resolveArtifactFile: vi.fn(),
  withWorkspaceArtifactOpen: vi.fn(),
  trackRendererEvent: vi.fn(),
  watchFile: vi.fn().mockResolvedValue(undefined),
  unwatchFile: vi.fn().mockResolvedValue(undefined),
  readTextFile: vi.fn(),
  readCanonicalNotebookPackage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../platform', () => ({
  platform: () => ({
    fs: {
      watchFile,
      unwatchFile,
      readTextFile,
    },
    on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
      if (channel === 'file-changed') listeners.push(listener);
      return () => {
        listeners = listeners.filter((candidate) => candidate !== listener);
      };
    }),
  }),
}));

vi.mock('../../../db/notebook-package-migration', () => ({ readCanonicalNotebookPackage }));

vi.mock('../../../db/workspace-catalog', () => ({
  getCurrentCatalogFileForEntity,
}));

vi.mock('../../../services/workspace-artifact-open', () => ({ withWorkspaceArtifactOpen }));

vi.mock('../../../lib/analytics', () => ({ trackRendererEvent }));

vi.mock('../store', () => ({
  usePageStore: {
    getState: () => ({ upsertPageFromArtifact, setDirty }),
  },
}));

describe('useNotebookFileWatcher', () => {
  beforeEach(() => {
    __resetReferenceGenerationForTests();
    markdown = 'original markdown';
    listeners = [];
    vi.clearAllMocks();
    readTextFile.mockImplementation(async () => markdown);
    getCurrentCatalogFileForEntity.mockResolvedValue({
      path: '/workspace/Notebook',
      file_kind: 'waypoint-notebook',
    });
    resolveArtifactFile.mockResolvedValue(
      resolvedNotebook('original markdown', 'original markdown')
    );
    withWorkspaceArtifactOpen.mockImplementation(
      async (input: {
        path: string;
        workspaceRoot: string | null;
        consume: (
          resolved: ReturnType<typeof resolvedNotebook>,
          mutationToken?: string
        ) => Promise<unknown>;
      }) => {
        const resolved = await resolveArtifactFile({
          path: input.path,
          workspaceRoot: input.workspaceRoot,
        });
        return input.consume(resolved, 'mutation-token-1');
      }
    );
  });

  it('retries target discovery when workspace reconciliation publishes the binding', async () => {
    getCurrentCatalogFileForEntity.mockResolvedValueOnce(null).mockResolvedValue({
      path: '/workspace/Notebook',
      file_kind: 'waypoint-notebook',
    });
    const onReload = vi.fn();

    renderHook(() =>
      useNotebookFileWatcher({
        pageId: 'page-1',
        workspaceRoot: '/workspace',
        isDirty: false,
        onReload,
      })
    );
    await waitFor(() => expect(getCurrentCatalogFileForEntity).toHaveBeenCalledOnce());
    expect(onReload).not.toHaveBeenCalled();

    act(() => bumpReferenceGeneration());

    await waitFor(() => expect(getCurrentCatalogFileForEntity).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(onReload).toHaveBeenCalledOnce());
  });

  it('keeps the observed external revision when the catalog republishes the same notebook', async () => {
    const onKeepLocal = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useNotebookFileWatcher({
        pageId: 'page-1',
        workspaceRoot: '/workspace',
        isDirty: true,
        onKeepLocal,
      })
    );
    await waitFor(() =>
      expect(result.current.expectedCanonicalFingerprint()).toBe(contentFingerprint(markdown))
    );
    markdown = 'external edit';
    act(() => listeners.forEach((listener) => listener('/workspace/Notebook/Notebook.md')));
    await waitFor(() => expect(result.current.state).toBe('conflict'));
    await act(async () => bumpReferenceGeneration());
    await waitFor(() => expect(getCurrentCatalogFileForEntity).toHaveBeenCalledTimes(2));
    act(() => result.current.dismissExternalChange());
    await waitFor(() => expect(result.current.state).toBe('current'));
    expect(onKeepLocal).toHaveBeenCalledWith(contentFingerprint(markdown));
    expect(watchFile).toHaveBeenCalledOnce();
  });

  it('keeps watching the flat legacy authority until package cutover completes', async () => {
    getCurrentCatalogFileForEntity.mockResolvedValue({
      path: '/workspace/Legacy.wpnote.json',
      file_kind: 'waypoint-notebook',
    });

    renderHook(() =>
      useNotebookFileWatcher({
        pageId: 'page-1',
        workspaceRoot: '/workspace',
        isDirty: false,
      })
    );

    await waitFor(() => expect(watchFile).toHaveBeenCalledWith('/workspace/Legacy.wpnote.json'));
    expect(resolveArtifactFile).toHaveBeenCalledWith({
      path: '/workspace/Legacy.wpnote.json',
      workspaceRoot: '/workspace',
    });
  });

  it('reloads a clean notebook from canonical Markdown', async () => {
    const onReload = vi.fn();
    renderHook(() =>
      useNotebookFileWatcher({
        pageId: 'page-1',
        workspaceRoot: '/workspace',
        isDirty: false,
        onReload,
      })
    );
    await waitFor(() => expect(onReload).toHaveBeenCalledOnce());
    upsertPageFromArtifact.mockClear();
    onReload.mockClear();

    markdown = 'external markdown';
    resolveArtifactFile.mockResolvedValue(
      resolvedNotebook('external markdown', 'external markdown')
    );
    act(() => listeners.forEach((listener) => listener('/workspace/Notebook/Notebook.md')));

    await waitFor(() => expect(upsertPageFromArtifact).toHaveBeenCalledOnce());
    expect(upsertPageFromArtifact).toHaveBeenCalledWith({
      id: 'page-1',
      title: 'Notebook',
      content: notebookContent('external markdown'),
      workspaceRoot: '/workspace',
      authorityFingerprint: contentFingerprint('external markdown'),
      mutationToken: 'mutation-token-1',
    });
    expect(onReload).toHaveBeenCalledWith({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'external markdown' }],
        },
      ],
    });
  });

  it('keeps a restored competing application version visible until Reload is explicitly chosen', async () => {
    withWorkspaceArtifactOpen.mockRejectedValueOnce(
      Object.assign(new Error('Saved and app revisions differ'), {
        name: 'NotebookExternalConflictError',
        code: 'NOTEBOOK_EXTERNAL_CONFLICT',
      })
    );
    const onReload = vi.fn();
    const { result } = renderHook(() =>
      useNotebookFileWatcher({
        pageId: 'page-1',
        workspaceRoot: '/workspace',
        isDirty: false,
        onReload,
      })
    );
    await waitFor(() => expect(result.current.showExternalChangeToast).toBe(true));
    expect(result.current.showExternalReloadError).toBe(false);
    expect(upsertPageFromArtifact).not.toHaveBeenCalled();
    expect(onReload).not.toHaveBeenCalled();

    act(() => result.current.acceptExternalChange());
    await waitFor(() => expect(onReload).toHaveBeenCalledOnce());
    expect(withWorkspaceArtifactOpen).toHaveBeenLastCalledWith(
      expect.objectContaining({
        notebookConflictResolution: 'use-file',
      })
    );
    expect(result.current.showExternalChangeToast).toBe(false);
  });

  it.each(['read', 'projection'] as const)(
    'preserves an edit made while initial notebook %s is pending',
    async (boundary) => {
      let release: (() => void) | undefined;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      if (boundary === 'read') {
        resolveArtifactFile.mockImplementationOnce(async () => {
          await pending;
          return resolvedNotebook('original markdown', 'original markdown');
        });
      } else {
        upsertPageFromArtifact.mockImplementationOnce(() => pending);
      }
      const onReload = vi.fn();
      const { rerender } = renderHook(
        ({ isDirty }) =>
          useNotebookFileWatcher({
            pageId: 'page-1',
            workspaceRoot: '/workspace',
            isDirty,
            onReload,
          }),
        { initialProps: { isDirty: false } }
      );
      await waitFor(() =>
        expect(
          boundary === 'read' ? resolveArtifactFile : upsertPageFromArtifact
        ).toHaveBeenCalledOnce()
      );
      rerender({ isDirty: true });
      await act(async () => {
        release?.();
        await pending;
      });

      expect(onReload).not.toHaveBeenCalled();
      expect(setDirty).not.toHaveBeenCalledWith('page-1', false);
      if (boundary === 'read') expect(upsertPageFromArtifact).not.toHaveBeenCalled();
    }
  );

  it('does not baseline a newer rename against content parsed from older bytes', async () => {
    let finishInitialRead: ((value: ReturnType<typeof resolvedNotebook>) => void) | undefined;
    resolveArtifactFile
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishInitialRead = resolve;
          })
      )
      .mockResolvedValue(resolvedNotebook('external markdown', 'external markdown'));
    const onReload = vi.fn();

    renderHook(() =>
      useNotebookFileWatcher({
        pageId: 'page-1',
        workspaceRoot: '/workspace',
        isDirty: false,
        onReload,
      })
    );
    await waitFor(() => expect(resolveArtifactFile).toHaveBeenCalledOnce());

    markdown = 'external markdown';
    finishInitialRead?.(resolvedNotebook('original markdown', 'original markdown'));
    await waitFor(() => expect(onReload).toHaveBeenCalledOnce());
    act(() => listeners.forEach((listener) => listener('/workspace/Notebook/Notebook.md')));

    await waitFor(() => expect(resolveArtifactFile).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(onReload).toHaveBeenLastCalledWith(notebookContent('external markdown'))
    );
  });

  it('blocks a dirty editor until the user explicitly keeps or reloads', async () => {
    const { result, rerender } = renderHook(
      ({ isDirty }: { isDirty: boolean }) =>
        useNotebookFileWatcher({
          pageId: 'page-1',
          workspaceRoot: '/workspace',
          isDirty,
        }),
      { initialProps: { isDirty: false } }
    );
    await waitFor(() => expect(resolveArtifactFile).toHaveBeenCalled());
    rerender({ isDirty: true });
    upsertPageFromArtifact.mockClear();

    markdown = 'external markdown';
    act(() => listeners.forEach((listener) => listener('/workspace/Notebook/Notebook.md')));
    await waitFor(() => expect(result.current.showExternalChangeToast).toBe(true));
    expect(upsertPageFromArtifact).not.toHaveBeenCalled();

    act(() => result.current.dismissExternalChange());
    expect(result.current.showExternalChangeToast).toBe(false);
    expect(result.current.expectedCanonicalFingerprint()).toBe(
      contentFingerprint('external markdown')
    );
  });

  it.each([true, false])('waits for native keep acknowledgement, accepted=%s', async (accepted) => {
    const pending = Promise.withResolvers<void>();
    const onKeepLocal = vi.fn(() => pending.promise);
    const { result, rerender } = renderHook(
      ({ isDirty }: { isDirty: boolean }) =>
        useNotebookFileWatcher({
          pageId: 'page-1',
          workspaceRoot: '/workspace',
          isDirty,
          onKeepLocal,
        }),
      { initialProps: { isDirty: false } }
    );
    await waitFor(() => expect(resolveArtifactFile).toHaveBeenCalled());
    rerender({ isDirty: true });
    markdown = 'external markdown';
    act(() => listeners.forEach((listener) => listener('/workspace/Notebook/Notebook.md')));
    await waitFor(() => expect(result.current.showExternalChangeToast).toBe(true));
    act(() => result.current.dismissExternalChange());
    expect(onKeepLocal).toHaveBeenCalledWith(contentFingerprint(markdown));
    expect(result.current.showExternalChangeToast).toBe(true);
    expect(result.current.expectedCanonicalFingerprint()).toBe(
      contentFingerprint('original markdown')
    );
    await act(async () => {
      if (accepted) pending.resolve();
      else pending.reject(new Error('The observed external source changed.'));
    });
    await waitFor(() => expect(result.current.showExternalChangeToast).toBe(!accepted));
    expect(result.current.expectedCanonicalFingerprint()).toBe(
      contentFingerprint(accepted ? 'external markdown' : 'original markdown')
    );
  });

  it.each([false, true])(
    'records keep-local recovery only after native persistence without resolving a newer failure: %s',
    async (newerFailure) => {
      const pending = Promise.withResolvers<void>();
      const onKeepLocal = vi.fn(() => pending.promise);
      const { result, rerender } = renderHook(
        ({ isDirty }: { isDirty: boolean }) =>
          useNotebookFileWatcher({
            pageId: 'page-1',
            workspaceRoot: '/workspace',
            isDirty,
            onKeepLocal,
          }),
        { initialProps: { isDirty: false } }
      );
      await waitFor(() => expect(resolveArtifactFile).toHaveBeenCalled());
      markdown = 'unreadable external revision';
      resolveArtifactFile.mockRejectedValueOnce(new Error('unreadable source'));
      act(() => listeners.forEach((listener) => listener('/workspace/Notebook/Notebook.md')));
      await waitFor(() => expect(result.current.showExternalReloadError).toBe(true));
      const failures = () =>
        trackRendererEvent.mock.calls.filter(
          ([event, properties]) =>
            event === 'notebook_external_reload_result' && properties.outcome === 'failed'
        );
      const recoveries = () =>
        trackRendererEvent.mock.calls.filter(
          ([event, properties]) =>
            event === 'notebook_external_reload_result' && properties.outcome === 'recovered'
        );
      const originalOperation = failures()[0][1].operation_id;
      rerender({ isDirty: true });
      markdown = 'readable external revision';
      act(() => result.current.retryExternalReload());
      await waitFor(() => expect(result.current.state).toBe('conflict'));
      act(() => result.current.dismissExternalChange());
      expect(onKeepLocal).toHaveBeenCalledOnce();
      expect(recoveries()).toHaveLength(0);
      expect(result.current.state).toBe('conflict');
      if (newerFailure) {
        resolveArtifactFile.mockRejectedValueOnce(new Error('newer unreadable source'));
        act(() => result.current.acceptExternalChange());
        await waitFor(() => expect(failures()).toHaveLength(2));
        expect(failures()[1][1].operation_id).not.toBe(originalOperation);
      }
      await act(async () => pending.resolve());
      expect(recoveries()).toHaveLength(newerFailure ? 0 : 1);
      expect(result.current.showExternalReloadError).toBe(newerFailure);
      if (!newerFailure) {
        expect(recoveries()[0][1]).toMatchObject({
          operation_id: originalOperation,
          reload_stage: 'keep-local',
          outcome: 'recovered',
        });
      }
    }
  );

  it('does not report a newer read failure recovered when an earlier reload completes', async () => {
    const onReload = vi.fn();
    const { result } = renderHook(() =>
      useNotebookFileWatcher({
        pageId: 'page-1',
        workspaceRoot: '/workspace',
        isDirty: false,
        onReload,
      })
    );
    await waitFor(() => expect(onReload).toHaveBeenCalledOnce());
    markdown = 'first unreadable revision';
    resolveArtifactFile.mockRejectedValueOnce(new Error('first source failure'));
    act(() => listeners.forEach((listener) => listener('/workspace/Notebook/Notebook.md')));
    await waitFor(() => expect(result.current.showExternalReloadError).toBe(true));
    const pending = Promise.withResolvers<void>();
    resolveArtifactFile.mockImplementationOnce(async () => {
      await pending.promise;
      return resolvedNotebook('older repaired revision', 'older repaired revision');
    });
    act(() => result.current.retryExternalReload());
    await waitFor(() => expect(resolveArtifactFile).toHaveBeenCalledTimes(3));
    readTextFile.mockRejectedValueOnce(new Error('newer source failure'));
    act(() => listeners.forEach((listener) => listener('/workspace/Notebook/Notebook.md')));
    await waitFor(() =>
      expect(
        trackRendererEvent.mock.calls.filter(([, properties]) => properties.outcome === 'failed')
      ).toHaveLength(2)
    );
    await act(async () => pending.resolve());
    expect(result.current.showExternalReloadError).toBe(true);
    expect(onReload).toHaveBeenCalledOnce();
    expect(
      trackRendererEvent.mock.calls.filter(([, properties]) => properties.outcome === 'recovered')
    ).toHaveLength(0);
  });

  it('records the exact committed fingerprint without rereading a newer external revision', async () => {
    const { result } = renderHook(() =>
      useNotebookFileWatcher({
        pageId: 'page-1',
        workspaceRoot: '/workspace',
        isDirty: false,
      })
    );
    await waitFor(() => expect(resolveArtifactFile).toHaveBeenCalled());

    markdown = 'external revision that landed after our publish';
    act(() => result.current.recordOwnSave(contentFingerprint('our committed revision')));

    expect(result.current.expectedCanonicalFingerprint()).toBe(
      contentFingerprint('our committed revision')
    );
  });

  it.each([false, true])(
    'only discards the edits authorized by Reload, with a newer edit: %s',
    async (newerEdit) => {
      const onReload = vi.fn();
      const { result, rerender } = renderHook(
        ({ isDirty }) =>
          useNotebookFileWatcher({
            pageId: 'page-1',
            workspaceRoot: '/workspace',
            isDirty,
            onReload,
          }),
        { initialProps: { isDirty: false } }
      );
      await waitFor(() => expect(onReload).toHaveBeenCalledOnce());
      onReload.mockClear();
      setDirty.mockClear();
      rerender({ isDirty: true });
      markdown = 'external markdown';
      act(() => listeners.forEach((listener) => listener('/workspace/Notebook/Notebook.md')));
      await waitFor(() => expect(result.current.showExternalChangeToast).toBe(true));

      let release: (() => void) | undefined;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      resolveArtifactFile.mockImplementationOnce(async () => {
        await pending;
        return resolvedNotebook('external markdown', 'external markdown');
      });
      act(() => result.current.acceptExternalChange());
      await waitFor(() => expect(resolveArtifactFile).toHaveBeenCalledTimes(2));
      if (newerEdit) act(() => result.current.recordLocalEdit());
      await act(async () => {
        release?.();
        await pending;
      });

      if (newerEdit) {
        expect(onReload).not.toHaveBeenCalled();
        expect(setDirty).not.toHaveBeenCalledWith('page-1', false);
        expect(result.current.showExternalChangeToast).toBe(true);
      } else {
        expect(onReload).toHaveBeenCalledWith(notebookContent('external markdown'));
        expect(setDirty).toHaveBeenCalledWith('page-1', false);
        expect(result.current.showExternalChangeToast).toBe(false);
      }
    }
  );

  it('does not publish a pending reload after its watcher is disposed', async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    resolveArtifactFile.mockImplementationOnce(async () => {
      await pending;
      return resolvedNotebook('original markdown', 'original markdown');
    });
    const onReload = vi.fn();
    const { unmount } = renderHook(() =>
      useNotebookFileWatcher({
        pageId: 'page-1',
        workspaceRoot: '/workspace',
        isDirty: false,
        onReload,
      })
    );
    await waitFor(() => expect(resolveArtifactFile).toHaveBeenCalledOnce());
    unmount();
    await act(async () => {
      release?.();
      await pending;
    });
    expect(upsertPageFromArtifact).not.toHaveBeenCalled();
    expect(onReload).not.toHaveBeenCalled();
    expect(setDirty).not.toHaveBeenCalled();
  });

  it('releases a native file watch registered after the notebook closes', async () => {
    const pending = Promise.withResolvers<void>();
    const consumers = new FileWatchConsumers();
    const senderId = 1;
    const watchedPath = '/workspace/Notebook/Notebook.md';
    watchFile.mockImplementationOnce(async (path: string) => {
      await pending.promise;
      consumers.acquire(path, senderId);
    });
    unwatchFile.mockImplementationOnce(async (path: string) => {
      consumers.release(path, senderId);
    });
    const { unmount } = renderHook(() =>
      useNotebookFileWatcher({
        pageId: 'page-1',
        workspaceRoot: '/workspace',
        isDirty: false,
      })
    );
    await waitFor(() => expect(watchFile).toHaveBeenCalledWith(watchedPath));
    unmount();
    await act(async () => {
      pending.resolve();
      await pending.promise;
    });

    expect(unwatchFile).toHaveBeenCalledExactlyOnceWith(watchedPath);
    expect(consumers.releaseSender(senderId)).toEqual([]);
    expect(readTextFile).not.toHaveBeenCalled();
  });

  it.each(['fulfilled', 'rejected'] as const)(
    'ignores a %s file read from the previous notebook binding',
    async (outcome) => {
      const onReload = vi.fn();
      const { result } = renderHook(() =>
        useNotebookFileWatcher({
          pageId: 'page-1',
          workspaceRoot: '/workspace',
          isDirty: false,
          onReload,
        })
      );
      await waitFor(() => expect(onReload).toHaveBeenCalledOnce());
      readTextFile.mockClear();
      const pending = Promise.withResolvers<string>();
      readTextFile.mockReturnValueOnce(pending.promise);
      act(() => listeners.forEach((listener) => listener('/workspace/Notebook/Notebook.md')));
      expect(readTextFile).toHaveBeenCalledWith('/workspace/Notebook/Notebook.md');

      getCurrentCatalogFileForEntity.mockResolvedValue({
        path: '/workspace/Renamed',
        file_kind: 'waypoint-notebook',
      });
      markdown = 'current notebook markdown';
      resolveArtifactFile.mockResolvedValue(resolvedNotebook(markdown, markdown));
      act(() => bumpReferenceGeneration());
      await waitFor(() =>
        expect(onReload).toHaveBeenLastCalledWith(notebookContent('current notebook markdown'))
      );
      expect(watchFile).toHaveBeenCalledWith('/workspace/Renamed/Renamed.md');
      expect(resolveArtifactFile).toHaveBeenCalledTimes(2);

      await act(async () => {
        if (outcome === 'fulfilled') pending.resolve('retired notebook markdown');
        else pending.reject(new Error('Retired notebook read failed'));
        await pending.promise.catch(() => undefined);
      });

      expect(result.current.state).toBe('current');
      expect(result.current.expectedCanonicalFingerprint()).toBe(
        contentFingerprint('current notebook markdown')
      );
      expect(resolveArtifactFile).toHaveBeenCalledTimes(2);
      expect(onReload).toHaveBeenCalledTimes(2);
      expect(trackRendererEvent).not.toHaveBeenCalled();
    }
  );

  it('validates an external revision before offering to overwrite dirty edits', async () => {
    const onReload = vi.fn();
    const { result, rerender } = renderHook(
      ({ isDirty }: { isDirty: boolean }) =>
        useNotebookFileWatcher({
          pageId: 'page-1',
          workspaceRoot: '/workspace',
          isDirty,
          onReload,
        }),
      { initialProps: { isDirty: false } }
    );
    await waitFor(() => expect(onReload).toHaveBeenCalledOnce());
    onReload.mockClear();
    upsertPageFromArtifact.mockClear();
    rerender({ isDirty: true });
    markdown = 'unsupported external notebook';
    readCanonicalNotebookPackage.mockRejectedValueOnce(new Error('unsupported notebook codec'));
    act(() => listeners.forEach((listener) => listener('/workspace/Notebook/Notebook.md')));
    await waitFor(() => expect(result.current.state).toBe('reload-unavailable'));
    expect(result.current.showExternalChangeToast).toBe(false);
    expect(upsertPageFromArtifact).not.toHaveBeenCalled();
    expect(onReload).not.toHaveBeenCalled();
    expect(result.current.expectedCanonicalFingerprint()).toBe(
      contentFingerprint('original markdown')
    );
  });

  it('requires an explicit choice before replacing dirty edits after an unreadable file is repaired', async () => {
    const onReload = vi.fn();
    const { result, rerender } = renderHook(
      ({ isDirty }: { isDirty: boolean }) =>
        useNotebookFileWatcher({
          pageId: 'page-1',
          workspaceRoot: '/workspace',
          isDirty,
          onReload,
        }),
      { initialProps: { isDirty: false } }
    );
    await waitFor(() => expect(onReload).toHaveBeenCalledOnce());
    onReload.mockClear();
    upsertPageFromArtifact.mockClear();
    rerender({ isDirty: true });
    act(() => result.current.recordLocalEdit());
    markdown = 'unreadable external revision';
    readCanonicalNotebookPackage.mockRejectedValueOnce(new Error('unsupported notebook codec'));
    act(() => listeners.forEach((listener) => listener('/workspace/Notebook/Notebook.md')));
    await waitFor(() => expect(result.current.state).toBe('reload-unavailable'));

    markdown = 'original markdown';
    act(() => result.current.retryExternalReload());

    await waitFor(() => expect(result.current.state).toBe('conflict'));
    expect(onReload).not.toHaveBeenCalled();
    expect(upsertPageFromArtifact).not.toHaveBeenCalled();
    expect(result.current.expectedCanonicalFingerprint()).toBe(
      contentFingerprint('original markdown')
    );

    act(() => result.current.acceptExternalChange());
    await waitFor(() => expect(onReload).toHaveBeenCalledOnce());
    expect(result.current.state).toBe('current');
  });

  it('retains unreadable-file recovery when a delayed save conflict arrives', async () => {
    const onReload = vi.fn();
    const { result } = renderHook(() =>
      useNotebookFileWatcher({
        pageId: 'page-1',
        workspaceRoot: '/workspace',
        isDirty: false,
        onReload,
      })
    );
    await waitFor(() => expect(onReload).toHaveBeenCalledOnce());
    onReload.mockClear();
    markdown = 'unreadable external revision';
    resolveArtifactFile.mockRejectedValueOnce(new Error('unsupported notebook codec'));
    act(() => listeners.forEach((listener) => listener('/workspace/Notebook/Notebook.md')));
    await waitFor(() => expect(result.current.showExternalReloadError).toBe(true));
    await act(() => result.current.reportSaveConflict());
    expect(result.current.state).toBe('reload-unavailable');
    expect(onReload).not.toHaveBeenCalled();
    resolveArtifactFile.mockResolvedValue(
      resolvedNotebook('repaired revision', 'repaired revision')
    );
    act(() => result.current.retryExternalReload());
    await waitFor(() => expect(result.current.state).toBe('current'));
    expect(onReload).toHaveBeenLastCalledWith(notebookContent('repaired revision'));
  });

  it('keeps the editor intact and exposes a retry when changed Markdown is invalid', async () => {
    const onReload = vi.fn();
    const { result } = renderHook(() =>
      useNotebookFileWatcher({
        pageId: 'page-1',
        workspaceRoot: '/workspace',
        isDirty: false,
        onReload,
      })
    );
    await waitFor(() => expect(onReload).toHaveBeenCalledOnce());
    onReload.mockClear();
    upsertPageFromArtifact.mockClear();

    markdown = 'invalid external markdown';
    resolveArtifactFile.mockRejectedValueOnce(new Error('invalid notebook marker'));
    act(() => listeners.forEach((listener) => listener('/workspace/Notebook/Notebook.md')));

    await waitFor(() => expect(result.current.showExternalReloadError).toBe(true));
    expect(onReload).not.toHaveBeenCalled();
    expect(upsertPageFromArtifact).not.toHaveBeenCalled();
    expect(trackRendererEvent).toHaveBeenCalledWith('notebook_external_reload_result', {
      feature_area: 'reliability',
      workflow_status: 'failed',
      version: 2,
      outcome: 'failed',
      success: false,
      error_class: 'unknown',
      reload_reason: 'unknown',
      reload_stage: 'external-change',
      operation_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });

    resolveArtifactFile.mockResolvedValue(
      resolvedNotebook('repaired external markdown', 'repaired external markdown')
    );
    act(() => result.current.retryExternalReload());

    await waitFor(() => expect(result.current.showExternalReloadError).toBe(false));
    expect(onReload).toHaveBeenLastCalledWith(notebookContent('repaired external markdown'));
    expect(trackRendererEvent).toHaveBeenCalledWith('notebook_external_reload_result', {
      feature_area: 'reliability',
      workflow_status: 'completed',
      version: 2,
      outcome: 'recovered',
      success: true,
      error_class: 'none',
      reload_reason: 'none',
      reload_stage: 'reload',
      operation_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    const reloadResults = trackRendererEvent.mock.calls
      .filter(([event]) => event === 'notebook_external_reload_result')
      .map(([, properties]) => properties);
    expect(reloadResults).toHaveLength(2);
    expect(reloadResults[0].operation_id).toBe(reloadResults[1].operation_id);
    for (const properties of reloadResults) {
      expect(sanitizeClosedBetaProperties(properties)).toEqual(properties);
    }

    trackRendererEvent.mockClear();
    markdown = 'ordinary external edit after recovery';
    resolveArtifactFile.mockResolvedValue(resolvedNotebook(markdown, markdown));
    act(() => listeners.forEach((listener) => listener('/workspace/Notebook/Notebook.md')));
    await waitFor(() => expect(onReload).toHaveBeenLastCalledWith(notebookContent(markdown)));
    expect(trackRendererEvent).not.toHaveBeenCalled();
  });
});
