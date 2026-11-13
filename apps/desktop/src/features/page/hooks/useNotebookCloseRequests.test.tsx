// @vitest-environment jsdom
import { useCallback, useRef } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import type { SaveDocumentTarget } from '../../../shared/save-document-events';
import { documentLifecycle } from '../../../shared/document-lifecycle';
type SaveResult = SaveDocumentTarget & { requestId: string; success: boolean };
import { useEditorAutosave } from './useEditorAutosave';
import { useNotebookCloseRequests } from './useNotebookCloseRequests';

const initial: JSONContent = { type: 'doc', content: [{ type: 'text', text: 'original' }] };
const newer: JSONContent = { type: 'doc', content: [{ type: 'text', text: 'newer' }] };
let completions: SaveResult[];

beforeEach(() => {
  vi.useFakeTimers();
  completions = [];
});
afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});

function setup(
  options: {
    onSave?: (content: JSONContent, pageId: string) => Promise<void>;
    onSaved?: (pageId: string) => void;
  } = {}
) {
  const onSave = options.onSave ?? vi.fn(async () => {});
  const onSaved = options.onSaved ?? vi.fn();
  const discarded = vi.fn();
  const owner = { isDestroyed: false };
  const view = renderHook(
    ({ pageId, source }) => {
      const contentRef = useRef<JSONContent | null>(initial);
      const api = useEditorAutosave({ pageId, contentRef, onSave, onSaved });
      const discard = useCallback(() => {
        api.discardPendingChanges();
        discarded();
      }, [api.discardPendingChanges]);
      useNotebookCloseRequests({
        pageId,
        owner: source,
        contentRef,
        saveNow: api.saveNow,
        onDiscard: discard,
      });
      return { api, contentRef };
    },
    { initialProps: { pageId: 'synthetic-page', source: owner } }
  );
  return { ...view, onSave, onSaved, discarded, owner };
}

function request(
  target: SaveDocumentTarget = { kind: 'page', pageId: 'synthetic-page' },
  requestId = 'notebook-save-request'
) {
  void documentLifecycle
    .save(target)
    .then((success) => completions.push({ ...target, requestId, success }));
}

function discard() {
  void documentLifecycle.discard({ kind: 'page', pageId: 'synthetic-page' });
}

