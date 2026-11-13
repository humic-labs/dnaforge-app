// @vitest-environment jsdom
import { useCallback, useRef } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import { useEditorAutosave } from './useEditorAutosave';
import { useNotebookCloseRequests } from './useNotebookCloseRequests';
import { documentLifecycle } from '../../../shared/document-lifecycle';

afterEach(cleanup);

it('accepts the native save receipt when its acknowledgement republishes the same content', async () => {
  const initial: JSONContent = {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Retain this edit' }] }],
  };
  const owner = { isDestroyed: false };
  const view = renderHook(() => {
    const contentRef = useRef<JSONContent | null>(initial);
    const acknowledge = useRef<() => void>(() => undefined);
    const onSave = useCallback(async () => {
      acknowledge.current();
      contentRef.current = structuredClone(initial);
    }, []);
    const api = useEditorAutosave({
      pageId: 'notebook-acknowledgement',
      contentRef,
      onSave,
      nativeOwner: true,
    });
    acknowledge.current = api.markDirty;
    useNotebookCloseRequests({
      pageId: 'notebook-acknowledgement',
      owner,
      contentRef,
      saveNow: api.saveNow,
      onDiscard: vi.fn(),
    });
    return api;
  });
  try {
    let accepted = false;
    await act(async () => {
      view.result.current.markDirty();
      accepted = await documentLifecycle.save({
        kind: 'page',
        pageId: 'notebook-acknowledgement',
      });
    });
    expect(accepted).toBe(true);
    expect(view.result.current.saveStatus).toBe('clean');
  } finally {
    view.unmount();
  }
});
