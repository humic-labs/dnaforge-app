// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSequenceDocumentMetadata } from '@waypoint/sequence-utils';
import type { getFileSystem } from '../../../hooks/useMockedFileSystem';
import { useSequence } from './useSequence';
import { useSequenceStore } from '../store';
import { useCanvasStore } from '../../canvas/public/store';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import {
  parseBinarySequenceFileAsAnnotated,
  parseTextSequenceFileAsAnnotated,
} from '../../../shared/parse-sequence-file';
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

const READ_PATH = '/owned-tab-lifetime/read.ab1';
const READ_ID = 'owned-tab-lifetime-document';
const REPLACEMENT_PATH = '/owned-tab-lifetime/replacement.ab1';
const EDITABLE_PATH = '/owned-tab-lifetime/replacement.gb';
const EDITABLE_TEXT = 'LOCUS       owned 6 bp DNA linear\nORIGIN\n        1 acgtac\n//\n';
let currentReadBytes: Uint8Array = new Uint8Array();
let previousFolders: ReturnType<typeof useWorkspaceStore.getState>['folders'] = [];
const suppliedReadBytes: Array<{ original: Uint8Array; returned: Uint8Array }> = [];

function openOwnedTab(panelId = 'main') {
  const reference = {
    kind: 'catalog-sequence',
    entityId: READ_ID,
  } satisfies SequenceDocumentRef;
  let tabId = '';
  act(() => {
    tabId = useCanvasStore.getState().openTab(panelId, {
      type: 'sequence',
      entityId: READ_ID,
      sequenceDocument: reference,
      label: 'Owned read',
      loadStatus: 'loaded',
      readOnly: false,
    });
  });
  expect(tabId).not.toBe('');
  return tabId;
}

function closeOwnedTab(tabId: string, panelId = 'main') {
  act(() => useCanvasStore.getState().closeTab(panelId, tabId));
}

function snapshot() {
  const state = useSequenceStore.getState();
  return {
    sequence: state.sequences[READ_ID],
    saved: state.savedSequences[READ_ID],
    draft: state.drafts[READ_ID],
    lineage: state.draftLineages[READ_ID],
    version: state.getVersion(READ_ID),
    savedVersion: state.savedVersions[READ_ID],
    dirty: state.isDirty(READ_ID),
  };
}

function expectSnapshotRetained(before: ReturnType<typeof snapshot>) {
  const after = snapshot();
  expect(after.sequence).toBe(before.sequence);
  expect(after.saved).toBe(before.saved);
  expect(after.draft).toBe(before.draft);
  expect(after.lineage).toBe(before.lineage);
  expect(after.version).toBe(before.version);
  expect(after.savedVersion).toBe(before.savedVersion);
  expect(after.dirty).toBe(before.dirty);
}

async function loadedRead() {
  const hook = renderHook(() => useSequence(READ_PATH, READ_ID));
  await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
  const data = hook.result.current.data;
  if (!data) throw new Error('The owned sequence read has not loaded.');
  expect(data.sequence.toUpperCase()).toBe('ACGTAC');
  expect(getSequenceDocumentMetadata(data)?.source.path).toBe(READ_PATH);
  return hook;
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
  currentReadBytes = syntheticAb1();
  suppliedReadBytes.length = 0;
  io.readFile.mockReset().mockImplementation(async (path) => {
    expect(path).toBe(READ_PATH);
    const returned = Uint8Array.from(currentReadBytes);
    suppliedReadBytes.push({ original: Uint8Array.from(returned), returned });
    return returned;
  });
  io.readTextFile.mockReset().mockResolvedValue(EDITABLE_TEXT);
});

afterEach(() => {
  cleanup();
  useCanvasStore.getState().reset();
  useSequenceStore.getState().clearAll();
  useWorkspaceStore.setState({ folders: previousFolders });
  resetWorkspaceSyncRendererGenerationsForTest();
  for (const input of suppliedReadBytes) expect(input.returned).toEqual(input.original);
});

