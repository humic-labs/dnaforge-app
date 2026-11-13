import { act, renderHook, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  IndexedGenomeBamTrackState,
  IndexedGenomeDataTrackState,
} from '../../../shared/indexed-genome';
import type { RemoteGenomicsRuntimeStatusEventV1 } from '../../../shared/remote-genomics-ipc';
import { readAlignmentHeader, type AlignmentReferenceIdentity } from '../alignment-header-client';
import { createIndexedBbiTrackId } from '@waypoint/genome-data';
import { startAlignmentCoverageOperation } from '../alignment-coverage-operation-client';
import { openAlignedReadSource } from '../aligned-read-source-session';
import { attachRemoteSignalBigWig } from '../attach-remote-signal-bigwig';
import { useLaneContractStore } from '../lane-contract-store';
import { buildReadPileupDataset } from '../read-pileup-import';
import { laneFromIndexedGenomeDataTrack } from '../ucsc-track-persistence';
import { usePersistedBamTracks } from './usePersistedBamTracks';
import { usePersistedSignalReadPileupViews } from './usePersistedSignalReadPileupViews';
import { usePersistedDataTracks } from './usePersistedUcscTracks';

const {
  mockStat,
  mockWatchFile,
  mockUnwatchFile,
  mockRemoteConnect,
  mockRemoteDisconnect,
  remoteStatusListeners,
  fileChangedListeners,
  bbiOpen,
  bbiClose,
  bbiQuery,
} = vi.hoisted(() => ({
  mockStat: vi.fn(),
  mockWatchFile: vi.fn().mockResolvedValue(undefined),
  mockUnwatchFile: vi.fn().mockResolvedValue(undefined),
  mockRemoteConnect: vi.fn(),
  mockRemoteDisconnect: vi.fn().mockResolvedValue(undefined),
  remoteStatusListeners: new Set<(event: RemoteGenomicsRuntimeStatusEventV1) => void>(),
  fileChangedListeners: new Set<(...args: unknown[]) => void>(),
  bbiOpen: vi.fn(),
  bbiClose: vi.fn().mockResolvedValue(undefined),
  bbiQuery: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../platform', () => ({
  platform: () => ({
    fs: { stat: mockStat, watchFile: mockWatchFile, unwatchFile: mockUnwatchFile },
    remoteGenomics: {
      listEndpoints: vi.fn().mockResolvedValue([]),
      connectAlignment: mockRemoteConnect,
      disconnectSession: mockRemoteDisconnect,
      subscribeStatus: (listener: (event: RemoteGenomicsRuntimeStatusEventV1) => void) => {
        remoteStatusListeners.add(listener);
        return () => remoteStatusListeners.delete(listener);
      },
    },
    on: (event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'file-changed') fileChangedListeners.add(listener);
      return () => fileChangedListeners.delete(listener);
    },
  }),
}));

vi.mock('../alignment-header-client', async () => {
  const actual = await vi.importActual<typeof import('../alignment-header-client')>(
    '../alignment-header-client'
  );
  return {
    ...actual,
    readAlignmentHeader: vi.fn(),
  };
});

vi.mock('../alignment-coverage-operation-client', () => ({
  startAlignmentCoverageOperation: vi.fn(),
}));

vi.mock('../aligned-read-source-session', () => ({
  openAlignedReadSource: vi.fn(),
}));

vi.mock('../attach-remote-signal-bigwig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../attach-remote-signal-bigwig')>()),
  attachRemoteSignalBigWig: vi.fn(),
}));

vi.mock('../bbi-reader-runtime', () => ({
  getBbiReaderWorkerClient: () => ({
    open: bbiOpen,
    closeSource: bbiClose,
    queryQuantitative: bbiQuery,
  }),
}));

const REFERENCES = [
  { name: 'chr1', length: 1_000 },
  { name: 'chr2', length: 2_000 },
] as const;

const TRACKS: readonly IndexedGenomeBamTrackState[] = [
  {
    trackId: 'tumor-track',
    label: 'Tumor',
    source: { bamPath: '/data/tumor.bam', indexPath: '/data/tumor.bam.bai' },
    visible: false,
    coverageCutoffDepth: 80,
  },
  {
    trackId: 'normal-track',
    label: 'Normal',
    source: { bamPath: '/data/normal.bam', indexPath: '/managed/normal.bam.bai' },
    visible: true,
    coverageCutoffDepth: 0,
  },
];

function remoteTrack(): IndexedGenomeBamTrackState {
  return {
    trackId: 'remote-tumor',
    label: 'Remote tumor',
    source: {
      bamPath: 'https://reads.example.org/tumor.bam',
      indexPath: 'https://reads.example.org/tumor.bam.bai',
    },
    admittedSource: {
      admissionVersion: 2,
      request: {
        contract: 'dnaforge.track-admission-request.v1',
        assemblyId: 'grch38',
        source: { kind: 'http', url: 'https://reads.example.org/tumor.bam' },
        index: { kind: 'http', url: 'https://reads.example.org/tumor.bam.bai' },
        formatId: 'bam',
        scientificKind: 'reads',
        ingress: { kind: 'url' },
      },
      admittedAt: '2026-09-21T20:00:00.000Z',
      uri: 'https://reads.example.org/tumor.bam',
      input: { kind: 'url', url: 'https://reads.example.org/tumor.bam' },
      index: { kind: 'url', url: 'https://reads.example.org/tumor.bam.bai' },
      formatId: 'bam',
      recommendedTypes: ['pileup'],
      fingerprint: `sha256:${'d'.repeat(64)}`,
      readerKind: 'bam',
      scientificKind: 'reads',
      assemblyId: 'grch38',
      referenceReceipt: {
        assemblyId: 'grch38',
        referenceSignature: `sha256:${'e'.repeat(64)}`,
        sourceSignature: `sha256:${'f'.repeat(64)}`,
        contigMap: { chr1: 'chr1', chr2: 'chr2' },
        checkedContigs: 2,
        status: 'compatible',
        checkedAt: '2026-09-21T20:00:00.000Z',
      },
      provenance: { provider: 'http', sourceKind: 'http', label: 'tumor.bam' },
      expectedValidators: { contentLength: 10_000, etag: '"bam-v1"' },
      indexExpectedValidators: { contentLength: 500, etag: '"bai-v1"' },
      alignedReadIndexState: 'present',
    },
    visible: true,
    coverageCutoffDepth: 0,
  };
}

function savedSshTrack(): IndexedGenomeBamTrackState {
  return {
    trackId: 'saved-ssh-track',
    label: 'GRCh38: tumor.bam',
    source: {
      bamPath: '/project/run 42/tumor.bam',
      indexPath: '/project/run 42/tumor.bam.bai',
      remote: {
        contract: 'remote-alignment-locator.v1',
        endpointId: 'endpoint-1',
        target: 'lab-hpc',
        alignmentPath: '/project/run 42/tumor.bam',
        indexPath: '/project/run 42/tumor.bam.bai',
      },
    },
    visible: true,
    coverageCutoffDepth: 0,
  };
}

function htsgetTrack(): IndexedGenomeBamTrackState {
  const identity = 'e'.repeat(64);
  return {
    trackId: 'htsget-tumor',
    label: 'htsget tumor',
    source: {
      bamPath: `htsget-source://${identity}/source.bam`,
      indexPath: `htsget-source://${identity}/managed.bai`,
    },
    admittedSource: {
      admissionVersion: 2,
      request: {
        contract: 'dnaforge.track-admission-request.v1',
        assemblyId: 'grch38',
        source: {
          kind: 'htsget',
          endpoint: 'https://htsget.example.org',
          resourceId: 'tumor',
          dataClass: 'reads',
          format: 'BAM',
        },
        formatId: 'bam',
        scientificKind: 'reads',
        ingress: { kind: 'url' },
      },
      admittedAt: '2026-09-21T20:00:00.000Z',
      uri: `htsget:${identity}`,
      formatId: 'bam',
      recommendedTypes: ['pileup'],
      fingerprint: `sha256:${'d'.repeat(64)}`,
      readerKind: 'bam',
      scientificKind: 'reads',
      assemblyId: 'grch38',
      referenceReceipt: {
        assemblyId: 'grch38',
        referenceSignature: `sha256:${'e'.repeat(64)}`,
        sourceSignature: `sha256:${'f'.repeat(64)}`,
        contigMap: { chr1: 'chr1', chr2: 'chr2' },
        checkedContigs: 2,
        status: 'compatible',
        checkedAt: '2026-09-21T20:00:00.000Z',
      },
      provenance: { provider: 'htsget', sourceKind: 'htsget', label: 'tumor' },
      alignedReadIndexState: 'present',
    },
    visible: true,
    coverageCutoffDepth: 0,
  };
}

function availableFile(path: string) {
  return {
    canonicalPath: `/canonical${path}`,
    size: 1,
    isFile: true,
    isDirectory: false,
    mtime: 1,
    ctime: 2,
    mtimeNs: '1000000',
    ctimeNs: '2000000',
    device: '42',
    inode: '1001',
  };
}

function savedSshSignalTrack(
  trackId: string,
  target = 'lab-hpc',
  signalPath = '/project/coverage.bigWig',
  assemblyId = 'grch38'
): IndexedGenomeDataTrackState {
  const uri = `ssh://${target}${signalPath}`;
  return {
    trackId,
    trackType: 'quantitative',
    label: 'Saved SSH histogram',
    order: 1,
    color: 0xa8ceff,
    trackPx: 96,
    laneHeightPx: 8,
    maxLanes: 32,
    visible: true,
    remoteSignal: {
      contract: 'remote-signal-locator.v1',
      endpointId: 'endpoint-1',
      target,
      signalPath,
    },
    source: {
      admissionVersion: 1,
      uri,
      input: { kind: 'url', url: uri },
      formatId: 'bigwig',
      recommendedTypes: ['quantitative'],
      fingerprint: ['remote-signal', uri].join('\0'),
      readerKind: 'bbi',
      scientificKind: 'quantitative',
      quantitativeColumnSemantics: 'continuous-signal',
      assemblyId,
      referenceReceipt: {
        assemblyId,
        referenceSignature: 'previous-reference-receipt',
        sourceSignature: 'previous-signal-receipt',
        contigMap: { chr1: 'chr1', chr2: 'chr2' },
        checkedContigs: 2,
        status: 'compatible',
        checkedAt: '2026-09-21T20:00:00.000Z',
      },
      provenance: { provider: 'direct-url', sourceKind: 'remote-url', label: 'Saved histogram' },
    },
  };
}

function restoredSshPair() {
  const saved = savedSshTrack();
  const locator = { ...saved.source.remote!, signalPath: '/project/coverage.bigWig' };
  const remote = { ...saved, source: { ...saved.source, remote: locator } };
  const bigWigUrl = 'http://127.0.0.1:43119/v1/restored-pair/signal.bigWig';
  const fileGeneration = (canonicalPath: string, size: number) => ({
    canonicalPath,
    size,
    mtimeNs: '1',
    ctimeNs: '1',
    device: '1',
    inode: '2',
  });
  mockRemoteConnect.mockResolvedValue({
    protocol: 'dnaforge-remote-range.v1',
    sessionId: 'restored-pair-lease',
    endpoint: {
      endpointId: 'endpoint-1',
      displayName: 'Lab HPC',
      target: locator.target,
      lastConnectedAt: 1,
      observedPlatform: 'linux',
      lastFailure: null,
    },
    locator,
    bamUrl: 'http://127.0.0.1:43119/v1/restored-pair/alignment.bam',
    bigWigUrl,
    indexPath: '/tmp/restored-pair/reads.bam.bai',
    generation: {
      alignment: fileGeneration(locator.alignmentPath, 100),
      index: fileGeneration(locator.indexPath, 10),
      signal: fileGeneration(locator.signalPath, 1_000),
    },
  });
  return { remote, locator, bigWigUrl };
}

