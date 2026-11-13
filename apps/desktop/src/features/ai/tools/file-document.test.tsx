// @vitest-environment jsdom

import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TabularFileViewerTab } from '../../../components/TabularFileViewerTab';
import { useCanvasStore } from '../../canvas/public/store';
import { createFileDocumentTool as createUncheckedFileDocumentTool, fileDocumentSchema, fileDocumentOutputSchema } from './file-document';
import { checkedToolFactory } from '../../../test-utils/mcp-output-test-helper';
import { NativeFileDocumentOwner, type NativeFileDocumentRecord } from '../../../main/file-document-owner';
import type { FileDocumentRequest, FileDocumentSnapshot } from '../../../shared/file-document';
import type { TextFileAtomicWriteInput } from '../../../shared/text-file-atomic';

const createFileDocumentTool = checkedToolFactory(createUncheckedFileDocumentTool, fileDocumentOutputSchema);

const native = vi.hoisted(() => ({
  write: vi.fn<(input: TextFileAtomicWriteInput) => Promise<void>>(),
  validate: vi.fn(),
  fileDocument: vi.fn<(request: FileDocumentRequest) => Promise<FileDocumentSnapshot>>(),
  files: new Map<string, string>(),
  records: new Map<string, NativeFileDocumentRecord>(),
  listeners: new Set<(snapshot: FileDocumentSnapshot) => void>(),
  readOnly: false,
}));
vi.mock('../../../platform', () => ({ platform: () => ({ fs: {
  stat: async (path: string) => ({ size: native.files.get(path)?.length ?? 0, isFile: true, isDirectory: false }),
  readTextFile: async (path: string) => native.files.get(path) ?? '',
  validateWorkspacePath: native.validate,
  writeTextFileAtomic: native.write,
  fileDocument: native.fileDocument,
  subscribeFileDocuments: (listener: (snapshot: FileDocumentSnapshot) => void) => {
    native.listeners.add(listener);
    return () => native.listeners.delete(listener);
  },
}, shell: { revealItemInDir: vi.fn() } }) }));
vi.mock('../../../utils/environment', async (original) => ({
  ...(await original<typeof import('../../../utils/environment')>()),
  isBrowserOnly: () => false,
}));
vi.mock('../../../shared/unsaved-draft-recovery', () => ({
  fingerprintText: (text: string) => text,
  useUnsavedDraftRecovery: () => ({ flushDraft: async () => {} }),
}));

let caseNumber = 0;
let filePath = '';
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  Element.prototype.scrollIntoView = vi.fn();
  useCanvasStore.getState().reset();
  filePath = `/ws/case-${++caseNumber}/values.csv`;
  native.readOnly = false;
  native.files.clear();
  native.records.clear();
  native.files.set(filePath, 'sample,condition\nA1,control\n');
  native.write.mockReset().mockImplementation(async (input) => {
    native.files.set(input.path, input.content);
  });
  native.validate.mockReset().mockResolvedValue(true);
  const owner = new NativeFileDocumentOwner({
    admit: async (path) => {
      if (!(await native.validate(path))) throw new Error('OUTSIDE_WORKSPACE: The native workspace rejected this path.');
      return { path, workspaceRoot: '/ws', readOnly: native.readOnly, assertCurrent() {} };
    },
    read: async (path) => new TextEncoder().encode(native.files.get(path) ?? ''),
    write: (input) => native.write(input),
    loadRecord: async (path) => native.records.get(path),
    resolveIdentity: async (id) => [...native.records.values()].find((record) => record.documentId === id)?.path,
    storeRecord: async (record) => { native.records.set(record.path, structuredClone(record)); },
  });
  owner.subscribe((snapshot) => {
    for (const listener of native.listeners) listener(snapshot);
  });
  native.fileDocument.mockReset().mockImplementation((request) => owner.execute(request, 'renderer'));
});
afterEach(cleanup);

const tool = () => createFileDocumentTool([{ name: 'Workspace', path: '/ws', addedAt: 0 }]);
const execute = async (input: unknown) => tool().execute!(fileDocumentSchema.parse(input), { toolCallId: 'native-file-control', messages: [] });

async function open(readOnly = false) {
  native.readOnly = readOnly;
  const tabId = useCanvasStore.getState().openTab('main', { type: 'file', entityId: filePath, label: 'values.csv', readOnly });
  render(<TabularFileViewerTab filePath={filePath} canvasTabId={tabId} readOnly={readOnly} />);
  await screen.findByTestId('tabular-file-viewer');
  return tabId;
}
async function revision(tabId: string) {
  const result = await execute({ tabId, operation: { kind: 'inspect' } });
  expect(result).toMatchObject({ ok: true, ready: true });
  return (result as { revision: string }).revision;
}

