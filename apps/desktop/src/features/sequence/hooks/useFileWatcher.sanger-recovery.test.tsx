import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseBinarySequenceFileAsAnnotated } from '../parse-sequence-file';
import { buildSharedSequenceReadScene } from '../components/shared-sequence-read-model';
import { getTraceData } from '../tracks/SequenceTracksView';
import { useSequenceStore } from '../store';
import { getNativeSequenceDocumentClient } from '../sequence-document-client';
import { useFileWatcher } from './useFileWatcher';

const boundary = vi.hoisted(() => ({
  root: '',
  readFile: vi.fn<(path: string) => Promise<Uint8Array>>(),
}));
vi.mock('../../../platform', () => ({
  platform: () => ({
    fs: {
      readFile: boundary.readFile,
      watchFile: vi.fn(async () => {}),
      unwatchFile: vi.fn(async () => {}),
    },
    on: () => () => {},
  }),
}));
vi.mock('../../../db/workspace-catalog', () => ({
  findWorkspaceRootForPath: () => boundary.root,
}));
vi.mock('../../../stores/workspaceStore', () => ({
  useWorkspaceStore: { getState: () => ({ folders: [] }) },
}));

const documentId = 'owned-sanger-c2-read';
let filePath = '';

function syntheticAb1(qualityCount: number): Uint8Array {
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

function currentScene() {
  const sequence = useSequenceStore.getState().sequences[documentId];
  if (!sequence) throw new Error('ACTUAL_RELOADED_SEQUENCE_REQUIRED');
  const trace = getTraceData(sequence);
  if (!trace) throw new Error('REAL_AB1_TRACE_REQUIRED');
  return buildSharedSequenceReadScene({
    documentId,
    genome: {
      name: documentId,
      length: sequence.length,
      circular: false,
      sequence: sequence.sequence,
      features: [],
    },
    directRead: { trace, sequence: sequence.sequence, quality: sequence.quality },
  });
}
function mount() {
  const onReload = vi.fn();
  const hook = renderHook(() =>
    useFileWatcher({
      filePath,
      documentId,
      isDirty: useSequenceStore((state) => state.dirtyPaths[documentId] === true),
      onReload,
    })
  );
  return { ...hook, onReload };
}
function seedCorruptRead(): void {
  const bytes = syntheticAb1(5);
  writeFileSync(filePath, bytes);
  const parsed = parseBinarySequenceFileAsAnnotated(bytes, filePath);
  useSequenceStore.getState().setSequence(documentId, parsed.sequence);
}

beforeEach(() => {
  delete document.documentElement.dataset.dnaforgeRuntime;
  expect(getNativeSequenceDocumentClient()).toBeUndefined();
  boundary.root = mkdtempSync(join(tmpdir(), 'dnaforge-sanger-c2-'));
  filePath = join(boundary.root, 'owned-read.ab1');
  boundary.readFile.mockReset();
  boundary.readFile.mockImplementation(async (path) => new Uint8Array(readFileSync(path)));
  useSequenceStore.getState().clearAll();
  seedCorruptRead();
});
afterEach(() => {
  useSequenceStore.getState().clearAll();
  rmSync(boundary.root, { recursive: true, force: true });
  expect(existsSync(boundary.root)).toBe(false);
});

describe('C2 owned Sanger reload through the actual parser and scene admission', () => {
  it('keeps unchanged corrupt quality rejected and admits corrected bytes on the same document', async () => {
    const hook = mount();
    try {
      const originalBytes = readFileSync(filePath);
      expect(useSequenceStore.getState().sequences[documentId]?.sequence).toBe('ACGTAC');
      expect(() => currentScene()).toThrow('Quality values do not match the called bases.');
      await act(async () => {
        await hook.result.current.reloadFromDisk();
      });
      expect(() => currentScene()).toThrow('Quality values do not match the called bases.');
      expect(readFileSync(filePath)).toEqual(originalBytes);
      expect(useSequenceStore.getState().sequences[documentId]?.sequence).toBe('ACGTAC');
      const failedVersion = useSequenceStore.getState().getVersion(documentId);
      writeFileSync(filePath, syntheticAb1(6));
      await act(async () => {
        await hook.result.current.reloadFromDisk();
      });
      const current = useSequenceStore.getState();
      expect(Object.keys(current.sequences)).toEqual([documentId]);
      expect(current.getVersion(documentId)).toBeGreaterThan(failedVersion);
      expect(current.sequences[documentId]?.quality).toHaveLength(6);
      expect(current.sequences[documentId]?.sequence).toBe('ACGTAC');
      const scene = currentScene();
      expect(scene.lanes).toHaveLength(1);
      expect(scene.lanes[0]).toMatchObject({
        id: `sanger-direct-${documentId}`,
        kind: 'sanger',
        quality: [40, 40, 40, 40, 40, 40],
      });
      expect(current.dirtyPaths[documentId]).not.toBe(true);
      expect(hook.onReload).toHaveBeenCalledTimes(2);
      expect(boundary.readFile).toHaveBeenCalledTimes(2);
    } finally {
      hook.unmount();
    }
  });

  it('does not let a delayed corrupt read overwrite a newer corrected same-document revision', async () => {
    const hook = mount();
    let release = () => {};
    const pending: Promise<void>[] = [];
    try {
      expect(useSequenceStore.getState().sequences[documentId]?.sequence).toBe('ACGTAC');
      let captured!: () => void;
      const capturedRead = new Promise<void>((resolve) => {
        captured = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      boundary.readFile.mockImplementationOnce(async (path) => {
        const bytes = new Uint8Array(readFileSync(path));
        captured();
        await held;
        return bytes;
      });
      act(() => {
        pending.push(hook.result.current.reloadFromDisk());
      });
      await capturedRead;
      writeFileSync(filePath, syntheticAb1(6));
      await act(async () => {
        await hook.result.current.reloadFromDisk();
      });
      const corrected = useSequenceStore.getState().sequences[documentId];
      const version = useSequenceStore.getState().getVersion(documentId);
      expect(corrected?.quality).toHaveLength(6);
      expect(corrected?.sequence).toBe('ACGTAC');
      expect(currentScene().lanes).toHaveLength(1);
      await act(async () => {
        release();
        await pending[0];
      });
      expect(useSequenceStore.getState().sequences[documentId]).toBe(corrected);
      expect(useSequenceStore.getState().getVersion(documentId)).toBe(version);
      expect(useSequenceStore.getState().sequences[documentId]?.sequence).toBe('ACGTAC');
      expect(currentScene().lanes).toHaveLength(1);
      expect(hook.onReload).toHaveBeenCalledOnce();
      expect(boundary.readFile).toHaveBeenCalledTimes(2);
      expect(useSequenceStore.getState().dirtyPaths[documentId]).not.toBe(true);
    } finally {
      release();
      await Promise.allSettled(pending);
      hook.unmount();
    }
  });
});