describe('notebook close requests through the existing autosave owner', () => {
  it('settles concurrent close callers from the same captured save', async () => {
    const pending = Promise.withResolvers<void>();
    const view = setup({ onSave: () => pending.promise });
    const send = (requestId: string) =>
      request({ kind: 'page', pageId: 'synthetic-page' }, requestId);
    act(() => {
      view.result.current.api.markDirty();
      send('close-a');
    });
    await act(async () => {
      send('close-b');
    });
    expect(completions).toEqual([]);
    await act(async () => {
      pending.resolve();
    });
    expect([...completions].sort((a, b) => a.requestId!.localeCompare(b.requestId!))).toEqual([
      { kind: 'page', pageId: 'synthetic-page', requestId: 'close-a', success: true },
      { kind: 'page', pageId: 'synthetic-page', requestId: 'close-b', success: true },
    ]);
  });

  it('keeps dirty state when a destroyed owner receives a matching Discard before cleanup', () => {
    const view = setup();
    act(() => view.result.current.api.markDirty());
    expect(view.result.current.api.saveStatus).toBe('dirty');
    view.owner.isDestroyed = true;
    act(() => discard());
    expect(view.discarded).not.toHaveBeenCalled();
    expect(view.result.current.api.saveStatus).toBe('dirty');
    expect(view.result.current.contentRef.current).toBe(initial);
    expect(completions).toEqual([]);
  });

  it('does not begin a save after its editor owner has been destroyed', async () => {
    const view = setup();
    view.owner.isDestroyed = true;
    await act(async () => {
      request();
    });
    expect(view.onSave).not.toHaveBeenCalled();
    expect(completions.map((result) => result.success)).toEqual([false]);
  });

  it('retires a deferred Save after Discard even when the current content object is unchanged', async () => {
    const pending = Promise.withResolvers<void>();
    const view = setup({ onSave: () => pending.promise });
    act(() => {
      view.result.current.api.markDirty();
      request();
    });
    expect(view.result.current.contentRef.current).toBe(initial);
    act(() => discard());
    expect(view.result.current.contentRef.current).toBe(initial);
    expect(view.discarded).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve();
    });
    expect(completions.map((result) => result.success)).toEqual([false]);
    expect(view.onSaved).not.toHaveBeenCalled();
    expect(view.result.current.api.saveStatus).toBe('clean');
  });

  it('retires the request when Discard follows accepted publication before the close acknowledgement', async () => {
    const pending = Promise.withResolvers<void>();
    const view = setup({ onSave: () => pending.promise, onSaved: () => discard() });
    act(() => {
      view.result.current.api.markDirty();
      request();
    });
    await act(async () => {
      pending.resolve();
    });
    expect(view.result.current.contentRef.current).toBe(initial);
    expect(view.discarded).toHaveBeenCalledTimes(1);
    expect(completions.map((result) => result.success)).toEqual([false]);
    expect(view.result.current.api.saveStatus).toBe('clean');
  });

  it.each(['current owner', 'unmounted owner', 'replacement owner'] as const)(
    'keeps shared Save results bound to the %s',
    async (state) => {
      const pending = Promise.withResolvers<void>();
      const onSave = vi.fn(() => pending.promise);
      const view = setup({ onSave });
      act(() => {
        view.result.current.api.markDirty();
        request();
      });
      await act(async () => {
        request();
      });
      expect(completions).toEqual([]);
      expect(view.result.current.contentRef.current).toBe(initial);
      if (state === 'unmounted owner') view.unmount();
      else if (state === 'replacement owner')
        view.rerender({ pageId: 'synthetic-page', source: { isDestroyed: false } });
      await act(async () => {
        pending.resolve();
      });
      expect(completions.map((result) => result.success).sort()).toEqual(
        state === 'current owner' ? [true, true] : [false, false]
      );
      expect(onSave).toHaveBeenCalledTimes(1);
      if (state === 'current owner') {
        await act(async () => {
          request();
        });
        expect(completions.map((result) => result.success).sort()).toEqual([true, true, true]);
        expect(onSave).toHaveBeenCalledTimes(2);
      }
    }
  );

  it('waits for the actual owner callback and then returns one page-scoped result', async () => {
    const pending = Promise.withResolvers<void>();
    const onSave = vi.fn(() => pending.promise);
    const view = setup({ onSave });
    act(() => {
      view.result.current.api.markDirty();
      request();
    });
    expect(onSave).toHaveBeenCalledExactlyOnceWith(initial, 'synthetic-page');
    expect(completions).toEqual([]);
    await act(async () => {
      pending.resolve();
    });
    expect(completions).toEqual([
      { requestId: 'notebook-save-request', kind: 'page', pageId: 'synthetic-page', success: true },
    ]);
    expect(view.result.current.api.saveStatus).toBe('clean');
    expect(view.onSaved).toHaveBeenCalledExactlyOnceWith('synthetic-page');
  });

  it('reports failure while preserving edits, then accepts a deliberate retry', async () => {
    const onSave = vi
      .fn()
      .mockRejectedValueOnce(new Error('controlled refusal'))
      .mockResolvedValue(undefined);
    const view = setup({ onSave });
    await act(async () => {
      view.result.current.api.markDirty();
      request();
    });
    expect(completions).toEqual([
      {
        requestId: 'notebook-save-request',
        kind: 'page',
        pageId: 'synthetic-page',
        success: false,
      },
    ]);
    expect(view.result.current.api.saveStatus).toBe('dirty');
    expect(view.result.current.contentRef.current).toBe(initial);
    expect(view.onSaved).not.toHaveBeenCalled();
    await act(async () => {
      request();
    });
    expect(completions.map((result) => result.success)).toEqual([false, true]);
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(view.onSaved).toHaveBeenCalledExactlyOnceWith('synthetic-page');
  });

  it('waits for a busy autosave before accepting close without a concurrent write', async () => {
    const pending = Promise.withResolvers<void>();
    const onSave = vi.fn(() => pending.promise);
    const view = setup({ onSave });
    act(() => {
      view.result.current.api.markDirty();
      void view.result.current.api.saveNow();
    });
    await act(async () => {
      request();
    });
    expect(completions).toEqual([]);
    expect(onSave).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve();
    });
    expect(completions).toEqual([
      { kind: 'page', pageId: 'synthetic-page', requestId: 'notebook-save-request', success: true },
    ]);
    expect(view.onSaved).toHaveBeenCalledExactlyOnceWith('synthetic-page');
    expect(onSave).toHaveBeenCalledTimes(1);
    await act(async () => {
      request();
    });
    expect(completions.map((result) => result.success)).toEqual([true, true]);
    expect(onSave).toHaveBeenCalledTimes(2);
  });

  it('keeps a newer edit unsaved when an older requested snapshot fulfills', async () => {
    const pending = Promise.withResolvers<void>();
    const onSave = vi.fn(() => pending.promise);
    const view = setup({ onSave });
    act(() => {
      view.result.current.api.markDirty();
      request();
    });
    act(() => {
      view.result.current.contentRef.current = newer;
      view.result.current.api.markDirty();
    });
    await act(async () => {
      pending.resolve();
    });
    expect(completions.map((result) => result.success)).toEqual([false]);
    expect(view.onSaved).not.toHaveBeenCalled();
    expect(view.result.current.api.saveStatus).toBe('dirty');
    await act(async () => {
      request();
    });
    expect(onSave).toHaveBeenLastCalledWith(newer, 'synthetic-page');
    expect(completions.map((result) => result.success)).toEqual([false, true]);
  });

  it.each(['unmount', 'replace owner', 'destroy owner'] as const)(
    'refuses a stale save result after %s',
    async (change) => {
      const pending = Promise.withResolvers<void>();
      const view = setup({ onSave: () => pending.promise });
      act(() => {
        view.result.current.api.markDirty();
        request();
      });
      if (change === 'unmount') view.unmount();
      else if (change === 'replace owner')
        view.rerender({ pageId: 'synthetic-page', source: { isDestroyed: false } });
      else view.owner.isDestroyed = true;
      await act(async () => {
        pending.resolve();
      });
      expect(completions.map((result) => result.success)).toEqual([false]);
    }
  );

  it('checks the current snapshot again after the save callback publishes success', async () => {
    let replace = () => {};
    const view = setup({ onSaved: () => replace() });
    replace = () => {
      view.result.current.contentRef.current = newer;
    };
    await act(async () => {
      view.result.current.api.markDirty();
      request();
    });
    expect(completions.map((result) => result.success)).toEqual([false]);
    expect(view.result.current.contentRef.current).toBe(newer);
  });

  it('ignores a different target kind or page and cancels pending autosave on the matching discard', async () => {
    const view = setup();
    act(() => {
      view.result.current.api.markDirty();
      request({ kind: 'file', filePath: 'synthetic-page' });
      request({ kind: 'page', pageId: 'different-page' });
      void documentLifecycle.discard({ kind: 'file', filePath: 'synthetic-page' });
    });
    expect(view.onSave).not.toHaveBeenCalled();
    expect(view.discarded).not.toHaveBeenCalled();
    expect(completions).toEqual([]);
    act(() => discard());
    expect(view.discarded).toHaveBeenCalledTimes(1);
    view.unmount();
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(view.onSave).not.toHaveBeenCalled();
  });
});
