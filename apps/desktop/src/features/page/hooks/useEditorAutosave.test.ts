// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRef } from 'react';
import { useEditorAutosave } from './useEditorAutosave';
import type { JSONContent } from '@tiptap/core';
import { NativeNotebookWorkingCopyOwner } from '../../../main/notebook-document-owner';
import {
  assertWorkspaceEditorsSettled,
  freezeWorkspaceEditorWrites,
} from '../../../services/workspace-editor-mutation-state';

const { captureSaveFailure } = vi.hoisted(() => ({ captureSaveFailure: vi.fn() }));
vi.mock('../../../lib/analytics', () => ({ trackRendererEvent: captureSaveFailure }));

beforeEach(() => {
  vi.useFakeTimers();
  captureSaveFailure.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

function setupHook(opts: {
  initialContent?: JSONContent | null;
  initialPageId?: string;
  onSave?: (content: JSONContent, pageId: string) => Promise<void | boolean>;
  onDirtyTransition?: (pageId: string) => void;
  onSaved?: (pageId: string) => void;
  debounceMs?: number;
  workspaceRoot?: string;
  nativeOwner?: boolean;
}) {
  const onSave = opts.onSave ?? vi.fn(async () => {});
  const onDirtyTransition = opts.onDirtyTransition ?? vi.fn();
  const onSaved = opts.onSaved ?? vi.fn();
  return renderHook(
    ({ pageId }: { pageId: string }) => {
      const contentRef = useRef<JSONContent | null>(opts.initialContent ?? null);
      const api = useEditorAutosave({
        pageId,
        contentRef,
        onSave,
        onDirtyTransition,
        onSaved,
        debounceMs: opts.debounceMs ?? 1000,
        workspaceRoot: opts.workspaceRoot,
        nativeOwner: opts.nativeOwner,
      });
      return { api, contentRef, onSave, onDirtyTransition, onSaved };
    },
    { initialProps: { pageId: opts.initialPageId ?? 'page-1' } }
  );
}

describe('useEditorAutosave', () => {
  it('retires a failed native autosave retry without discarding content or flushing again on unmount', async () => {
    const failure = new Error('Original publication failure');
    const onSave = vi.fn().mockRejectedValue(failure);
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    const content = { type: 'doc', content: [{ type: 'paragraph' }] };
    const view = setupHook({ initialContent: content, onSave, nativeOwner: true });
    try {
      await act(async () => {
        view.result.current.api.markDirty();
        expect(await view.result.current.api.saveNow()).toBe(false);
      });
      expect(report).toHaveBeenCalledExactlyOnceWith(
        '[useEditorAutosave] save failed:',
        { pageId: 'page-1', operation: 'manual' },
        failure
      );
      await act(async () => {
        await view.result.current.api.retirePendingChanges();
      });
      expect(view.result.current.api.saveStatus).toBe('dirty');
      expect(view.result.current.contentRef.current).toBe(content);
      view.rerender({ pageId: 'page-2' });
      act(() => view.result.current.api.markDirty());
      expect(await view.result.current.api.saveNow()).toBe(false);
      view.unmount();
      await vi.advanceTimersByTimeAsync(3000);
      expect(onSave).toHaveBeenCalledTimes(1);
      expect(view.result.current.onSaved).not.toHaveBeenCalled();
    } finally {
      vi.clearAllTimers();
      view.unmount();
      report.mockRestore();
    }
  });

  it('keeps an explicitly pending native save dirty and retries without reporting a failure', async () => {
    const onSave = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = setupHook({ initialContent: { type: 'doc' }, onSave, nativeOwner: true });
    try {
      await act(async () => {
        view.result.current.api.markDirty();
        expect(await view.result.current.api.saveNow()).toBe(false);
      });
      expect(view.result.current.api.saveStatus).toBe('dirty');
      expect(view.result.current.onSaved).not.toHaveBeenCalled();
      expect(report).not.toHaveBeenCalled();
      expect(captureSaveFailure).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(onSave).toHaveBeenCalledTimes(2);
      expect(view.result.current.api.saveStatus).toBe('clean');
      expect(view.result.current.onSaved).toHaveBeenCalledExactlyOnceWith('page-1');
    } finally {
      act(() => view.result.current.api.discardPendingChanges());
      view.unmount();
      report.mockRestore();
    }
  });

  it.each(['unmount', 'page replacement'] as const)(
    'does not retry a retired notebook after %s and native owner close',
    async (lifetime) => {
      const owner = new NativeNotebookWorkingCopyOwner({} as never);
      const pending = Promise.withResolvers<void>();
      const onSave = vi.fn(async () => {
        await pending.promise;
        await owner.execute({ documentId: 'page-1', operation: { kind: 'inspect-copy' } });
      });
      const report = vi.spyOn(console, 'error').mockImplementation(() => {});
      const view = setupHook({ initialContent: { type: 'doc' }, onSave, nativeOwner: true });
      try {
        act(() => view.result.current.api.markDirty());
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });
        expect(onSave).toHaveBeenCalledTimes(1);
        if (lifetime === 'unmount') view.unmount();
        else view.rerender({ pageId: 'page-2' });
        await owner.close();
        await act(async () => {
          pending.resolve();
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(report).toHaveBeenCalledExactlyOnceWith(
          '[useEditorAutosave] save failed:',
          { pageId: 'page-1', operation: 'autosave' },
          expect.objectContaining({ code: 'NOTEBOOK_OWNER_CLOSED' })
        );
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1500);
        });
        expect(onSave).toHaveBeenCalledTimes(1);
      } finally {
        act(() => view.result.current.api.discardPendingChanges());
        vi.clearAllTimers();
        view.unmount();
        report.mockRestore();
      }
    }
  );

  it('reports the original autosave failure and keeps notebook content dirty without claiming a save', async () => {
    const failure = Object.assign(new Error('EACCES: notebook write denied'), { code: 'EACCES' });
    const content = { type: 'doc', content: [{ type: 'text', text: 'Retained notebook edit' }] };
    const onSave = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result, unmount } = setupHook({ initialContent: content, onSave });
    try {
      act(() => result.current.api.markDirty());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(result.current.api.saveStatus).toBe('dirty');
      expect(result.current.contentRef.current).toEqual(content);
      expect(result.current.onSaved).not.toHaveBeenCalled();
      expect(report).toHaveBeenCalledExactlyOnceWith(
        '[useEditorAutosave] save failed:',
        { pageId: 'page-1', operation: 'autosave' },
        failure
      );
      expect(captureSaveFailure).toHaveBeenCalledExactlyOnceWith(
        'workflow_action_observed',
        expect.objectContaining({
          workflow: 'content',
          workflow_action: 'save',
          outcome_kind: 'notebook_save_failed',
          action_phase: 'error',
          error_class: 'notebook_autosave_eacces',
          success: false,
        })
      );
      expect(JSON.stringify(captureSaveFailure.mock.calls)).not.toContain('Retained notebook edit');
      await act(async () => {
        expect(await result.current.api.saveNow()).toBe(true);
      });
      expect(result.current.api.saveStatus).toBe('clean');
      expect(result.current.onSaved).toHaveBeenCalledExactlyOnceWith('page-1');
    } finally {
      act(() => result.current.api.discardPendingChanges());
      unmount();
      report.mockRestore();
    }
  });

  it('reports the original notebook flush failure without announcing a saved document', async () => {
    const failure = Object.assign(new Error('EPERM: notebook flush denied'), { code: 'EPERM' });
    const onSave = vi.fn().mockRejectedValueOnce(failure);
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result, unmount } = setupHook({ initialContent: { type: 'doc' }, onSave });
    try {
      act(() => result.current.api.markDirty());
      await act(async () => {
        unmount();
        await Promise.resolve();
      });
      expect(result.current.onSaved).not.toHaveBeenCalled();
      expect(report).toHaveBeenCalledExactlyOnceWith(
        '[useEditorAutosave] flush save failed:',
        { pageId: 'page-1', operation: 'flush' },
        failure
      );
      expect(captureSaveFailure).toHaveBeenCalledExactlyOnceWith(
        'workflow_action_observed',
        expect.objectContaining({
          workflow: 'content',
          workflow_action: 'save',
          outcome_kind: 'notebook_save_failed',
          action_phase: 'error',
          error_class: 'notebook_flush_eperm',
          success: false,
        })
      );
    } finally {
      unmount();
      report.mockRestore();
    }
  });

  it.each(['same content', 'new content', 'discard', 'page change'] as const)(
    'joins an active autosave for %s',
    async (change) => {
      const pending = Promise.withResolvers<void>();
      const onSave = vi
        .fn()
        .mockImplementationOnce(() => pending.promise)
        .mockResolvedValue(undefined);
      const first = { type: 'doc', content: [{ type: 'text', text: 'first' }] };
      const next = { type: 'doc', content: [{ type: 'text', text: 'latest human edit' }] };
      const { result, rerender } = setupHook({ initialContent: first, onSave });
      await act(async () => {
        result.current.api.markDirty();
        vi.advanceTimersByTime(1000);
        await Promise.resolve();
      });
      if (change === 'new content')
        act(() => {
          result.current.contentRef.current = next;
          result.current.api.markDirty();
        });
      let request: Promise<boolean>;
      let acknowledged: boolean | undefined;
      await act(async () => {
        request = result.current.api.saveNow();
        void request.then((value) => {
          acknowledged = value;
        });
        await Promise.resolve();
      });
      expect(acknowledged).toBeUndefined();
      expect(onSave).toHaveBeenCalledTimes(1);
      if (change === 'discard') act(() => result.current.api.discardPendingChanges());
      if (change === 'page change') rerender({ pageId: 'page-2' });
      await act(async () => {
        pending.resolve();
        expect(await request!).toBe(change === 'same content' || change === 'new content');
      });
      expect(onSave).toHaveBeenCalledTimes(change === 'new content' ? 2 : 1);
      if (change === 'new content') expect(onSave).toHaveBeenLastCalledWith(next, 'page-1');
    }
  );

  it('returns a successful close acknowledgement only after the current save fulfills', async () => {
    const pending = Promise.withResolvers<void>();
    const onSave = vi.fn(() => pending.promise);
    const { result } = setupHook({ initialContent: { type: 'doc' }, onSave });
    let save: Promise<boolean>;
    let settled = false;
    act(() => {
      result.current.api.markDirty();
      save = result.current.api.saveNow();
      void save.then(() => {
        settled = true;
      });
    });
    expect(settled).toBe(false);
    expect(result.current.onSaved).not.toHaveBeenCalled();
    await act(async () => {
      pending.resolve();
      expect(await save!).toBe(true);
    });
    expect(result.current.onSaved).toHaveBeenCalledExactlyOnceWith('page-1');
    expect(result.current.api.saveStatus).toBe('clean');
  });

  it('returns false for an absent document or refused write and true for an explicit retry', async () => {
    const onSave = vi
      .fn()
      .mockRejectedValueOnce(new Error('controlled refusal'))
      .mockResolvedValue(undefined);
    const { result } = setupHook({ onSave });
    await act(async () => {
      expect(await result.current.api.saveNow()).toBe(false);
    });
    expect(onSave).not.toHaveBeenCalled();
    act(() => {
      result.current.contentRef.current = { type: 'doc' };
      result.current.api.markDirty();
    });
    await act(async () => {
      expect(await result.current.api.saveNow()).toBe(false);
    });
    expect(result.current.api.saveStatus).toBe('dirty');
    expect(result.current.onSaved).not.toHaveBeenCalled();
    await act(async () => {
      expect(await result.current.api.saveNow()).toBe(true);
    });
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(result.current.onSaved).toHaveBeenCalledExactlyOnceWith('page-1');
  });

  it.each(['new edit', 'discard'] as const)(
    'does not acknowledge a held older save after %s',
    async (change) => {
      const pending = Promise.withResolvers<void>();
      const onSave = vi.fn(() => pending.promise);
      const { result } = setupHook({ initialContent: { type: 'doc' }, onSave });
      let save: Promise<boolean>;
      act(() => {
        result.current.api.markDirty();
        save = result.current.api.saveNow();
      });
      act(() => {
        if (change === 'new edit') {
          result.current.contentRef.current = {
            type: 'doc',
            content: [{ type: 'text', text: 'newer' }],
          };
          result.current.api.markDirty();
        } else result.current.api.discardPendingChanges();
      });
      await act(async () => {
        pending.resolve();
        expect(await save!).toBe(false);
      });
      expect(result.current.onSaved).not.toHaveBeenCalled();
      expect(result.current.api.saveStatus).toBe(change === 'new edit' ? 'dirty' : 'clean');
    }
  );

  it('flushes an unrelated workspace on close while another workspace is frozen', async () => {
    const onSave = vi.fn(async () => {});
    const { result, unmount } = setupHook({
      workspaceRoot: '/workspace/b',
      initialPageId: 'page-b',
      initialContent: { type: 'doc' },
      onSave,
    });
    const release = freezeWorkspaceEditorWrites({
      workspaceRoot: '/workspace/a',
      affectedEntityIds: ['page-a'],
    });
    try {
      act(() => result.current.api.markDirty());
      unmount();
      await act(async () => {
        await Promise.resolve();
      });
      expect(onSave).toHaveBeenCalledWith({ type: 'doc' }, 'page-b');
    } finally {
      release();
    }
  });
  it('can retry a refused notebook write after the workspace freeze ends', async () => {
    const onSave = vi.fn(async () => {});
    const { result } = setupHook({ initialContent: { type: 'doc' }, onSave });
    const release = freezeWorkspaceEditorWrites({
      workspaceRoot: '/workspace',
      affectedEntityIds: ['page-1'],
    });
    try {
      await act(async () => {
        await result.current.api.saveNow();
      });
    } finally {
      release();
    }
    await act(async () => {
      await result.current.api.saveNow();
    });
    expect(onSave).toHaveBeenCalledOnce();
    expect(result.current.api.saveStatus).toBe('clean');
  });
  const mutation = { workspaceRoot: '/managed/workspace', affectedEntityIds: ['page-1'] };
  it('exposes pending notebook edits synchronously before React rerenders', () => {
    const { result } = setupHook({ initialContent: { type: 'doc' } });
    act(() => {
      result.current.api.markDirty();
      expect(() => assertWorkspaceEditorsSettled(mutation)).toThrow(/unsaved changes/);
    });
    act(() => result.current.api.discardPendingChanges());
    expect(() => assertWorkspaceEditorsSettled(mutation)).not.toThrow();
  });
  it.each(['save', 'unmount flush'] as const)(
    'retains a pending notebook %s after unmount',
    async (mode) => {
      const pending = Promise.withResolvers<void>();
      const { result, unmount } = setupHook({
        initialContent: { type: 'doc' },
        onSave: () => pending.promise,
      });
      act(() => result.current.api.markDirty());
      if (mode === 'save')
        act(() => {
          void result.current.api.saveNow();
        });
      unmount();
      expect(() => assertWorkspaceEditorsSettled(mutation)).toThrow(/still saving/);
      await act(async () => {
        pending.resolve();
        await pending.promise;
      });
      expect(() => assertWorkspaceEditorsSettled(mutation)).not.toThrow();
    }
  );
  it('does not invoke notebook persistence during a workspace freeze', async () => {
    const onSave = vi.fn(async () => {});
    const { result } = setupHook({ initialContent: { type: 'doc' }, onSave });
    const release = freezeWorkspaceEditorWrites(mutation);
    try {
      await act(async () => {
        await result.current.api.saveNow();
      });
      expect(onSave).not.toHaveBeenCalled();
      expect(result.current.api.saveStatus).toBe('dirty');
      act(() => result.current.api.discardPendingChanges());
    } finally {
      release();
    }
  });
  it('starts clean and does not call onSave without dirty', async () => {
    const onSave = vi.fn(async () => {});
    setupHook({ onSave });
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(onSave).not.toHaveBeenCalled();
  });

  it('calls onDirtyTransition exactly once across many keystrokes (the lag fix)', () => {
    const onDirtyTransition = vi.fn();
    const { result } = setupHook({ onDirtyTransition });
    act(() => {
      result.current.contentRef.current = { type: 'doc', content: [] };
    });

    for (let i = 0; i < 100; i++) {
      act(() => {
        result.current.api.markDirty();
      });
    }

    expect(onDirtyTransition).toHaveBeenCalledTimes(1);
    expect(onDirtyTransition).toHaveBeenCalledWith('page-1');
  });

  it('flushes pending content to OLD pageId on entity switch', async () => {
    const onSave = vi.fn(async () => {});
    const { result, rerender } = setupHook({ onSave, debounceMs: 1000, initialPageId: 'page-A' });

    act(() => {
      result.current.contentRef.current = {
        type: 'doc',
        content: [{ type: 'text', text: 'A-content' }],
      };
      result.current.api.markDirty();
    });

    rerender({ pageId: 'page-B' });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(
      { type: 'doc', content: [{ type: 'text', text: 'A-content' }] },
      'page-A'
    );
  });

  it('save status transitions clean → dirty on first markDirty', () => {
    const { result } = setupHook({});
    expect(result.current.api.saveStatus).toBe('clean');
    act(() => {
      result.current.contentRef.current = { type: 'doc', content: [] };
      result.current.api.markDirty();
    });
    expect(result.current.api.saveStatus).toBe('dirty');
  });

  it('debounces save to the trailing edge', async () => {
    const onSave = vi.fn(async () => {});
    const { result } = setupHook({ onSave, debounceMs: 1000 });

    act(() => {
      result.current.contentRef.current = { type: 'doc', content: [{ type: 'text', text: 'a' }] };
      result.current.api.markDirty();
    });

    await act(async () => {
      vi.advanceTimersByTime(999);
    });
    expect(onSave).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(2);

      await Promise.resolve();
    });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(
      { type: 'doc', content: [{ type: 'text', text: 'a' }] },
      'page-1'
    );
  });

  it('coalesces many keystrokes into a single trailing save', async () => {
    const onSave = vi.fn(async () => {});
    const { result } = setupHook({ onSave, debounceMs: 1000 });

    for (let i = 0; i < 50; i++) {
      act(() => {
        result.current.contentRef.current = {
          type: 'doc',
          content: [{ type: 'text', text: `tick-${i}` }],
        };
        result.current.api.markDirty();
        vi.advanceTimersByTime(10);
      });
    }

    expect(onSave).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1100);
      await Promise.resolve();
    });
    expect(onSave).toHaveBeenCalledTimes(1);

    expect(onSave.mock.calls[0][0]).toEqual({
      type: 'doc',
      content: [{ type: 'text', text: 'tick-49' }],
    });
  });

  it('saveNow bypasses the debounce', async () => {
    const onSave = vi.fn(async () => {});
    const { result } = setupHook({ onSave, debounceMs: 1000 });
    act(() => {
      result.current.contentRef.current = { type: 'doc', content: [] };
      result.current.api.markDirty();
    });
    await act(async () => {
      await result.current.api.saveNow();
    });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(result.current.api.saveStatus).toBe('clean');
  });

  it('returns to clean after a successful save and re-arms on next markDirty', async () => {
    const onSave = vi.fn(async () => {});
    const onDirtyTransition = vi.fn();
    const { result } = setupHook({ onSave, onDirtyTransition, debounceMs: 100 });

    act(() => {
      result.current.contentRef.current = { type: 'doc', content: [] };
      result.current.api.markDirty();
    });
    await act(async () => {
      vi.advanceTimersByTime(150);
      await Promise.resolve();
    });
    expect(result.current.api.saveStatus).toBe('clean');
    expect(onDirtyTransition).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.api.markDirty();
    });
    expect(onDirtyTransition).toHaveBeenCalledTimes(2);
  });

  it('returns to dirty when onSave rejects  ship review)', async () => {
    const onSave = vi.fn(async () => {
      throw new Error('boom');
    });
    const { result } = setupHook({ onSave, debounceMs: 100 });

    act(() => {
      result.current.contentRef.current = { type: 'doc', content: [] };
      result.current.api.markDirty();
    });
    await act(async () => {
      vi.advanceTimersByTime(150);

      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(result.current.api.saveStatus).toBe('dirty');
  });

  it('stays dirty when typing happens during an in-flight save (Codex P1)', async () => {
    let resolveSave: () => void = () => {};
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        })
    );
    const onSaved = vi.fn();
    const { result } = setupHook({ onSave, onSaved, debounceMs: 100 });

    act(() => {
      result.current.contentRef.current = { type: 'doc', content: [{ type: 'text', text: 'A' }] };
      result.current.api.markDirty();
    });
    await act(async () => {
      vi.advanceTimersByTime(150);
      await Promise.resolve();
    });
    expect(result.current.api.saveStatus).toBe('saving');

    act(() => {
      result.current.contentRef.current = { type: 'doc', content: [{ type: 'text', text: 'AB' }] };
      result.current.api.markDirty();
    });

    await act(async () => {
      resolveSave();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.api.saveStatus).toBe('dirty');
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('re-arms the debounce after a save failure so a retry fires (Codex P1)', async () => {
    let calls = 0;
    const onSave = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('transient');
    });
    const { result } = setupHook({ onSave, debounceMs: 100 });

    act(() => {
      result.current.contentRef.current = { type: 'doc', content: [] };
      result.current.api.markDirty();
    });
    await act(async () => {
      vi.advanceTimersByTime(150);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(result.current.api.saveStatus).toBe('dirty');

    await act(async () => {
      vi.advanceTimersByTime(1600);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(result.current.api.saveStatus).toBe('clean');
  });

  it('discards a failed save retry when external content is explicitly accepted', async () => {
    const onSave = vi.fn(async () => {
      throw new Error('external conflict');
    });
    const { result } = setupHook({ onSave, debounceMs: 100 });

    act(() => {
      result.current.contentRef.current = {
        type: 'doc',
        content: [{ type: 'text', text: 'local' }],
      };
      result.current.api.markDirty();
    });
    await act(async () => {
      vi.advanceTimersByTime(150);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(result.current.api.saveStatus).toBe('dirty');

    act(() => {
      result.current.contentRef.current = {
        type: 'doc',
        content: [{ type: 'text', text: 'accepted external' }],
      };
      result.current.api.discardPendingChanges();
    });
    expect(result.current.api.saveStatus).toBe('clean');

    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await Promise.resolve();
    });
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('fires onSaved for the OLD pageId after entity-switch flush', async () => {
    const onSave = vi.fn(async () => {});
    const onSaved = vi.fn();
    const { result, rerender } = setupHook({
      onSave,
      onSaved,
      debounceMs: 1000,
      initialPageId: 'page-A',
    });

    act(() => {
      result.current.contentRef.current = { type: 'doc', content: [] };
      result.current.api.markDirty();
    });
    rerender({ pageId: 'page-B' });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onSave).toHaveBeenCalledWith(expect.anything(), 'page-A');
    expect(onSaved).toHaveBeenCalledWith('page-A');
  });

  describe('save serialization (no concurrent saves)', () => {
    it('does not start a second save while one is in flight', async () => {
      let resolveA: (() => void) | null = null;
      let aStarted = false;
      let bStarted = false;
      let callCount = 0;
      const onSave = vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          aStarted = true;
          await new Promise<void>((r) => {
            resolveA = r;
          });
        } else {
          bStarted = true;
        }
      });

      const { result } = setupHook({ onSave, debounceMs: 100 });

      act(() => {
        result.current.contentRef.current = {
          type: 'doc',
          content: [{ type: 'text', text: 'first' }],
        };
        result.current.api.markDirty();
      });

      await act(async () => {
        vi.advanceTimersByTime(100);
        await Promise.resolve();
      });
      expect(aStarted).toBe(true);
      expect(bStarted).toBe(false);
      expect(callCount).toBe(1);

      act(() => {
        result.current.contentRef.current = {
          type: 'doc',
          content: [{ type: 'text', text: 'second' }],
        };
        result.current.api.markDirty();
      });

      await act(async () => {
        vi.advanceTimersByTime(100);
        await Promise.resolve();
      });

      expect(callCount).toBe(1);
      expect(bStarted).toBe(false);

      await act(async () => {
        resolveA!();
        await Promise.resolve();
        await Promise.resolve();

        vi.advanceTimersByTime(0);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(callCount).toBe(2);
      expect(bStarted).toBe(true);

      expect(onSave.mock.calls[1][0]).toEqual({
        type: 'doc',
        content: [{ type: 'text', text: 'second' }],
      });
    });

    it('keeps status dirty until the follow-up save completes', async () => {
      let resolveA: (() => void) | null = null;
      let resolveB: (() => void) | null = null;
      let callCount = 0;
      const onSave = vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          await new Promise<void>((r) => {
            resolveA = r;
          });
        } else {
          await new Promise<void>((r) => {
            resolveB = r;
          });
        }
      });

      const { result } = setupHook({ onSave, debounceMs: 100 });

      act(() => {
        result.current.contentRef.current = { type: 'doc', content: [] };
        result.current.api.markDirty();
      });
      await act(async () => {
        vi.advanceTimersByTime(100);
        await Promise.resolve();
      });
      expect(result.current.api.saveStatus).toBe('saving');

      act(() => {
        result.current.contentRef.current = {
          type: 'doc',
          content: [{ type: 'text', text: 'more' }],
        };
        result.current.api.markDirty();
      });
      await act(async () => {
        vi.advanceTimersByTime(100);
        await Promise.resolve();
      });

      await act(async () => {
        resolveA!();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(result.current.api.saveStatus).toBe('dirty');

      await act(async () => {
        vi.advanceTimersByTime(0);
        await Promise.resolve();
      });
      expect(result.current.api.saveStatus).toBe('saving');
      expect(callCount).toBe(2);

      await act(async () => {
        resolveB!();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(result.current.api.saveStatus).toBe('clean');
    });
  });
});
