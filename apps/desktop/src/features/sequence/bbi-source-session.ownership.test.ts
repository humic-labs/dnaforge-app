import { afterEach, expect, it, vi } from 'vitest';
import type { UcscTrackSource } from '@waypoint/genome-data';
import type { Assembly } from '@waypoint/genome-renderer';
import { createBbiSourceSession } from './bbi-source-session';

const assembly: Assembly = {
  id: 'fixture',
  displayName: 'Fixture',
  totalLengthBp: 100,
  chromosomes: [
    {
      chromosome: { id: 'chr1', displayName: 'chr1', length: 100, cytobands: [] },
      globalStartBp: 0,
      globalEndBp: 100,
      order: 0,
    },
  ],
};
const source: UcscTrackSource = {
  admissionVersion: 1,
  uri: 'https://fixture.invalid/signal.bw',
  formatId: 'bigwig',
  readerKind: 'bbi',
  scientificKind: 'quantitative',
  quantitativeColumnSemantics: 'continuous-signal',
  assemblyId: 'fixture',
  referenceReceipt: {
    assemblyId: 'fixture',
    referenceSignature: 'chr1',
    sourceSignature: 'chr1',
    contigMap: { chr1: 'chr1' },
    checkedContigs: 1,
    status: 'compatible',
    checkedAt: '2026-11-02T00:00:00Z',
  },
  provenance: {
    provider: 'ucsc',
    sourceKind: 'ucsc-native',
    catalogId: 'fixture:signal',
    ucscGenome: 'fixture',
    track: 'signal',
    label: 'Signal',
  },
  fingerprint: 'fixture',
};
function fixture() {
  const reader = {
    open: vi
      .fn()
      .mockResolvedValue({
        fileType: 'bigwig',
        references: [{ name: 'chr1', length: 100 }],
        zoomReductionLevels: [],
      }),
    closeSource: vi.fn().mockResolvedValue(undefined),
  };
  const admit = vi
    .fn()
    .mockResolvedValue({
      baseUrl: 'http://127.0.0.1:8099',
      sourceUri: source.uri,
      sourceToken: 'fixture',
      canonicalUrlHash: 'fixture',
      byteLength: 100,
      provenanceId: 'fixture',
      expiresAtMs: Date.now() + 60000,
    });
  return {
    reader,
    session: createBbiSourceSession({ assembly, source, format: 'bigwig', reader, admit }),
  };
}
afterEach(() => vi.restoreAllMocks());

it('retires opening while real reference hashing is pending', async () => {
  let began!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  let release!: () => void;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (...args) => {
    const result = await digest(...args);
    began();
    await paused;
    return result;
  });
  const { session, reader } = fixture();
  const query = vi.fn().mockResolvedValue([]);
  const pending = session.execute(new AbortController().signal, query);
  await started;
  const disposal = session.dispose();
  release();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await disposal;
  expect(query).not.toHaveBeenCalled();
  expect(reader.closeSource).toHaveBeenCalledTimes(1);
});

it('retires cached-open continuation before it can dispatch a query', async () => {
  const { session } = fixture();
  await session.execute(new AbortController().signal, async () => []);
  const query = vi.fn().mockResolvedValue([]);
  const pending = session.execute(new AbortController().signal, query);
  const disposal = session.dispose();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await disposal;
  expect(query).not.toHaveBeenCalled();
});