describe('native file tool and mounted human table owner', () => {
  it('keeps exact-text refusals unchanged through the agent adapter before editing and saving', async () => {
    filePath = `/ws/case-${caseNumber}/notes.py`;
    const original = '\uFEFFprint("agent draft")\r\n';
    native.files.set(filePath, original);
    const target = { path: filePath };
    const initial = await execute({ target, operation: { kind: 'inspect' } }) as { revision: string };
    for (const [oldText, code] of [['missing', 'TEXT_NOT_FOUND'], ['a', 'TEXT_MATCH_AMBIGUOUS']]) {
      expect(await execute({ target, expectedRevision: initial.revision, operation: {
        kind: 'replace-string', oldText, newText: 'refused',
      } })).toMatchObject({ ok: false, code, stateChanged: false, partialEffects: [] });
      expect(native.files.get(filePath)).toBe(original);
    }
    const changed = await execute({ target, expectedRevision: initial.revision, operation: {
      kind: 'replace-string', oldText: 'agent draft', newText: 'agent durable',
    } }) as { revision: string };
    expect(changed).toMatchObject({ ok: true, applied: true, dirty: true, text: '\uFEFFprint("agent durable")\n' });
    expect(await execute({ target, expectedRevision: changed.revision, operation: { kind: 'save' } })).toMatchObject({
      ok: true, saved: true, dirty: false,
    });
    expect(native.files.get(filePath)).toBe('\uFEFFprint("agent durable")\r\n');
  });

  it('preserves human edits through stale refusal, shared undo and captured native save', async () => {
    const tabId = await open();
    const beforeHuman = await revision(tabId);
    fireEvent.doubleClick(screen.getByText('control'));
    const input = await screen.findByRole('textbox');
    fireEvent.change(input, { target: { value: 'human' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await execute({ tabId, expectedRevision: beforeHuman, operation: { kind: 'discard' } })).toMatchObject({ ok: false, code: 'STALE_FILE_DRAFT', stateChanged: false });
    let result: unknown;
    await act(async () => {
      result = await execute({ tabId, expectedRevision: await revision(tabId), operation: { kind: 'table', command: { kind: 'set-cell', row: 0, column: 1, value: 'agent' } } });
    });
    expect(result).toMatchObject({ ok: true, dirty: true });
    expect(screen.getByText('agent')).toBeDefined();
    await act(async () => { await execute({ tabId, expectedRevision: await revision(tabId), operation: { kind: 'undo' } }); });
    expect(screen.getByText('human')).toBeDefined();
    await act(async () => { await execute({ tabId, expectedRevision: await revision(tabId), operation: { kind: 'redo' } }); });
    await act(async () => { result = await execute({ tabId, expectedRevision: await revision(tabId), operation: { kind: 'save' } }); });
    expect(result).toMatchObject({ ok: true, saved: true, dirty: false });
    expect(native.write).toHaveBeenCalledWith({ path: filePath, content: 'sample,condition\nA1,agent\n', expectedContentHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) });
    expect(native.files.get(filePath)).toBe('sample,condition\nA1,agent\n');
  });

  it('refuses readonly previews and paths rejected by native workspace validation', async () => {
    const tabId = await open(true);
    expect(await execute({ tabId, expectedRevision: await revision(tabId), operation: { kind: 'discard' } })).toMatchObject({ ok: false, code: 'READ_ONLY_FILE', stateChanged: false });
    native.validate.mockResolvedValue(false);
    expect(await execute({ tabId, operation: { kind: 'inspect' } })).toMatchObject({ ok: false, code: 'OUTSIDE_WORKSPACE', stateChanged: false });
    expect(native.write).not.toHaveBeenCalled();
  });

  it('retains the visible draft and reports a native external-file conflict', async () => {
    const tabId = await open();
    await act(async () => { await execute({ tabId, expectedRevision: await revision(tabId), operation: { kind: 'table', command: { kind: 'set-cell', row: 0, column: 1, value: 'unsaved' } } }); });
    native.write.mockRejectedValue(new Error('FILE_CHANGED: external edit'));
    let result: unknown;
    await act(async () => { result = await execute({ tabId, expectedRevision: await revision(tabId), operation: { kind: 'save' } }); });
    expect(result).toMatchObject({ ok: false, code: 'FILE_CHANGED', stateChanged: false });
    expect(screen.getByText('unsaved', { selector: 'div.truncate' })).toBeDefined();
    expect(await execute({ tabId, operation: { kind: 'inspect' } })).toMatchObject({ ok: true, dirty: true });
  });
});
