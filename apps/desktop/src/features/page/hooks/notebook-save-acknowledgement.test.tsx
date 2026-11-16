// @vitest-environment jsdom
import { useCallback, useRef } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import { useEditorAutosave } from './useEditorAutosave';
import { useNotebookCloseRequests } from './useNotebookCloseRequests';
import { documentLifecycle } from '../../../shared/document-lifecycle';
import {
  NativeNotebookWorkingCopyOwner,
  type NativeNotebookOptions,
  type NativeNotebookSource,
} from '../../../main/notebook-document-owner';
import { NativeNotebookDocumentClient } from '../notebook-document-client';
import { NotebookDocumentModel } from '../../../shared/notebook-model/document';
import { canonicalNotebookJson } from '../../../db/notebook-markdown-codec';
import { contentFingerprint } from '../../../shared/content-fingerprint';

const port = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('../../../platform', () => ({
  platform: () => ({ notebook: { execute: port.execute } }),
}));
vi.mock('../../workspace/public/file-document-client', () => ({
  registerNativeDocumentClientFlush() {},
  waitForNativeFileDocumentReadiness: async () => {},
}));
vi.mock('../../../lib/analytics', () => ({
  trackRendererEvent() {},
  subscribeAnalyticsCaptureReady: () => () => {},
  getMeaningfulActivityAuthority: () => null,
  getAnalyticsIdentifiedAccountId: () => null,
  isAnalyticsIdentityIdentified: () => false,
  captureAnalyticsOptionalOrigin: () => null,
  getAnalyticsCaptureGeneration: () => 0,
  isAnalyticsCaptureReady: () => false,
}));

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  port.execute.mockReset();
});

async function nativeNotebook(publish: () => Promise<void>) {
  const makeSource = (content: JSONContent): NativeNotebookSource => ({
    content: structuredClone(content),
    title: 'Notebook',
    fingerprint: contentFingerprint(canonicalNotebookJson(content)),
    metadataRaw: '{}',
    preservedPreamble: '',
    preservedTitleProjection: { kind: 'missing-heading', source: '', lineEnding: '\n' },
    sourceShape: 'v2-package',
  });
  let source = makeSource({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Original' }] }],
  });
  const options: NativeNotebookOptions = {
    resolve: async () => ({
      documentId: 'pending-notebook',
      path: '/registered/Notebook',
      workspaceRoot: '/registered',
      readOnly: false,
      assertCurrent() {},
    }),
    load: async () => source,
    publish: async (_scope, _source, content) => {
      await publish();
      source = makeSource(content);
      return { source };
    },
    loadRecord: async () => undefined,
    storeRecord: async () => {},
    retainedDirty: async () => [],
    normalizePath: (path) => path,
    prepareInsertion: async () => {
      throw new Error('Unused insertion.');
    },
    search: async () => [],
    list: async () => [],
    create: async () => {
      throw new Error('Unused creation.');
    },
  };
  const owner = new NativeNotebookWorkingCopyOwner(options);
  const client = new NativeNotebookDocumentClient('pending-notebook');
  port.execute.mockImplementation(async (request) => structuredClone(await owner.execute(request)));
  const stop = owner.subscribe((snapshot) => client.observe(structuredClone(snapshot)));
  client.observe(
    await owner.execute({ documentId: 'pending-notebook', operation: { kind: 'inspect-copy' } })
  );
  return { owner, client, stop, saved: () => source.content };
}