describe('sequence cache follows its open tabs', () => {
  it('recovers a corrected source after an evicted renderer and the last matching tab close', async () => {
    const corrupt = syntheticAb1(5);
    const corrected = syntheticAb1(6);
    currentReadBytes = corrupt;
    const tabId = openOwnedTab();
    const first = await loadedRead();
    expect(first.result.current.data?.quality).toHaveLength(5);
    expect(() => validateTraceQuality(first.result.current.data?.quality, 6)).toThrow(
      'Quality values do not match the called bases.'
    );
    const accepted = snapshot();
    expect(accepted.dirty).toBe(false);
    let secondPanel = '';
    act(() => {
      secondPanel = useCanvasStore.getState().splitPanel('main', 'horizontal');
    });
    expect(secondPanel).not.toBe('');
    const secondTab = openOwnedTab(secondPanel);

    first.unmount();
    expectSnapshotRetained(accepted);
    closeOwnedTab(secondTab, secondPanel);
    expectSnapshotRetained(accepted);
    closeOwnedTab(tabId);
    currentReadBytes = corrected;

    const reopenedTab = openOwnedTab();
    const reopened = await loadedRead();
    await waitFor(() => expect(reopened.result.current.data?.quality).toHaveLength(6));
    expect(reopened.result.current.data?.quality).toEqual([40, 40, 40, 40, 40, 40]);
    expect(() => validateTraceQuality(reopened.result.current.data?.quality, 6)).not.toThrow();
    expect(suppliedReadBytes.map((input) => input.original)).toContainEqual(corrected);
    expect(snapshot().dirty).toBe(false);
    expect(corrupt).toEqual(syntheticAb1(5));
    expect(corrected).toEqual(syntheticAb1(6));
    closeOwnedTab(reopenedTab);
    reopened.unmount();
  });

  it('shares the accepted object and lineage across concurrent and remounted consumers of an open tab', async () => {
    const tabId = openOwnedTab();
    const first = await loadedRead();
    const accepted = snapshot();
    const second = await loadedRead();
    expect(second.result.current.data).toBe(accepted.sequence);
    expect(first.result.current.data).toBe(accepted.sequence);
    expectSnapshotRetained(accepted);
    first.unmount();
    second.unmount();
    expectSnapshotRetained(accepted);

    const remounted = await loadedRead();
    expect(remounted.result.current.data).toBe(accepted.sequence);
    expectSnapshotRetained(accepted);
    closeOwnedTab(tabId);
    remounted.unmount();
  });

  it('does not clear a clean replacement source when the old read tab closes', async () => {
    const tabId = openOwnedTab();
    const first = await loadedRead();
    const original = snapshot();
    first.unmount();
    const replacement = parseBinarySequenceFileAsAnnotated(syntheticAb1(), REPLACEMENT_PATH);
    act(() => useSequenceStore.getState().setSequence(READ_ID, replacement.sequence));
    const accepted = snapshot();
    expect(accepted.sequence).not.toBe(original.sequence);
    expect(accepted.lineage).not.toBe(original.lineage);
    expect(accepted.version).toBeGreaterThan(original.version);
    expect(accepted.dirty).toBe(false);
    expect(getSequenceDocumentMetadata(accepted.sequence)?.source.path).toBe(REPLACEMENT_PATH);

    closeOwnedTab(tabId);
    expectSnapshotRetained(accepted);
    expect(accepted.sequence?.sequence.toUpperCase()).toBe('ACGTAC');
    expect(accepted.sequence?.quality).toEqual([40, 40, 40, 40, 40, 40]);
  });

  it('preserves a dirty editable replacement and its saved baseline when the old read tab closes', async () => {
    const tabId = openOwnedTab();
    const first = await loadedRead();
    first.unmount();
    const replacement = parseTextSequenceFileAsAnnotated(EDITABLE_TEXT, EDITABLE_PATH);
    act(() => {
      useSequenceStore.getState().setSequence(READ_ID, replacement.sequence);
      useSequenceStore.getState().addAnnotation(READ_ID, {
        name: 'Unsaved synthetic feature',
        type: 'misc_feature',
        start: 1,
        end: 4,
        direction: 1,
      });
    });
    const dirty = snapshot();
    expect(dirty.dirty).toBe(true);
    expect(dirty.sequence?.sequence.toUpperCase()).toBe('ACGTAC');
    expect(dirty.saved?.sequence.toUpperCase()).toBe('ACGTAC');
    expect(dirty.sequence?.annotations).toHaveLength(1);
    expect(dirty.saved?.annotations).toHaveLength(0);
    expect(dirty.version).toBeGreaterThan(dirty.savedVersion ?? 0);
    expect(getSequenceDocumentMetadata(dirty.sequence)?.source.path).toBe(EDITABLE_PATH);

    closeOwnedTab(tabId);
    expectSnapshotRetained(dirty);
    expect(dirty.sequence?.annotations[0]?.name).toBe('Unsaved synthetic feature');
    expect(EDITABLE_TEXT).toBe('LOCUS       owned 6 bp DNA linear\nORIGIN\n        1 acgtac\n//\n');
  });
});
