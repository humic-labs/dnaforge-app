import { beforeEach, expect, it, vi } from 'vitest';
import type { IndexedBbiTrackSource } from '@waypoint/genome-data';
import { useLaneContractStore } from './lane-contract-store';
import { relinkIndexedBbiTrack } from './relink-indexed-bbi-track';

const mocks = vi.hoisted(() => ({ admit: vi.fn() }));
vi.mock('./indexed-track-admission', () => ({
  admitIndexedBigWigRequest: mocks.admit,
  admitIndexedBigBedRequest: mocks.admit,
}));
const source: IndexedBbiTrackSource = {
  admissionVersion: 1,
  input: { kind: 'path', path: '/removed/source.bw' },
  uri: 'file:///removed/source.bw',
  formatId: 'bigwig',
  fingerprint: 'old-source',
  readerKind: 'bbi',
  scientificKind: 'quantitative',
  assemblyId: 'ref',
  referenceReceipt: {
    assemblyId: 'ref',
    referenceSignature: 'ref',
    sourceSignature: 'old-source',
    contigMap: { chr1: 'chr1' },
    checkedContigs: 1,
    status: 'compatible',
    checkedAt: '2026-09-29T00:00:00.000Z',
  },
  provenance: { provider: 'local-file', sourceKind: 'local-file', label: 'Signal' },
};
const input = {
  ownerId: 'view',
  trackId: 'signal',
  path: '/selected/source.bw',
  assemblyReferences: [{ name: 'chr1', length: 1000 }],
};
const lane = () => useLaneContractStore.getState().lanesByOwnerId.view?.[0];
beforeEach(() => {
  vi.resetAllMocks();
  useLaneContractStore.setState({ lanesByOwnerId: {} });
  useLaneContractStore.getState().addLane(
    'view',
    'ref',
    {
      kind: 'annotation',
      trackType: 'quantitative',
      trackId: 'signal',
      label: 'Custom label',
      records: [],
      color: 0x123456,
      trackPx: 144,
      laneHeightPx: 22,
      maxLanes: 2,
      quantitativePresentation: {
        version: 1,
        graph: 'bar',
        showRange: true,
        smoothingSigmaBins: 2,
        scale: { mode: 'fixed', transform: 'linear', min: 0, max: 7 },
      },
    },
    false,
    source
  );
  mocks.admit.mockResolvedValue({
    ...source,
    fingerprint: 'replacement',
    input: { kind: 'path', path: input.path },
  });
});

it('replaces only the admitted source while preserving the current lane and scientific presentation', async () => {
  const before = lane()!;
  await relinkIndexedBbiTrack(input);
  expect(mocks.admit).toHaveBeenCalledWith(
    expect.objectContaining({
      request: expect.objectContaining({ source: { kind: 'local-file', path: input.path } }),
      assemblyReferences: input.assemblyReferences,
    })
  );
  expect(lane()?.source?.fingerprint).toBe('replacement');
  expect(lane()?.visible).toBe(before.visible);
  for (const field of [
    'label',
    'color',
    'trackPx',
    'laneHeightPx',
    'maxLanes',
    'quantitativePresentation',
  ] as const)
    expect(lane()?.dataset[field]).toEqual(before.dataset[field]);
});

it.each(['wrong reference', 'invalid file', 'permission denied'])(
  'preserves the complete original lane when admission rejects %s',
  async (message) => {
    const before = lane();
    mocks.admit.mockRejectedValue(new Error(message));
    await expect(relinkIndexedBbiTrack(input)).rejects.toThrow(message);
    expect(lane()).toBe(before);
  }
);

it('does not resurrect a removed track after a replacement finishes loading', async () => {
  let finish!: (value: IndexedBbiTrackSource) => void;
  mocks.admit.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const pending = relinkIndexedBbiTrack(input);
  useLaneContractStore.getState().removeLane('view', 'signal');
  finish(source);
  await expect(pending).rejects.toThrow('track changed');
  expect(lane()).toBeUndefined();
});