it('keeps newer native input dirty when a held captured save completes without a close acknowledgement', async () => {
  vi.useFakeTimers();
  const publishing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const native = await nativeNotebook(async () => {
    publishing.resolve();
    await release.promise;
  });
  const report = vi.spyOn(console, 'error').mockImplementation(() => {});
  const onSaved = vi.fn();
  const editorOwner = { isDestroyed: false };
  const view = renderHook(() => {
    const contentRef = useRef<JSONContent | null>(native.client.snapshot!.copy.content);
    const api = useEditorAutosave({
      pageId: 'pending-notebook',
      contentRef,
      nativeOwner: true,
      onSave: async () => {
        await native.client.flush();
        return native.client.save();
      },
      onSaved,
    });
    useNotebookCloseRequests({
      pageId: 'pending-notebook',
      owner: editorOwner,
      contentRef,
      saveNow: api.saveNow,
      onDiscard: api.discardPendingChanges,
    });
    return { api, contentRef };
  });
  try {
    const a = new NotebookDocumentModel(native.client.snapshot!.copy.content, 'Notebook');
    native.client.capture(a.state.tr.insertText('A', 1));
    await native.client.flush();
    act(() => {
      view.result.current.contentRef.current = native.client.snapshot!.copy.content;
      view.result.current.api.markDirty();
    });
    let close!: Promise<boolean>;
    await act(async () => {
      close = documentLifecycle.save({ kind: 'page', pageId: 'pending-notebook' });
      await publishing.promise;
    });
    const b = new NotebookDocumentModel(native.client.snapshot!.copy.content, 'Notebook');
    native.client.capture(b.state.tr.insertText('B', 2));
    await native.client.flush();
    act(() => {
      view.result.current.contentRef.current = native.client.snapshot!.copy.content;
      view.result.current.api.markDirty();
    });
    await act(async () => {
      release.resolve();
      expect(await close).toBe(false);
    });
    expect(native.saved().content?.[0].content?.[0].text).toBe('AOriginal');
    expect(native.client.snapshot!.copy.content.content?.[0].content?.[0].text).toBe('ABOriginal');
    expect(native.client.dirty).toBe(true);
    expect(view.result.current.api.saveStatus).toBe('dirty');
    expect(onSaved).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
    await act(async () => {
      expect(await documentLifecycle.save({ kind: 'page', pageId: 'pending-notebook' })).toBe(true);
    });
    expect(native.saved().content?.[0].content?.[0].text).toBe('ABOriginal');
    expect(view.result.current.api.saveStatus).toBe('clean');
    expect(onSaved).toHaveBeenCalledExactlyOnceWith('pending-notebook');
  } finally {
    release.resolve();
    act(() => view.result.current.api.discardPendingChanges());
    view.unmount();
    native.stop();
    await native.owner.close();
  }
});

it('reports the original native publication failure while retaining input for a deliberate retry', async () => {
  vi.useFakeTimers();
  const denied = Object.assign(new Error('Notebook publication denied'), { code: 'EACCES' });
  let refuse = true;
  const native = await nativeNotebook(async () => {
    if (refuse) throw denied;
  });
  const a = new NotebookDocumentModel(native.client.snapshot!.copy.content, 'Notebook');
  native.client.capture(a.state.tr.insertText('A', 1));
  await native.client.flush();
  const report = vi.spyOn(console, 'error').mockImplementation(() => {});
  const onSaved = vi.fn();
  const view = renderHook(() => {
    const contentRef = useRef<JSONContent | null>(native.client.snapshot!.copy.content);
    return useEditorAutosave({
      pageId: 'pending-notebook',
      contentRef,
      nativeOwner: true,
      onSave: async () => {
        await native.client.flush();
        const saved = await native.client.save();
        if (!saved && native.client.lastCommandError) throw native.client.lastCommandError;
        return saved;
      },
      onSaved,
    });
  });
  try {
    await act(async () => {
      view.result.current.markDirty();
      expect(await view.result.current.saveNow()).toBe(false);
    });
    expect(view.result.current.saveStatus).toBe('dirty');
    expect(onSaved).not.toHaveBeenCalled();
    expect(native.saved().content?.[0].content?.[0].text).toBe('Original');
    expect(native.client.snapshot!.copy.content.content?.[0].content?.[0].text).toBe('AOriginal');
    expect(report).toHaveBeenCalledExactlyOnceWith(
      '[useEditorAutosave] save failed:',
      { pageId: 'pending-notebook', operation: 'manual' },
      expect.objectContaining({ code: 'NOTEBOOK_SAVE_FAILED', cause: denied })
    );
    refuse = false;
    await act(async () => {
      expect(await view.result.current.saveNow()).toBe(true);
    });
    expect(native.saved().content?.[0].content?.[0].text).toBe('AOriginal');
    expect(view.result.current.saveStatus).toBe('clean');
    expect(onSaved).toHaveBeenCalledExactlyOnceWith('pending-notebook');
  } finally {
    act(() => view.result.current.discardPendingChanges());
    view.unmount();
    native.stop();
    await native.owner.close();
  }
});

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
