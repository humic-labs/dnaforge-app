import { userMessage } from '@waypoint/user-messages';
import 'fake-indexeddb/auto';
import { createHash, webcrypto } from 'node:crypto';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TextViewerTab } from './TextViewerTab';
import { getFileDocumentClient } from '../features/workspace/public/file-document-client';
import { Panel } from '../features/canvas/components/Panel';
import { CommandScopeProvider } from '../commands/CommandScopeProvider';
import { useCanvasStore } from '../features/canvas/store';
import type { Tab } from '../features/canvas/types';
import type { SaveDocumentTarget } from '../shared/save-document-events';
import { documentLifecycle } from '../shared/document-lifecycle';
type SaveResult = SaveDocumentTarget & {
  requestId: string;
  sourceTabId?: string;
  success: boolean;
};
const saveDocument = documentLifecycle.save.bind(documentLifecycle);
import { deleteAllUnsavedDrafts } from '../shared/unsaved-draft-recovery';
import {
  NativeFileDocumentOwner,
  type NativeFileDocumentRecord,
} from '../main/file-document-owner';
import type { FileDocumentRequest, FileDocumentSnapshot } from '../shared/file-document';
import { useToastStore } from '../stores/toast-store';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { saveAllUnsavedWork } from '../shared/dirty-reporter';
import type { TextFileAtomicWriteInput } from '../shared/text-file-atomic';

const io = vi.hoisted(() => ({
  files: new Map<string, string>(),
  writeTextFileAtomic: vi.fn<(input: TextFileAtomicWriteInput) => Promise<void>>(),
  fileDocument: vi.fn<(request: FileDocumentRequest) => Promise<FileDocumentSnapshot>>(),
  records: new Map<string, NativeFileDocumentRecord>(),
  storeRecord: vi.fn<(record: NativeFileDocumentRecord) => Promise<void>>(),
  listeners: new Set<(snapshot: FileDocumentSnapshot) => void>(),
}));

vi.mock('../platform', () => ({
  platform: () => ({
    fs: {
      stat: async (path: string) => ({ size: io.files.get(path)?.length ?? 0 }),
      readFile: async (path: string) => new TextEncoder().encode(io.files.get(path) ?? ''),
      writeTextFileAtomic: io.writeTextFileAtomic,
      fileDocument: io.fileDocument,
      subscribeFileDocuments: (listener: (snapshot: FileDocumentSnapshot) => void) => {
        io.listeners.add(listener);
        return () => io.listeners.delete(listener);
      },
    },
  }),
}));
vi.mock('../utils/environment', async (original) => ({
  ...(await original<typeof import('../utils/environment')>()),
  isBrowserOnly: () => false,
}));
vi.mock('../lib/workflow-telemetry', () => ({ observeWorkflowAction: vi.fn() }));
vi.mock('../features/sequence/save-all-sequences', () => ({
  saveAllDirtySequences: async () => ({ saved: 0, failed: [] }),
}));
vi.mock('../features/canvas/components/TabPortalTarget', () => ({
  TabPortalTarget: ({ tab }: { tab: Tab }) => (
    <div data-testid={`editor-${tab.id}`}>
      <TextViewerTab
        key={tab.id}
        filePath={tab.entityId}
        canvasTabId={tab.id}
        readOnly={tab.readOnly}
      />
    </div>
  ),
}));
vi.mock('./CodeEditor', () => ({
  default: ({
    value,
    onChange,
    onSave,
    readOnly,
  }: {
    value: string;
    onChange: (text: string) => void;
    onSave: () => Promise<boolean>;
    readOnly: boolean;
  }) => (
    <textarea
      aria-label="Text buffer"
      value={value}
      readOnly={readOnly}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 's' && event.metaKey) void onSave();
      }}
    />
  ),
}));

let filePath = '';
let caseNumber = 0;
const fingerprintText = (text: string) =>
  `sha256:${createHash('sha256').update(text).digest('hex')}`;