const SIGNAL_HEADER = {
  fileType: 'bigwig',
  references: REFERENCES,
  zoomReductionLevels: [10],
  totalSummary: { basesCovered: 100, scoreMin: 0, scoreMax: 12 },
};

describe('usePersistedBamTracks', () => {
  afterEach(() => vi.useRealTimers());

  beforeEach(() => {
    useLaneContractStore.getState().clear();
    fileChangedListeners.clear();
    remoteStatusListeners.clear();
    mockStat.mockReset().mockImplementation(async (path: string) => availableFile(path));
    mockWatchFile.mockClear();
    mockUnwatchFile.mockClear();
    mockRemoteConnect.mockReset();
    mockRemoteDisconnect.mockReset().mockResolvedValue(undefined);
    vi.mocked(readAlignmentHeader)
      .mockReset()
      .mockResolvedValue({
        format: 'bam',
        isCram: false,
        referenceRequired: false,
        references: REFERENCES.map((reference) => ({ ...reference, md5: null })),
        index: { state: 'present' },
      });
    vi.mocked(startAlignmentCoverageOperation)
      .mockReset()
      .mockResolvedValue(undefined as never);
    vi.mocked(openAlignedReadSource).mockReset();
    vi.mocked(attachRemoteSignalBigWig)
      .mockReset()
      .mockResolvedValue({ trackId: 'remote-signal', label: 'signal.bigWig' });
    bbiOpen.mockReset();
    bbiClose.mockReset().mockResolvedValue(undefined);
    bbiQuery.mockReset().mockResolvedValue([]);
  });

  it.each(['old-assembly canonical ID', 'custom ID'] as const)(
    'preserves a paired saved SSH histogram %s through fresh admission',
    async (identity) => {
      const actual = await vi.importActual<typeof import('../attach-remote-signal-bigwig')>(
        '../attach-remote-signal-bigwig'
      );
      vi.mocked(attachRemoteSignalBigWig).mockImplementation(actual.attachRemoteSignalBigWig);
      let finishHeader!: (header: typeof SIGNAL_HEADER) => void;
      bbiOpen.mockImplementationOnce(() => new Promise((resolve) => (finishHeader = resolve)));
      const { remote, locator, bigWigUrl } = restoredSshPair();
      const preservedId =
        identity === 'custom ID'
          ? 'user-saved-histogram'
          : createIndexedBbiTrackId({
              assemblyId: 'hg19',
              source: { kind: 'url', url: `ssh://${locator.target}${locator.signalPath}` },
            });
      const savedSignal = savedSshSignalTrack(preservedId);
      const { result, unmount } = renderHook(() => {
        const bam = usePersistedBamTracks({
          laneOwnerId: 'tab',
          assemblyId: 'grch38',
          assemblyDisplayName: 'GRCh38',
          references: REFERENCES,
          persistedTracks: [remote],
          onChange: vi.fn(),
        });
        const data = usePersistedDataTracks({
          laneOwnerId: 'tab',
          assemblyId: 'grch38',
          references: REFERENCES,
          persistedTracks: [savedSignal],
          pairedBamTracks: [remote],
          pairedSourcesReady: bam.status === 'ready',
          onChange: vi.fn(),
        });
        return { bam, data };
      });
      try {
        await waitFor(() => expect(bbiOpen).toHaveBeenCalledOnce());
        expect(result.current.bam.status).toBe('restoring');
        const placeholder = useLaneContractStore
          .getState()
          .lanesForOwner('tab')
          .find((lane) => lane.dataset.trackId === preservedId);
        expect(placeholder?.source).toBeUndefined();
        await act(async () => finishHeader(SIGNAL_HEADER));
        await waitFor(() => expect(result.current.bam.status).toBe('ready'));
        expect(attachRemoteSignalBigWig).toHaveBeenCalledOnce();
        expect(attachRemoteSignalBigWig).toHaveBeenCalledWith(
          expect.objectContaining({
            trackId: preservedId,
            assemblyId: 'grch38',
            assemblyReferences: REFERENCES,
            target: locator.target,
            signalPath: locator.signalPath,
            bigWigUrl,
          })
        );
        const lanes = useLaneContractStore.getState().lanesForOwner('tab');
        expect(lanes.map((lane) => lane.dataset.trackId).sort()).toEqual(
          [remote.trackId, preservedId].sort()
        );
        const admitted = lanes.find((lane) => lane.dataset.trackId === preservedId);
        expect(admitted?.source?.uri).toBe(bigWigUrl);
        expect(admitted?.source?.referenceReceipt).toMatchObject({
          assemblyId: 'grch38',
          checkedContigs: 2,
          status: 'compatible',
        });
        expect(admitted?.source?.referenceReceipt.referenceSignature).not.toBe(
          savedSignal.source.referenceReceipt.referenceSignature
        );
        expect(bbiOpen).toHaveBeenCalledOnce();
        expect(bbiClose).toHaveBeenCalledOnce();
        expect(result.current.bam.issues).toEqual([]);
        await waitFor(() => expect(result.current.data.status).toBe('ready'));
        expect(result.current.data.issues).toEqual([]);
      } finally {
        finishHeader?.(SIGNAL_HEADER);
        unmount();
        useLaneContractStore.getState().clearOwner('tab');
        await waitFor(() =>
          expect(mockRemoteDisconnect).toHaveBeenCalledWith('restored-pair-lease')
        );
      }
    }
  );

  it('freshly re-admits a paired histogram in its existing validated custom lane', async () => {
    const actual = await vi.importActual<typeof import('../attach-remote-signal-bigwig')>(
      '../attach-remote-signal-bigwig'
    );
    vi.mocked(attachRemoteSignalBigWig).mockImplementation(actual.attachRemoteSignalBigWig);
    bbiOpen.mockResolvedValue(SIGNAL_HEADER);
    const { remote, locator, bigWigUrl } = restoredSshPair();
    const preservedId = 'validated-user-histogram';
    const oldUrl = 'http://127.0.0.1:43000/v1/previous-pair/signal.bigWig';
    await actual.attachRemoteSignalBigWig({
      laneOwnerId: 'tab',
      assemblyId: 'grch38',
      assemblyReferences: REFERENCES,
      target: locator.target,
      signalPath: locator.signalPath,
      bigWigUrl: oldUrl,
      byteLength: 1_000,
      trackId: preservedId,
      remote: { locator: { ...savedSshSignalTrack(preservedId).remoteSignal! } },
    });
    const { result, unmount } = renderHook(() =>
      usePersistedBamTracks({
        laneOwnerId: 'tab',
        assemblyId: 'grch38',
        assemblyDisplayName: 'GRCh38',
        references: REFERENCES,
        persistedTracks: [remote],
        onChange: vi.fn(),
      })
    );
    try {
      await waitFor(() => expect(result.current.status).toBe('ready'));
      expect(attachRemoteSignalBigWig).toHaveBeenCalledWith(
        expect.objectContaining({ trackId: preservedId, bigWigUrl })
      );
      const lanes = useLaneContractStore.getState().lanesForOwner('tab');
      expect(lanes.map((lane) => lane.dataset.trackId).sort()).toEqual(
        [remote.trackId, preservedId].sort()
      );
      expect(lanes.find((lane) => lane.dataset.trackId === preservedId)?.source?.uri).toBe(
        bigWigUrl
      );
      expect(bbiOpen).toHaveBeenCalledTimes(2);
      expect(bbiClose).toHaveBeenCalledTimes(2);
      expect(result.current.issues).toEqual([]);
    } finally {
      unmount();
      useLaneContractStore.getState().clearOwner('tab');
      await waitFor(() => expect(mockRemoteDisconnect).toHaveBeenCalledWith('restored-pair-lease'));
    }
  });

  it('does not bypass a cancelled saved SSH histogram with a new canonical ID', async () => {
    const actual = await vi.importActual<typeof import('../attach-remote-signal-bigwig')>(
      '../attach-remote-signal-bigwig'
    );
    vi.mocked(attachRemoteSignalBigWig).mockImplementation(actual.attachRemoteSignalBigWig);
    bbiOpen.mockResolvedValue(SIGNAL_HEADER);
    const { remote } = restoredSshPair();
    const preservedId = 'cancelled-user-histogram';
    const saved = laneFromIndexedGenomeDataTrack(savedSshSignalTrack(preservedId), 'grch38');
    useLaneContractStore.getState().addLane('tab', 'grch38', {
      ...saved.dataset,
      remoteSignal: { ...saved.dataset.remoteSignal!, admissionCancelled: true },
    });
    const { result, unmount } = renderHook(() =>
      usePersistedBamTracks({
        laneOwnerId: 'tab',
        assemblyId: 'grch38',
        assemblyDisplayName: 'GRCh38',
        references: REFERENCES,
        persistedTracks: [remote],
        onChange: vi.fn(),
      })
    );
    try {
      await waitFor(() => expect(result.current.status).toBe('ready'));
      expect(bbiOpen).not.toHaveBeenCalled();
      const lanes = useLaneContractStore.getState().lanesForOwner('tab');
      expect(lanes.map((lane) => lane.dataset.trackId).sort()).toEqual(
        [remote.trackId, preservedId].sort()
      );
      const cancelled = lanes.find((lane) => lane.dataset.trackId === preservedId);
      expect(cancelled?.source).toBeUndefined();
      expect(cancelled?.dataset.remoteSignal?.admissionCancelled).toBe(true);
      expect(vi.mocked(attachRemoteSignalBigWig).mock.calls[0]![0].resumeCancelled).not.toBe(true);
    } finally {
      unmount();
      useLaneContractStore.getState().clearOwner('tab');
      await waitFor(() => expect(mockRemoteDisconnect).toHaveBeenCalledWith('restored-pair-lease'));
    }
  });

  it.each(['owner', 'assembly', 'target', 'path'] as const)(
    'does not reuse a saved SSH histogram from a different %s',
    async (difference) => {
      const actual = await vi.importActual<typeof import('../attach-remote-signal-bigwig')>(
        '../attach-remote-signal-bigwig'
      );
      vi.mocked(attachRemoteSignalBigWig).mockImplementation(actual.attachRemoteSignalBigWig);
      bbiOpen.mockResolvedValue(SIGNAL_HEADER);
      const { remote, locator, bigWigUrl } = restoredSshPair();
      const foreignOwner = difference === 'owner' ? 'other-tab' : 'tab';
      const foreignAssembly = difference === 'assembly' ? 'hg19' : 'grch38';
      const savedSignal = savedSshSignalTrack(
        'unrelated-user-histogram',
        difference === 'target' ? 'different-cluster' : locator.target,
        difference === 'path' ? '/project/different.bigWig' : locator.signalPath,
        foreignAssembly
      );
      const foreignLane = laneFromIndexedGenomeDataTrack(savedSignal, foreignAssembly);
      useLaneContractStore
        .getState()
        .addLane(foreignOwner, foreignAssembly, foreignLane.dataset, true);
      const { result, unmount } = renderHook(() =>
        usePersistedBamTracks({
          laneOwnerId: 'tab',
          assemblyId: 'grch38',
          assemblyDisplayName: 'GRCh38',
          references: REFERENCES,
          persistedTracks: [remote],
          onChange: vi.fn(),
        })
      );
      try {
        await waitFor(() => expect(result.current.status).toBe('ready'));
        expect(attachRemoteSignalBigWig).toHaveBeenCalledOnce();
        expect(vi.mocked(attachRemoteSignalBigWig).mock.calls[0]![0].trackId).toBeUndefined();
        const canonicalId = createIndexedBbiTrackId({
          assemblyId: 'grch38',
          source: { kind: 'url', url: `ssh://${locator.target}${locator.signalPath}` },
        });
        const admitted = useLaneContractStore
          .getState()
          .lanesForOwner('tab')
          .find((lane) => lane.dataset.trackId === canonicalId);
        expect(admitted?.source?.uri).toBe(bigWigUrl);
        expect(admitted?.dataset.remoteSignal?.locator).toMatchObject({
          target: locator.target,
          signalPath: locator.signalPath,
        });
        const retainedForeign = useLaneContractStore
          .getState()
          .lanesForOwner(foreignOwner)
          .find((lane) => lane.dataset.trackId === savedSignal.trackId);
        expect(retainedForeign?.source).toBeUndefined();
        expect(retainedForeign?.assemblyId).toBe(foreignAssembly);
        expect(retainedForeign?.dataset.remoteSignal?.locator).toEqual(savedSignal.remoteSignal);
        expect(bbiOpen).toHaveBeenCalledOnce();
        expect(result.current.issues).toEqual([]);
      } finally {
        unmount();
        useLaneContractStore.getState().clearOwner('tab');
        useLaneContractStore.getState().clearOwner('other-tab');
        await waitFor(() =>
          expect(mockRemoteDisconnect).toHaveBeenCalledWith('restored-pair-lease')
        );
      }
    }
  );

  it.each([
    'unchanged',
    'local-file-changed',
    'dual-local-file-changed',
    'same-owner-remount',
    'view-closed',
    'reads-removed',
    'unchanged-rejected',
    'local-file-changed-rejected',
  ] as const)('settles an SSH companion according to its live view after %s', async (change) => {
    const actual = await vi.importActual<typeof import('../attach-remote-signal-bigwig')>(
      '../attach-remote-signal-bigwig'
    );
    vi.mocked(attachRemoteSignalBigWig).mockImplementation(actual.attachRemoteSignalBigWig);
    let resolveHeader!: (header: {
      fileType: string;
      references: typeof REFERENCES;
      zoomReductionLevels: number[];
      totalSummary: { basesCovered: number; scoreMin: number; scoreMax: number };
    }) => void;
    let rejectHeader!: (error: Error) => void;
    let resolveLocalHeader:
      | ((header: Awaited<ReturnType<typeof readAlignmentHeader>>) => void)
      | undefined;
    const alignmentHeader = {
      format: 'bam' as const,
      isCram: false,
      referenceRequired: false,
      references: REFERENCES.map((reference) => ({ ...reference, md5: null })),
      index: { state: 'present' as const },
    };
    const header = {
      fileType: 'bigwig',
      references: REFERENCES,
      zoomReductionLevels: [10],
      totalSummary: { basesCovered: 100, scoreMin: 0, scoreMax: 12 },
    };
    bbiOpen.mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          resolveHeader = resolve;
          rejectHeader = reject;
        })
    );
    const saved = savedSshTrack();
    const locator = { ...saved.source.remote!, signalPath: '/project/coverage.bigWig' };
    const remote = { ...saved, source: { ...saved.source, remote: locator } };
    const sourceId = `stable-remote-source-${change}`;
    const sessionId = `remote-view-lease-${change}`;
    const fileGeneration = (path: string, size: number) => ({
      canonicalPath: path,
      size,
      mtimeNs: '1',
      ctimeNs: '1',
      device: '1',
      inode: '2',
    });
    mockRemoteConnect.mockResolvedValue({
      protocol: 'dnaforge-remote-range.v1',
      sessionId,
      endpoint: {
        endpointId: 'endpoint-1',
        displayName: 'Lab HPC',
        target: locator.target,
        lastConnectedAt: 1,
        observedPlatform: 'linux',
        lastFailure: null,
      },
      locator,
      bamUrl: `http://127.0.0.1:43119/v1/${sourceId}/alignment.bam`,
      bigWigUrl: `http://127.0.0.1:43119/v1/${sourceId}/signal.bigWig`,
      indexPath: '/tmp/stable-index/reads.bam.bai',
      generation: {
        alignment: fileGeneration(locator.alignmentPath, 100),
        index: fileGeneration(locator.indexPath, 10),
        signal: fileGeneration(locator.signalPath, 1_000),
      },
    });
    const signalTrackId = createIndexedBbiTrackId({
      assemblyId: 'grch38',
      source: { kind: 'url', url: `ssh://${locator.target}${locator.signalPath}` },
    });
    const view = {
      contract: 'dnaforge.signal-read-pileup-view.v1' as const,
      trackId: 'combined',
      readsTrackId: remote.trackId,
      signalTrackId,
      label: 'Coverage to reads',
      order: 2,
      visible: true,
      color: 0xa8ceff,
      trackPx: 276,
      laneHeightPx: 3,
      maxLanes: 80,
      overflowBandHeightPx: 36,
      coverageCutoffDepth: 80,
      loadingAnimation: 'diagonal-scan' as const,
    };
    const restore = () => {
      const bam = usePersistedBamTracks({
        laneOwnerId: 'tab',
        assemblyId: 'grch38',
        assemblyDisplayName: 'GRCh38',
        references: REFERENCES,
        persistedTracks: [remote, TRACKS[0]!],
        onChange: vi.fn(),
      });
      const composition = usePersistedSignalReadPileupViews({
        laneOwnerId: 'tab',
        assemblyId: 'grch38',
        persistedViews: [view],
        sourcesReady: bam.status === 'ready',
        onChange: vi.fn(),
      });
      return { bam, composition };
    };
    let hook = renderHook(restore);
    try {
      await waitFor(() => expect(bbiOpen).toHaveBeenCalledOnce());
      expect(hook.result.current.bam.status).toBe('restoring');
      expect(hook.result.current.composition.issues).toEqual([]);
      const signal = vi.mocked(attachRemoteSignalBigWig).mock.calls[0]![0].signal;
      if (change === 'view-closed') {
        hook.unmount();
        act(() => {
          useLaneContractStore.getState().clearOwner('tab');
        });
      } else if (change === 'reads-removed') {
        act(() => {
          useLaneContractStore.getState().removeLane('tab', remote.trackId);
        });
      } else if (
        change === 'local-file-changed' ||
        change === 'dual-local-file-changed' ||
        change === 'local-file-changed-rejected'
      ) {
        if (change === 'local-file-changed-rejected') {
          vi.mocked(readAlignmentHeader).mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                resolveLocalHeader = resolve;
              })
          );
        }
        act(() => {
          for (const listener of fileChangedListeners) listener(TRACKS[0]!.source.bamPath);
        });
        if (change === 'dual-local-file-changed') {
          await act(async () => {});
          act(() => {
            for (const listener of fileChangedListeners) listener(TRACKS[0]!.source.bamPath);
          });
        }
      } else if (change === 'same-owner-remount') {
        hook.unmount();
        expect(useLaneContractStore.getState().lanesForOwner('tab')).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              dataset: expect.objectContaining({ trackId: remote.trackId }),
            }),
          ])
        );
        hook = renderHook(restore);
      }
      if (change === 'view-closed' || change === 'reads-removed') {
        expect(signal?.aborted).toBe(true);
      }
      const rejected = change === 'unchanged-rejected' || change === 'local-file-changed-rejected';
      if (change === 'local-file-changed-rejected') {
        await waitFor(() => expect(resolveLocalHeader).toBeDefined());
      }
      await act(async () => {
        if (rejected) rejectHeader(new Error('The BigWig source could not be read.'));
        else resolveHeader(header);
      });
      if (change === 'local-file-changed-rejected') {
        await act(async () => resolveLocalHeader!(alignmentHeader));
      }
      if (change === 'view-closed' || change === 'reads-removed') {
        expect(
          useLaneContractStore
            .getState()
            .lanesForOwner('tab')
            .some((lane) => lane.dataset.trackId === signalTrackId)
        ).toBe(false);
        await waitFor(() => expect(mockRemoteDisconnect).toHaveBeenCalledWith(sessionId));
        if (change === 'view-closed')
          expect(useLaneContractStore.getState().lanesByOwnerId).not.toHaveProperty('tab');
        return;
      }
      await waitFor(() => expect(hook.result.current.bam.status).toBe('ready'));
      if (rejected) {
        expect(hook.result.current.bam.issues).toEqual([
          expect.objectContaining({
            trackId: remote.trackId,
            message: expect.stringContaining(
              'Histogram could not be opened: The BigWig source could not be read.'
            ),
          }),
        ]);
        expect(hook.result.current.composition.issues).toEqual([
          expect.objectContaining({ trackId: view.trackId }),
        ]);
      } else {
        expect(hook.result.current.composition.issues).toEqual([]);
      }
      expect(
        useLaneContractStore
          .getState()
          .lanesForOwner('tab')
          .some((lane) => lane.dataset.trackId === signalTrackId)
      ).toBe(!rejected);
      expect(bbiOpen).toHaveBeenCalledOnce();
      expect(mockRemoteConnect).toHaveBeenCalledOnce();
      expect(mockRemoteDisconnect).not.toHaveBeenCalled();
      expect(signal?.aborted).toBe(false);
    } finally {
      resolveHeader(header);
      resolveLocalHeader?.(alignmentHeader);
      hook.unmount();
      useLaneContractStore.getState().clearOwner('tab');
      await waitFor(() => expect(mockRemoteDisconnect).toHaveBeenCalledWith(sessionId));
    }
  });

  it('hydrates persisted tracks without reindexing and submits coverage as managed work', async () => {
    let persisted = TRACKS;
    const onChange = vi.fn(
      (
        update: (
          previous: readonly IndexedGenomeBamTrackState[]
        ) => readonly IndexedGenomeBamTrackState[]
      ) => {
        persisted = update(persisted);
      }
    );

    const { result } = renderHook(() =>
      usePersistedBamTracks({
        laneOwnerId: 'tab',
        assemblyId: 'grch38',
        assemblyDisplayName: 'GRCh38',
        references: REFERENCES,
        persistedTracks: TRACKS,
        onChange,
      })
    );

    await waitFor(() => expect(result.current.status).toBe('ready'));
    const lanes = useLaneContractStore.getState().lanesForOwner('tab');
    expect(lanes.map((lane) => lane.dataset.trackId)).toEqual(['tumor-track', 'normal-track']);
    expect(lanes.map((lane) => lane.visible)).toEqual([false, true]);
    expect(lanes.map((lane) => lane.dataset.source)).toEqual([
      expect.objectContaining({
        bamPath: '/data/tumor.bam',
        indexPath: '/data/tumor.bam.bai',
        generation: expect.objectContaining({
          alignment: expect.objectContaining({ canonicalPath: '/canonical/data/tumor.bam' }),
        }),
      }),
      expect.objectContaining({
        bamPath: '/data/normal.bam',
        indexPath: '/managed/normal.bam.bai',
        generation: expect.objectContaining({
          alignment: expect.objectContaining({ canonicalPath: '/canonical/data/normal.bam' }),
        }),
      }),
    ]);
    expect(mockStat).toHaveBeenCalledTimes(4);
    expect(mockWatchFile).toHaveBeenCalledTimes(4);
    expect(readAlignmentHeader).toHaveBeenCalledTimes(2);
    expect(startAlignmentCoverageOperation).toHaveBeenCalledTimes(2);
    expect(startAlignmentCoverageOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        assemblyId: 'grch38',
        bamPath: '/data/tumor.bam',
        indexPath: '/data/tumor.bam.bai',
        chroms: ['chr1', 'chr2'],
        sourceGeneration: expect.objectContaining({
          contract: 'aligned-read-source-generation.v1',
          alignment: expect.objectContaining({ canonicalPath: '/canonical/data/tumor.bam' }),
          index: expect.objectContaining({ canonicalPath: '/canonical/data/tumor.bam.bai' }),
        }),
      })
    );
    expect(result.current.issues).toEqual([]);
    await waitFor(() =>
      expect(persisted[0]?.source.generation?.contract).toBe('aligned-read-source-generation.v1')
    );

    act(() => {
      useLaneContractStore.getState().setLaneVisible('tab', 'tumor-track', true);
      useLaneContractStore.getState().setLaneCoverageCutoff('tab', 'tumor-track', 240);
    });
    await waitFor(() => {
      expect(persisted[0]).toMatchObject({ visible: true, coverageCutoffDepth: 240 });
    });
  });

  it('keeps the shared admission receipt attached while restoring and re-persisting a lane', async () => {
    const generation = {
      contract: 'aligned-read-source-generation.v1' as const,
      alignment: {
        canonicalPath: '/canonical/data/tumor.bam',
        size: 1,
        mtimeNs: '1000000',
        ctimeNs: '2000000',
        device: '42',
        inode: '1001',
      },
      index: {
        canonicalPath: '/canonical/data/tumor.bam.bai',
        size: 1,
        mtimeNs: '1000000',
        ctimeNs: '2000000',
        device: '42',
        inode: '1001',
      },
    };
    const admittedSource = {
      admissionVersion: 2 as const,
      request: {
        contract: 'dnaforge.track-admission-request.v1' as const,
        assemblyId: 'grch38',
        source: { kind: 'local-file' as const, path: '/data/tumor.bam' },
        index: { kind: 'local-file' as const, path: '/data/tumor.bam.bai' },
        formatId: 'bam',
        scientificKind: 'reads' as const,
        ingress: { kind: 'file-picker' as const },
      },
      admittedAt: '2026-09-21T20:00:00.000Z',
      uri: 'file:///data/tumor.bam',
      input: { kind: 'path' as const, path: '/data/tumor.bam' },
      index: { kind: 'path' as const, path: '/data/tumor.bam.bai' },
      formatId: 'bam',
      recommendedTypes: ['pileup'],
      fingerprint: `sha256:${'a'.repeat(64)}`,
      readerKind: 'bam' as const,
      scientificKind: 'reads' as const,
      assemblyId: 'grch38',
      referenceReceipt: {
        assemblyId: 'grch38',
        referenceSignature: `sha256:${'b'.repeat(64)}`,
        sourceSignature: `sha256:${'c'.repeat(64)}`,
        contigMap: { chr1: 'chr1', chr2: 'chr2' },
        checkedContigs: 2,
        status: 'compatible' as const,
        checkedAt: '2026-09-21T20:00:00.000Z',
      },
      provenance: { provider: 'local-file', sourceKind: 'local-file', label: 'tumor.bam' },
      expectedValidators: { contentLength: 1 },
      alignedReadGeneration: generation,
      alignedReadIndexState: 'present' as const,
    };
    const track: IndexedGenomeBamTrackState = {
      ...TRACKS[0],
      source: { ...TRACKS[0].source, generation },
      admittedSource,
    };
    let persisted: readonly IndexedGenomeBamTrackState[] = [track];

    const { result } = renderHook(() =>
      usePersistedBamTracks({
        laneOwnerId: 'tab',
        assemblyId: 'grch38',
        assemblyDisplayName: 'GRCh38',
        references: REFERENCES,
        persistedTracks: [track],
        onChange: (update) => {
          persisted = update(persisted);
        },
      })
    );

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(useLaneContractStore.getState().lanesForOwner('tab')[0]?.source).toEqual(admittedSource);
    await waitFor(() => expect(persisted[0]?.admittedSource).toEqual(admittedSource));
  });

  it.each([
    { state: 'needs-authentication', code: 'authentication-required' },
    { state: 'blocked', code: 'host-trust-failed' },
  ] as const)(
    'preserves main-owned $state and its typed failure when saved SSH restoration rejects',
    async ({ state, code }) => {
      let rejectConnect!: (error: Error) => void;
      mockRemoteConnect.mockReturnValue(
        new Promise((_resolve, reject) => {
          rejectConnect = reject;
        })
      );
      const track = savedSshTrack();
      const locator = track.source.remote!;
      const { result } = renderHook(() =>
        usePersistedBamTracks({
          laneOwnerId: 'tab',
          assemblyId: 'grch38',
          assemblyDisplayName: 'GRCh38',
          references: REFERENCES,
          persistedTracks: [track],
          onChange: vi.fn(),
        })
      );
      await waitFor(() => expect(mockRemoteConnect).toHaveBeenCalledOnce());
      const failure = { code, message: 'Typed main-process failure.' };
      act(() => {
        for (const listener of remoteStatusListeners) {
          listener({
            sequence: 1,
            reason: 'blocked',
            status: {
              sourceId: 'restoring-source',
              endpointId: locator.endpointId,
              target: locator.target,
              displayName: 'Lab HPC',
              alignmentPath: locator.alignmentPath,
              indexPath: locator.indexPath,
              signalPath: null,
              state,
              attempt: 1,
              nextRetryAt: null,
              transportGeneration: 0,
              lastFailure: failure,
              updatedAt: Date.now() + 1,
            },
          });
        }
      });
      const terminalConnection = useLaneContractStore.getState().lanesForOwner('tab')[0]!.dataset
        .source!.remote!.connection;
      expect(terminalConnection).toMatchObject({ state, lastFailure: failure });

      await act(async () => rejectConnect(new Error('Serialized connect rejection.')));

      await waitFor(() => expect(result.current.status).toBe('ready'));
      const source = useLaneContractStore.getState().lanesForOwner('tab')[0]!.dataset.source;
      expect(source?.remote?.connection).toEqual(terminalConnection);
      expect(source?.admissionError).toContain('Serialized connect rejection.');
      expect(result.current.issues).toHaveLength(1);
      expect(mockRemoteDisconnect).not.toHaveBeenCalled();
    }
  );

  it.each([
    { state: 'needs-authentication', code: 'authentication-required' },
    { state: 'needs-authentication', code: 'host-trust-failed' },
    { state: 'blocked', code: 'source-changed' },
  ] as const)(
    'retains queued main-owned $code when the connect rejection arrives first',
    async ({ state, code }) => {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
      try {
        let rejectConnect!: (error: Error) => void;
        mockRemoteConnect.mockReturnValue(
          new Promise((_resolve, reject) => {
            rejectConnect = reject;
          })
        );
        const track = savedSshTrack();
        const locator = track.source.remote!;
        const { result } = renderHook(() =>
          usePersistedBamTracks({
            laneOwnerId: 'tab',
            assemblyId: 'grch38',
            assemblyDisplayName: 'GRCh38',
            references: REFERENCES,
            persistedTracks: [track],
            onChange: vi.fn(),
          })
        );
        await waitFor(() => expect(mockRemoteConnect).toHaveBeenCalledOnce());
        const connecting = {
          sourceId: 'queued-restore-source',
          endpointId: locator.endpointId,
          target: locator.target,
          displayName: 'Lab HPC',
          alignmentPath: locator.alignmentPath,
          indexPath: locator.indexPath,
          signalPath: null,
          state: 'connecting' as const,
          attempt: 0,
          nextRetryAt: null,
          transportGeneration: 0,
          lastFailure: null,
          updatedAt: 1_000,
        };
        const deliver = (status: RemoteGenomicsRuntimeStatusEventV1['status']): void => {
          for (const listener of remoteStatusListeners)
            listener({ sequence: 1, reason: 'blocked', status });
        };
        act(() => deliver(connecting));
        clock.mockReturnValue(1_100);
        await act(async () => rejectConnect(new Error('Serialized connect rejection.')));
        await waitFor(() => expect(result.current.status).toBe('ready'));
        const terminal = {
          ...connecting,
          state,
          attempt: 1,
          lastFailure: { code, message: 'Actual main-owned terminal failure.' },
          updatedAt: 1_001,
        };
        act(() => deliver(terminal));
        const connection = () =>
          useLaneContractStore.getState().lanesForOwner('tab')[0]?.dataset.source?.remote
            ?.connection;
        expect(connection()).toMatchObject({
          sourceId: terminal.sourceId,
          state,
          lastFailure: terminal.lastFailure,
          updatedAt: terminal.updatedAt,
        });
        const accepted = connection();
        act(() => {
          deliver({ ...connecting, updatedAt: 999 });
          deliver({ ...terminal, sourceId: 'another-source', updatedAt: 1_200 });
        });
        expect(connection()).toEqual(accepted);
        expect(mockRemoteDisconnect).not.toHaveBeenCalled();
      } finally {
        clock.mockRestore();
      }
    }
  );

  it('marks a rejected saved SSH restore blocked without inventing a failure code from its error text', async () => {
    mockRemoteConnect.mockRejectedValue(new Error('Permission denied: local IPC rejection.'));
    const { result } = renderHook(() =>
      usePersistedBamTracks({
        laneOwnerId: 'tab',
        assemblyId: 'grch38',
        assemblyDisplayName: 'GRCh38',
        references: REFERENCES,
        persistedTracks: [savedSshTrack()],
        onChange: vi.fn(),
      })
    );

    await waitFor(() => expect(result.current.status).toBe('ready'));

    const source = useLaneContractStore.getState().lanesForOwner('tab')[0]?.dataset.source;
    expect(source?.remote?.connection).toMatchObject({ state: 'blocked', lastFailure: null });
    expect(source?.admissionError).toContain('Permission denied: local IPC rejection.');
    expect(result.current.issues).toHaveLength(1);
  });

  it.each(['removed', 'replaced'] as const)(
    'abandons saved SSH restoration when its placeholder is %s during header validation',
    async (change) => {
      const track = savedSshTrack();
      const sessionId = `uncommitted-restore-${change}`;
      const generationFile = {
        size: 100,
        mtimeNs: '1',
        ctimeNs: '2',
        device: '42',
        inode: '1001',
      };
      mockRemoteConnect.mockResolvedValue({
        protocol: 'dnaforge-remote-range.v1',
        sessionId,
        endpoint: {
          endpointId: 'endpoint-1',
          displayName: 'Lab HPC',
          target: 'lab-hpc',
          lastConnectedAt: 1,
          observedPlatform: 'linux',
          lastFailure: null,
        },
        locator: track.source.remote,
        bamUrl: 'http://127.0.0.1:43119/v1/restore/alignment.bam',
        indexPath: '/tmp/restore/alignment.bam.bai',
        generation: {
          alignment: { ...generationFile, canonicalPath: track.source.bamPath },
          index: { ...generationFile, canonicalPath: track.source.indexPath },
        },
      });
      let finishHeader!: (header: Awaited<ReturnType<typeof readAlignmentHeader>>) => void;
      vi.mocked(readAlignmentHeader).mockReturnValue(
        new Promise((resolve) => {
          finishHeader = resolve;
        })
      );
      const { result, unmount } = renderHook(() => {
        const [persisted, setPersisted] = useState<readonly IndexedGenomeBamTrackState[]>([track]);
        const restoration = usePersistedBamTracks({
          laneOwnerId: 'tab',
          assemblyId: 'grch38',
          assemblyDisplayName: 'GRCh38',
          references: REFERENCES,
          persistedTracks: persisted,
          onChange: setPersisted,
        });
        return { ...restoration, persisted };
      });
      await waitFor(() => expect(readAlignmentHeader).toHaveBeenCalledOnce());

      act(() => {
        const store = useLaneContractStore.getState();
        if (change === 'removed') store.removeLane('tab', track.trackId);
        else {
          const lane = store.lanesForOwner('tab')[0]!;
          store.replaceLaneDataset('tab', track.trackId, 'grch38', {
            ...lane.dataset,
            source: { bamPath: '/new/local.bam', indexPath: '/new/local.bam.bai' },
          });
        }
      });
      const expected = useLaneContractStore.getState().lanesForOwner('tab');

      await waitFor(() => expect(mockRemoteDisconnect).toHaveBeenCalledWith(sessionId));
      await waitFor(() => expect(result.current.status).toBe('ready'));
      await act(async () => {
        finishHeader({
          format: 'bam',
          isCram: false,
          referenceRequired: false,
          references: REFERENCES.map((reference) => ({ ...reference, md5: null })),
          index: { state: 'present' },
        });
      });
      expect(useLaneContractStore.getState().lanesForOwner('tab')).toEqual(expected);
      expect(mockRemoteDisconnect).toHaveBeenCalledOnce();
      expect(result.current.issues).toEqual([]);
      await waitFor(() => {
        if (change === 'removed') expect(result.current.persisted).toEqual([]);
        else {
          expect(result.current.persisted).toHaveLength(1);
          expect(result.current.persisted[0]?.source).toMatchObject({
            bamPath: '/new/local.bam',
            indexPath: '/new/local.bam.bai',
          });
          expect(result.current.persisted[0]?.source.remote).toBeUndefined();
        }
      });

      const saved = result.current.persisted;
      const connectCount = mockRemoteConnect.mock.calls.length;
      unmount();
      act(() => useLaneContractStore.getState().clearOwner('tab'));
      vi.mocked(readAlignmentHeader).mockResolvedValue({
        format: 'bam',
        isCram: false,
        referenceRequired: false,
        references: REFERENCES.map((reference) => ({ ...reference, md5: null })),
        index: { state: 'present' },
      });
      const reopened = renderHook(() =>
        usePersistedBamTracks({
          laneOwnerId: 'tab',
          assemblyId: 'grch38',
          assemblyDisplayName: 'GRCh38',
          references: REFERENCES,
          persistedTracks: saved,
          onChange: vi.fn(),
        })
      );
      await waitFor(() => expect(reopened.result.current.status).toBe('ready'));
      expect(mockRemoteConnect).toHaveBeenCalledTimes(connectCount);
      const reopenedLanes = useLaneContractStore.getState().lanesForOwner('tab');
      if (change === 'removed') expect(reopenedLanes).toEqual([]);
      else expect(reopenedLanes[0]?.dataset.source?.bamPath).toBe('/new/local.bam');
    }
  );

  it.each(['removed', 'replaced'] as const)(
    'saves a %s SSH placeholder before another source finishes restoring and preserves it on reopen',
    async (change) => {
      const first = savedSshTrack();
      const second: IndexedGenomeBamTrackState = {
        ...first,
        trackId: 'second-ssh-track',
        source: {
          bamPath: '/project/second.bam',
          indexPath: '/project/second.bam.bai',
          remote: {
            ...first.source.remote!,
            alignmentPath: '/project/second.bam',
            indexPath: '/project/second.bam.bai',
          },
        },
      };
      mockRemoteConnect.mockImplementation(async (request) => {
        const track = request.alignmentPath === first.source.bamPath ? first : second;
        const file = { size: 100, mtimeNs: '1', ctimeNs: '2', device: '42', inode: '1001' };
        return {
          protocol: 'dnaforge-remote-range.v1',
          sessionId: `durability-${track.trackId}-${mockRemoteConnect.mock.calls.length}`,
          endpoint: {
            endpointId: 'endpoint-1',
            displayName: 'Lab HPC',
            target: 'lab-hpc',
            lastConnectedAt: 1,
            observedPlatform: 'linux',
            lastFailure: null,
          },
          locator: track.source.remote,
          bamUrl: `http://127.0.0.1:43119/v1/${track.trackId}/alignment.bam`,
          indexPath: `/tmp/${track.trackId}/alignment.bam.bai`,
          generation: {
            alignment: { ...file, canonicalPath: track.source.bamPath },
            index: { ...file, canonicalPath: track.source.indexPath },
          },
        };
      });
      vi.mocked(readAlignmentHeader).mockImplementation(() => new Promise(() => undefined));
      const { result, unmount } = renderHook(() => {
        const [persisted, setPersisted] = useState<readonly IndexedGenomeBamTrackState[]>([
          first,
          second,
        ]);
        const restoration = usePersistedBamTracks({
          laneOwnerId: 'tab',
          assemblyId: 'grch38',
          assemblyDisplayName: 'GRCh38',
          references: REFERENCES,
          persistedTracks: persisted,
          onChange: setPersisted,
        });
        return { ...restoration, persisted };
      });
      await waitFor(() => expect(readAlignmentHeader).toHaveBeenCalledTimes(2));
      act(() => {
        const store = useLaneContractStore.getState();
        if (change === 'removed') store.removeLane('tab', first.trackId);
        else {
          const lane = store
            .lanesForOwner('tab')
            .find((row) => row.dataset.trackId === first.trackId)!;
          store.replaceLaneDataset('tab', first.trackId, 'grch38', {
            ...lane.dataset,
            source: { bamPath: '/new/local.bam', indexPath: '/new/local.bam.bai' },
          });
        }
      });
      await waitFor(() => {
        const savedFirst = result.current.persisted.find(
          (track) => track.trackId === first.trackId
        );
        if (change === 'removed') expect(savedFirst).toBeUndefined();
        else
          expect(savedFirst?.source).toEqual({
            bamPath: '/new/local.bam',
            indexPath: '/new/local.bam.bai',
          });
      });
      expect(result.current.status).toBe('restoring');
      expect(result.current.persisted.some((track) => track.trackId === second.trackId)).toBe(true);
      const saved = result.current.persisted;
      const connectCount = mockRemoteConnect.mock.calls.length;
      unmount();
      act(() => useLaneContractStore.getState().clearOwner('tab'));
      vi.mocked(readAlignmentHeader).mockResolvedValue({
        format: 'bam',
        isCram: false,
        referenceRequired: false,
        references: REFERENCES.map((reference) => ({ ...reference, md5: null })),
        index: { state: 'present' },
      });
      const reopened = renderHook(() =>
        usePersistedBamTracks({
          laneOwnerId: 'tab',
          assemblyId: 'grch38',
          assemblyDisplayName: 'GRCh38',
          references: REFERENCES,
          persistedTracks: saved,
          onChange: vi.fn(),
        })
      );
      await waitFor(() => expect(reopened.result.current.status).toBe('ready'));
      expect(
        mockRemoteConnect.mock.calls.slice(connectCount).map(([request]) => request.alignmentPath)
      ).toEqual([second.source.bamPath]);
      const reopenedFirst = useLaneContractStore
        .getState()
        .lanesForOwner('tab')
        .find((lane) => lane.dataset.trackId === first.trackId);
      if (change === 'removed') expect(reopenedFirst).toBeUndefined();
      else expect(reopenedFirst?.dataset.source?.bamPath).toBe('/new/local.bam');
    }
  );

  it('does not publish another restored SSH source after its view closes while releasing a removed candidate', async () => {
    const first = savedSshTrack();
    const second: IndexedGenomeBamTrackState = {
      ...first,
      trackId: 'second-ssh-track',
      label: 'GRCh38: second.bam',
      source: {
        bamPath: '/project/second.bam',
        indexPath: '/project/second.bam.bai',
        remote: {
          ...first.source.remote!,
          alignmentPath: '/project/second.bam',
          indexPath: '/project/second.bam.bai',
        },
      },
    };
    const generationFile = {
      size: 100,
      mtimeNs: '1',
      ctimeNs: '2',
      device: '42',
      inode: '1001',
    };
    mockRemoteConnect.mockImplementation(async (request) => {
      const track = request.alignmentPath === first.source.bamPath ? first : second;
      const sessionId = track === first ? 'publication-race-first' : 'publication-race-second';
      return {
        protocol: 'dnaforge-remote-range.v1',
        sessionId,
        endpoint: {
          endpointId: 'endpoint-1',
          displayName: 'Lab HPC',
          target: 'lab-hpc',
          lastConnectedAt: 1,
          observedPlatform: 'linux',
          lastFailure: null,
        },
        locator: track.source.remote,
        bamUrl: `http://127.0.0.1:43119/v1/${sessionId}/alignment.bam`,
        indexPath: `/tmp/${sessionId}/alignment.bam.bai`,
        generation: {
          alignment: { ...generationFile, canonicalPath: track.source.bamPath },
          index: { ...generationFile, canonicalPath: track.source.indexPath },
        },
      };
    });
    const finishHeaders = new Map<
      string,
      (header: Awaited<ReturnType<typeof readAlignmentHeader>>) => void
    >();
    vi.mocked(readAlignmentHeader).mockImplementation(
      ({ bamPath }) => new Promise((resolve) => finishHeaders.set(bamPath, resolve))
    );
    const header: Awaited<ReturnType<typeof readAlignmentHeader>> = {
      format: 'bam',
      isCram: false,
      referenceRequired: false,
      references: REFERENCES.map((reference) => ({ ...reference, md5: null })),
      index: { state: 'present' },
    };
    let finishFirstDisconnect!: () => void;
    mockRemoteDisconnect.mockImplementation((sessionId) =>
      sessionId === 'publication-race-first'
        ? new Promise<void>((resolve) => {
            finishFirstDisconnect = resolve;
          })
        : Promise.resolve()
    );
    const { unmount } = renderHook(() =>
      usePersistedBamTracks({
        laneOwnerId: 'tab',
        assemblyId: 'grch38',
        assemblyDisplayName: 'GRCh38',
        references: REFERENCES,
        persistedTracks: [first, second],
        onChange: vi.fn(),
      })
    );
    await waitFor(() => expect(finishHeaders.size).toBe(2));
    await act(async () => {
      finishHeaders.get('http://127.0.0.1:43119/v1/publication-race-first/alignment.bam')!(header);
    });
    act(() => useLaneContractStore.getState().removeLane('tab', first.trackId));
    expect(mockRemoteDisconnect).toHaveBeenCalledWith('publication-race-first');
    await act(async () => {
      finishHeaders.get('http://127.0.0.1:43119/v1/publication-race-second/alignment.bam')!(header);
    });
    expect(
      useLaneContractStore.getState().lanesForOwner('tab')[0]?.dataset.source?.remote?.sessionId
    ).toBeUndefined();

    unmount();
    act(() => useLaneContractStore.getState().clearOwner('tab'));
    expect(mockRemoteDisconnect).toHaveBeenCalledWith('publication-race-second');
    await act(async () => finishFirstDisconnect());

    expect(useLaneContractStore.getState().lanesForOwner('tab')).toEqual([]);
    expect(useLaneContractStore.getState().lanesByOwnerId).not.toHaveProperty('tab');
    expect(
      mockRemoteDisconnect.mock.calls.filter(([id]) => id === 'publication-race-second')
    ).toHaveLength(1);
  });

  it.each([false, true])(
    'restores the admitted SSH computation origin (cluster=%s)',
    async (cluster) => {
      const tileBaseUrl = 'http://127.0.0.1:43119/v1/source/compute';
      const remoteTrack: IndexedGenomeBamTrackState = {
        trackId: 'remote-tumor-track',
        label: 'GRCh38: tumor.bam',
        source: {
          bamPath: '/project/run 42/tumor.bam',
          indexPath: '/project/run 42/tumor.bam.bai',
          remote: {
            contract: 'remote-alignment-locator.v1',
            endpointId: 'endpoint-1',
            target: 'lab-hpc',
            alignmentPath: '/project/run 42/tumor.bam',
            indexPath: '/project/run 42/tumor.bam.bai',
          },
        },
        visible: true,
        coverageCutoffDepth: 0,
      };
      mockRemoteConnect.mockResolvedValue({
        protocol: 'dnaforge-remote-range.v1',
        sessionId: 'restored-session-1',
        endpoint: {
          endpointId: 'endpoint-1',
          displayName: 'Lab HPC',
          target: 'lab-hpc',
          lastConnectedAt: 1,
          observedPlatform: 'linux',
          lastFailure: null,
        },
        locator: remoteTrack.source.remote,
        bamUrl: 'http://127.0.0.1:43119/alignment.bam',
        ...(cluster ? { tileBaseUrl } : {}),
        indexPath: '/tmp/dnaforge-remote-index-3/alignment.bam.bai',
        generation: {
          alignment: {
            canonicalPath: remoteTrack.source.bamPath,
            size: 100,
            mtimeNs: '1',
            ctimeNs: '2',
            device: null,
            inode: null,
          },
          index: {
            canonicalPath: remoteTrack.source.indexPath,
            size: 20,
            mtimeNs: '3',
            ctimeNs: '4',
            device: null,
            inode: null,
          },
        },
      });

      const { result, unmount } = renderHook(() =>
        usePersistedBamTracks({
          laneOwnerId: 'tab',
          assemblyId: 'grch38',
          assemblyDisplayName: 'GRCh38',
          references: REFERENCES,
          persistedTracks: [remoteTrack],
          onChange: vi.fn(),
        })
      );

      await waitFor(() => expect(result.current.status).toBe('ready'));
      expect(mockRemoteConnect).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: expect.stringMatching(/^remote-restore-/u),
          endpointId: 'endpoint-1',
          target: 'lab-hpc',
          alignmentPath: '/project/run 42/tumor.bam',
          indexPath: '/project/run 42/tumor.bam.bai',
        })
      );
      expect(mockStat).not.toHaveBeenCalled();
      expect(mockWatchFile).not.toHaveBeenCalled();
      expect(startAlignmentCoverageOperation).not.toHaveBeenCalled();
      expect(readAlignmentHeader).toHaveBeenCalledWith({
        bamPath: 'http://127.0.0.1:43119/alignment.bam',
        indexPath: '/tmp/dnaforge-remote-index-3/alignment.bam.bai',
        ...(cluster ? { remote: { locator: remoteTrack.source.remote, tileBaseUrl } } : {}),
      });
      expect(useLaneContractStore.getState().lanesForOwner('tab')[0]?.dataset.source).toMatchObject(
        {
          bamPath: 'http://127.0.0.1:43119/alignment.bam',
          indexPath: '/tmp/dnaforge-remote-index-3/alignment.bam.bai',
          remote: {
            locator: remoteTrack.source.remote,
            sessionId: 'restored-session-1',
          },
        }
      );
      expect(result.current.issues).toEqual([]);

      unmount();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(mockRemoteDisconnect).not.toHaveBeenCalled();

      act(() => {
        useLaneContractStore.getState().removeLane('tab', 'remote-tumor-track');
      });
      await waitFor(() => expect(mockRemoteDisconnect).toHaveBeenCalledWith('restored-session-1'));
      expect(mockRemoteDisconnect).toHaveBeenCalledWith('restored-session-1');
    }
  );

  it('publishes a remote lane immediately while the main process keeps connecting', async () => {
    let finishConnect: ((value: Awaited<ReturnType<typeof mockRemoteConnect>>) => void) | undefined;
    const connecting = new Promise<Awaited<ReturnType<typeof mockRemoteConnect>>>((resolve) => {
      finishConnect = resolve;
    });
    const track: IndexedGenomeBamTrackState = {
      trackId: 'remote-pending-track',
      label: 'GRCh38: pending.cram',
      source: {
        bamPath: '/project/pending.cram',
        indexPath: '/project/pending.cram.crai',
        remote: {
          contract: 'remote-alignment-locator.v1',
          endpointId: 'endpoint-pending',
          target: 'lab-hpc',
          alignmentPath: '/project/pending.cram',
          indexPath: '/project/pending.cram.crai',
        },
      },
      visible: true,
      coverageCutoffDepth: 80,
    };
    mockRemoteConnect.mockReturnValue(connecting);

    const { result } = renderHook(() =>
      usePersistedBamTracks({
        laneOwnerId: 'tab',
        assemblyId: 'grch38',
        assemblyDisplayName: 'GRCh38',
        references: REFERENCES,
        persistedTracks: [track],
        onChange: vi.fn(),
      })
    );

    await waitFor(() =>
      expect(useLaneContractStore.getState().lanesForOwner('tab')[0]?.dataset.source).toMatchObject(
        {
          bamPath: '/project/pending.cram',
          remote: {
            locator: track.source.remote,
            connection: { state: 'connecting', transportGeneration: 0 },
          },
        }
      )
    );
    expect(result.current.status).toBe('restoring');
    expect(result.current.issues).toEqual([]);

    act(() => {
      finishConnect?.({
        protocol: 'dnaforge-remote-range.v1',
        sessionId: 'pending-lease',
        endpoint: {
          endpointId: 'endpoint-pending',
          displayName: 'Lab HPC',
          target: 'lab-hpc',
          lastConnectedAt: 1,
          observedPlatform: 'linux',
          lastFailure: null,
        },
        locator: track.source.remote!,
        bamUrl: 'http://127.0.0.1:43119/v1/stable/alignment.cram',
        indexPath: '/tmp/dnaforge-remote-source/alignment.crai',
        generation: {
          alignment: {
            canonicalPath: track.source.bamPath,
            size: 100,
            mtimeNs: '1',
            ctimeNs: '1',
            device: '1',
            inode: '2',
          },
          index: {
            canonicalPath: track.source.indexPath,
            size: 10,
            mtimeNs: '1',
            ctimeNs: '1',
            device: '1',
            inode: '3',
          },
        },
      });
    });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(useLaneContractStore.getState().lanesForOwner('tab')[0]?.dataset.source).toMatchObject({
      bamPath: 'http://127.0.0.1:43119/v1/stable/alignment.cram',
      remote: { sessionId: 'pending-lease', connection: { state: 'online' } },
    });
  });

  it.each(['connection', 'gateway'] as const)(
    'keeps two views of the same locator isolated by their %s source IDs',
    async (sourceIdentity) => {
      const track = savedSshTrack();
      const locator = track.source.remote!;
      const oldSourceId = `old-source-${sourceIdentity}`;
      const newSourceId = `new-source-${sourceIdentity}`;
      const oldSessionId = `old-lease-${sourceIdentity}`;
      const newSessionId = `new-lease-${sourceIdentity}`;
      const initialStatus: RemoteGenomicsRuntimeStatusEventV1['status'] = {
        sourceId: oldSourceId,
        endpointId: locator.endpointId,
        target: locator.target,
        displayName: 'Lab HPC',
        alignmentPath: locator.alignmentPath,
        indexPath: locator.indexPath,
        signalPath: null,
        state: 'blocked',
        attempt: 0,
        nextRetryAt: null,
        transportGeneration: 1,
        lastFailure: { code: 'source-changed', message: 'The alignment file changed.' },
        updatedAt: Date.now(),
      };
      const materialization = (sessionId: string, sourceId: string) => ({
        protocol: 'dnaforge-remote-range.v1',
        sessionId,
        endpoint: {
          endpointId: locator.endpointId,
          displayName: 'Lab HPC',
          target: locator.target,
          lastConnectedAt: 1,
          observedPlatform: 'linux',
          lastFailure: null,
        },
        locator,
        bamUrl: `http://127.0.0.1:43119/v1/${sourceId}/alignment.bam`,
        indexPath: '/tmp/source-index/alignment.bam.bai',
        generation: {
          alignment: availableFile(locator.alignmentPath),
          index: availableFile(locator.indexPath),
        },
        ...(sourceIdentity === 'connection'
          ? { runtimeStatus: { ...initialStatus, sourceId } }
          : {}),
      });
      mockRemoteConnect
        .mockResolvedValueOnce(materialization(oldSessionId, oldSourceId))
        .mockResolvedValueOnce(materialization(newSessionId, newSourceId));
      const mountView = (laneOwnerId: string) =>
        renderHook(() =>
          usePersistedBamTracks({
            laneOwnerId,
            assemblyId: 'grch38',
            assemblyDisplayName: 'GRCh38',
            references: REFERENCES,
            persistedTracks: [track],
            onChange: vi.fn(),
          })
        );
      const oldView = mountView('old-view');
      await waitFor(() => expect(oldView.result.current.status).toBe('ready'));
      const newView = mountView('new-view');
      await waitFor(() => expect(newView.result.current.status).toBe('ready'));
      try {
        if (sourceIdentity === 'gateway') {
          act(() => {
            const lane = useLaneContractStore.getState().lanesForOwner('old-view')[0]!;
            const source = lane.dataset.source!;
            useLaneContractStore.getState().replaceLaneDataset(
              'old-view',
              track.trackId,
              'grch38',
              {
                ...lane.dataset,
                source: {
                  ...source,
                  remote: {
                    ...source.remote!,
                    connection: {
                      ...source.remote!.connection!,
                      state: 'blocked',
                      lastFailure: initialStatus.lastFailure,
                      updatedAt: initialStatus.updatedAt,
                    },
                  },
                },
              },
              lane.source
            );
          });
        }
        const oldUrl = useLaneContractStore.getState().lanesForOwner('old-view')[0]!.dataset.source!
          .bamPath;
        act(() => {
          for (const listener of remoteStatusListeners) {
            listener({
              sequence: 20,
              reason: 'connected',
              status: {
                ...initialStatus,
                sourceId: newSourceId,
                state: 'online',
                transportGeneration: 2,
                lastFailure: null,
                updatedAt: Date.now() + 20,
              },
            });
          }
        });
        const oldSource = useLaneContractStore.getState().lanesForOwner('old-view')[0]!.dataset
          .source!;
        const newSource = useLaneContractStore.getState().lanesForOwner('new-view')[0]!.dataset
          .source!;
        expect(oldSource.remote!.connection!.state).toBe('blocked');
        expect(oldSource.bamPath).toBe(oldUrl);
        expect(oldSource.remote!.sessionId).toBe(oldSessionId);
        expect(newSource.remote!.connection).toMatchObject({
          sourceId: newSourceId,
          state: 'online',
          transportGeneration: 2,
        });
      } finally {
        oldView.unmount();
        newView.unmount();
        useLaneContractStore.getState().clearOwner('old-view');
        useLaneContractStore.getState().clearOwner('new-view');
        await waitFor(() => {
          expect(mockRemoteDisconnect).toHaveBeenCalledWith(oldSessionId);
          expect(mockRemoteDisconnect).toHaveBeenCalledWith(newSessionId);
        });
      }
    }
  );

  it('projects main-owned SSH generations onto a historical lane missing source IDs', async () => {
    const track: IndexedGenomeBamTrackState = {
      trackId: 'remote-status-track',
      label: 'GRCh38: status.cram',
      source: {
        bamPath: '/project/status.cram',
        indexPath: '/project/status.cram.crai',
        remote: {
          contract: 'remote-alignment-locator.v1',
          endpointId: 'endpoint-status',
          target: 'lab-hpc',
          alignmentPath: '/project/status.cram',
          indexPath: '/project/status.cram.crai',
        },
      },
      visible: true,
      coverageCutoffDepth: 80,
    };
    mockRemoteConnect.mockResolvedValue({
      protocol: 'dnaforge-remote-range.v1',
      sessionId: 'stable-lease',
      endpoint: {
        endpointId: 'endpoint-status',
        displayName: 'Lab HPC',
        target: 'lab-hpc',
        lastConnectedAt: 1,
        observedPlatform: 'linux',
        lastFailure: null,
      },
      locator: track.source.remote,
      bamUrl: 'http://127.0.0.1:43119/v1/stable/alignment.cram',
      indexPath: '/tmp/dnaforge-remote-source/alignment.crai',
      generation: {
        alignment: {
          canonicalPath: track.source.bamPath,
          size: 100,
          mtimeNs: '1',
          ctimeNs: '1',
          device: '1',
          inode: '2',
        },
        index: {
          canonicalPath: track.source.indexPath,
          size: 10,
          mtimeNs: '1',
          ctimeNs: '1',
          device: '1',
          inode: '3',
        },
      },
    });
    const { result } = renderHook(() =>
      usePersistedBamTracks({
        laneOwnerId: 'tab',
        assemblyId: 'grch38',
        assemblyDisplayName: 'GRCh38',
        references: REFERENCES,
        persistedTracks: [track],
        onChange: vi.fn(),
      })
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const stableUrl = useLaneContractStore.getState().lanesForOwner('tab')[0]?.dataset
      .source?.bamPath;

    act(() => {
      for (const listener of remoteStatusListeners) {
        listener({
          sequence: 10,
          reason: 'transport-closed',
          status: {
            sourceId: 'source-status',
            endpointId: 'endpoint-status',
            target: 'lab-hpc',
            displayName: 'Lab HPC',
            alignmentPath: '/project/status.cram',
            indexPath: '/project/status.cram.crai',
            signalPath: null,
            state: 'retrying',
            attempt: 1,
            nextRetryAt: 2,
            transportGeneration: 1,
            lastFailure: { code: 'tunnel-failed', message: 'Transport closed.' },
            updatedAt: Date.now() + 10,
          },
        });
      }
    });
    expect(
      useLaneContractStore.getState().lanesForOwner('tab')[0]?.dataset.source?.remote?.connection
        ?.state
    ).toBe('retrying');

    act(() => {
      for (const listener of remoteStatusListeners) {
        listener({
          sequence: 11,
          reason: 'connected',
          status: {
            sourceId: 'source-status',
            endpointId: 'endpoint-status',
            target: 'lab-hpc',
            displayName: 'Lab HPC',
            alignmentPath: '/project/status.cram',
            indexPath: '/project/status.cram.crai',
            signalPath: null,
            state: 'online',
            attempt: 0,
            nextRetryAt: null,
            transportGeneration: 2,
            lastFailure: null,
            updatedAt: Date.now() + 20,
          },
        });
      }
    });
    const source = useLaneContractStore.getState().lanesForOwner('tab')[0]?.dataset.source;
    expect(source?.bamPath).toBe(stableUrl);
    expect(source?.remote?.sessionId).toBe('stable-lease');
    expect(source?.remote?.connection).toMatchObject({ state: 'online', transportGeneration: 2 });
  });

  it('does not declare SSH source restoration ready before its paired BigWig is admitted', async () => {
    let finishSignalAdmission: ((value: { trackId: string; label: string }) => void) | undefined;
    vi.mocked(attachRemoteSignalBigWig).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSignalAdmission = resolve;
        })
    );
    const track: IndexedGenomeBamTrackState = {
      trackId: 'remote-with-signal',
      label: 'GRCh38: reads.cram',
      source: {
        bamPath: '/project/reads.cram',
        indexPath: '/project/reads.cram.crai',
        remote: {
          contract: 'remote-alignment-locator.v1',
          endpointId: 'endpoint-1',
          target: 'lab-hpc',
          alignmentPath: '/project/reads.cram',
          indexPath: '/project/reads.cram.crai',
          signalPath: '/project/coverage.bigWig',
        },
      },
      visible: false,
      coverageCutoffDepth: 80,
    };
    mockRemoteConnect.mockResolvedValue({
      protocol: 'dnaforge-remote-range.v1',
      sessionId: 'restored-session-with-signal',
      endpoint: {
        endpointId: 'endpoint-1',
        displayName: 'Lab HPC',
        target: 'lab-hpc',
        lastConnectedAt: 1,
        observedPlatform: 'linux',
        lastFailure: null,
      },
      locator: track.source.remote,
      bamUrl: 'http://127.0.0.1:43119/alignment.cram',
      indexPath: '/tmp/dnaforge-remote-index/alignment.cram.crai',
      bigWigUrl: 'http://127.0.0.1:43119/signal.bigWig',
      generation: {
        alignment: {
          canonicalPath: track.source.bamPath,
          size: 100,
          mtimeNs: '1',
          ctimeNs: '1',
          device: '1',
          inode: '2',
        },
        index: {
          canonicalPath: track.source.indexPath,
          size: 10,
          mtimeNs: '1',
          ctimeNs: '1',
          device: '1',
          inode: '3',
        },
        signal: {
          canonicalPath: '/project/coverage.bigWig',
          size: 1_000,
          mtimeNs: '1',
          ctimeNs: '1',
          device: '1',
          inode: '4',
        },
      },
    });

    const { result } = renderHook(() =>
      usePersistedBamTracks({
        laneOwnerId: 'tab',
        assemblyId: 'grch38',
        assemblyDisplayName: 'GRCh38',
        references: REFERENCES,
        persistedTracks: [track],
        onChange: vi.fn(),
      })
    );

    await waitFor(() => expect(attachRemoteSignalBigWig).toHaveBeenCalledOnce());
    expect(result.current.status).toBe('restoring');

    act(() => {
      finishSignalAdmission?.({ trackId: 'remote-signal', label: 'coverage.bigWig' });
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.issues).toEqual([]);
  });

  it('re-admits remote locators into runtime proxies without persisting those grants', async () => {
    const track = remoteTrack();
    const grantExpiresAtMs = Date.now() + 1_800_000;
    vi.mocked(openAlignedReadSource).mockResolvedValue({
      source: {
        bamPath: 'http://127.0.0.1:8000/external/range-proxy/secret-bam/tumor.bam',
        indexPath: 'http://127.0.0.1:8000/external/range-proxy/secret-bai/tumor.bam.bai',
        grantExpiresAtMs,
      },
      grantExpiresAtMs,
    });
    let persisted: readonly IndexedGenomeBamTrackState[] = [track];

    const { result } = renderHook(() =>
      usePersistedBamTracks({
        laneOwnerId: 'tab',
        assemblyId: 'grch38',
        assemblyDisplayName: 'GRCh38',
        references: REFERENCES,
        persistedTracks: [track],
        onChange: (update) => {
          persisted = update(persisted);
        },
      })
    );

    await waitFor(() => expect(result.current.status).toBe('ready'));
    const lane = useLaneContractStore.getState().lanesForOwner('tab')[0];
    expect(lane?.dataset.source?.bamPath).toContain('/external/range-proxy/secret-bam/');
    expect(lane?.dataset.source?.grantExpiresAtMs).toBe(grantExpiresAtMs);
    expect(mockStat).not.toHaveBeenCalled();
    expect(mockWatchFile).not.toHaveBeenCalled();
    expect(startAlignmentCoverageOperation).not.toHaveBeenCalled();
    await waitFor(() => expect(persisted[0]?.source.bamPath).toBe(track.source.bamPath));
    expect(JSON.stringify(persisted)).not.toContain('/external/range-proxy/');
  });

  it('re-admits htsget without watching pseudo-files or persisting the runtime token', async () => {
    const track = htsgetTrack();
    const identity = 'e'.repeat(64);
    const grantExpiresAtMs = Date.now() + 900_000;
    vi.mocked(openAlignedReadSource).mockResolvedValue({
      source: {
        bamPath: `htsget-runtime://${identity}/source.bam`,
        grantExpiresAtMs,
        htsget: {
          sourceToken: 'fresh-short-lived-token',
          sourceIdentity: identity,
          format: 'BAM',
        },
      },
      grantExpiresAtMs,
    });
    let persisted: readonly IndexedGenomeBamTrackState[] = [track];

    const { result } = renderHook(() =>
      usePersistedBamTracks({
        laneOwnerId: 'tab',
        assemblyId: 'grch38',
        assemblyDisplayName: 'GRCh38',
        references: REFERENCES,
        persistedTracks: [track],
        onChange: (update) => {
          persisted = update(persisted);
        },
      })
    );

    await waitFor(() => expect(result.current.status).toBe('ready'));
    const lane = useLaneContractStore.getState().lanesForOwner('tab')[0];
    expect(openAlignedReadSource).toHaveBeenCalledWith(
      expect.objectContaining({ source: track.admittedSource })
    );
    expect(lane?.dataset.source).toMatchObject({
      bamPath: `htsget-runtime://${identity}/source.bam`,
      grantExpiresAtMs,
      htsget: { sourceToken: 'fresh-short-lived-token', sourceIdentity: identity },
    });
    expect(mockStat).not.toHaveBeenCalled();
    expect(mockWatchFile).not.toHaveBeenCalled();
    expect(startAlignmentCoverageOperation).not.toHaveBeenCalled();
    await waitFor(() => expect(persisted[0]?.source).toEqual(track.source));
    expect(JSON.stringify(persisted)).not.toContain('fresh-short-lived-token');
    expect(JSON.stringify(persisted)).not.toContain('htsget-runtime');
  });

  it('refreshes a remote runtime proxy before its temporary grant expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-21T20:00:00.000Z'));
    const track = remoteTrack();
    let persisted: readonly IndexedGenomeBamTrackState[] = [track];
    vi.mocked(openAlignedReadSource).mockImplementation(async () => {
      const callNumber = vi.mocked(openAlignedReadSource).mock.calls.length;
      const grantExpiresAtMs = Date.now() + (callNumber === 1 ? 30_100 : 1_800_000);
      return {
        source: {
          bamPath: `http://127.0.0.1:8000/external/range-proxy/grant-${callNumber}/source.bam`,
          indexPath: `/tmp/dnaforge-grant-${callNumber}.bai`,
          grantExpiresAtMs,
        },
        grantExpiresAtMs,
      };
    });

    const { result, unmount } = renderHook(() =>
      usePersistedBamTracks({
        laneOwnerId: 'tab',
        assemblyId: 'grch38',
        assemblyDisplayName: 'GRCh38',
        references: REFERENCES,
        persistedTracks: [track],
        onChange: (update) => {
          persisted = update(persisted);
        },
      })
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.status).toBe('ready');
    expect(openAlignedReadSource).toHaveBeenCalledTimes(1);
    expect(
      useLaneContractStore.getState().lanesForOwner('tab')[0]?.dataset.source?.bamPath
    ).toContain('/grant-1/');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();
    });
    expect(openAlignedReadSource).toHaveBeenCalledTimes(2);
    expect(
      useLaneContractStore.getState().lanesForOwner('tab')[0]?.dataset.source?.bamPath
    ).toContain('/grant-2/');

    unmount();
    vi.useRealTimers();
  });

  it('keeps a newly imported SSH lease when its durable descriptor feeds back into restore', async () => {
    const locator = {
      contract: 'remote-alignment-locator.v1' as const,
      endpointId: 'endpoint-new',
      target: 'lab-hpc',
      alignmentPath: '/project/new.cram',
      indexPath: '/project/new.cram.crai',
    };
    const receipt = (canonicalPath: string) => ({
      canonicalPath,
      size: 100,
      mtimeNs: '1',
      ctimeNs: '2',
      device: null,
      inode: null,
    });
    const imported = buildReadPileupDataset({
      assemblyId: 'grch38',
      assemblyDisplayName: 'GRCh38',
      bamPath: 'http://127.0.0.1:43119/v1/new-source/alignment.cram',
      indexPath: '/private/new-session/alignment.crai',
      remote: {
        locator,
        sessionId: 'fresh-import-lease',
        generation: {
          alignment: receipt(locator.alignmentPath),
          index: receipt(locator.indexPath),
        },
      },
    });
    mockRemoteConnect.mockReturnValue(new Promise(() => {}));
    const { result, rerender } = renderHook(
      ({ references }) => {
        const [persisted, setPersisted] = useState<readonly IndexedGenomeBamTrackState[]>([]);
        const restore = usePersistedBamTracks({
          laneOwnerId: 'tab',
          assemblyId: 'grch38',
          assemblyDisplayName: 'GRCh38',
          references,
          persistedTracks: persisted,
          onChange: setPersisted,
        });
        return { persisted, ...restore };
      },
      { initialProps: { references: REFERENCES as readonly AlignmentReferenceIdentity[] } }
    );
    act(() => {
      useLaneContractStore.getState().addLane('tab', 'grch38', imported);
    });
    await waitFor(() => expect(result.current.persisted).toHaveLength(1));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(useLaneContractStore.getState().lanesForOwner('tab')[0]?.dataset.source).toEqual(
      imported.source
    );
    expect(mockRemoteConnect).not.toHaveBeenCalled();
    expect(mockRemoteDisconnect).not.toHaveBeenCalled();
    rerender({ references: [...REFERENCES, { name: 'chr3', length: 3_000 }] });
    await waitFor(() => expect(mockRemoteConnect).toHaveBeenCalledOnce());
    expect(useLaneContractStore.getState().lanesForOwner('tab')[0]?.dataset.source).toMatchObject({
      bamPath: locator.alignmentPath,
      remote: { connection: { state: 'connecting' } },
    });
  });

  it('persists a newly imported source-backed lane and removes its descriptor with the lane', async () => {
    let persisted: readonly IndexedGenomeBamTrackState[] = [];
    const onChange = vi.fn(
      (
        update: (
          previous: readonly IndexedGenomeBamTrackState[]
        ) => readonly IndexedGenomeBamTrackState[]
      ) => {
        persisted = update(persisted);
      }
    );
    const { result } = renderHook(() =>
      usePersistedBamTracks({
        laneOwnerId: 'tab',
        assemblyId: 'grch38',
        assemblyDisplayName: 'GRCh38',
        references: REFERENCES,
        persistedTracks: [],
        onChange,
      })
    );
    expect(result.current.status).toBe('ready');

    const imported = buildReadPileupDataset({
      assemblyId: 'grch38',
      assemblyDisplayName: 'GRCh38',
      bamPath: '/canonical/project/new.bam',
      indexPath: '/managed/indexes/new.bam.bai',
    });
    act(() => {
      useLaneContractStore.getState().addLane('tab', 'grch38', imported);
    });
    await waitFor(() => {
      expect(persisted).toEqual([
        {
          trackId: imported.trackId,
          label: imported.label,
          order: 0,
          source: {
            bamPath: '/canonical/project/new.bam',
            indexPath: '/managed/indexes/new.bam.bai',
          },
          visible: true,
          color: imported.color,
          trackPx: imported.trackPx,
          laneHeightPx: imported.laneHeightPx,
          maxLanes: imported.maxLanes,
          coverageCutoffDepth: 0,
        },
      ]);
    });

    act(() => {
      useLaneContractStore.getState().removeLane('tab', imported.trackId);
    });
    await waitFor(() => expect(persisted).toEqual([]));
  });

  it('keeps a moved BAM as a blocked source lane so native Repair remains available', async () => {
    mockStat.mockImplementation(async (path: string) => {
      if (path === '/data/tumor.bam') throw new Error('ENOENT');
      return availableFile(path);
    });

    let persisted: readonly IndexedGenomeBamTrackState[] = [...TRACKS];
    const onChange = vi.fn(
      (
        update: (
          previous: readonly IndexedGenomeBamTrackState[]
        ) => readonly IndexedGenomeBamTrackState[]
      ) => {
        persisted = update(persisted);
      }
    );

    const { result } = renderHook(() =>
      usePersistedBamTracks({
        laneOwnerId: 'tab',
        assemblyId: 'grch38',
        assemblyDisplayName: 'GRCh38',
        references: REFERENCES,
        persistedTracks: [TRACKS[0]],
        onChange,
      })
    );

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(useLaneContractStore.getState().lanesForOwner('tab')).toMatchObject([
      {
        visible: false,
        dataset: {
          trackId: 'tumor-track',
          source: { bamPath: '/data/tumor.bam', indexPath: '/data/tumor.bam.bai' },
        },
      },
    ]);
    expect(result.current.issues).toEqual([
      expect.objectContaining({
        trackId: 'tumor-track',
        message: expect.stringContaining('/data/tumor.bam'),
      }),
    ]);
    expect(startAlignmentCoverageOperation).not.toHaveBeenCalled();

    act(() => {
      useLaneContractStore.getState().removeLane('tab', 'tumor-track');
    });
    await waitFor(() => expect(persisted).toEqual([]));
  });

  it('reports a missing persisted index instead of silently rebuilding it', async () => {
    mockStat.mockImplementation(async (path: string) => {
      if (path === '/data/tumor.bam.bai') throw new Error('ENOENT');
      return availableFile(path);
    });

    const { result } = renderHook(() =>
      usePersistedBamTracks({
        laneOwnerId: 'tab',
        assemblyId: 'grch38',
        assemblyDisplayName: 'GRCh38',
        references: REFERENCES,
        persistedTracks: [TRACKS[0]],
        onChange: vi.fn(),
      })
    );

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(useLaneContractStore.getState().lanesForOwner('tab')).toHaveLength(1);
    expect(result.current.issues[0]?.message).toContain('/data/tumor.bam.bai');
  });

  it('restores CRAM only after its source, index, reference, and FAI are present', async () => {
    const cramTrack: IndexedGenomeBamTrackState = {
      trackId: 'cram-track',
      label: 'NA12718',
      source: {
        bamPath: '/data/NA12718.final.cram',
        indexPath: '/data/NA12718.final.cram.crai',
        referencePath: '/references/GRCh38.fa',
      },
      visible: true,
      coverageCutoffDepth: 0,
    };
    vi.mocked(readAlignmentHeader).mockResolvedValueOnce({
      format: 'cram',
      isCram: true,
      referenceRequired: true,
      references: REFERENCES.map((reference) => ({ ...reference, md5: null })),
      index: { state: 'present' },
    });

    const { result } = renderHook(() =>
      usePersistedBamTracks({
        laneOwnerId: 'tab',
        assemblyId: 'grch38',
        assemblyDisplayName: 'GRCh38',
        references: REFERENCES,
        persistedTracks: [cramTrack],
        onChange: vi.fn(),
      })
    );

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(mockStat).toHaveBeenCalledWith('/references/GRCh38.fa.fai');
    expect(startAlignmentCoverageOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        assemblyId: 'grch38',
        ...cramTrack.source,
        chroms: ['chr1', 'chr2'],
        sourceGeneration: expect.objectContaining({
          contract: 'aligned-read-source-generation.v1',
          alignment: expect.objectContaining({
            canonicalPath: '/canonical/data/NA12718.final.cram',
          }),
          index: expect.objectContaining({
            canonicalPath: '/canonical/data/NA12718.final.cram.crai',
          }),
          reference: expect.objectContaining({
            canonicalPath: '/canonical/references/GRCh38.fa',
          }),
          referenceIndex: expect.objectContaining({
            canonicalPath: '/canonical/references/GRCh38.fa.fai',
          }),
        }),
      })
    );
    expect(useLaneContractStore.getState().lanesForOwner('tab')[0]?.dataset.source).toMatchObject({
      ...cramTrack.source,
      generation: {
        contract: 'aligned-read-source-generation.v1',
        reference: { canonicalPath: '/canonical/references/GRCh38.fa' },
        referenceIndex: { canonicalPath: '/canonical/references/GRCh38.fa.fai' },
      },
    });
  });

  it('blocks a same-path replacement that no longer matches the open assembly', async () => {
    const previousGeneration = {
      contract: 'aligned-read-source-generation.v1' as const,
      alignment: {
        canonicalPath: '/canonical/data/tumor.bam',
        size: 10,
        mtimeNs: '10',
        ctimeNs: '11',
        device: '42',
        inode: '1001',
      },
      index: {
        canonicalPath: '/canonical/data/tumor.bam.bai',
        size: 10,
        mtimeNs: '10',
        ctimeNs: '11',
        device: '42',
        inode: '1002',
      },
    };
    const replacedTrack: IndexedGenomeBamTrackState = {
      ...TRACKS[0],
      source: { ...TRACKS[0]!.source, generation: previousGeneration },
    };
    vi.mocked(readAlignmentHeader).mockResolvedValueOnce({
      format: 'bam',
      isCram: false,
      referenceRequired: false,
      references: [{ name: 'chrZ', length: 999, md5: null }],
      index: { state: 'present' },
    });
    let persisted: readonly IndexedGenomeBamTrackState[] = [replacedTrack];

    const { result } = renderHook(() =>
      usePersistedBamTracks({
        laneOwnerId: 'tab',
        assemblyId: 'grch38',
        assemblyDisplayName: 'GRCh38',
        references: REFERENCES,
        persistedTracks: [replacedTrack],
        onChange: (update) => {
          persisted = update(persisted);
        },
      })
    );

    await waitFor(() => expect(result.current.status).toBe('ready'));
    const restored = useLaneContractStore.getState().lanesForOwner('tab')[0];
    expect(restored?.dataset.source).toMatchObject({
      bamPath: '/data/tumor.bam',
      admissionError: expect.stringContaining('missing exact reference "chr1"'),
    });
    expect(result.current.issues[0]?.message).toContain('incompatible with GRCh38');
    expect(startAlignmentCoverageOperation).not.toHaveBeenCalled();
    expect(persisted[0]?.source.generation).toEqual(previousGeneration);
  });

  it('revalidates a watched same-path replacement and swaps to one new generation', async () => {
    let generationVersion = 1;
    mockStat.mockImplementation(async (path: string) => ({
      ...availableFile(path),
      size: generationVersion,
      mtimeNs: String(generationVersion * 1_000_000),
      ctimeNs: String(generationVersion * 1_000_000 + 1),
    }));
    let persisted: readonly IndexedGenomeBamTrackState[] = [TRACKS[0]];
    const { result } = renderHook(() =>
      usePersistedBamTracks({
        laneOwnerId: 'tab',
        assemblyId: 'grch38',
        assemblyDisplayName: 'GRCh38',
        references: REFERENCES,
        persistedTracks: persisted,
        onChange: (update) => {
          persisted = update(persisted);
        },
      })
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(
      useLaneContractStore.getState().lanesForOwner('tab')[0]?.dataset.source?.generation?.alignment
        .size
    ).toBe(1);

    generationVersion = 2;
    act(() => {
      for (const listener of fileChangedListeners) listener('/data/tumor.bam');
    });
    await waitFor(() =>
      expect(
        useLaneContractStore.getState().lanesForOwner('tab')[0]?.dataset.source?.generation
          ?.alignment.size
      ).toBe(2)
    );
    expect(readAlignmentHeader).toHaveBeenCalledTimes(2);
    expect(result.current.issues).toEqual([]);
    expect(startAlignmentCoverageOperation).toHaveBeenCalledTimes(2);
  });
});
