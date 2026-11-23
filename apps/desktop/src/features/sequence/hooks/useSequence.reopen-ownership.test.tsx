// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { getFileSystem } from '../../../hooks/useMockedFileSystem';
import { useSequence } from './useSequence';
import { useSequenceStore } from '../store';
import { useCanvasStore } from '../../canvas/public/store';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { parseTextSequenceFileAsAnnotated } from '../../../shared/parse-sequence-file';
import { validateTraceQuality } from '../../trace/public';
import { resetWorkspaceSyncRendererGenerationsForTest } from '../../../services/workspace-sync-renderer-generation';
import type { SequenceDocumentRef } from '../../../shared/managed-sequence-document';

const io = vi.hoisted(() => ({
  readFile: vi.fn<(path: string) => Promise<Uint8Array>>(),
  readTextFile: vi.fn<(path: string) => Promise<string>>(),
}));

vi.mock('../../../hooks/useMockedFileSystem', () => ({
  getFileSystem: async () =>
    ({
      readFile: io.readFile,
      readTextFile: io.readTextFile,
      readDir: async () => [],
      exists: async () => true,
    }) satisfies Awaited<ReturnType<typeof getFileSystem>>,
}));

const READ_PATH = '/owned-reopen/read.ab1';
const READ_ID = 'owned-catalog-read-document';
const EDITABLE_PATH = '/owned-reopen/editable.gb';
const EDITABLE_ID = 'owned-editable-document';
const ORIGINAL_TEXT = 'LOCUS       owned 6 bp DNA linear\nORIGIN\n        1 acgtac\n//\n';
const EXTERNAL_TEXT = 'LOCUS       owned 6 bp DNA linear\nORIGIN\n        1 tttttt\n//\n';
let currentReadBytes: Uint8Array = new Uint8Array();
let currentText = ORIGINAL_TEXT;
const suppliedReadBytes: Array<{ original: Uint8Array; returned: Uint8Array }> = [];
let previousFolders: ReturnType<typeof useWorkspaceStore.getState>['folders'] = [];

function openOwnedTab(documentId: string, readOnly: boolean) {
  const reference = {
    kind: 'catalog-sequence',
    entityId: documentId,
  } satisfies SequenceDocumentRef;
  let tabId = '';
  act(() => {
    tabId = useCanvasStore.getState().openTab('main', {
      type: 'sequence',
      entityId: documentId,
      sequenceDocument: reference,
      label: documentId === READ_ID ? 'Owned read' : 'Owned editable sequence',
      loadStatus: 'loaded',
      readOnly,
    });
  });
  return tabId;
}

function mountRead() {
  const tabId = openOwnedTab(READ_ID, false);
  const hook = renderHook(() => useSequence(READ_PATH, READ_ID));
  let closed = false;
  return {
    hook,
    close() {
      if (closed) return;
      act(() => useCanvasStore.getState().closeTab('main', tabId));
      hook.unmount();
      closed = true;
    },
  };
}

function readData(mounted: ReturnType<typeof mountRead>) {
  const data = mounted.hook.result.current.data;
  if (!data) throw new Error('The owned sequence read has not loaded.');
  return data;
}

function expectReadInputsUnchanged() {
  for (const input of suppliedReadBytes) expect(input.returned).toEqual(input.original);
}

function syntheticAb1(qualityCount = 6): Uint8Array {
  const shorts = (values: number[]) => {
    const result = new Uint8Array(values.length * 2);
    const view = new DataView(result.buffer);
    values.forEach((value, index) => view.setInt16(index * 2, value, false));
    return result;
  };
  const characters = (text: string) =>
    Uint8Array.from(text, (character) => character.charCodeAt(0));
  const entries = [
    { tag: 'PBAS', number: 2, size: 1, data: characters('ACGTAC') },
    { tag: 'PCON', number: 2, size: 1, data: new Uint8Array(qualityCount).fill(40) },
    { tag: 'PLOC', number: 2, size: 2, data: shorts([1, 3, 5, 7, 9, 11]) },
    { tag: 'FWO_', number: 1, size: 1, data: characters('ACGT') },
    ...[9, 10, 11, 12].map((number) => ({
      tag: 'DATA',
      number,
      size: 2,
      data: shorts(Array.from({ length: 16 }, (_, index) => (index % 4 === number % 4 ? 30 : 0))),
    })),
  ];
  const directoryOffset = 128;
  let dataOffset = directoryOffset + entries.length * 28;
  const bytes = new Uint8Array(
    dataOffset +
      entries.reduce((count, entry) => count + (entry.data.length > 4 ? entry.data.length : 0), 0)
  );
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x41424946, false);
  view.setInt16(4, 101, false);
  view.setInt32(18, entries.length, false);
  view.setInt32(26, directoryOffset, false);
  entries.forEach((entry, index) => {
    const offset = directoryOffset + index * 28;
    bytes.set(characters(entry.tag), offset);
    view.setInt32(offset + 4, entry.number, false);
    view.setInt16(offset + 8, entry.size === 2 ? 4 : 2, false);
    view.setInt16(offset + 10, entry.size, false);
    view.setInt32(offset + 12, entry.data.length / entry.size, false);
    view.setInt32(offset + 16, entry.data.length, false);
    if (entry.data.length <= 4) bytes.set(entry.data, offset + 20);
    else {
      view.setInt32(offset + 20, dataOffset, false);
      bytes.set(entry.data, dataOffset);
      dataOffset += entry.data.length;
    }
  });
  return bytes;
}