function retainedDraft() {
  const record = io.records.get(filePath);
  return record?.dirty ? { baseline: record.baseline, payload: record.content } : undefined;
}
function nativeOwner(readOnly = false) {
  const owner = new NativeFileDocumentOwner({
    admit: async (path) => ({
      path,
      workspaceRoot: '/synthetic',
      readOnly,
      assertCurrent() {},
    }),
    read: async (path) => new TextEncoder().encode(io.files.get(path) ?? ''),
    write: async (input) => io.writeTextFileAtomic(input),
    loadRecord: async (path) => io.records.get(path),
    resolveIdentity: async (id) =>
      [...io.records.values()].find((record) => record.documentId === id)?.path,
    storeRecord: io.storeRecord,
  });
  owner.subscribe((snapshot) => {
    for (const listener of io.listeners) listener(snapshot);
  });
  io.fileDocument.mockImplementation((request) => owner.execute(request, 'renderer'));
  return owner;
}
const baseline = 'baseline';
const editA = 'edit A';
const editB = 'edit B newer';
const editC = 'edit C newest';
type Write = {
  path: string;
  text: string;
  resolve: () => void;
  reject: (error: Error) => void;
};
let writes: Write[];
let completions: SaveResult[];
let tabId: string;

function Scene() {
  const panels = useCanvasStore((state) => state.panels);
  const focusedPanelId = useCanvasStore((state) => state.focusedPanelId);
  return (
    <CommandScopeProvider>
      {Object.values(panels).map((panel) => (
        <Panel key={panel.id} panel={panel} isFocused={panel.id === focusedPanelId} />
      ))}
    </CommandScopeProvider>
  );
}

function editor(id = tabId) {
  return within(screen.getByTestId(`editor-${id}`)).getByRole('textbox');
}
function edit(text: string, id = tabId) {
  fireEvent.change(editor(id), { target: { value: text } });
}
function save(id = tabId) {
  fireEvent.keyDown(editor(id), { key: 's', metaKey: true });
}
function closeAndSave(id = tabId) {
  fireEvent.click(screen.getByTestId(`tab-close-${id}`));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' }));
}
function stillOpen(id = tabId) {
  return Object.values(useCanvasStore.getState().panels).some((panel) =>
    panel.tabs.some((tab) => tab.id === id)
  );
}
async function mount() {
  render(<Scene />);
  await screen.findByDisplayValue(baseline);
}
async function finish(index: number, error?: Error) {
  const write = await waitFor(() => {
    const pending = writes[index];
    if (!pending) throw new Error(`Missing controlled write ${index}`);
    return pending;
  });
  await act(async () => {
    if (error) write.reject(error);
    else write.resolve();
  });
}

beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto);
  filePath = `/synthetic/case-${++caseNumber}/save-close.txt`;
  useWorkspaceStore.setState({ folders: [] });
  io.files.clear();
  io.records.clear();
  io.storeRecord.mockReset().mockImplementation(async (record) => {
    io.records.set(record.path, structuredClone(record));
  });
  nativeOwner();
  io.files.set(filePath, baseline);
  writes = [];
  completions = [];
  io.writeTextFileAtomic.mockReset();
  io.writeTextFileAtomic.mockImplementation(({ path, content: text, expectedContentHash }) => {
    const pending = Promise.withResolvers<void>();
    writes.push({
      path,
      text,
      resolve: () => {
        const diskHash = `sha256:${createHash('sha256')
          .update(io.files.get(path) ?? '')
          .digest('hex')}`;
        if (expectedContentHash !== diskHash) {
          pending.reject(new Error('FILE_CHANGED: controlled disk baseline changed'));
          return;
        }
        io.files.set(path, text);
        pending.resolve();
      },
      reject: pending.reject,
    });
    return pending.promise;
  });
  useCanvasStore.getState().reset();
  useToastStore.getState().clearToasts();
  await deleteAllUnsavedDrafts();
  tabId = useCanvasStore.getState().openTab('main', {
    type: 'text',
    entityId: filePath,
    label: 'save-close.txt',
  });
  vi.spyOn(documentLifecycle, 'save').mockImplementation(async (target, sourceTabId) => {
    const requestId = crypto.randomUUID();
    const success = await saveDocument(target, sourceTabId);
    completions.push({ ...target, sourceTabId, requestId, success });
    return success;
  });
});

