// @vitest-environment jsdom
import { useCallback, useRef } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Editor, type JSONContent } from '@tiptap/core';
import { useEditorAutosave } from './useEditorAutosave';
import { useNotebookCloseRequests } from './useNotebookCloseRequests';
import { documentLifecycle } from '../../../shared/document-lifecycle';
import {
  NativeNotebookWorkingCopyOwner,
  type NativeNotebookOptions,
  type NativeNotebookSource,
  type NativeNotebookRecord,
} from '../../../main/notebook-document-owner';
import { NativeNotebookDocumentClient } from '../notebook-document-client';
import { NotebookDocumentModel } from '../../../shared/notebook-model/document';
import { canonicalNotebookJson } from '../../../db/notebook-markdown-codec';
import { contentFingerprint } from '../../../shared/content-fingerprint';
import { getNotebookBaseExtensions } from '../../../shared/notebook-model/extensions/notebook-model-extensions';
import { NotebookMentionNode } from '../../../shared/notebook-model/extensions/notebook-mention-model';
import { NotebookEmbedNode } from '../../../shared/notebook-model/extensions/notebook-embed-model';

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
  let retained: NativeNotebookRecord | undefined;
  const makeSource = (content: JSONContent): NativeNotebookSource => {
    const canonical = new NotebookDocumentModel(content, 'Notebook').content;
    return {
      content: structuredClone(canonical),
      title: 'Notebook',
      fingerprint: contentFingerprint(canonicalNotebookJson(canonical)),
      metadataRaw: '{}',
      preservedPreamble: '',
      preservedTitleProjection: { kind: 'missing-heading', source: '', lineEnding: '\n' },
      sourceShape: 'v2-package',
    };
  };
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
    storeRecord: async (record) => {
      retained = structuredClone(record);
    },
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
  expect(client.dirty).toBe(false);
  return { owner, client, stop, saved: () => source.content, retained: () => retained };
}

it.each(['capture', 'command', 'save', 'replace', 'discard', 'history'] as const)(
  'refuses a fresh notebook %s after retirement without another native command',
  async (operation) => {
    const native = await nativeNotebook(async () => {});
    try {
      await native.client.flush('retire');
      port.execute.mockClear();
      const model = new NotebookDocumentModel(native.client.snapshot!.copy.content, 'Notebook');
      const attempts = {
        capture: () => native.client.capture(model.state.tr.insertText('Late', 1)),
        command: () => native.client.command({ kind: 'inspect-copy' }),
        save: () => native.client.save(),
        replace: () =>
          native.client.replaceContent({ type: 'doc', content: [{ type: 'paragraph' }] }),
        discard: () => native.client.discard(),
        history: () => native.client.history('undo'),
      };
      await expect(
        Promise.resolve().then(async () => {
          await attempts[operation]();
        })
      ).rejects.toThrow('NOTEBOOK_CLIENT_RETIRED');
      expect(port.execute).not.toHaveBeenCalled();
      expect(native.saved().content?.[0].content?.[0].text).toBe('Original');
    } finally {
      await native.client.flush('discard');
      native.stop();
      await native.owner.close();
    }
  }
);

it('preserves the original refused mutation and disables its attached notebook editor', async () => {
  const native = await nativeNotebook(async () => {});
  const editor = new Editor({
    extensions: [...getNotebookBaseExtensions(), NotebookMentionNode, NotebookEmbedNode],
    content: native.client.snapshot!.copy.content,
  });
  const detach = native.client.attach(editor);
  const refused = new Error('Original notebook mutation refused');
  const execute = port.execute.getMockImplementation()!;
  port.execute.mockImplementation(async (request) => {
    if (request.operation.kind === 'apply-steps') throw refused;
    return execute(request);
  });
  try {
    const transaction = editor.state.tr.insertText('A', 1);
    editor.view.dispatch(transaction);
    native.client.capture(transaction, editor.getJSON());
    await expect(native.client.flush()).rejects.toBe(refused);
    expect(native.client.error).toBe(refused.message);
    expect(editor.isEditable).toBe(false);
    expect(editor.getText()).toBe('AOriginal');
    expect(native.saved().content?.[0].content?.[0].text).toBe('Original');
  } finally {
    await native.client.flush('retire');
    detach();
    editor.destroy();
    native.stop();
    await native.owner.close();
  }
});