beforeEach(() => {
  previousFolders = useWorkspaceStore.getState().folders;
  useWorkspaceStore.setState({ folders: [] });
  useCanvasStore.getState().reset();
  useSequenceStore.getState().clearAll();
  resetWorkspaceSyncRendererGenerationsForTest();
  suppliedReadBytes.length = 0;
  currentReadBytes = syntheticAb1(5);
  currentText = ORIGINAL_TEXT;
  io.readFile.mockReset().mockImplementation(async (path) => {
    expect(path).toBe(READ_PATH);
    const returned = Uint8Array.from(currentReadBytes);
    suppliedReadBytes.push({ original: Uint8Array.from(returned), returned });
    return returned;
  });
  io.readTextFile.mockReset().mockImplementation(async (path) => {
    expect(path).toBe(EDITABLE_PATH);
    return currentText;
  });
});

afterEach(() => {
  cleanup();
  useCanvasStore.getState().reset();
  useSequenceStore.getState().clearAll();
  useWorkspaceStore.setState({ folders: previousFolders });
  resetWorkspaceSyncRendererGenerationsForTest();
});

describe('sequence reopen ownership', () => {
  it('refuses the same malformed read on remount and recovers its corrected source after closing', async () => {
    const corrupt = syntheticAb1(5);
    const corrected = syntheticAb1(6);
    const corruptSnapshot = Uint8Array.from(corrupt);
    const correctedSnapshot = Uint8Array.from(corrected);
    currentReadBytes = corrupt;
    const first = mountRead();
    await waitFor(() => expect(first.hook.result.current.data?.quality).toHaveLength(5));
    expect(readData(first).sequence.toUpperCase()).toBe('ACGTAC');
    expect(() => validateTraceQuality(readData(first).quality, 6)).toThrow(
      'Quality values do not match the called bases.'
    );
    expect(useSequenceStore.getState().isDirty(READ_ID)).toBe(false);
    first.close();
    expect(currentReadBytes).toEqual(corruptSnapshot);
    expectReadInputsUnchanged();

    const sameCorruption = mountRead();
    await waitFor(() => expect(sameCorruption.hook.result.current.data?.quality).toHaveLength(5));
    expect(readData(sameCorruption).sequence.toUpperCase()).toBe('ACGTAC');
    expect(() => validateTraceQuality(readData(sameCorruption).quality, 6)).toThrow(
      'Quality values do not match the called bases.'
    );
    sameCorruption.close();
    expect(currentReadBytes).toEqual(corruptSnapshot);
    expectReadInputsUnchanged();

    currentReadBytes = corrected;
    const reopened = mountRead();
    await waitFor(() => expect(reopened.hook.result.current.data?.quality).toHaveLength(6));
    await waitFor(() => expect(reopened.hook.result.current.isLoading).toBe(false));
    expect(readData(reopened).sequence.toUpperCase()).toBe('ACGTAC');
    expect(readData(reopened).quality).toEqual([40, 40, 40, 40, 40, 40]);
    expect(() => validateTraceQuality(readData(reopened).quality, 6)).not.toThrow();
    expect(suppliedReadBytes.map((input) => input.original)).toContainEqual(corrected);
    expect(useSequenceStore.getState().isDirty(READ_ID)).toBe(false);
    const state = useSequenceStore.getState();
    expect(state.savedSequences[READ_ID]?.sequence.toUpperCase()).toBe('ACGTAC');
    expect(state.getVersion(READ_ID)).toBe(state.savedVersions[READ_ID]);
    reopened.close();
    expect(currentReadBytes).toEqual(correctedSnapshot);
    expect(corrupt).toEqual(corruptSnapshot);
    expect(corrected).toEqual(correctedSnapshot);
    expectReadInputsUnchanged();
  });

  it('preserves an ordinary unsaved editable draft when its mounted owner is recreated', async () => {
    const parsed = parseTextSequenceFileAsAnnotated(ORIGINAL_TEXT, EDITABLE_PATH);
    act(() => useSequenceStore.getState().setSequence(EDITABLE_ID, parsed.sequence));
    openOwnedTab(EDITABLE_ID, false);
    const first = renderHook(() => useSequence(EDITABLE_PATH, EDITABLE_ID));
    await waitFor(() => expect(first.result.current.isLoading).toBe(false));
    act(() =>
      useSequenceStore.getState().dispatchEdit(EDITABLE_ID, { type: 'INSERT', text: 'TT' })
    );
    const before = useSequenceStore.getState();
    const working = before.sequences[EDITABLE_ID];
    const draft = before.drafts[EDITABLE_ID];
    const saved = before.savedSequences[EDITABLE_ID];
    const version = before.getVersion(EDITABLE_ID);
    const savedVersion = before.savedVersions[EDITABLE_ID];
    expect(before.isDirty(EDITABLE_ID)).toBe(true);
    expect(working?.sequence).not.toBe(saved?.sequence);
    expect(version).toBeGreaterThan(savedVersion ?? 0);
    first.unmount();
    currentText = EXTERNAL_TEXT;

    const remounted = renderHook(() => useSequence(EDITABLE_PATH, EDITABLE_ID));
    await waitFor(() => expect(remounted.result.current.isLoading).toBe(false));
    const after = useSequenceStore.getState();
    expect(after.isDirty(EDITABLE_ID)).toBe(true);
    expect(after.sequences[EDITABLE_ID]).toBe(working);
    expect(after.drafts[EDITABLE_ID]).toBe(draft);
    expect(after.savedSequences[EDITABLE_ID]).toBe(saved);
    expect(after.getVersion(EDITABLE_ID)).toBe(version);
    expect(after.savedVersions[EDITABLE_ID]).toBe(savedVersion);
    expect(remounted.result.current.data?.sequence).toBe(working?.sequence);
    expect(remounted.result.current.data?.sequence).not.toBe('TTTTTT');
    expect(currentText).toBe(EXTERNAL_TEXT);
    remounted.unmount();
  });
});
