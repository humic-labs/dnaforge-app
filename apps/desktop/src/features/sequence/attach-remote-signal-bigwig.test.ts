import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  attachRemoteSignalBigWig,
  remoteSignalReferenceReceipt,
} from './attach-remote-signal-bigwig';
import { useLaneContractStore, type ActiveStressDataset } from './lane-contract-store';

const bbiMocks = vi.hoisted(() => ({
  open: vi.fn(),
  queryQuantitative: vi.fn(),
  closeSource: vi.fn(),
}));

vi.mock('./bbi-reader-runtime', () => ({
  getBbiReaderWorkerClient: () => bbiMocks,
}));

const REFERENCE = [{ name: 'chr1', length: 249_250_621 }];

function readDataset(): ActiveStressDataset {
  return {
    kind: 'pileup',
    trackType: 'pileup-genomewide',
    trackId: 'reads',
    label: 'Reads',
    color: 0xa8ceff,
    laneHeightPx: 3,
    maxLanes: 80,
    overflowBandHeightPx: 36,
    trackPx: 276,
    records: [],
    source: { bamPath: '/analysis/sample.bam', indexPath: '/analysis/sample.bam.bai' },
  };
}

function remoteReadDataset(): ActiveStressDataset {
  return {
    ...readDataset(),
    source: {
      bamPath: 'http://127.0.0.1:4100/v1/primary-session/alignment.bam',
      indexPath: '/tmp/primary-session/alignment.bam.bai',
      remote: {
        locator: {
          contract: 'remote-alignment-locator.v1',
          endpointId: 'endpoint-1',
          target: 'cluster',
          alignmentPath: '/analysis/sample.bam',
          indexPath: '/analysis/sample.bam.bai',
          signalPath: '/analysis/sample.bigWig',
        },
        sessionId: 'primary-session',
      },
    },
  };
}

