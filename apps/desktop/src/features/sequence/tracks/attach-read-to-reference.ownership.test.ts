// @vitest-environment node

import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseAb1 } from '@waypoint/sequence-utils';
import type { getFileSystem } from '../../../hooks/useMockedFileSystem';
import type { callPairwiseCircularAware } from '../../alignment-manager/public/utils/circular-alignment';
import { attachReadToReference } from './attach-read-to-reference';
import { useAttachedReadsStore } from './attached-reads-store';

type AlignmentResult = Awaited<ReturnType<typeof callPairwiseCircularAware>>;
type AcceptedRead = Awaited<ReturnType<typeof attachReadToReference>>['read'];

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

const DOCUMENT_ID = 'owned-reference-document';
const REFERENCE_PATH = '/owned-read-attachment/reference.fasta';
const READ_PATH = '/owned-read-attachment/read.ab1';
const REFERENCE_CALLS = 'ACGTAC';
const REFERENCE_TEXT = '>owned-reference\nACGTAC\n';
const OLD_CALLS = 'ACGTAC';
const NEW_CALLS = 'ACGTTC';
let currentSource: Uint8Array = new Uint8Array();
const borrowedReads: Array<{ before: Uint8Array; returned: Uint8Array }> = [];

function deferred<T>() {
  let deliver: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    deliver = resolve;
  });
  return {
    promise,
    resolve(value: T) {
      if (!deliver) throw new Error('The controlled alignment is not initialized.');
      deliver(value);
    },
  };
}

function alignment(query: string, identity: number): AlignmentResult {
  return {
    aligned_query: query,
    aligned_reference: REFERENCE_CALLS,
    identity,
    mutations: [],
    alignment_length: 6,
    wraps: false,
    refStart: 0,
    refEnd: 6,
  };
}

function replyToKnownSyntheticAlignment() {
  const replies = new Map([
    [OLD_CALLS, alignment(OLD_CALLS, 1)],
    ['GTACGT', alignment('GTACGT', 0)],
    [NEW_CALLS, alignment(NEW_CALLS, 5 / 6)],
    ['GAACGT', alignment('GAACGT', 0)],
  ]);
  io.align.mockImplementation(async (input) => {
    expect(input.reference).toBe(REFERENCE_CALLS);
    expect(input.isCircular).toBe(false);
    const reply = replies.get(input.query);
    if (!reply) throw new Error('Unexpected synthetic alignment input.');
    return reply;
  });
}

function reads() {
  return useAttachedReadsStore.getState().attachedBySequenceId[DOCUMENT_ID] ?? [];
}

function expectBorrowedBytesUnchanged() {
  for (const read of borrowedReads) expect(read.returned).toEqual(read.before);
}

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

beforeEach(() => {
  io.readFile.mockReset();
  io.readTextFile.mockReset();
  io.align.mockReset();
  useAttachedReadsStore.getState().clear();
  borrowedReads.length = 0;
  currentSource = syntheticAb1();
  io.readTextFile.mockImplementation(async (path) => {
    expect(path).toBe(REFERENCE_PATH);
    return REFERENCE_TEXT;
  });
  io.readFile.mockImplementation(async (path) => {
    expect(path).toBe(READ_PATH);
    const returned = Uint8Array.from(currentSource);
    borrowedReads.push({ before: Uint8Array.from(returned), returned });
    return returned;
  });
  replyToKnownSyntheticAlignment();
});

afterEach(() => {
  useAttachedReadsStore.getState().clear();
});