it.each(['complete', 'refuse'] as const)(
  'settles an admitted notebook save dependency with explicit %s before its owner closes',
  async (outcome) => {
    const native = await nativeNotebook(async () => {});
    const model = new NotebookDocumentModel(native.client.snapshot!.copy.content, 'Notebook');
    native.client.capture(model.state.tr.insertText('A', 1));
    await native.client.flush();
    const beforeSave = Promise.withResolvers<void>();
    const refused = new Error('Original reference repair refused');
    const saving = native.client.save(beforeSave.promise);
    const result = saving.catch((error: unknown) => error);
    let retired = false;
    const retirement = native.client.flush('retire').then(() => {
      retired = true;
    });
    port.execute.mockClear();
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(retired).toBe(false);
      expect(port.execute).not.toHaveBeenCalled();
      if (outcome === 'complete') beforeSave.resolve();
      else beforeSave.reject(refused);
      expect(await result).toBe(outcome === 'complete' ? true : refused);
      await retirement;
      await native.owner.close();
      expect(native.saved().content?.[0].content?.[0].text).toBe(
        outcome === 'complete' ? 'AOriginal' : 'Original'
      );
      expect(native.retained()).toMatchObject({ dirty: outcome === 'refuse' });
      const calls = port.execute.mock.calls.length;
      await expect(native.client.save()).rejects.toThrow('NOTEBOOK_CLIENT_RETIRED');
      expect(port.execute).toHaveBeenCalledTimes(calls);
    } finally {
      beforeSave.resolve();
      await result;
      await retirement;
      native.stop();
      await native.owner.close();
    }
  }
);

it('finishes an admitted reference repair and save without a serial-tail deadlock during retirement', async () => {
  const native = await nativeNotebook(async () => {});
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const execute = port.execute.getMockImplementation()!;
  let held = false;
  port.execute.mockImplementation(async (request) => {
    const snapshot = await execute(request);
    if (request.operation.kind === 'apply-steps' && !held) {
      held = true;
      entered.resolve();
      await release.promise;
    }
    return snapshot;
  });
  const model = new NotebookDocumentModel(native.client.snapshot!.copy.content, 'Notebook');
  native.client.capture(model.state.tr.insertText('A', 1));
  await entered.promise;
  const repair = native.client.replaceContent({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Repaired' }] }],
  });
  const saving = native.client.save(repair);
  const retirement = native.client.flush('retire');
  try {
    release.resolve();
    expect(await saving).toBe(true);
    await retirement;
    await native.owner.close();
    expect(native.saved().content?.[0].content?.[0].text).toBe('Repaired');
    expect(native.retained()).toMatchObject({ dirty: false });
  } finally {
    release.resolve();
    await Promise.allSettled([repair, saving, retirement]);
    native.stop();
    await native.owner.close();
  }
});