describe('remote signal reference check', () => {
  const expected = [
    { name: 'chr1', length: 249_250_621 },
    { name: 'chrM', length: 16_571 },
    { name: 'chr19_gl000209_random', length: 159_169 },
  ];

  beforeEach(() => {
    useLaneContractStore.getState().clear();
    bbiMocks.open.mockReset().mockResolvedValue({
      fileType: 'bigwig',
      references: REFERENCE,
      zoomReductionLevels: [10],
      totalSummary: { basesCovered: 100, scoreMin: 0, scoreMax: 12 },
    });
    bbiMocks.queryQuantitative.mockReset().mockResolvedValue([]);
    bbiMocks.closeSource.mockReset().mockResolvedValue(undefined);
  });

  it('accepts a BigWig that omits an unplaced contig and keeps the primary chromosomes', async () => {
    const receipt = await remoteSignalReferenceReceipt({
      assemblyId: 'hg19',
      expected,
      actual: [
        { name: 'chr1', length: 249_250_621 },
        { name: 'chrM', length: 16_571 },
        { name: 'ERCC-00130', length: 1_059 },
      ],
    });
    expect(receipt.status).toBe('compatible');
    expect(receipt.checkedContigs).toBe(2);
  });

  it('rejects a length mismatch on a shared contig', async () => {
    await expect(
      remoteSignalReferenceReceipt({
        assemblyId: 'hg19',
        expected,
        actual: [
          { name: 'chr1', length: 100 },
          { name: 'chrM', length: 16_571 },
        ],
      })
    ).rejects.toThrow('chr1');
  });

  it('rejects a BigWig that is missing a primary chromosome', async () => {
    await expect(
      remoteSignalReferenceReceipt({
        assemblyId: 'hg19',
        expected,
        actual: [{ name: 'chr1', length: 249_250_621 }],
      })
    ).rejects.toThrow('chrM');
  });

  it('refreshes an SSH BigWig source in place without deleting or moving its composed lane', async () => {
    const first = await attachRemoteSignalBigWig({
      laneOwnerId: 'tab',
      assemblyId: 'hg19',
      assemblyReferences: REFERENCE,
      target: 'cluster',
      signalPath: '/analysis/sample.bigWig',
      bigWigUrl: 'http://127.0.0.1:4100/v1/sessionA1/signal.bigWig',
      byteLength: 4_096,
      label: 'Signal',
    });
    const store = useLaneContractStore.getState();
    store.addLane('tab', 'hg19', readDataset());
    store.addLane('tab', 'hg19', {
      ...readDataset(),
      trackId: 'combined',
      label: 'Signal to reads',
      experimentalHybrid: {
        alignmentTrackId: 'reads',
        quantitativeTrackId: first.trackId,
        loadingAnimation: 'diagonal-scan',
      },
    });
    store.setLaneVisible('tab', first.trackId, false);

    const refreshed = await attachRemoteSignalBigWig({
      laneOwnerId: 'tab',
      assemblyId: 'hg19',
      assemblyReferences: REFERENCE,
      target: 'cluster',
      signalPath: '/analysis/sample.bigWig',
      bigWigUrl: 'http://127.0.0.1:4101/v1/sessionB2/signal.bigWig',
      byteLength: 4_096,
      label: 'Signal from a new session',
    });

    expect(refreshed.trackId).toBe(first.trackId);
    expect(store.lanesForOwner('tab').map((lane) => lane.dataset.trackId)).toEqual([
      first.trackId,
      'reads',
      'combined',
    ]);
    expect(
      store.lanesForOwner('tab').find((lane) => lane.dataset.trackId === 'combined')
    ).toBeTruthy();
    expect(
      store.lanesForOwner('tab').find((lane) => lane.dataset.trackId === first.trackId)
    ).toMatchObject({
      visible: false,
      source: {
        uri: 'http://127.0.0.1:4101/v1/sessionB2/signal.bigWig',
      },
    });
  });

  it('preserves user row reordering while an SSH signal refresh is pending', async () => {
    const request = {
      laneOwnerId: 'tab',
      assemblyId: 'hg19',
      assemblyReferences: REFERENCE,
      target: 'cluster',
      signalPath: '/analysis/sample.bigWig',
      bigWigUrl: 'http://127.0.0.1:4100/v1/sessionA1/signal.bigWig',
      byteLength: 4096,
    };
    const first = await attachRemoteSignalBigWig(request);
    const store = useLaneContractStore.getState();
    store.addLane('tab', 'hg19', readDataset());
    store.addLane('tab', 'hg19', {
      ...readDataset(),
      trackId: 'combined',
      experimentalHybrid: { alignmentTrackId: 'reads', quantitativeTrackId: first.trackId },
    });
    store.clearOwnerHistory('tab');
    let finishOpen!: (header: unknown) => void;
    bbiMocks.open.mockReturnValueOnce(
      new Promise((resolve) => {
        finishOpen = resolve;
      })
    );
    const pending = attachRemoteSignalBigWig({
      ...request,
      bigWigUrl: 'http://127.0.0.1:4101/v1/sessionB2/signal.bigWig',
    });
    store.moveLane('tab', 'combined', first.trackId, 'before');
    const rows = () =>
      store.lanesForOwner('tab').map((lane) => ({
        id: lane.dataset.trackId,
        order: lane.order,
        visible: lane.visible,
      }));
    const reordered = rows();
    finishOpen({
      fileType: 'bigwig',
      references: REFERENCE,
      zoomReductionLevels: [10],
      totalSummary: { basesCovered: 100, scoreMin: 0, scoreMax: 12 },
    });
    await pending;
    expect(rows()).toEqual(reordered);
    expect(store.undoLaneChange('tab')).toBe(true);
    expect(store.lanesForOwner('tab').map((lane) => lane.dataset.trackId)).toEqual([
      first.trackId,
      'reads',
      'combined',
    ]);
    expect(store.canUndoLaneChange('tab')).toBe(false);
  });

  it.each([
    'closed',
    'primary-removed',
    'primary-replaced',
    'signal-removed',
    'signal-refreshed',
    'aborted',
  ] as const)('does not publish a delayed companion when its admission is %s', async (change) => {
    const request = {
      laneOwnerId: 'tab',
      assemblyId: 'hg19',
      assemblyReferences: REFERENCE,
      target: 'cluster',
      signalPath: '/analysis/sample.bigWig',
      bigWigUrl: 'http://127.0.0.1:4100/v1/original-signal/signal.bigWig',
      byteLength: 4_096,
    };
    const original = await attachRemoteSignalBigWig(request);
    const store = useLaneContractStore.getState();
    store.addLane('tab', 'hg19', remoteReadDataset());
    let finishOpen!: (header: unknown) => void;
    bbiMocks.open.mockReturnValueOnce(
      new Promise((resolve) => {
        finishOpen = resolve;
      })
    );
    const controller = new AbortController();
    const pending = attachRemoteSignalBigWig({
      ...request,
      bigWigUrl: 'http://127.0.0.1:4101/v1/delayed-signal/signal.bigWig',
      signal: controller.signal,
      primaryTrack: { trackId: 'reads', sessionId: 'primary-session' },
    });

    if (change === 'closed') store.clearOwner('tab');
    else if (change === 'primary-removed') store.removeLane('tab', 'reads');
    else if (change === 'primary-replaced') {
      store.replaceLaneDataset('tab', 'reads', 'hg19', readDataset());
    } else if (change === 'signal-removed') store.removeLane('tab', original.trackId);
    else if (change === 'signal-refreshed') {
      await attachRemoteSignalBigWig({
        ...request,
        bigWigUrl: 'http://127.0.0.1:4102/v1/newest-signal/signal.bigWig',
        primaryTrack: { trackId: 'reads', sessionId: 'primary-session' },
      });
    } else controller.abort();
    const expected = store.lanesForOwner('tab');
    finishOpen({
      fileType: 'bigwig',
      references: REFERENCE,
      zoomReductionLevels: [10],
      totalSummary: { basesCovered: 100, scoreMin: 0, scoreMax: 12 },
    });

    await expect(pending).rejects.toThrow('cancelled');
    expect(store.lanesForOwner('tab')).toEqual(expected);
    if (change === 'closed') {
      expect(useLaneContractStore.getState().lanesByOwnerId).not.toHaveProperty('tab');
    }
    expect(bbiMocks.closeSource).toHaveBeenCalledWith(expect.stringContaining('delayed-signal'));
  });
});
