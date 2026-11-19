// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, fireEvent } from '@testing-library/react';
import { WorkspaceCommandProvider as CommandScopeProvider } from '../../../test/document-save-commands';
import {
  useDocumentLifecycle,
  useDocumentSaveCommand,
} from '../../../shared/use-document-lifecycle';
import { useCanvasStore } from '../../canvas/public/store';
import { useSequencePersistence } from './useSequencePersistence';
import type { SequenceDocumentSaveCompletion } from '../complete-sequence-document-save';
import { useSequenceStore } from '../store';
import { SequenceDocumentClientBridge } from '../sequence-document-client';
import { setSequenceClientPort } from '../sequence-client-port';
import { useToastStore } from '../../../stores/toast-store';
import {
  assertWorkspaceEditorsSettled,
  freezeWorkspaceEditorWrites,
} from '../../../services/workspace-editor-mutation-state';
import {
  attachSequenceDocumentMetadata,
  getSequenceFormatCapabilities,
  parseGenBankFull,
  type AnnotatedSequence,
  type Annotation,
} from '@waypoint/sequence-utils';

const { saveSequenceDocument, writeTextFile, sequenceDocument, isSequenceDocumentAvailable } =
  vi.hoisted(() => ({
    saveSequenceDocument: vi.fn(),
    writeTextFile: vi.fn(),
    sequenceDocument: vi.fn(),
    isSequenceDocumentAvailable: vi.fn(),
  }));

vi.mock('../../../platform', () => ({
  platform: () => ({
    fs: {
      exists: vi.fn(async () => false),
      saveSequenceDocument,
      writeTextFile,
      sequenceDocument,
      isSequenceDocumentAvailable,
      readTextFile: vi.fn().mockResolvedValue(''),
      watchFile: vi.fn().mockResolvedValue(undefined),
      unwatchFile: vi.fn().mockResolvedValue(undefined),
    },
  }),
}));

vi.mock('./useFileWatcher', () => ({
  useFileWatcher: () => ({
    showExternalChangeToast: false,
    acceptExternalChange: vi.fn(),
    dismissExternalChange: vi.fn(),
    suppressNextChange: vi.fn(),
    reloadFromDisk: vi.fn(),
  }),
}));

const PATH = 'sequence-document-puc19';
const FILE_PATH = '/test/pUC19.gb';
const SNAPGENE_PATH = 'sequence-document-snapgene';
const SNAPGENE_FILE_PATH = '/test/sample-f.dna';

const committedAnnotation: Annotation = {
  name: 'AmpR',
  type: 'CDS',
  start: 100,
  end: 900,
  direction: 1,
  color: '#4299e1',
  qualifiers: { source: ['pLannotate'] },
};

function makeSequence(annotations: Annotation[]): AnnotatedSequence {
  return {
    id: PATH,
    name: 'pUC19',
    sequence: 'ATGC'.repeat(250),
    length: 1000,
    circular: true,
    annotations,
  };
}

const lateEdit: Annotation = {
  name: 'late-edit',
  type: 'promoter',
  start: 10,
  end: 20,
  direction: 1,
};

function dirtyWithAnnotation(documentId = PATH, annotation: Annotation = lateEdit): void {
  useSequenceStore.getState().addAnnotation(documentId, annotation);
}

function typeBases(text: string, position = 0): void {
  useSequenceStore.getState().dispatchEdit(PATH, { type: 'SET_CURSOR', position });
  useSequenceStore.getState().dispatchEdit(PATH, { type: 'INSERT', text });
}

function mountSave(
  persistPendingPrimerBindings?: Parameters<
    typeof useSequencePersistence
  >[0]['persistPendingPrimerBindings'],
  readOnly = false,
  onSaveComplete: Parameters<typeof useSequencePersistence>[0]['onSaveComplete'] = vi
    .fn<() => Promise<SequenceDocumentSaveCompletion>>()
    .mockResolvedValue({ status: 'not-a-repository' }),
  filePath = FILE_PATH
) {
  const onExternalReload = vi.fn();
  const { result, unmount } = renderHook(() =>
    useSequencePersistence({
      documentId: PATH,
      filePath,
      sequence: useSequenceStore.getState().sequences[PATH] ?? null,
      readOnly,
      onSaveComplete,
      onExternalReload,
      persistPendingPrimerBindings,
    })
  );
  return { result, unmount, onSaveComplete, onExternalReload };
}