afterEach(async () => {
  cleanup();
  await act(async () => {
    for (const write of writes) write.resolve();
  });
  vi.mocked(documentLifecycle.save).mockRestore();
  useCanvasStore.getState().reset();
  useToastStore.getState().clearToasts();
  await deleteAllUnsavedDrafts();
});

describe('text Save and Close durable revision', () => {
  it('retries a restored editor when its project is opened after admission failed', async () => {
    const owner = nativeOwner();
    io.fileDocument.mockImplementation((request) => {
      if (!useWorkspaceStore.getState().folders.some((folder) => folder.path === '/synthetic'))
        return Promise.reject(
          new Error('DOCUMENT_ADMISSION_FAILED: Absolute path is outside every open project.')
        );
      return owner.execute(request, 'renderer');
    });
    render(<Scene />);
    await waitFor(() => expect(screen.queryByText('Loading file...')).not.toBeInTheDocument());
    expect(screen.queryByRole('textbox', { name: 'Text buffer' })).not.toBeInTheDocument();
    act(() => useWorkspaceStore.getState().addFolder('/synthetic', 'Recovered project'));
    expect(await screen.findByRole('textbox', { name: 'Text buffer' })).toHaveValue(baseline);
    expect(io.files.get(filePath)).toBe(baseline);
    expect(io.writeTextFileAtomic).not.toHaveBeenCalled();
  });

  it('retains a dirty editor when its project becomes available', async () => {
    await mount();
    edit(editA);
    await waitFor(() => expect(retainedDraft()?.payload).toBe(editA));
    act(() => useWorkspaceStore.getState().addFolder('/synthetic', 'Recovered project'));
    expect(await screen.findByRole('textbox', { name: 'Text buffer' })).toHaveValue(editA);
    expect(io.files.get(filePath)).toBe(baseline);
    expect(io.writeTextFileAtomic).not.toHaveBeenCalled();
  });

  it('honors native read-only admission when the canvas tab has no read-only hint', async () => {
    nativeOwner(true);
    await mount();
    expect(screen.getByRole('textbox', { name: 'Text buffer' })).toHaveAttribute('readonly');
    edit(editA);
    expect(screen.getByRole('textbox', { name: 'Text buffer' })).toHaveValue(baseline);
    expect(io.writeTextFileAtomic).not.toHaveBeenCalled();
    expect(io.files.get(filePath)).toBe(baseline);
  });

  it('keeps a reopened view loading until its retired save owner settles', async () => {
    await mount();
    edit(editA);
    save();
    let replacement = '';
    act(() => {
      useCanvasStore.getState().closeTab('main', tabId);
      replacement = useCanvasStore.getState().openTab('main', {
        type: 'text',
        entityId: filePath,
        label: 'Reopened text',
      });
    });
    await act(async () => {});
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText('Loading file...')).toBeInTheDocument();
    await finish(0);
    await screen.findByDisplayValue(editA);
    edit(editB, replacement);
    await waitFor(async () =>
      expect(retainedDraft()).toMatchObject({
        baseline: fingerprintText(editA),
        payload: editB,
      })
    );
    expect(completions).toEqual([]);
    expect(stillOpen(replacement)).toBe(true);
  });

  it('does not recreate a discarded B draft when retired A finishes writing', async () => {
    await mount();
    edit(editA);
    save();
    edit(editB);
    await waitFor(async () => expect(retainedDraft()?.payload).toBe(editB));
    fireEvent.click(screen.getByTestId(`tab-close-${tabId}`));
    fireEvent.click(screen.getByRole('button', { name: "Don't Save" }));
    await waitFor(async () => expect(retainedDraft()).toMatchObject({ payload: editA }));
    await finish(0);
    expect(retainedDraft()).toBeUndefined();
    expect(io.files.get(filePath)).toBe(editA);
    expect(stillOpen()).toBe(false);
  });

  it('rebases retained B before A completes and offers B in a fresh recovery session', async () => {
    await mount();
    edit(editA);
    save();
    edit(editB);
    await waitFor(async () =>
      expect(retainedDraft()).toMatchObject({
        baseline: fingerprintText(baseline),
        payload: editB,
      })
    );
    await finish(0);
    expect(io.files.get(filePath)).toBe(editA);
    expect(retainedDraft()).toMatchObject({
      baseline: fingerprintText(editA),
      payload: editB,
    });
    cleanup();
    useToastStore.getState().clearToasts();
    nativeOwner();
    render(<Scene />);
    await screen.findByDisplayValue(editA);
    await waitFor(() =>
      expect(
        useToastStore
          .getState()
          .toasts.some((toast) => toast.definition === 'unsaved-draft-recovery-available')
      ).toBe(true)
    );
    const offer = useToastStore
      .getState()
      .toasts.find((toast) => toast.definition === 'unsaved-draft-recovery-available');
    if (!offer) throw new Error('Missing native recovery offer');
    await act(async () => {
      useToastStore.getState().invokeToastAction(offer.id, 0);
    });
    await screen.findByDisplayValue(editB);
    expect(io.files.get(filePath)).toBe(editA);
    expect(retainedDraft()).toMatchObject({ baseline: fingerprintText(editA), payload: editB });
  });

  it.each(['before draft retention', 'after draft retention'])(
    'waits for B after an in-flight A save, %s',
    async (schedule) => {
      await mount();
      edit(editA);
      save();
      await waitFor(() => expect(writes.map((write) => write.text)).toEqual([editA]));
      edit(editB);
      if (schedule === 'after draft retention') {
        await waitFor(async () => expect(retainedDraft()?.payload).toBe(editB));
      }
      closeAndSave();
      await finish(0);
      expect(stillOpen()).toBe(true);
      expect(completions).toEqual([]);
      expect(io.files.get(filePath)).toBe(editA);
      await waitFor(() => expect(writes.map((write) => write.text)).toEqual([editA, editB]));
      await finish(1);
      expect(io.files.get(filePath)).toBe(editB);
      await waitFor(() => expect(stillOpen()).toBe(false));
      expect(completions).toHaveLength(1);
      expect(completions[0]?.success).toBe(true);
    }
  );

  it('saves C typed during B before closing', async () => {
    await mount();
    edit(editA);
    save();
    edit(editB);
    closeAndSave();
    await finish(0);
    expect(stillOpen()).toBe(true);
    await waitFor(() => expect(writes[1]?.text).toBe(editB));
    edit(editC);
    await finish(1);
    expect(stillOpen()).toBe(true);
    expect(completions).toEqual([]);
    await waitFor(() => expect(writes.map((write) => write.text)).toEqual([editA, editB, editC]));
    await finish(2);
    await waitFor(() => expect(stillOpen()).toBe(false));
    expect(io.files.get(filePath)).toBe(editC);
  });

  it('retains C typed during the recovery rebase when its follow-up write fails', async () => {
    await mount();
    edit(editA);
    save();
    edit(editB);
    closeAndSave();
    const put = io.storeRecord.getMockImplementation();
    if (!put) throw new Error('Missing native recovery store');
    let editedDuringRebase = false;
    io.storeRecord.mockImplementation((value: NativeFileDocumentRecord) => {
      const result = put(value);
      if (
        !editedDuringRebase &&
        typeof value === 'object' &&
        value !== null &&
        'baseline' in value &&
        value.baseline === fingerprintText(editA) &&
        value.content === editB
      ) {
        editedDuringRebase = true;
        edit(editC);
      }
      return result;
    });
    try {
      await finish(0);
      await waitFor(() => expect(writes[1]?.text).toBe(editB));
      expect(editedDuringRebase).toBe(true);
      expect(editor()).toHaveValue(editC);
      await finish(1);
      await waitFor(() => expect(writes[2]?.text).toBe(editC));
      await finish(2, new Error('controlled C write failure'));
      expect(stillOpen()).toBe(true);
      expect(editor()).toHaveValue(editC);
      expect(retainedDraft()).toMatchObject({
        baseline: fingerprintText(editB),
        payload: editC,
      });
      closeAndSave();
      await finish(3);
      await waitFor(() => expect(stillOpen()).toBe(false));
      expect(io.files.get(filePath)).toBe(editC);
    } finally {
      io.storeRecord.mockImplementation(put);
    }
  });

  it('keeps B editable and recoverable after a failed follow-up, then retries B', async () => {
    await mount();
    edit(editA);
    save();
    edit(editB);
    closeAndSave();
    await finish(0);
    expect(stillOpen()).toBe(true);
    await finish(1, new Error('controlled B write failure'));
    expect(stillOpen()).toBe(true);
    expect(editor()).toHaveValue(editB);
    expect(completions.map((result) => result.success)).toEqual([false]);
    expect(
      useToastStore
        .getState()
        .toasts.some((toast) => toast.message === userMessage('failure.failed-to-save-file'))
    ).toBe(true);
    await waitFor(async () =>
      expect(retainedDraft()).toMatchObject({
        baseline: fingerprintText(editA),
        payload: editB,
      })
    );
    closeAndSave();
    await waitFor(() => expect(writes[2]?.text).toBe(editB));
    await finish(2);
    expect(io.files.get(filePath)).toBe(editB);
    await waitFor(() => expect(stillOpen()).toBe(false));
  });

  it('records the original write failure while retaining the unsaved text', async () => {
    await mount();
    const failure = new Error('EACCES: text write denied');
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      edit(editA);
      save();
      await finish(0, failure);
      expect(report).toHaveBeenCalledWith(
        '[TextViewerTab] Save failed:',
        { filePath, tabId, documentId: io.records.get(filePath)?.documentId },
        failure
      );
      expect(io.records.get(filePath)?.documentId).toMatch(/^file-document:/);
      expect(editor()).toHaveValue(editA);
      expect(io.files.get(filePath)).toBe(baseline);
      expect(stillOpen()).toBe(true);
    } finally {
      report.mockRestore();
    }
  });

  it('preserves an unacknowledged newer edit when an older save fails', async () => {
    const writeFailure = new Error('EACCES: older save denied');
    const editFailure = new Error('Edit transaction was not acknowledged');
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await mount();
      edit(editA);
      save();
      await waitFor(() => expect(writes).toHaveLength(1));
      const execute = io.fileDocument.getMockImplementation();
      if (!execute) throw new Error('Missing native document executor');
      io.fileDocument.mockImplementation((request) =>
        request.operation.kind === 'text-transaction'
          ? Promise.reject(editFailure)
          : execute(request)
      );
      edit(editB);
      const client = getFileDocumentClient(filePath);
      await waitFor(() => expect(client.error).toBe(editFailure.message));
      await finish(0, writeFailure);
      expect(editor()).toHaveValue(editB);
      expect(client.content).toBe(editB);
      expect(client.error).toBe(editFailure.message);
      expect(io.files.get(filePath)).toBe(baseline);
      save();
      await waitFor(() =>
        expect(
          report.mock.calls.some((call) =>
            call.some(
              (value) =>
                value instanceof Error &&
                value.message.includes('FILE_DOCUMENT_CLIENT_UNSYNCHRONIZED')
            )
          )
        ).toBe(true)
      );
      expect(writes).toHaveLength(1);
      expect(editor()).toHaveValue(editB);
      expect(io.files.get(filePath)).toBe(baseline);
    } finally {
      report.mockRestore();
    }
  });

  it('reports the original write failure if completion inspection also fails', async () => {
    const failure = new Error('EACCES: original text write denied');
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await mount();
      edit(editA);
      save();
      await waitFor(() => expect(writes).toHaveLength(1));
      const execute = io.fileDocument.getMockImplementation();
      if (!execute) throw new Error('Missing native document executor');
      io.fileDocument.mockImplementation((request) =>
        request.operation.kind === 'inspect'
          ? Promise.reject(new Error('Completion status unavailable'))
          : execute(request)
      );
      await finish(0, failure);
      expect(report).toHaveBeenCalledWith(
        '[TextViewerTab] Save failed:',
        { filePath, tabId, documentId: io.records.get(filePath)?.documentId },
        failure
      );
      expect(editor()).toHaveValue(editA);
      expect(io.files.get(filePath)).toBe(baseline);
    } finally {
      report.mockRestore();
    }
  });

  it.each(['deferred', 'immediate'] as const)(
    'enables the Save button after a %s write failure and retries through that button',
    async (timing) => {
      const failure = new Error('EACCES: controlled text write denied');
      const report = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        if (timing === 'immediate') io.writeTextFileAtomic.mockRejectedValueOnce(failure);
        await mount();
        edit(editA);
        save();
        if (timing === 'deferred') await finish(0, failure);
        await waitFor(() => expect(report).toHaveBeenCalled());
        await waitFor(() =>
          expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()
        );
        expect(editor()).toHaveValue(editA);
        expect(io.files.get(filePath)).toBe(baseline);
        fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
        await finish(timing === 'deferred' ? 1 : 0);
        expect(io.files.get(filePath)).toBe(editA);
        expect(stillOpen()).toBe(true);
      } finally {
        report.mockRestore();
      }
    }
  );

  it('shares same-revision keyboard, editor, and close requests in one write', async () => {
    await mount();
    edit(editA);
    save();
    save();
    closeAndSave();
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(completions).toEqual([]);
    await finish(0);
    expect(io.files.get(filePath)).toBe(editA);
    await waitFor(() => expect(stillOpen()).toBe(false));
    expect(completions).toHaveLength(1);
  });

  it('waits for a retired owner at the same path without accepting its close receipt', async () => {
    await mount();
    edit(editA);
    closeAndSave();
    let replacement = '';
    act(() => {
      useCanvasStore.getState().closeTab('main', tabId);
      replacement = useCanvasStore.getState().openTab('main', {
        type: 'text',
        entityId: filePath,
        label: 'Reopened text',
      });
    });
    await act(async () => {});
    expect(screen.getByText('Loading file...')).toBeInTheDocument();
    await waitFor(() => expect(writes).toHaveLength(1));
    await finish(0);
    await screen.findByDisplayValue(editA);
    edit(editB, replacement);
    closeAndSave(replacement);
    expect(stillOpen(replacement)).toBe(true);
    expect(completions.map((result) => result.success)).toEqual([false]);
    await waitFor(() => expect(writes.map((write) => write.text)).toEqual([editA, editB]));
    await finish(1);
    expect(io.files.get(filePath)).toBe(editB);
    await waitFor(() => expect(stillOpen(replacement)).toBe(false));
    expect(completions.map((result) => result.success)).toEqual([false, true]);
  });

  it('ignores a prior request result during a deliberate retry for the same document', async () => {
    await mount();
    edit(editA);
    closeAndSave();
    await finish(0, new Error('first request failed'));
    const prior = completions[0];
    expect(prior).toBeDefined();
    edit(editB);
    closeAndSave();
    expect(prior.success).toBe(false);
    expect(stillOpen()).toBe(true);
    expect(editor()).toHaveValue(editB);
    await finish(1);
    await waitFor(() => expect(stillOpen()).toBe(false));
    expect(io.files.get(filePath)).toBe(editB);
  });

  it('shares a duplicate view draft while closing only the requested view', async () => {
    const secondPanel = useCanvasStore.getState().splitPanel('main', 'vertical');
    const sibling = useCanvasStore.getState().openTab(secondPanel, {
      type: 'text',
      entityId: filePath,
      label: 'Duplicate text',
    });
    render(<Scene />);
    await screen.findAllByDisplayValue(baseline);
    await waitFor(() => expect(editor(sibling)).toHaveValue(baseline));
    edit(editB);
    expect(
      useCanvasStore.getState().panels.main.tabs.find((tab) => tab.id === tabId)?.isDirty
    ).toBe(true);
    expect(
      useCanvasStore.getState().panels[secondPanel]?.tabs.find((tab) => tab.id === sibling)?.isDirty
    ).toBe(true);
    expect(editor(sibling)).toHaveValue(editB);
    closeAndSave();
    await act(async () => {});
    expect(stillOpen()).toBe(true);
    expect(completions).toEqual([]);
    await waitFor(() => expect(writes.map((write) => write.text)).toEqual([editB]));
    await finish(0);
    await waitFor(() => expect(stillOpen()).toBe(false));
    expect(stillOpen(sibling)).toBe(true);
    expect(io.files.get(filePath)).toBe(editB);
  });

  it('save-all publishes the shared file once and acknowledges each dirty view', async () => {
    const secondPanel = useCanvasStore.getState().splitPanel('main', 'vertical');
    const sibling = useCanvasStore.getState().openTab(secondPanel, {
      type: 'text',
      entityId: filePath,
      label: 'Duplicate text',
    });
    render(<Scene />);
    await screen.findAllByDisplayValue(baseline);
    await waitFor(() => expect(editor(sibling)).toHaveValue(baseline));
    edit(editA);
    edit(editB, sibling);
    let completed = false;
    act(() => {
      void saveAllUnsavedWork().then(() => {
        completed = true;
      });
    });
    await waitFor(() => expect(writes.map((write) => write.text)).toEqual([editB]));
    expect(completed).toBe(false);
    await finish(0);
    await waitFor(() => expect(completed).toBe(true));
    expect(writes.map((write) => write.text)).toEqual([editB]);
    expect(completions).toHaveLength(2);
    expect(new Set(completions.map((result) => result.requestId)).size).toBe(2);
    expect(new Set(completions.map((result) => result.sourceTabId))).toEqual(
      new Set([tabId, sibling])
    );
    expect(io.files.get(filePath)).toBe(editB);
    expect(stillOpen()).toBe(true);
    expect(stillOpen(sibling)).toBe(true);
  });

  it.each(['Cancel', "Don't Save"])(
    'retains the existing %s close choice without writing',
    async (choice) => {
      await mount();
      edit(editB);
      fireEvent.click(screen.getByTestId(`tab-close-${tabId}`));
      fireEvent.click(screen.getByRole('button', { name: choice }));
      await waitFor(() => expect(stillOpen()).toBe(choice === 'Cancel'));
      expect(writes).toEqual([]);
      expect(io.files.get(filePath)).toBe(baseline);
      if (choice === 'Cancel') expect(editor()).toHaveValue(editB);
    }
  );

  it.each([false, true])('closes a clean readOnly=%s view without a write', async (readOnly) => {
    useCanvasStore.getState().updateTab('main', tabId, { readOnly });
    await mount();
    fireEvent.click(screen.getByTestId(`tab-close-${tabId}`));
    await waitFor(() => expect(stillOpen()).toBe(false));
    expect(writes).toEqual([]);
    expect(completions).toEqual([]);
  });
});