describe('read attachment recovery ownership', () => {
  it('retains an already completed newer same-read attachment when an older alignment finishes', async () => {
    const olderSource = syntheticAb1();
    const newerSource = syntheticAb1(6, NEW_CALLS);
    const olderSnapshot = Uint8Array.from(olderSource);
    const newerSnapshot = Uint8Array.from(newerSource);
    expect(parseAb1(Buffer.from(olderSource), 'read.ab1').sequence).toBe(OLD_CALLS);
    expect(parseAb1(Buffer.from(newerSource), 'read.ab1').sequence).toBe(NEW_CALLS);
    const forward = deferred<AlignmentResult>();
    const reverse = deferred<AlignmentResult>();
    io.align.mockImplementationOnce(() => forward.promise);
    io.align.mockImplementationOnce(() => reverse.promise);
    currentSource = olderSource;
    const older = attachReadToReference(DOCUMENT_ID, REFERENCE_PATH, READ_PATH);
    const settledOlder = Promise.allSettled([older]);
    let acceptedNewer: AcceptedRead | undefined;
    try {
      await vi.waitFor(() => expect(io.align).toHaveBeenCalledTimes(2));
      expect(io.align.mock.calls.map(([input]) => input.query)).toEqual([OLD_CALLS, 'GTACGT']);
      expect(reads()).toEqual([]);
      currentSource = newerSource;
      const newer = await attachReadToReference(DOCUMENT_ID, REFERENCE_PATH, READ_PATH);
      acceptedNewer = newer.read;
      expect(reads()).toHaveLength(1);
      expect(reads()[0]).toBe(acceptedNewer);
      expect(acceptedNewer.id).toBe(READ_PATH);
      expect(acceptedNewer.laneOptions.sequence).toBe(NEW_CALLS);
      expect(acceptedNewer.laneOptions.quality).toEqual([40, 40, 40, 40, 40, 40]);
      expect(acceptedNewer.laneOptions.baseToColumn).toEqual([0, 1, 2, 3, 4, 5]);
      expect(io.align.mock.calls.map(([input]) => input.query)).toEqual([
        OLD_CALLS,
        'GTACGT',
        NEW_CALLS,
        'GAACGT',
      ]);
    } finally {
      forward.resolve(alignment(OLD_CALLS, 1));
      reverse.resolve(alignment('GTACGT', 0));
      await settledOlder;
    }
    expect(reads()).toHaveLength(1);
    expect(reads()[0]).toBe(acceptedNewer);
    expect(reads()[0]?.laneOptions.sequence).toBe(NEW_CALLS);
    expect(currentSource).toEqual(newerSnapshot);
    expect(olderSource).toEqual(olderSnapshot);
    expect(newerSource).toEqual(newerSnapshot);
    expectBorrowedBytesUnchanged();
    expect(io.readFile).toHaveBeenCalledTimes(2);
    expect(io.readTextFile).toHaveBeenCalledTimes(2);
  });

  it('refuses the same corrupt quality twice, retains the accepted read, and recovers the corrected same path without duplicates', async () => {
    const original = syntheticAb1();
    currentSource = original;
    const existing = await attachReadToReference(DOCUMENT_ID, REFERENCE_PATH, READ_PATH);
    expect(existing.read.laneOptions.sequence).toBe(OLD_CALLS);
    const corrupt = syntheticAb1(5, NEW_CALLS);
    const corruptSnapshot = Uint8Array.from(corrupt);
    currentSource = corrupt;
    expect(parseAb1(Buffer.from(corrupt), 'read.ab1').quality).toHaveLength(5);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(attachReadToReference(DOCUMENT_ID, REFERENCE_PATH, READ_PATH)).rejects.toThrow(
        'Quality values do not match the called bases.'
      );
      expect(reads()).toHaveLength(1);
      expect(reads()[0]).toBe(existing.read);
      expect(reads()[0]?.laneOptions.sequence).toBe(OLD_CALLS);
      expect(currentSource).toEqual(corruptSnapshot);
      expectBorrowedBytesUnchanged();
    }
    const corrected = syntheticAb1(6, NEW_CALLS);
    const correctedSnapshot = Uint8Array.from(corrected);
    currentSource = corrected;
    const recovered = await attachReadToReference(DOCUMENT_ID, REFERENCE_PATH, READ_PATH);
    expect(reads()).toHaveLength(1);
    expect(reads()[0]).toBe(recovered.read);
    expect(recovered.read.id).toBe(existing.read.id);
    expect(recovered.read.laneOptions.sequence).toBe(NEW_CALLS);
    expect(recovered.read.laneOptions.quality).toEqual([40, 40, 40, 40, 40, 40]);
    expect(recovered.read.laneOptions.baseToColumn).toEqual([0, 1, 2, 3, 4, 5]);
    expect(currentSource).toEqual(correctedSnapshot);
    expect(corrupt).toEqual(corruptSnapshot);
    expect(original).toEqual(syntheticAb1());
    expectBorrowedBytesUnchanged();
    expect(io.readFile).toHaveBeenCalledTimes(4);
    expect(io.readTextFile).toHaveBeenCalledTimes(4);
  });
});
