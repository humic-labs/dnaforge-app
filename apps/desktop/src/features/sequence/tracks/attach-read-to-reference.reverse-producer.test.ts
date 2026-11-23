// @vitest-environment node

import { Buffer } from 'node:buffer';
import { afterEach, expect, it, vi } from 'vitest';
import { parseAb1 } from '@waypoint/sequence-utils';
import type { getFileSystem } from '../../../hooks/useMockedFileSystem';
import type { callPairwiseCircularAware } from '../../alignment-manager/public/utils/circular-alignment';
import { attachReadToReference } from './attach-read-to-reference';
import { useAttachedReadsStore } from './attached-reads-store';

const io = vi.hoisted(() => ({
  readFile: vi.fn<(path: string) => Promise<Uint8Array>>(),
  readTextFile: vi.fn<(path: string) => Promise<string>>(),
  align: vi.fn<typeof callPairwiseCircularAware>(),
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

vi.mock('../../alignment-manager/public/utils/circular-alignment', () => ({
  callPairwiseCircularAware: io.align,
}));

function syntheticAb1(qualityCount = 6, calls: 'ACGTAC' | 'ACGTTC' = 'ACGTAC'): Uint8Array {
  const shorts = (values: number[]) => {
    const result = new Uint8Array(values.length * 2);
    const view = new DataView(result.buffer);
    values.forEach((value, index) => view.setInt16(index * 2, value, false));
    return result;
  };
  const characters = (text: string) =>
    Uint8Array.from(text, (character) => character.charCodeAt(0));
  const entries = [
    { tag: 'PBAS', number: 2, size: 1, data: characters(calls) },
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

afterEach(() => useAttachedReadsStore.getState().clear());

it('publishes an RC-winning parsed read with correctly oriented quality and a display-ready lane', async () => {
  const documentId = 'reverse-reference-document';
  const referencePath = '/owned-reverse-read/reference.fasta';
  const readPath = '/owned-reverse-read/read.ab1';
  const referenceText = '>owned-reverse-reference\nGTACGT\n';
  const originalQuality = [0, 7, 19, 20, 40, 255];
  const source = syntheticAb1(6);
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  const qualityEntry = view.getInt32(26, false) + 28;
  expect(Buffer.from(source.subarray(qualityEntry, qualityEntry + 4)).toString('ascii')).toBe(
    'PCON'
  );
  expect(view.getInt32(qualityEntry + 4, false)).toBe(2);
  expect(view.getInt32(qualityEntry + 12, false)).toBe(6);
  const qualityOffset = view.getInt32(qualityEntry + 20, false);
  source.set(originalQuality, qualityOffset);
  const sourceBefore = Uint8Array.from(source);
  const parsed = parseAb1(Buffer.from(source), 'read.ab1');
  expect(parsed.sequence).toBe('ACGTAC');
  expect(parsed.quality).toEqual(originalQuality);
  const borrowed: Array<{ before: Uint8Array; value: Uint8Array }> = [];
  io.readFile.mockReset();
  io.readTextFile.mockReset();
  io.align.mockReset();
  useAttachedReadsStore.getState().clear();
  io.readFile.mockImplementation(async (path) => {
    expect(path).toBe(readPath);
    const value = Uint8Array.from(source);
    borrowed.push({ before: Uint8Array.from(value), value });
    return value;
  });
  io.readTextFile.mockImplementation(async (path) => {
    expect(path).toBe(referencePath);
    return referenceText;
  });
  io.align.mockImplementation(async ({ query, reference, isCircular }) => {
    expect(reference).toBe('GTACGT');
    expect(isCircular).toBe(false);
    expect(['ACGTAC', 'GTACGT']).toContain(query);
    return {
      aligned_query: query,
      aligned_reference: 'GTACGT',
      identity: query === 'GTACGT' ? 1 : 0,
      mutations: [],
      alignment_length: 6,
      wraps: false,
      refStart: 0,
      refEnd: 6,
    };
  });
  const result = await attachReadToReference(documentId, referencePath, readPath);
  expect(io.align.mock.calls.map(([input]) => input.query)).toEqual(['ACGTAC', 'GTACGT']);
  expect(result).toMatchObject({ identity: 1, reverseComplemented: true, wraps: false });
  expect(result.read.id).toBe(readPath);
  expect(result.read.coverageStart).toBe(0);
  expect(result.read.coverageEnd).toBe(6);
  const lane = result.read.laneOptions;
  expect(lane.sequence).toBe('GTACGT');
  expect(lane.quality).toEqual([255, 40, 20, 19, 7, 0]);
  expect(lane.baseToColumn).toEqual([0, 1, 2, 3, 4, 5]);
  expect(lane.totalColumns).toBe(6);
  expect(lane.reverseComplemented).toBe(false);
  expect(lane.trace.peakPositions).toEqual([4, 6, 8, 10, 12, 14]);
  expect(lane.trace.baseOrder).toBe('TGCA');
  expect(lane.trace.channels).toEqual({
    A: [0, 0, 0, 30, 0, 0, 0, 30, 0, 0, 0, 30, 0, 0, 0, 30],
    C: [30, 0, 0, 0, 30, 0, 0, 0, 30, 0, 0, 0, 30, 0, 0, 0],
    G: [0, 30, 0, 0, 0, 30, 0, 0, 0, 30, 0, 0, 0, 30, 0, 0],
    T: [0, 0, 30, 0, 0, 0, 30, 0, 0, 0, 30, 0, 0, 0, 30, 0],
  });
  expect(lane.mutationColumns).toEqual([]);
  expect(lane.deletionColumns).toEqual([]);
  const reads = useAttachedReadsStore.getState().attachedBySequenceId[documentId];
  expect(reads).toHaveLength(1);
  expect(reads?.[0]).toBe(result.read);
  expect(source).toEqual(sourceBefore);
  expect(parseAb1(Buffer.from(source), 'read.ab1').sequence).toBe('ACGTAC');
  expect(parseAb1(Buffer.from(source), 'read.ab1').quality).toEqual(originalQuality);
  expect(referenceText).toBe('>owned-reverse-reference\nGTACGT\n');
  for (const item of borrowed) expect(item.value).toEqual(item.before);
  expect(io.readFile).toHaveBeenCalledTimes(1);
  expect(io.readTextFile).toHaveBeenCalledTimes(1);
  expect(io.align).toHaveBeenCalledTimes(2);
});