describe('useSequencePersistence.save ', () => {
  const mutation = { workspaceRoot: '/test', affectedEntityIds: [PATH] };
  it('registers dirty sequences by physical workspace and retains saving after unmount', async () => {
    useSequenceStore.getState().setSequence(PATH, makeSequence([]));
    const { result, unmount } = mountSave();
    act(() => dirtyWithAnnotation());
    expect(() => assertWorkspaceEditorsSettled({ ...mutation, affectedEntityIds: [] })).toThrow(
      /unsaved/
    );
    let resolvePending!: () => void;
    const pending = {
      promise: new Promise<void>((resolve) => {
        resolvePending = resolve;
      }),
      resolve: () => resolvePending(),
    };
    writeTextFile.mockReturnValue(pending.promise);
    let saving: Promise<boolean> = Promise.resolve(false);
    act(() => {
      saving = result.current.save();
    });
    unmount();
    expect(() => assertWorkspaceEditorsSettled(mutation)).toThrow(/still saving/);
    await act(async () => {
      pending.resolve();
      expect(await saving).toBe(true);
    });
    expect(() => assertWorkspaceEditorsSettled(mutation)).not.toThrow();
  });
  it('refuses a sequence save while its workspace is frozen', async () => {
    useSequenceStore.getState().setSequence(PATH, makeSequence([]));
    dirtyWithAnnotation();
    const { result } = mountSave();
    const release = freezeWorkspaceEditorWrites(mutation);
    try {
      await act(async () => expect(await result.current.save()).toBe(false));
      expect(writeTextFile).not.toHaveBeenCalled();
      expect(useSequenceStore.getState().isDirty(PATH)).toBe(true);
    } finally {
      release();
    }
  });
  beforeEach(() => {
    useSequenceStore.getState().clearAll();
    useToastStore.setState({ toasts: [] });
    saveSequenceDocument.mockReset().mockResolvedValue({ status: 'unbound' });
    writeTextFile.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('preserves a dirty draft through a read-only transition and saves after editing returns', async () => {
    useSequenceStore.getState().setSequence(PATH, makeSequence([]));
    dirtyWithAnnotation();
    const draft = useSequenceStore.getState().drafts[PATH];
    const onSaveComplete = vi
      .fn<() => Promise<SequenceDocumentSaveCompletion>>()
      .mockResolvedValue({ status: 'not-a-repository' });
    const { result, rerender } = renderHook(
      ({ readOnly }) =>
        useSequencePersistence({
          documentId: PATH,
          filePath: FILE_PATH,
          sequence: useSequenceStore.getState().sequences[PATH],
          readOnly,
          onSaveComplete,
          onExternalReload: vi.fn(),
        }),
      { initialProps: { readOnly: false } }
    );
    rerender({ readOnly: true });
    expect(useSequenceStore.getState().drafts[PATH]).toBe(draft);
    expect(useSequenceStore.getState().isDirty(PATH)).toBe(true);
    expect(result.current.isDirty).toBe(true);
    expect(() => assertWorkspaceEditorsSettled(mutation)).toThrow(/unsaved/);
    await act(async () => expect(await result.current.save()).toBe(false));
    expect(writeTextFile).not.toHaveBeenCalled();
    expect(onSaveComplete).not.toHaveBeenCalled();
    expect(useSequenceStore.getState().drafts[PATH]).toBe(draft);
    rerender({ readOnly: false });
    expect(result.current.isDirty).toBe(true);
    await act(async () => expect(await result.current.save()).toBe(true));
    expect(writeTextFile.mock.lastCall?.[1]).toContain('late-edit');
    expect(onSaveComplete).toHaveBeenCalledTimes(1);
  });

  it('mounts an unavailable cached read-only sequence without requesting native Discard', async () => {
    useSequenceStore.getState().setSequence(PATH, makeSequence([]));
    isSequenceDocumentAvailable.mockResolvedValue(false);
    sequenceDocument.mockRejectedValue(
      new Error('The document workspace is not enrolled with this native owner.')
    );
    const bridge = new SequenceDocumentClientBridge(useSequenceStore);
    const detach = setSequenceClientPort(bridge);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    let unmount: (() => void) | undefined;
    try {
      bridge.refreshAvailableDocuments();
      await bridge.flush();
      ({ unmount } = mountSave(undefined, true));
      await expect(bridge.flush()).resolves.toBeUndefined();
      expect(sequenceDocument).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      expect(useSequenceStore.getState().sequences[PATH].sequence).toBe('ATGC'.repeat(250));
      expect(writeTextFile).not.toHaveBeenCalled();
    } finally {
      unmount?.();
      detach();
      log.mockRestore();
    }
  });

  it('routes the platform Save shortcut only to the focused document owner', async () => {
    const otherId = 'sequence-document-other-pane';
    useSequenceStore.getState().setSequence(PATH, makeSequence([]));
    useSequenceStore.getState().setSequence(otherId, { ...makeSequence([]), id: otherId });
    dirtyWithAnnotation(PATH);
    dirtyWithAnnotation(otherId);
    const canvas = useCanvasStore.getState();
    useCanvasStore.setState({
      focusedPanelId: 'main',
      panels: {
        main: {
          id: 'main',
          activeTabId: 'other-sequence-tab',
          tabs: [
            {
              id: 'first-sequence-tab',
              type: 'sequence',
              entityId: PATH,
              label: 'First',
              sequenceDocument: {
                kind: 'import-source-sequence',
                documentId: PATH,
                sourcePath: FILE_PATH,
              },
            },
            {
              id: 'other-sequence-tab',
              type: 'sequence',
              entityId: otherId,
              label: 'Other',
              sequenceDocument: {
                kind: 'import-source-sequence',
                documentId: otherId,
                sourcePath: '/test/other.gb',
              },
            },
          ],
        },
      },
    });
    const first = renderHook(() => {
      const persistence = useSequencePersistence({
        documentId: PATH,
        filePath: FILE_PATH,
        sequence: useSequenceStore.getState().getSequence(PATH),
        onSaveComplete: vi.fn().mockResolvedValue({ status: 'not-a-repository' }),
        onExternalReload: vi.fn(),
      });
      useDocumentLifecycle({
        target: { kind: 'sequence-document', documentId: PATH },
        tabId: 'first-sequence-tab',
        isDirty: () => useSequenceStore.getState().isDirty(PATH),
        readRevision: () => useSequenceStore.getState().getVersion(PATH),
        save: () => persistence.save(),
        discard: () => useSequenceStore.getState().discardEdits(PATH),
      });
      return persistence;
    });
    const second = renderHook(() => {
      const persistence = useSequencePersistence({
        documentId: otherId,
        filePath: '/test/other.gb',
        sequence: useSequenceStore.getState().getSequence(otherId),
        onSaveComplete: vi.fn().mockResolvedValue({ status: 'not-a-repository' }),
        onExternalReload: vi.fn(),
      });
      useDocumentLifecycle({
        target: { kind: 'sequence-document', documentId: otherId },
        tabId: 'other-sequence-tab',
        isDirty: () => useSequenceStore.getState().isDirty(otherId),
        readRevision: () => useSequenceStore.getState().getVersion(otherId),
        save: () => persistence.save(),
        discard: () => useSequenceStore.getState().discardEdits(otherId),
      });
      return persistence;
    });
    const commands = renderHook(useDocumentSaveCommand, {
      wrapper: CommandScopeProvider,
    });
    try {
      await act(async () => {
        fireEvent.keyDown(window, { key: 's', code: 'KeyS', metaKey: true });
        fireEvent.keyDown(window, { key: 's', code: 'KeyS', ctrlKey: true });
        await vi.waitFor(() => expect(writeTextFile).toHaveBeenCalledOnce());
      });
      expect(writeTextFile.mock.calls[0][0]).toBe('/test/other.gb');
      expect(useSequenceStore.getState().isDirty(PATH)).toBe(true);
      expect(useSequenceStore.getState().isDirty(otherId)).toBe(false);
    } finally {
      commands.unmount();
      first.unmount();
      second.unmount();
      useCanvasStore.setState(canvas);
    }
  });

  it('serializes and writes the dirty sequence (incl. committed annotations) to disk', async () => {
    useSequenceStore.getState().setSequence(PATH, makeSequence([]));
    dirtyWithAnnotation(PATH, committedAnnotation);

    const { result, onSaveComplete } = mountSave();

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.save();
    });

    expect(ok).toBe(true);
    expect(writeTextFile).toHaveBeenCalledTimes(1);
    const [writtenPath, contents] = writeTextFile.mock.calls[0];
    expect(writtenPath).toBe(FILE_PATH);
    expect(contents).toContain('AmpR');
    expect(contents).toContain('pLannotate');
    expect(useSequenceStore.getState().isDirty(PATH)).toBe(false);
    expect(onSaveComplete).toHaveBeenCalledTimes(1);
  });

  it('saves a renamed managed annotation ID and does not reuse it after delete and add', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const managed: Annotation = {
      ...committedAnnotation,
      qualifiers: { ...committedAnnotation.qualifiers, dnaforge_ann_id: [id] },
    };
    useSequenceStore.getState().setSequence(PATH, makeSequence([managed]));
    useSequenceStore.getState().updateAnnotation(PATH, 0, {
      name: 'renamed',
      type: managed.type,
      direction: managed.direction,
      color: managed.color ?? '#000000',
      start: managed.start,
      end: managed.end,
    });
    const { result } = mountSave();
    await act(async () => {
      expect(await result.current.save()).toBe(true);
    });
    expect(writeTextFile.mock.lastCall?.[1]).toContain(`/dnaforge_ann_id="${id}"`);

    act(() => useSequenceStore.getState().deleteAnnotation(PATH, 0));
    await act(async () => {
      expect(await result.current.save()).toBe(true);
    });
    expect(writeTextFile.mock.lastCall?.[1]).not.toContain(id);

    act(() =>
      useSequenceStore.getState().addAnnotation(PATH, {
        ...committedAnnotation,
        name: 'new annotation',
      })
    );
    await act(async () => {
      expect(await result.current.save()).toBe(true);
    });
    expect(writeTextFile.mock.lastCall?.[1]).toContain('new annotation');
    expect(writeTextFile.mock.lastCall?.[1]).not.toContain(id);
  });

  it('does not resolve a save before asynchronous commit publication settles', async () => {
    useSequenceStore.getState().setSequence(PATH, makeSequence([]));
    dirtyWithAnnotation(PATH, committedAnnotation);
    let resolveCompletion!: (value: SequenceDocumentSaveCompletion) => void;
    const completion = {
      promise: new Promise<SequenceDocumentSaveCompletion>((resolve) => {
        resolveCompletion = resolve;
      }),
      resolve: (value: SequenceDocumentSaveCompletion) => resolveCompletion(value),
    };
    const onSaveComplete = vi.fn(() => completion.promise);
    const { result } = mountSave(undefined, false, onSaveComplete);

    let settled = false;
    let saving!: Promise<boolean>;
    await act(async () => {
      saving = result.current.save();
      void saving.then(() => {
        settled = true;
      });
      await vi.waitFor(() => expect(onSaveComplete).toHaveBeenCalledOnce());
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await act(async () => {
      completion.resolve({ status: 'committed', repositoryRoot: '/test' });
      expect(await saving).toBe(true);
    });
    expect(settled).toBe(true);
  });

  it('never writes a dirty sequence opened from a read-only reference project', async () => {
    useSequenceStore.getState().setSequence(PATH, makeSequence([committedAnnotation]));
    typeBases('GGG');
    expect(useSequenceStore.getState().isDirty(PATH)).toBe(true);
    const { result } = mountSave(undefined, true);

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.save();
    });

    expect(ok).toBe(false);
    expect(writeTextFile).not.toHaveBeenCalled();
    expect(useSequenceStore.getState().isDirty(PATH)).toBe(true);
    expect(useSequenceStore.getState().sequences[PATH]?.sequence).toBe('GGG' + 'ATGC'.repeat(250));
  });

  it('automatically retries an edit that lands during a write without another save gesture', async () => {
    useSequenceStore.getState().setSequence(PATH, makeSequence([committedAnnotation]));
    typeBases('CCCC');

    let finishFirstWrite: (() => void) | undefined;
    writeTextFile.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishFirstWrite = resolve))
    );
    const { result } = mountSave();

    let firstSave: Promise<boolean> | undefined;
    await act(async () => {
      firstSave = result.current.save();
      await Promise.resolve();
    });
    expect(writeTextFile).toHaveBeenCalledTimes(1);
    expect(writeTextFile.mock.calls[0]?.[1]).toContain('CCCCATGC');

    dirtyWithAnnotation();

    let saveResult: boolean | undefined;
    await act(async () => {
      finishFirstWrite?.();
      saveResult = await firstSave;
    });

    expect(saveResult).toBe(true);
    expect(writeTextFile).toHaveBeenCalledTimes(2);
    expect(writeTextFile.mock.calls[1]?.[1]).toContain('CCCCATGC');
    expect(writeTextFile.mock.calls[1]?.[1]).toContain('late-edit');
    const working = useSequenceStore.getState().sequences[PATH];
    expect(working?.sequence).toBe('CCCC' + 'ATGC'.repeat(250));
    expect(working?.annotations).toContainEqual(lateEdit);
    expect(useSequenceStore.getState().isDirty(PATH)).toBe(false);
    expect(useSequenceStore.getState().drafts[PATH]?.insertedRanges).toEqual([]);
  });

  it('acknowledges only the captured revision: bases typed during a write stay dirty', async () => {
    useSequenceStore.getState().setSequence(PATH, makeSequence([]));
    typeBases('AAA');
    let finishWrite: (() => void) | undefined;
    writeTextFile
      .mockImplementationOnce(() => new Promise<void>((resolve) => (finishWrite = resolve)))
      .mockRejectedValue(new Error('EACCES'));
    const { result } = mountSave();

    let saving: Promise<boolean> | undefined;
    await act(async () => {
      saving = result.current.save();
      await Promise.resolve();
    });
    typeBases('GG', 3);

    let ok: boolean | undefined;
    await act(async () => {
      finishWrite?.();
      ok = await saving;
    });

    expect(ok).toBe(false);
    expect(useSequenceStore.getState().isDirty(PATH)).toBe(true);
    expect(useSequenceStore.getState().sequences[PATH]?.sequence).toBe(
      'AAAGG' + 'ATGC'.repeat(250)
    );
    expect(useSequenceStore.getState().savedSequences[PATH]?.sequence).toBe(
      'AAA' + 'ATGC'.repeat(250)
    );
    expect(useSequenceStore.getState().drafts[PATH]?.insertedRanges).toEqual([
      { start: 0, end: 5 },
    ]);
  });

  it('bounds automatic retries when edits keep racing every write', async () => {
    useSequenceStore.getState().setSequence(PATH, makeSequence([committedAnnotation]));
    dirtyWithAnnotation();
    let raced = 0;
    writeTextFile.mockImplementation(async () => {
      raced += 1;
      dirtyWithAnnotation(PATH, { ...lateEdit, name: `raced-${raced}` });
    });

    const { result, onSaveComplete } = mountSave();

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.save();
    });

    expect(ok).toBe(false);
    expect(writeTextFile).toHaveBeenCalledTimes(3);
    expect(useSequenceStore.getState().isDirty(PATH)).toBe(true);
    expect(onSaveComplete).toHaveBeenCalledTimes(1);
  });

  it('surfaces an error toast and stays dirty when the write fails (no silent loss)', async () => {
    useSequenceStore.getState().setSequence(PATH, makeSequence([committedAnnotation]));
    typeBases('TTT');
    writeTextFile.mockRejectedValueOnce(new Error('EACCES: disk full'));

    const { result, onSaveComplete } = mountSave();

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.save();
    });

    expect(ok).toBe(false);
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].type).toBe('error');
    expect(toasts[0].message).toContain("Couldn't save pUC19.gb");
    expect(toasts[0].message).not.toContain('EACCES');
    expect(toasts[0].duration).toBe(0);
    expect(useSequenceStore.getState().isDirty(PATH)).toBe(true);
    expect(useSequenceStore.getState().sequences[PATH]?.sequence).toBe('TTT' + 'ATGC'.repeat(250));
    expect(useSequenceStore.getState().drafts[PATH]?.insertedRanges).toEqual([
      { start: 0, end: 3 },
    ]);
    expect(onSaveComplete).not.toHaveBeenCalled();
  });

  it.each([
    [
      'native EACCES',
      new Error(
        "Error invoking remote method 'fs:sequenceDocument': NativeDocumentCommandError: SEQUENCE_SAVE_FAILED: EACCES: permission denied, open '/private/fixture/pUC19.gb'"
      ),
    ],
    [
      'native EPERM',
      new Error(
        "Error invoking remote method 'fs:sequenceDocument': NativeDocumentCommandError: SEQUENCE_SAVE_FAILED: EPERM: operation not permitted, open '/private/fixture/pUC19.gb'"
      ),
    ],
    [
      'native EROFS',
      new Error(
        "Error invoking remote method 'fs:sequenceDocument': NativeDocumentCommandError: SEQUENCE_SAVE_FAILED: EROFS: read-only file system, open '/private/fixture/pUC19.gb'"
      ),
    ],
    [
      'structured EACCES',
      Object.assign(new Error('Private operating-system detail'), { code: 'EACCES' }),
    ],
  ])(
    'keeps the captured draft and offers private-safe write-permission recovery for %s',
    async (_name, error) => {
      useSequenceStore.getState().setSequence(PATH, makeSequence([]));
      typeBases('TTT');
      const captured = useSequenceStore.getState().captureForSave(PATH);
      saveSequenceDocument.mockRejectedValueOnce(error);
      const { result, onSaveComplete } = mountSave();
      await act(async () => expect(await result.current.save()).toBe(false));
      const message = useToastStore.getState().toasts[0].message;
      expect(message).toContain("Couldn't save pUC19.gb");
      expect(message).toContain('Check its write permission.');
      expect(message).not.toContain('/private/fixture');
      expect(message).not.toContain('fs:sequenceDocument');
      expect(message).not.toContain('EACCES');
      expect(message).not.toContain('EPERM');
      expect(message).not.toContain('EROFS');
      expect(useSequenceStore.getState().captureForSave(PATH)).toEqual(captured);
      expect(useSequenceStore.getState().isDirty(PATH)).toBe(true);
      expect(onSaveComplete).not.toHaveBeenCalled();
      await act(async () => expect(await result.current.save()).toBe(true));
      expect(useSequenceStore.getState().sequences[PATH]?.sequence).toBe(
        captured?.sequence.sequence
      );
      expect(useSequenceStore.getState().isDirty(PATH)).toBe(false);
      expect(onSaveComplete).toHaveBeenCalledOnce();
      expect(useToastStore.getState().toasts).toHaveLength(0);
    }
  );

  it.each([
    "Error invoking remote method 'fs:sequenceDocument': NativeDocumentCommandError: FILE_CHANGED: /private/EACCES: fixture.gb",
    'ENOSPC: no space left on device',
    'Private diagnostic mentions EACCES: without an operating-system error prefix',
  ])('keeps unrelated failures generic without exposing diagnostic text: %s', async (message) => {
    useSequenceStore.getState().setSequence(PATH, makeSequence([]));
    typeBases('TTT');
    saveSequenceDocument.mockRejectedValueOnce(new Error(message));
    const { result } = mountSave();
    await act(async () => expect(await result.current.save()).toBe(false));
    expect(useToastStore.getState().toasts[0].message).toBe(
      "Couldn't save pUC19.gb. Your changes are still open. Try saving again, or discard your changes."
    );
    expect(useSequenceStore.getState().isDirty(PATH)).toBe(true);
  });

  it.each([
    [
      'native channel',
      new Error(
        "Error invoking remote method 'fs:sequenceDocument': NativeDocumentCommandError: SEQUENCE_DOCUMENT_BINDING_CHANGED: /private/original.gb -> /private/other.gb"
      ),
    ],
    [
      'direct code prefix',
      new Error('SEQUENCE_DOCUMENT_BINDING_CHANGED: Private diagnostic detail'),
    ],
    [
      'structured code',
      Object.assign(new Error('Private diagnostic detail'), {
        code: 'SEQUENCE_DOCUMENT_BINDING_CHANGED',
      }),
    ],
  ])('keeps the captured draft and offers location recovery for %s', async (_label, failure) => {
    useSequenceStore.getState().setSequence(PATH, makeSequence([]));
    typeBases('TTT');
    const capture = useSequenceStore.getState().captureForSave(PATH);
    saveSequenceDocument.mockRejectedValueOnce(failure);
    const { result, onSaveComplete } = mountSave();
    await act(async () => expect(await result.current.save()).toBe(false));
    const message = useToastStore.getState().toasts[0].message;
    expect(message).toContain("Couldn't save pUC19.gb");
    expect(message).toContain('The document location changed.');
    expect(message).toContain('Your changes are still open.');
    expect(message).not.toContain('/private/');
    expect(message).not.toContain('SEQUENCE_DOCUMENT_BINDING_CHANGED');
    expect(message).not.toContain('fs:sequenceDocument');
    expect(useSequenceStore.getState().captureForSave(PATH)).toEqual(capture);
    expect(useSequenceStore.getState().isDirty(PATH)).toBe(true);
    expect(onSaveComplete).not.toHaveBeenCalled();
    await act(async () => expect(await result.current.save()).toBe(true));
    expect(useSequenceStore.getState().isDirty(PATH)).toBe(false);
    expect(onSaveComplete).toHaveBeenCalledOnce();
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it.each([
    "Error invoking remote method 'fs:sequenceDocument': NativeDocumentCommandError: FILE_CHANGED: /private/SEQUENCE_DOCUMENT_BINDING_CHANGED.gb",
    'Private diagnostic mentions SEQUENCE_DOCUMENT_BINDING_CHANGED: without a command error prefix',
    "Error invoking remote method 'other:command': Error: SEQUENCE_DOCUMENT_BINDING_CHANGED: /private/fixture.gb",
  ])('keeps unrelated location diagnostics generic: %s', async (message) => {
    useSequenceStore.getState().setSequence(PATH, makeSequence([]));
    typeBases('TTT');
    const capture = useSequenceStore.getState().captureForSave(PATH);
    saveSequenceDocument.mockRejectedValueOnce(new Error(message));
    const { result, onSaveComplete } = mountSave();
    await act(async () => expect(await result.current.save()).toBe(false));
    expect(useToastStore.getState().toasts[0].message).toBe(
      "Couldn't save pUC19.gb. Your changes are still open. Try saving again, or discard your changes."
    );
    expect(useSequenceStore.getState().captureForSave(PATH)).toEqual(capture);
    expect(useSequenceStore.getState().isDirty(PATH)).toBe(true);
    expect(onSaveComplete).not.toHaveBeenCalled();
  });

  it('hides native save details and dismisses the error after discarding an empty draft', async () => {
    useSequenceStore.getState().setSequence(PATH, {
      ...makeSequence([]),
      sequence: '',
      length: 0,
    });
    typeBases('ACGT');
    saveSequenceDocument.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'fs:saveSequenceDocument': Error: The document has no unique current catalog file."
      )
    );
    const { result } = mountSave(undefined, false, vi.fn(), 'C:\\Users\\example\\test.gb');
    await act(async () => expect(await result.current.save()).toBe(false));
    expect(useToastStore.getState().toasts[0].message).toBe(
      "Couldn't save test.gb. Your changes are still open. Try saving again, or discard your changes."
    );
    expect(useSequenceStore.getState().sequences[PATH].sequence).toBe('ACGT');
    expect(result.current.isDirty).toBe(true);
    act(() => {
      useSequenceStore.getState().discardEdits(PATH);
    });
    expect(result.current.isDirty).toBe(false);
    expect(useSequenceStore.getState().sequences[PATH].sequence).toBe('');
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('is a no-op (returns true, no write) when the file is not dirty', async () => {
    useSequenceStore.getState().setSequence(PATH, makeSequence([committedAnnotation]));

    const { result } = mountSave();

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.save();
    });

    expect(ok).toBe(true);
    expect(writeTextFile).not.toHaveBeenCalled();
  });

  it('forwards an Apply capture even when the dirty projection says clean', async () => {
    useSequenceStore.getState().setSequence(PATH, makeSequence([]));
    dirtyWithAnnotation(PATH, {
      ...committedAnnotation,
      qualifiers: { dnaforge_operation_id: ['annotation-operation-live'] },
    });
    const edited = useSequenceStore.getState();
    useSequenceStore.setState({
      sequenceVersions: { ...edited.sequenceVersions, [PATH]: 1 },
      savedVersions: { ...edited.savedVersions, [PATH]: 1 },
      dirtyPaths: {},
    });
    const requiredCapture = useSequenceStore.getState().captureForSave(PATH)!;
    const { result, onSaveComplete } = mountSave();

    let persistence: Awaited<ReturnType<typeof result.current.save>> | undefined;
    await act(async () => {
      persistence = await result.current.save(requiredCapture);
    });

    expect(persistence).toEqual({
      ok: true,
      outcome: 'saved',
      attempts: 1,
      wrote: true,
      writtenRevision: requiredCapture.revision,
    });
    expect(writeTextFile).toHaveBeenCalledWith(
      FILE_PATH,
      expect.stringContaining('dnaforge_operation_id')
    );
    expect(useSequenceStore.getState().savedSequences[PATH]?.annotations).toEqual(
      useSequenceStore.getState().sequences[PATH]?.annotations
    );
    expect(onSaveComplete).toHaveBeenCalledOnce();
  });

  it('dedups the save-failure toast across repeated failed saves (no unbounded stacking)', async () => {
    useSequenceStore.getState().setSequence(PATH, makeSequence([committedAnnotation]));
    dirtyWithAnnotation();
    writeTextFile.mockRejectedValue(new Error('EACCES: read-only file system'));

    const { result } = mountSave();

    await act(async () => {
      await result.current.save();
    });
    await act(async () => {
      await result.current.save();
    });

    expect(useToastStore.getState().toasts).toHaveLength(1);
    expect(useSequenceStore.getState().isDirty(PATH)).toBe(true);
  });

  it('refuses to overwrite SnapGene source files with serialized GenBank text', async () => {
    const snapgeneSequence = attachSequenceDocumentMetadata(
      {
        ...makeSequence([committedAnnotation]),
        id: SNAPGENE_PATH,
        name: 'sample-f',
      },
      {
        format: 'snapgene',
        source: {
          path: SNAPGENE_FILE_PATH,
          filename: 'sample-f.dna',
          binary: true,
        },
        capabilities: getSequenceFormatCapabilities('snapgene'),
      }
    );
    useSequenceStore.getState().setSequence(SNAPGENE_PATH, snapgeneSequence);
    dirtyWithAnnotation(SNAPGENE_PATH);

    const onSaveComplete = vi
      .fn<() => Promise<SequenceDocumentSaveCompletion>>()
      .mockResolvedValue({ status: 'not-a-repository' });
    const { result } = renderHook(() =>
      useSequencePersistence({
        documentId: SNAPGENE_PATH,
        filePath: SNAPGENE_FILE_PATH,
        sequence: useSequenceStore.getState().sequences[SNAPGENE_PATH] ?? null,
        onSaveComplete,
        onExternalReload: vi.fn(),
      })
    );

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.save();
    });

    expect(ok).toBe(false);
    expect(writeTextFile).not.toHaveBeenCalled();
    expect(useSequenceStore.getState().isDirty(SNAPGENE_PATH)).toBe(true);
    expect(onSaveComplete).not.toHaveBeenCalled();
    const [toast] = useToastStore.getState().toasts;
    expect(toast.type).toBe('error');
    expect(toast.message).toContain('sample-f.dna');
    expect(toast.message).toContain('Try saving again, or discard your changes.');
  });

  it('dismisses the save-failure toast once a later save succeeds', async () => {
    useSequenceStore.getState().setSequence(PATH, makeSequence([committedAnnotation]));
    dirtyWithAnnotation();
    writeTextFile.mockRejectedValueOnce(new Error('EACCES')).mockResolvedValue(undefined);

    const { result } = mountSave();

    await act(async () => {
      await result.current.save();
    });
    expect(useToastStore.getState().toasts).toHaveLength(1);

    expect(useSequenceStore.getState().isDirty(PATH)).toBe(true);
    await act(async () => {
      await result.current.save();
    });
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('keeps a rich-paste draft recoverable until copied primer bindings persist', async () => {
    useSequenceStore.getState().setSequence(PATH, makeSequence([]));
    useSequenceStore.getState().dispatchEdit(PATH, { type: 'SET_CURSOR', position: 4 });
    useSequenceStore.getState().dispatchEdit(PATH, {
      type: 'INSERT_FRAGMENT',
      fragment: {
        sequence: 'GGCC',
        annotations: [{ name: 'pasted', type: 'misc_feature', start: 1, end: 4, direction: 1 }],
        primerBindings: [
          { primerId: 'primer-1', start: 0, end: 4, strand: 1, sourceWorkspaceRoot: '/test' },
        ],
      },
    });
    const persistBindings = vi
      .fn()
      .mockRejectedValueOnce(new Error('primer artifact is temporarily locked'))
      .mockResolvedValueOnce(undefined);
    const { result, onSaveComplete } = mountSave(persistBindings);

    let firstSave: boolean | undefined;
    await act(async () => {
      firstSave = await result.current.save();
    });

    expect(firstSave).toBe(false);
    expect(writeTextFile).toHaveBeenCalledTimes(1);
    expect(parseGenBankFull(String(writeTextFile.mock.calls[0]?.[1])).sequence).toBe(
      'ATGCGGCC' + 'ATGC'.repeat(249)
    );
    expect(persistBindings).toHaveBeenCalledWith(
      [
        {
          pendingId: expect.any(String),
          primerId: 'primer-1',
          start: 4,
          end: 8,
          strand: 1,
          sourceWorkspaceRoot: '/test',
        },
      ],
      { draftLineageId: expect.any(String), expectedFileSha256: expect.any(String) }
    );
    const capturedOwnership = persistBindings.mock.calls[0];
    expect(useSequenceStore.getState().isDirty(PATH)).toBe(true);
    expect(useSequenceStore.getState().drafts[PATH]?.pendingPrimerBindings).toHaveLength(1);
    expect(onSaveComplete).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts[0].message).toContain(
      'copied primer bindings could not be attached'
    );

    let retry: boolean | undefined;
    await act(async () => {
      retry = await result.current.save();
    });

    expect(retry).toBe(true);
    expect(persistBindings).toHaveBeenCalledTimes(2);
    expect(persistBindings.mock.calls[1]).toEqual(capturedOwnership);
    expect(useSequenceStore.getState().isDirty(PATH)).toBe(false);
    expect(useSequenceStore.getState().drafts[PATH]?.pendingPrimerBindings).toEqual([]);
    expect(useSequenceStore.getState().sequences[PATH]?.annotations).toEqual([
      { name: 'pasted', type: 'misc_feature', start: 5, end: 8, direction: 1 },
    ]);
    expect(onSaveComplete).toHaveBeenCalledTimes(1);
  });
});