it('retires an attached editor before draining a held native save and retains newer input without an unmount flush', async () => {
  vi.useFakeTimers();
  const publishing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const native = await nativeNotebook(async () => {
    publishing.resolve();
    await release.promise;
  });
  const onSave = vi.fn(async () => {
    await native.client.flush();
    const saved = await native.client.save();
    if (!saved && native.client.lastCommandError) throw native.client.lastCommandError;
    return saved;
  });
  const view = renderHook(() => {
    const contentRef = useRef<JSONContent | null>(native.client.snapshot!.copy.content);
    const api = useEditorAutosave({
      pageId: 'pending-notebook',
      contentRef,
      onSave,
      nativeOwner: true,
    });
    return { api, contentRef };
  });
  const editor = new Editor({
    extensions: [...getNotebookBaseExtensions(), NotebookMentionNode, NotebookEmbedNode],
    content: native.client.snapshot!.copy.content,
  });
  const detach = native.client.attach(editor, view.result.current.api.retirePendingChanges);
  let saving: Promise<boolean> | undefined;
  let retirement: Promise<void> | undefined;
  try {
    expect(editor.isEditable).toBe(true);
    const a = new NotebookDocumentModel(native.client.snapshot!.copy.content, 'Notebook');
    native.client.capture(a.state.tr.insertText('A', 1));
    await native.client.flush();
    await act(async () => {
      view.result.current.contentRef.current = native.client.snapshot!.copy.content;
      view.result.current.api.markDirty();
      saving = view.result.current.api.saveNow();
      await publishing.promise;
    });
    const b = new NotebookDocumentModel(native.client.snapshot!.copy.content, 'Notebook');
    native.client.capture(b.state.tr.insertText('B', 2));
    await native.client.flush();
    act(() => {
      view.result.current.contentRef.current = native.client.snapshot!.copy.content;
      view.result.current.api.markDirty();
    });
    let retired = false;
    await act(async () => {
      retirement = native.client.flush('retire');
      void retirement.then(() => {
        retired = true;
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(retired).toBe(false);
    expect(editor.isEditable).toBe(false);
    await act(async () => {
      release.resolve();
      await retirement;
      expect(await saving).toBe(false);
    });
    view.unmount();
    await vi.advanceTimersByTimeAsync(3000);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(native.saved().content?.[0].content?.[0].text).toBe('AOriginal');
    await native.owner.close();
    expect(native.retained()).toMatchObject({ dirty: true });
    expect(native.retained()?.content.content?.[0].content?.[0].text).toBe('ABOriginal');
  } finally {
    release.resolve();
    await saving;
    await retirement;
    act(() => view.result.current.api.discardPendingChanges());
    view.unmount();
    detach();
    editor.destroy();
    native.stop();
    await native.owner.close();
  }
});

it('keeps the actual editor and autosave active when quit is cancelled before irreversible shutdown', async () => {
  vi.useFakeTimers();
  vi.doMock('../../../main/auto-updater', () => ({
    readUpdateInstallCandidate: () => null,
    hasStartedMacUpdatePreparation: () => false,
    quitAndInstall() {},
    prepareUpdateInstallIntent() {},
    recordUpdateInstallOutcome() {},
    refuseUpdateRestartAfterShutdownFailure() {},
    restoreDownloadedUpdateAfterQuitCancellation() {},
  }));
  vi.doMock('../../../main/dirty-state-cache', () => ({
    readCurrentDirtyState: async () => ({ hasDirtyWork: true, details: 'Notebook' }),
  }));
  vi.doMock('../../../main/quit-consent', () => ({
    hasQuitConsent: () => false,
    resetQuitConsent() {},
    setQuitConsentGranted() {},
    shouldSuppressBlockingDialogs: () => false,
    showUnsavedWorkDialog: async () => 'cancel',
  }));
  vi.doMock('electron', () => ({ app: { relaunch: vi.fn() } }));
  const native = await nativeNotebook(async () => {});
  const onSave = vi.fn(async () => native.client.save());
  const view = renderHook(() => {
    const contentRef = useRef<JSONContent | null>(native.client.snapshot!.copy.content);
    return useEditorAutosave({ pageId: 'pending-notebook', contentRef, onSave, nativeOwner: true });
  });
  const editor = new Editor({
    extensions: [...getNotebookBaseExtensions(), NotebookMentionNode, NotebookEmbedNode],
    content: native.client.snapshot!.copy.content,
  });
  const detach = native.client.attach(editor, view.result.current.retirePendingChanges);
  try {
    const { handleBeforeQuit } = await import('../../../main/quit-orchestration');
    const closeDatabase = vi.fn(() => native.client.flush('retire'));
    const killSidecar = vi.fn();
    expect(
      await handleBeforeQuit({
        mainWindow: null,
        freezeRenderer: vi.fn(),
        restoreRenderer: vi.fn(),
        killSidecar,
        closeDatabase,
        trackAppClosed: vi.fn(),
        shutdownAnalytics: async () => {},
        quitApp: vi.fn(),
        requestSaveAll: async () => {},
      })
    ).toEqual({ cancelled: true });
    expect(closeDatabase).not.toHaveBeenCalled();
    expect(killSidecar).not.toHaveBeenCalled();
    expect(editor.isEditable).toBe(true);
    act(() => view.result.current.markDirty());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(onSave).toHaveBeenCalledOnce();
    expect(view.result.current.saveStatus).toBe('clean');
  } finally {
    act(() => view.result.current.discardPendingChanges());
    view.unmount();
    detach();
    editor.destroy();
    native.stop();
    await native.owner.close();
    vi.doUnmock('../../../main/auto-updater');
    vi.doUnmock('../../../main/dirty-state-cache');
    vi.doUnmock('../../../main/quit-consent');
    vi.doUnmock('electron');
  }
});

it('keeps an explicit native discard intact when retirement precedes the editor unmount', async () => {
  vi.useFakeTimers();
  const native = await nativeNotebook(async () => {});
  const a = new NotebookDocumentModel(native.client.snapshot!.copy.content, 'Notebook');
  native.client.capture(a.state.tr.insertText('A', 1));
  await native.client.flush();
  const onSave = vi.fn(async () => native.client.save());
  const view = renderHook(() => {
    const contentRef = useRef<JSONContent | null>(native.client.snapshot!.copy.content);
    return useEditorAutosave({ pageId: 'pending-notebook', contentRef, onSave, nativeOwner: true });
  });
  const editor = new Editor({
    extensions: [...getNotebookBaseExtensions(), NotebookMentionNode, NotebookEmbedNode],
    content: native.client.snapshot!.copy.content,
  });
  const detach = native.client.attach(editor, view.result.current.retirePendingChanges);
  try {
    act(() => view.result.current.markDirty());
    await native.client.discard();
    await act(async () => {
      await native.client.flush('retire');
    });
    view.unmount();
    await vi.advanceTimersByTimeAsync(3000);
    expect(onSave).not.toHaveBeenCalled();
    await native.owner.close();
    expect(native.saved().content?.[0].content?.[0].text).toBe('Original');
    expect(native.retained()).toMatchObject({ dirty: false });
    expect(native.retained()?.content.content?.[0].content?.[0].text).toBe('Original');
  } finally {
    act(() => view.result.current.discardPendingChanges());
    view.unmount();
    detach();
    editor.destroy();
    native.stop();
    await native.owner.close();
  }
});

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
