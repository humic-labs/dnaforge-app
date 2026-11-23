// @vitest-environment node

import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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

const CALLS = 'ACGTTGCAACGA';
const RC_CALLS = 'TCGTTGCAACGT';
const QUALITY = [0, 7, 19, 20, 40, 55, 70, 85, 100, 125, 200, 255];
const DOCUMENT = 'synthetic-auto-oriented-reference';
const REFERENCE = '/synthetic-auto-oriented/reference.fasta';
const READ = '/synthetic-auto-oriented/read.ab1';

function syntheticAb1(): Uint8Array {
  const shorts = (values: number[]) => {
    const bytes = new Uint8Array(values.length * 2);
    const view = new DataView(bytes.buffer);
    values.forEach((value, index) => view.setInt16(index * 2, value, false));
    return bytes;
  };
  const characters = (value: string) => Uint8Array.from(value, (base) => base.charCodeAt(0));
  const entries = [
    { tag: 'PBAS', number: 2, size: 1, data: characters(CALLS) },
    { tag: 'PCON', number: 2, size: 1, data: Uint8Array.from(QUALITY) },
    { tag: 'PLOC', number: 2, size: 2, data: shorts([1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23]) },
    { tag: 'FWO_', number: 1, size: 1, data: characters('ACGT') },
    ...[9, 10, 11, 12].map((number) => ({
      tag: 'DATA',
      number,
      size: 2,
      data: shorts(Array.from({ length: 28 }, (_, index) => (index % 4 === number % 4 ? 30 : 0))),
    })),
  ];
  const directory = 128;
  let dataOffset = directory + entries.length * 28;
  const bytes = new Uint8Array(
    dataOffset +
      entries.reduce((sum, entry) => sum + (entry.data.length > 4 ? entry.data.length : 0), 0)
  );
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x41424946, false);
  view.setInt16(4, 101, false);
  view.setInt32(18, entries.length, false);
  view.setInt32(26, directory, false);
  entries.forEach((entry, index) => {
    const offset = directory + index * 28;
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
  io.readFile.mockReset();
  io.readTextFile.mockReset();
  io.align.mockReset();
  useAttachedReadsStore.getState().clear();
});
afterEach(() => useAttachedReadsStore.getState().clear());

async function attachNormalized(referenceCalls: string) {
  const source = syntheticAb1();
  const before = Uint8Array.from(source);
  const parsed = parseAb1(Buffer.from(source), 'synthetic.ab1');
  expect(parsed.sequence).toBe(CALLS);
  expect(parsed.quality).toEqual(QUALITY);
  expect(parsed.length).toBe(12);
  const referenceText = `>synthetic_reference\n${referenceCalls}\n`;
  const borrowed: Array<{ before: Uint8Array; value: Uint8Array }> = [];
  io.readFile.mockImplementation(async (path) => {
    expect(path).toBe(READ);
    const value = Uint8Array.from(source);
    borrowed.push({ before: Uint8Array.from(value), value });
    return value;
  });
  io.readTextFile.mockImplementation(async (path) => {
    expect(path).toBe(REFERENCE);
    return referenceText;
  });
  io.align.mockImplementation(async (input) => {
    expect(input.reference).toBe(referenceCalls);
    expect(input.isCircular).toBe(false);
    expect([CALLS, RC_CALLS]).toContain(input.query);
    return {
      aligned_query: referenceCalls,
      aligned_reference: referenceCalls,
      identity: 100,
      mutations: [],
      alignment_length: 12,
      wraps: false,
      refStart: 0,
      refEnd: 12,
    };
  });
  const result = await attachReadToReference(DOCUMENT, REFERENCE, READ);
  expect(io.align.mock.calls.map(([input]) => input.query)).toEqual([CALLS, RC_CALLS]);
  expect(io.align.mock.results).toHaveLength(2);
  expect(result.identity).toBe(100);
  expect(result.wraps).toBe(false);
  expect(result.read.coverageStart).toBe(0);
  expect(result.read.coverageEnd).toBe(12);
  expect(result.read.laneOptions.baseToColumn).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  expect(result.read.laneOptions.totalColumns).toBe(12);
  expect(result.read.laneOptions.reverseComplemented).toBe(false);
  const reads = useAttachedReadsStore.getState().attachedBySequenceId[DOCUMENT];
  expect(reads).toHaveLength(1);
  expect(reads?.[0]).toBe(result.read);
  expect(result.read.id).toBe(READ);
  expect(source).toEqual(before);
  for (const item of borrowed) expect(item.value).toEqual(item.before);
  expect(referenceText).toBe(`>synthetic_reference\n${referenceCalls}\n`);
  expect(io.readFile).toHaveBeenCalledTimes(1);
  expect(io.readTextFile).toHaveBeenCalledTimes(1);
  return result.read.laneOptions;
}

it('orients the complete read when both equal-identity alignments normalize to its reverse complement', async () => {
  const lane = await attachNormalized(RC_CALLS);
  expect(lane.sequence).toBe(RC_CALLS);
  expect(lane.quality).toEqual([255, 200, 125, 100, 85, 70, 55, 40, 20, 19, 7, 0]);
  expect(lane.trace.peakPositions).toEqual([4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26]);
  expect(lane.trace.baseOrder).toBe('TGCA');
  expect(lane.trace.channels).toEqual({
    A: [0, 0, 0, 30, 0, 0, 0, 30, 0, 0, 0, 30, 0, 0, 0, 30, 0, 0, 0, 30, 0, 0, 0, 30, 0, 0, 0, 30],
    C: [30, 0, 0, 0, 30, 0, 0, 0, 30, 0, 0, 0, 30, 0, 0, 0, 30, 0, 0, 0, 30, 0, 0, 0, 30, 0, 0, 0],
    G: [0, 30, 0, 0, 0, 30, 0, 0, 0, 30, 0, 0, 0, 30, 0, 0, 0, 30, 0, 0, 0, 30, 0, 0, 0, 30, 0, 0],
    T: [0, 0, 30, 0, 0, 0, 30, 0, 0, 0, 30, 0, 0, 0, 30, 0, 0, 0, 30, 0, 0, 0, 30, 0, 0, 0, 30, 0],
  });
});

it('keeps the complete forward read when both equal-identity alignments normalize forward', async () => {
  const lane = await attachNormalized(CALLS);
  expect(lane.sequence).toBe(CALLS);
  expect(lane.quality).toEqual(QUALITY);
  expect(lane.trace.peakPositions).toEqual([1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23]);
  expect(lane.trace.baseOrder).toBe('ACGT');
  expect(lane.trace.channels).toEqual({
    A: [0, 30, 0, 0, 0, 30, 0, 0, 0, 30, 0, 0, 0, 30, 0, 0, 0, 30, 0, 0, 0, 30, 0, 0, 0, 30, 0, 0],
    C: [0, 0, 30, 0, 0, 0, 30, 0, 0, 0, 30, 0, 0, 0, 30, 0, 0, 0, 30, 0, 0, 0, 30, 0, 0, 0, 30, 0],
    G: [0, 0, 0, 30, 0, 0, 0, 30, 0, 0, 0, 30, 0, 0, 0, 30, 0, 0, 0, 30, 0, 0, 0, 30, 0, 0, 0, 30],
    T: [30, 0, 0, 0, 30, 0, 0, 0, 30, 0, 0, 0, 30, 0, 0, 0, 30, 0, 0, 0, 30, 0, 0, 0, 30, 0, 0, 0],
  });
});
