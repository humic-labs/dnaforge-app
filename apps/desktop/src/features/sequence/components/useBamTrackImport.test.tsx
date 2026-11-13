import { act, renderHook, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createIndexedBbiTrackId, directTrackAdmissionRequest } from '@waypoint/genome-data';
import type { RemoteAlignmentMaterializationV1 } from '../../../shared/remote-genomics-ipc';
import { parseTrackViewDocument, serializeTrackViewDocument } from '../../../shared/track-view';
import { trackViewFixture } from '../../../shared/track-view-fixture';

import { readAlignmentHeader } from '../alignment-header-client';
import { attachRemoteSignalBigWig } from '../attach-remote-signal-bigwig';
import { startAlignmentCoverageOperation } from '../alignment-coverage-operation-client';
import {
  startAlignmentIndexOperation,
  waitForAlignmentIndexResult,
} from '../alignment-index-operation-client';
import { admitIndexedRangeSource, materializeIndexedRangeSource } from '../indexed-range-client';
import { useLaneContractStore } from '../lane-contract-store';
import { useBamTrackImport } from './useBamTrackImport';
import { indexedGenomeBamTrackFromLane } from '../bam-track-persistence';
import { indexedGenomeDataTrackFromLane } from '../ucsc-track-persistence';
import {
  buildExperimentalHybridPileupDataset,
  indexedGenomeSignalReadPileupViewFromLane,
} from '../experimental-hybrid-pileup';
import type { IndexedGenomeSignalReadPileupViewState } from '../../../shared/indexed-genome';
import { usePersistedBamTracks } from './usePersistedBamTracks';
import { usePersistedSignalReadPileupViews } from './usePersistedSignalReadPileupViews';

const {
  mockDialogOpen,
  mockStat,
  mockRemoteList,
  mockRemoteConnect,
  mockRemoteCancel,
  mockRemoteRetry,
  mockRemoteDisconnect,
  bbiOpen,
} = vi.hoisted(() => ({
  mockDialogOpen: vi.fn(),
  mockStat: vi.fn(),
  mockRemoteList: vi.fn(),
  mockRemoteConnect: vi.fn(),
  mockRemoteCancel: vi.fn(),
  mockRemoteRetry: vi.fn(),
  mockRemoteDisconnect: vi.fn(),
  bbiOpen: vi.fn(),
}));

vi.mock('../../../platform', () => ({
  platform: () => ({
    dialog: { open: mockDialogOpen },
    fs: { stat: mockStat },
    remoteGenomics: {
      listEndpoints: mockRemoteList,
      connectAlignment: mockRemoteConnect,
      cancelConnect: mockRemoteCancel,
      retryEndpoint: mockRemoteRetry,
      disconnectSession: mockRemoteDisconnect,
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

vi.mock('../alignment-index-operation-client', () => ({
  startAlignmentIndexOperation: vi.fn(),
  waitForAlignmentIndexResult: vi.fn(),
}));

vi.mock('../alignment-coverage-operation-client', () => ({
  startAlignmentCoverageOperation: vi.fn(),
}));

vi.mock('../indexed-range-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../indexed-range-client')>()),
  admitIndexedRangeSource: vi.fn(),
  materializeIndexedRangeSource: vi.fn(),
  nativeRangeProxyUrl: vi.fn(
    (grant: { sourceToken: string; format: string }) =>
      `http://dnaforge-source:${grant.sourceToken}@127.0.0.1:8000/external/range-proxy/source.${grant.format}`
  ),
}));

vi.mock('../attach-remote-signal-bigwig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../attach-remote-signal-bigwig')>()),
  attachRemoteSignalBigWig: vi.fn(),
}));

vi.mock('../bbi-reader-runtime', () => ({
  getBbiReaderWorkerClient: () => ({
    open: bbiOpen,
    closeSource: vi.fn().mockResolvedValue(undefined),
    queryQuantitative: vi.fn().mockResolvedValue([]),
  }),
}));

const GENOME = {
  laneOwnerId: 'tab',
  assemblyId: 'grch38',
  displayName: 'GRCh38',
  references: [
    { name: 'chr1', length: 1_000 },
    { name: 'chr2', length: 2_000 },
  ],
};

function readableHeader() {
  return {
    format: 'bam' as const,
    isCram: false,
    referenceRequired: false,
    references: GENOME.references.map((reference) => ({ ...reference, md5: null })),
    index: { state: 'present' as const },
  };
}

function readableCramHeader() {
  return {
    ...readableHeader(),
    format: 'cram' as const,
    isCram: true,
    referenceRequired: true,
  };
}

function remoteMaterialization(): RemoteAlignmentMaterializationV1 {
  return {
    protocol: 'dnaforge-remote-range.v1',
    sessionId: 'candidate-session',
    endpoint: {
      endpointId: 'endpoint-1',
      displayName: 'Lab HPC',
      target: 'lab-hpc',
      lastConnectedAt: 1,
      observedPlatform: 'linux',
      lastFailure: null,
    },
    locator: {
      contract: 'remote-alignment-locator.v1',
      endpointId: 'endpoint-1',
      target: 'lab-hpc',
      alignmentPath: '/project/run 42/tumor.bam',
      indexPath: '/project/run 42/tumor.bam.bai',
    },
    bamUrl: 'http://127.0.0.1:43117/v1/candidate/alignment.bam',
    indexPath: '/tmp/candidate/alignment.bam.bai',
    generation: {
      alignment: {
        canonicalPath: '/project/run 42/tumor.bam',
        size: 100,
        mtimeNs: '1',
        ctimeNs: '2',
        device: '42',
        inode: '1001',
      },
      index: {
        canonicalPath: '/project/run 42/tumor.bam.bai',
        size: 20,
        mtimeNs: '3',
        ctimeNs: '4',
        device: '42',
        inode: '1002',
      },
    },
  };
}

function addExistingRemoteLane(): void {
  const materialization = remoteMaterialization();
  useLaneContractStore.getState().addLane('tab', 'grch38', {
    kind: 'pileup',
    trackType: 'pileup-genomewide',
    trackId: 'remote-track',
    label: 'GRCh38: tumor.bam',
    color: 0xe11d48,
    trackPx: 276,
    records: [],
    source: {
      bamPath: 'http://127.0.0.1:41000/v1/old/alignment.bam',
      indexPath: '/tmp/old/alignment.bam.bai',
      remote: { locator: materialization.locator, sessionId: 'old-session' },
    },
  });
}

describe('useBamTrackImport', () => {
  beforeEach(() => {
    useLaneContractStore.getState().clear();
    mockDialogOpen.mockReset();
    mockStat.mockReset().mockImplementation(async (path: string) => ({
      canonicalPath: `/canonical${path}`,
      size: 100,
      isFile: true,
      isDirectory: false,
      mtime: 1,
      ctime: 2,
      mtimeNs: '1000000',
      ctimeNs: '2000000',
      device: '42',
      inode: '1001',
    }));
    mockRemoteList.mockReset().mockResolvedValue([]);
    mockRemoteConnect.mockReset();
    mockRemoteCancel.mockReset().mockResolvedValue(true);
    mockRemoteRetry.mockReset().mockResolvedValue(true);
    mockRemoteDisconnect.mockReset().mockResolvedValue(undefined);
    vi.mocked(startAlignmentIndexOperation)
      .mockReset()
      .mockImplementation(async ({ bamPath }) => ({ id: `index:${bamPath}` }) as never);
    vi.mocked(waitForAlignmentIndexResult)
      .mockReset()
      .mockImplementation(async (operationId) => ({
        format: 'bam',
        state: 'present',
        indexPath: `${operationId.slice('index:'.length)}.bai`,
      }));
    vi.mocked(readAlignmentHeader).mockReset();
    vi.mocked(startAlignmentCoverageOperation)
      .mockReset()
      .mockResolvedValue(undefined as never);
    vi.mocked(admitIndexedRangeSource)
      .mockReset()
      .mockImplementation(async ({ source, formatId, provenanceId }) => ({
        baseUrl: 'http://127.0.0.1:8000',
        sourceUri: source.kind === 'url' ? source.url : `file://${source.path}`,
        sourceToken: `runtime-${formatId}`,
        canonicalUrlHash: `${formatId}-hash`,
        format: formatId,
        byteLength: formatId === 'bam' ? 10_000 : 500,
        etag: `"${formatId}-v1"`,
        provenanceId,
        expiresAtMs: Date.now() + 1_800_000,
      }));
    vi.mocked(materializeIndexedRangeSource)
      .mockReset()
      .mockImplementation(async (grant) => ({
        sourcePath: `/tmp/dnaforge-index.${grant.format}`,
        representationSha256: 'a'.repeat(64),
        expiresAtMs: grant.expiresAtMs,
      }));
    vi.mocked(attachRemoteSignalBigWig)
      .mockReset()
      .mockResolvedValue({ trackId: 'signal-track', label: 'signal.bigWig' });
    bbiOpen.mockReset();
  });

  it('saves and reopens an edited signal composition while the replacement header is pending', async () => {
    const actual = await vi.importActual<typeof import('../attach-remote-signal-bigwig')>(
      '../attach-remote-signal-bigwig'
    );
    vi.mocked(attachRemoteSignalBigWig).mockImplementation(actual.attachRemoteSignalBigWig);
    const header = {
      fileType: 'bigwig',
      references: GENOME.references,
      zoomReductionLevels: [10],
      totalSummary: { basesCovered: 100, scoreMin: 0, scoreMax: 12 },
    };
    bbiOpen.mockResolvedValue(header);
    vi.mocked(readAlignmentHeader).mockResolvedValue(readableHeader());
    const base = remoteMaterialization();
    const materialization = (sessionId: string, signalPath: string) => ({
      ...base,
      sessionId,
      locator: { ...base.locator, signalPath },
      bamUrl: `http://127.0.0.1:43117/v1/source-${sessionId}/alignment.bam`,
      bigWigUrl: `http://127.0.0.1:43117/v1/source-${sessionId}/signal.bigWig`,
      generation: {
        ...base.generation,
        signal: { ...base.generation.alignment, canonicalPath: signalPath },
      },
    });
    const original = materialization('composition-original', '/project/original.bigWig');
    const edited = materialization('composition-edited', '/project/edited.bigWig');
    const restored = materialization('composition-restored', edited.locator.signalPath);
    mockRemoteConnect
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(edited)
      .mockResolvedValueOnce(restored);
    const initial = renderHook(() => {
      const [views, setViews] = useState<readonly IndexedGenomeSignalReadPileupViewState[]>([]);
      const bamImport = useBamTrackImport(GENOME);
      const compositions = usePersistedSignalReadPileupViews({
        laneOwnerId: 'tab',
        assemblyId: GENOME.assemblyId,
        persistedViews: views,
        sourcesReady: true,
        onChange: setViews,
      });
      return { bamImport, compositions, views };
    });
    let finishHeader: ((value: typeof header) => void) | undefined;
    let reopened: ReturnType<typeof renderHook> | undefined;
    try {
      await act(async () =>
        initial.result.current.bamImport.addRemote({
          target: original.locator.target,
          alignmentPath: original.locator.alignmentPath,
          signalPath: original.locator.signalPath,
        })
      );
      const store = useLaneContractStore.getState();
      const reads = store.lanesForOwner('tab').find((lane) => lane.dataset.source?.remote)!;
      const signal = store
        .lanesForOwner('tab')
        .find((lane) => lane.source?.scientificKind === 'quantitative')!;
      act(() =>
        store.addLane(
          'tab',
          GENOME.assemblyId,
          {
            ...buildExperimentalHybridPileupDataset({
              alignment: reads.dataset,
              signal: signal.dataset,
            }),
            trackId: 'retained-composition',
            label: 'Custom signal view',
            color: 0xe11d48,
            trackPx: 420,
            laneHeightPx: 4,
            maxLanes: 90,
            coverageCutoffDepth: 90,
          },
          false
        )
      );
      await waitFor(() => expect(initial.result.current.views).toHaveLength(1));
      const before = initial.result.current.views[0]!;
      bbiOpen.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishHeader = resolve;
          })
      );
      await act(async () =>
        initial.result.current.bamImport.editRemoteTrack(reads.dataset.trackId, {
          target: edited.locator.target,
          alignmentPath: edited.locator.alignmentPath,
          indexPath: edited.locator.indexPath,
          signalPath: edited.locator.signalPath,
        })
      );
      await waitFor(() => expect(bbiOpen).toHaveBeenCalledTimes(2));
      const save = () => {
        const lanes = store.lanesForOwner('tab');
        return serializeTrackViewDocument({
          ...trackViewFixture(),
          reference: {
            assemblyId: GENOME.assemblyId,
            name: GENOME.displayName,
            chromosomes: GENOME.references.map(({ name, length }) => ({ chrom: name, length })),
            sourceFingerprint: null,
            inventoryFingerprint: null,
            bundleFingerprint: null,
          },
          bamTracks: lanes.flatMap((lane) => {
            const value = indexedGenomeBamTrackFromLane(lane);
            return value ? [value] : [];
          }),
          dataTracks: lanes.flatMap((lane) => {
            const value = indexedGenomeDataTrackFromLane(lane);
            return value ? [value] : [];
          }),
          signalReadPileupViews: lanes.flatMap((lane) => {
            const value = indexedGenomeSignalReadPileupViewFromLane(lane);
            return value ? [value] : [];
          }),
        });
      };
      expect(save, 'Edit Source must preserve strict saved composition references').not.toThrow();
      const saved = parseTrackViewDocument(save());
      const expectedSignalId = createIndexedBbiTrackId({
        assemblyId: GENOME.assemblyId,
        source: { kind: 'url', url: `ssh://${edited.locator.target}${edited.locator.signalPath}` },
      });
      expect(saved.signalReadPileupViews).toEqual([{ ...before, signalTrackId: expectedSignalId }]);
      expect(initial.result.current.views).toEqual(saved.signalReadPileupViews);
      expect(
        store.lanesForOwner('tab').find((lane) => lane.dataset.trackId === before.trackId)?.dataset
          .experimentalHybrid
      ).toMatchObject({ quantitativeTrackId: expectedSignalId, waitingForSources: true });
      await act(async () => finishHeader!(header));
      await waitFor(() =>
        expect(
          store.lanesForOwner('tab').some((lane) => lane.dataset.trackId === signal.dataset.trackId)
        ).toBe(false)
      );
      await waitFor(() => expect(initial.result.current.compositions.issues).toEqual([]));
      expect(
        store.lanesForOwner('tab').find((lane) => lane.dataset.trackId === before.trackId)?.dataset
          .experimentalHybrid?.waitingForSources
      ).toBeUndefined();
      expect(parseTrackViewDocument(save()).signalReadPileupViews).toEqual(
        saved.signalReadPileupViews
      );
      initial.unmount();
      act(() => store.clearOwner('tab'));
      await waitFor(() => expect(mockRemoteDisconnect).toHaveBeenCalledWith(edited.sessionId));
      reopened = renderHook(() => {
        const bam = usePersistedBamTracks({
          laneOwnerId: 'reopened',
          assemblyId: GENOME.assemblyId,
          assemblyDisplayName: GENOME.displayName,
          references: GENOME.references,
          persistedTracks: saved.bamTracks,
          onChange: vi.fn(),
        });
        const compositions = usePersistedSignalReadPileupViews({
          laneOwnerId: 'reopened',
          assemblyId: GENOME.assemblyId,
          persistedViews: saved.signalReadPileupViews!,
          sourcesReady: bam.status === 'ready',
          onChange: vi.fn(),
        });
        return { bam, compositions };
      });
      await waitFor(() =>
        expect(
          store.lanesForOwner('reopened').find((lane) => lane.dataset.trackId === before.trackId)
            ?.dataset.experimentalHybrid
        ).toMatchObject({ quantitativeTrackId: expectedSignalId })
      );
      expect(
        store.lanesForOwner('reopened').find((lane) => lane.dataset.trackId === before.trackId)
      ).toMatchObject({
        visible: before.visible,
        dataset: { label: before.label, trackPx: before.trackPx },
      });
    } finally {
      initial.unmount();
      reopened?.unmount();
      finishHeader?.(header);
      act(() => useLaneContractStore.getState().clear());
      for (const candidate of [original, edited, restored].slice(
        0,
        mockRemoteConnect.mock.calls.length
      )) {
        await waitFor(() => expect(mockRemoteDisconnect).toHaveBeenCalledWith(candidate.sessionId));
      }
    }
  });

  it('registers acquired leases so surviving companions retain only their own view', async () => {
    const actual = await vi.importActual<typeof import('../attach-remote-signal-bigwig')>(
      '../attach-remote-signal-bigwig'
    );
    vi.mocked(attachRemoteSignalBigWig).mockImplementation(actual.attachRemoteSignalBigWig);
    bbiOpen.mockResolvedValue({
      fileType: 'bigwig',
      references: GENOME.references,
      zoomReductionLevels: [10],
      totalSummary: { basesCovered: 100, scoreMin: 0, scoreMax: 12 },
    });
    vi.mocked(readAlignmentHeader).mockResolvedValue(readableHeader());
    const base = remoteMaterialization();
    const sourceId = 'stable-source-for-two-views';
    const candidate = {
      ...base,
      locator: { ...base.locator, signalPath: '/project/tumor.bigWig' },
      bamUrl: `http://127.0.0.1:43117/v1/${sourceId}/alignment.bam`,
      bigWigUrl: `http://127.0.0.1:43117/v1/${sourceId}/signal.bigWig`,
      generation: {
        ...base.generation,
        signal: { ...base.generation.alignment, canonicalPath: '/project/tumor.bigWig' },
      },
    };
    mockRemoteConnect
      .mockResolvedValueOnce({ ...candidate, sessionId: 'first-view-lease' })
      .mockResolvedValueOnce({ ...candidate, sessionId: 'second-view-lease' });
    const first = renderHook(() => useBamTrackImport(GENOME));
    const second = renderHook(() => useBamTrackImport({ ...GENOME, laneOwnerId: 'second-tab' }));
    try {
      await act(async () => {
        await first.result.current.addRemote({
          target: base.locator.target,
          alignmentPath: base.locator.alignmentPath,
        });
      });
      await act(async () => {
        await second.result.current.addRemote({
          target: base.locator.target,
          alignmentPath: base.locator.alignmentPath,
        });
      });
      expect(useLaneContractStore.getState().lanesForOwner('tab')).toHaveLength(2);
      expect(useLaneContractStore.getState().lanesForOwner('second-tab')).toHaveLength(2);
      vi.useFakeTimers();
      act(() => {
        const reads = useLaneContractStore
          .getState()
          .lanesForOwner('tab')
          .find((lane) => lane.dataset.kind === 'pileup')!;
        useLaneContractStore.getState().removeLane('tab', reads.dataset.trackId);
      });
      first.unmount();
      await vi.runAllTimersAsync();
      expect(mockRemoteDisconnect).not.toHaveBeenCalled();
      act(() => {
        useLaneContractStore.getState().clearOwner('tab');
      });
      await vi.runAllTimersAsync();
      expect(mockRemoteDisconnect.mock.calls).toEqual([['first-view-lease']]);
      expect(useLaneContractStore.getState().lanesForOwner('second-tab')).toHaveLength(2);
      second.unmount();
      act(() => {
        useLaneContractStore.getState().clearOwner('second-tab');
      });
      await vi.runAllTimersAsync();
      expect(mockRemoteDisconnect.mock.calls).toEqual([
        ['first-view-lease'],
        ['second-view-lease'],
      ]);
    } finally {
      first.unmount();
      second.unmount();
      useLaneContractStore.getState().clear();
      if (vi.isFakeTimers()) await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
  });

  it('adds multiple selected BAMs as independent lanes', async () => {
    mockDialogOpen.mockResolvedValue(['/data/tumor.bam', '/data/normal.bam']);
    vi.mocked(readAlignmentHeader).mockResolvedValue(readableHeader());
    const { result } = renderHook(() => useBamTrackImport(GENOME));

    await act(async () => result.current.addFiles(['/data/tumor.bam', '/data/normal.bam']));

    const lanes = useLaneContractStore.getState().lanesForOwner('tab');
    expect(lanes).toHaveLength(2);
    expect(lanes.map((lane) => lane.dataset.source?.bamPath)).toEqual([
      '/canonical/data/tumor.bam',
      '/canonical/data/normal.bam',
    ]);
    expect(result.current.notice).toEqual({
      kind: 'success',
      text: 'Coverage preparation started for normal.bam. Follow it in Jobs.',
    });
  });

  it.each([false, true])(
    'streams a remote BAM through its admitted computation origin (cluster=%s)',
    async (cluster) => {
      const tileBaseUrl = 'http://127.0.0.1:43117/v1/source/compute';
      mockRemoteConnect.mockResolvedValue({
        protocol: 'dnaforge-remote-range.v1',
        sessionId: 'remote-session-1',
        endpoint: {
          endpointId: 'endpoint-1',
          displayName: 'Lab HPC',
          target: 'lab-hpc',
          lastConnectedAt: 1_700_000_000_000,
          observedPlatform: 'linux',
          lastFailure: null,
        },
        locator: {
          contract: 'remote-alignment-locator.v1',
          endpointId: 'endpoint-1',
          target: 'lab-hpc',
          alignmentPath: '/project/run 42/tumor.bam',
          indexPath: '/project/run 42/tumor.bam.bai',
        },
        runtimeStatus: {
          sourceId: 'source-1',
          endpointId: 'endpoint-1',
          target: 'lab-hpc',
          displayName: 'Lab HPC',
          alignmentPath: '/project/run 42/tumor.bam',
          indexPath: '/project/run 42/tumor.bam.bai',
          signalPath: null,
          state: 'online',
          attempt: 0,
          nextRetryAt: null,
          transportGeneration: 9,
          lastFailure: null,
          updatedAt: 4567,
        },
        bamUrl: 'http://127.0.0.1:43117/alignment.bam',
        ...(cluster ? { tileBaseUrl } : {}),
        indexPath: '/tmp/dnaforge-remote-index-1/alignment.bam.bai',
        generation: {
          alignment: {
            canonicalPath: '/project/run 42/tumor.bam',
            size: 100,
            mtimeNs: '1',
            ctimeNs: '2',
            device: '42',
            inode: '1001',
          },
          index: {
            canonicalPath: '/project/run 42/tumor.bam.bai',
            size: 20,
            mtimeNs: '3',
            ctimeNs: '4',
            device: '42',
            inode: '1002',
          },
        },
      });
      vi.mocked(readAlignmentHeader).mockResolvedValue(readableHeader());
      const { result, unmount } = renderHook(() => useBamTrackImport(GENOME));

      await act(async () =>
        result.current.addRemote({
          target: 'lab-hpc',
          alignmentPath: '/project/run 42/tumor.bam',
          indexPath: '/project/run 42/tumor.bam.bai',
        })
      );

      expect(readAlignmentHeader).toHaveBeenCalledWith({
        bamPath: 'http://127.0.0.1:43117/alignment.bam',
        indexPath: '/tmp/dnaforge-remote-index-1/alignment.bam.bai',
        ...(cluster
          ? {
              remote: {
                locator: expect.objectContaining({ target: 'lab-hpc' }),
                tileBaseUrl,
              },
            }
          : {}),
      });
      expect(startAlignmentCoverageOperation).not.toHaveBeenCalled();
      expect(useLaneContractStore.getState().lanesForOwner('tab')[0]?.dataset.source).toMatchObject(
        {
          bamPath: 'http://127.0.0.1:43117/alignment.bam',
          indexPath: '/tmp/dnaforge-remote-index-1/alignment.bam.bai',
          remote: {
            locator: {
              contract: 'remote-alignment-locator.v1',
              endpointId: 'endpoint-1',
              target: 'lab-hpc',
              alignmentPath: '/project/run 42/tumor.bam',
              indexPath: '/project/run 42/tumor.bam.bai',
            },
            sessionId: 'remote-session-1',
            connection: {
              state: 'online',
              transportGeneration: 9,
              updatedAt: 4567,
            },
          },
        }
      );
      expect(result.current.notice).toEqual({
        kind: 'success',
        text: 'Streaming tumor.bam from Lab HPC. Read details come from the BAM index.',
      });

      unmount();
      expect(mockRemoteDisconnect).not.toHaveBeenCalled();
      act(() => {
        useLaneContractStore
          .getState()
          .removeLane(
            'tab',
            useLaneContractStore.getState().lanesForOwner('tab')[0]!.dataset.trackId
          );
      });
      await waitFor(() => expect(mockRemoteDisconnect).toHaveBeenCalledWith('remote-session-1'));
    }
  );

  it('cancels an unfinished remote connection when its viewer owner unmounts', async () => {
    let rejectConnect!: (error: Error) => void;
    mockRemoteConnect.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectConnect = reject;
        })
    );
    mockRemoteCancel.mockImplementation(async () => {
      rejectConnect(new Error('Remote aligned-read connection was cancelled.'));
      return true;
    });
    const { result, unmount } = renderHook(() => useBamTrackImport(GENOME));

    let connection!: Promise<void>;
    act(() => {
      connection = result.current.addRemote({
        target: 'lab-hpc',
        alignmentPath: '/project/run 42/tumor.bam',
        indexPath: '/project/run 42/tumor.bam.bai',
      });
    });
    await waitFor(() => expect(mockRemoteConnect).toHaveBeenCalledOnce());
    const requestId = mockRemoteConnect.mock.calls[0]?.[0]?.requestId;

    unmount();

    await expect(connection).rejects.toThrow('cancelled');
    expect(requestId).toMatch(/^remote-import-/u);
    expect(mockRemoteCancel).toHaveBeenCalledWith(requestId);
  });

  it('cancels a pending SSH attachment and releases a late result without admitting it', async () => {
    let complete!: (value: { sessionId: string }) => void;
    mockRemoteConnect.mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      })
    );
    const { result } = renderHook(() => useBamTrackImport(GENOME));
    let connecting!: Promise<void>;
    act(() => {
      connecting = result.current.addRemote({ target: 'lab-hpc', alignmentPath: '/run/tumor.bam' });
    });
    const cancelled = expect(connecting).rejects.toThrow('cancelled');
    await waitFor(() => expect(mockRemoteConnect).toHaveBeenCalledOnce());
    expect(result.current.remoteConnecting).toBe(true);
    act(() => result.current.cancelRemoteConnect());
    expect(mockRemoteCancel).toHaveBeenCalledWith(mockRemoteConnect.mock.calls[0][0].requestId);
    await act(async () => {
      complete({ sessionId: 'late-cancelled-session' });
      await cancelled;
    });
    expect(mockRemoteDisconnect).toHaveBeenCalledWith('late-cancelled-session');
    expect(readAlignmentHeader).not.toHaveBeenCalled();
    expect(useLaneContractStore.getState().lanesForOwner('tab')).toEqual([]);
    expect(result.current.remoteConnecting).toBe(false);
    expect(result.current.busy).toBeNull();
  });

  it('cancels an acquired SSH lease during header validation without admitting the late header', async () => {
    let finishHeader!: (header: ReturnType<typeof readableHeader>) => void;
    mockRemoteConnect.mockResolvedValue(remoteMaterialization());
    vi.mocked(readAlignmentHeader).mockReturnValue(
      new Promise((resolve) => {
        finishHeader = resolve;
      })
    );
    const { result } = renderHook(() => useBamTrackImport(GENOME));
    let connecting!: Promise<void>;
    act(() => {
      connecting = result.current.addRemote({
        target: 'lab-hpc',
        alignmentPath: '/project/run 42/tumor.bam',
      });
    });
    const cancelled = expect(connecting).rejects.toThrow('cancelled');
    await waitFor(() => expect(readAlignmentHeader).toHaveBeenCalledOnce());
    expect(result.current.remoteConnecting).toBe(true);

    act(() => result.current.cancelRemoteConnect());

    await waitFor(() => expect(mockRemoteDisconnect).toHaveBeenCalledWith('candidate-session'));
    await act(async () => {
      await cancelled;
    });
    expect(result.current.remoteConnecting).toBe(false);
    expect(result.current.busy).toBeNull();
    await act(async () => finishHeader(readableHeader()));
    expect(useLaneContractStore.getState().lanesForOwner('tab')).toEqual([]);
    expect(mockRemoteDisconnect).toHaveBeenCalledOnce();
  });

  it('releases an uncommitted SSH lease when its viewer closes during header validation', async () => {
    let finishHeader!: (header: ReturnType<typeof readableHeader>) => void;
    mockRemoteConnect.mockResolvedValue(remoteMaterialization());
    vi.mocked(readAlignmentHeader).mockReturnValue(
      new Promise((resolve) => {
        finishHeader = resolve;
      })
    );
    const { result, unmount } = renderHook(() => useBamTrackImport(GENOME));
    let connecting!: Promise<void>;
    act(() => {
      connecting = result.current.addRemote({
        target: 'lab-hpc',
        alignmentPath: '/project/run 42/tumor.bam',
      });
    });
    const cancelled = expect(connecting).rejects.toThrow('cancelled');
    await waitFor(() => expect(readAlignmentHeader).toHaveBeenCalledOnce());

    unmount();
    act(() => useLaneContractStore.getState().clearOwner('tab'));

    await waitFor(() => expect(mockRemoteDisconnect).toHaveBeenCalledWith('candidate-session'));
    await cancelled;
    await act(async () => finishHeader(readableHeader()));
    expect(useLaneContractStore.getState().lanesForOwner('tab')).toEqual([]);
    expect(mockRemoteDisconnect).toHaveBeenCalledOnce();
  });

  it('cancels a source edit during header validation while preserving the current lease and source', async () => {
    addExistingRemoteLane();
    const original = useLaneContractStore.getState().lanesForOwner('tab')[0]!.dataset.source;
    let finishHeader!: (header: ReturnType<typeof readableHeader>) => void;
    mockRemoteConnect.mockResolvedValue(remoteMaterialization());
    vi.mocked(readAlignmentHeader).mockReturnValue(
      new Promise((resolve) => {
        finishHeader = resolve;
      })
    );
    const { result } = renderHook(() => useBamTrackImport(GENOME));
    let editing!: Promise<void>;
    act(() => {
      editing = result.current.editRemoteTrack('remote-track', {
        target: 'lab-hpc',
        alignmentPath: '/project/run 42/tumor.bam',
      });
    });
    const cancelled = expect(editing).rejects.toThrow('cancelled');
    await waitFor(() => expect(readAlignmentHeader).toHaveBeenCalledOnce());
    expect(result.current.remoteConnecting).toBe(true);

    act(() => result.current.cancelRemoteConnect());

    await waitFor(() => expect(mockRemoteDisconnect).toHaveBeenCalledWith('candidate-session'));
    await cancelled;
    await act(async () => finishHeader(readableHeader()));
    expect(useLaneContractStore.getState().lanesForOwner('tab')[0]?.dataset.source).toBe(original);
    expect(mockRemoteDisconnect).toHaveBeenCalledOnce();
    expect(mockRemoteDisconnect).not.toHaveBeenCalledWith('old-session');
  });

  it('does not mark the current source as failed when Repair is cancelled during header validation', async () => {
    addExistingRemoteLane();
    const original = useLaneContractStore.getState().lanesForOwner('tab')[0]!.dataset.source;
    let finishHeader!: (header: ReturnType<typeof readableHeader>) => void;
    mockRemoteConnect.mockResolvedValue(remoteMaterialization());
    vi.mocked(readAlignmentHeader).mockReturnValue(
      new Promise((resolve) => {
        finishHeader = resolve;
      })
    );
    const { result } = renderHook(() => useBamTrackImport(GENOME));
    let repairing!: Promise<void>;
    act(() => {
      repairing = result.current.repairTrack('remote-track');
    });
    await waitFor(() => expect(readAlignmentHeader).toHaveBeenCalledOnce());

    act(() => result.current.cancelRemoteConnect());

    await waitFor(() => expect(mockRemoteDisconnect).toHaveBeenCalledWith('candidate-session'));
    await act(async () => repairing);
    await act(async () => finishHeader(readableHeader()));
    expect(useLaneContractStore.getState().lanesForOwner('tab')[0]?.dataset.source).toBe(original);
    expect(mockRemoteDisconnect).toHaveBeenCalledOnce();
  });

  it.each(['removed', 'replaced'] as const)(
    'abandons Repair when its track is %s during header validation',
    async (change) => {
      addExistingRemoteLane();
      let finishHeader!: (header: ReturnType<typeof readableHeader>) => void;
      mockRemoteConnect.mockResolvedValue(remoteMaterialization());
      vi.mocked(readAlignmentHeader).mockReturnValue(
        new Promise((resolve) => {
          finishHeader = resolve;
        })
      );
      const { result } = renderHook(() => useBamTrackImport(GENOME));
      let repairing!: Promise<void>;
      act(() => {
        repairing = result.current.repairTrack('remote-track');
      });
      await waitFor(() => expect(readAlignmentHeader).toHaveBeenCalledOnce());

      act(() => {
        const store = useLaneContractStore.getState();
        if (change === 'removed') store.removeLane('tab', 'remote-track');
        else {
          const lane = store.lanesForOwner('tab')[0]!;
          store.replaceLaneDataset('tab', 'remote-track', 'grch38', {
            ...lane.dataset,
            source: { bamPath: '/new/local.bam', indexPath: '/new/local.bam.bai' },
          });
        }
      });
      const expected = useLaneContractStore.getState().lanesForOwner('tab');

      await waitFor(() => expect(mockRemoteDisconnect).toHaveBeenCalledWith('candidate-session'));
      await act(async () => repairing);
      await act(async () => finishHeader(readableHeader()));
      expect(useLaneContractStore.getState().lanesForOwner('tab')).toEqual(expected);
      expect(mockRemoteDisconnect).toHaveBeenCalledOnce();
    }
  );

  it('closes the SSH session and adds no lane when the remote BAM has the wrong assembly', async () => {
    mockRemoteConnect.mockResolvedValue({
      protocol: 'dnaforge-remote-range.v1',
      sessionId: 'remote-session-wrong-assembly',
      endpoint: {
        endpointId: 'endpoint-1',
        displayName: 'Lab HPC',
        target: 'lab-hpc',
        lastConnectedAt: 1,
        observedPlatform: 'linux',
        lastFailure: null,
      },
      locator: {
        contract: 'remote-alignment-locator.v1',
        endpointId: 'endpoint-1',
        target: 'lab-hpc',
        alignmentPath: '/project/wrong.bam',
        indexPath: '/project/wrong.bam.bai',
      },
      bamUrl: 'http://127.0.0.1:43118/alignment.bam',
      indexPath: '/tmp/dnaforge-remote-index-2/alignment.bam.bai',
      generation: {
        alignment: {
          canonicalPath: '/project/wrong.bam',
          size: 100,
          mtimeNs: '1',
          ctimeNs: '2',
          device: null,
          inode: null,
        },
        index: {
          canonicalPath: '/project/wrong.bam.bai',
          size: 20,
          mtimeNs: '3',
          ctimeNs: '4',
          device: null,
          inode: null,
        },
      },
    });
    vi.mocked(readAlignmentHeader).mockResolvedValue({
      ...readableHeader(),
      references: [{ name: 'chrZ', length: 999, md5: null }],
    });
    const { result } = renderHook(() => useBamTrackImport(GENOME));

    let failure: unknown;
    await act(async () => {
      try {
        await result.current.addRemote({ target: 'lab-hpc', alignmentPath: '/project/wrong.bam' });
      } catch (error) {
        failure = error;
      }
    });

    expect(failure).toEqual(
      expect.objectContaining({ message: expect.stringMatching(/incompatible with GRCh38/u) })
    );
    expect(mockRemoteDisconnect).toHaveBeenCalledWith('remote-session-wrong-assembly');
    expect(useLaneContractStore.getState().lanesForOwner('tab')).toHaveLength(0);
    expect(result.current.notice?.kind).toBe('error');
  });

  it('mounts remote BAM runtime proxies while keeping the durable URL receipt on the lane', async () => {
    vi.mocked(readAlignmentHeader).mockResolvedValue(readableHeader());
    const { result } = renderHook(() => useBamTrackImport(GENOME));

    await act(async () =>
      result.current.addRequests([
        directTrackAdmissionRequest({
          assemblyId: GENOME.assemblyId,
          input: { kind: 'url', url: 'https://reads.example.org/tumor.bam' },
          index: { kind: 'url', url: 'https://reads.example.org/tumor.bam.bai' },
          formatId: 'bam',
          scientificKind: 'reads',
          label: 'Tumor reads',
          ingress: 'url',
        }),
      ])
    );

    const lane = useLaneContractStore.getState().lanesForOwner('tab')[0];
    expect(lane?.dataset.source).toEqual({
      bamPath: 'http://dnaforge-source:runtime-bam@127.0.0.1:8000/external/range-proxy/source.bam',
      indexPath: '/tmp/dnaforge-index.bai',
      grantExpiresAtMs: expect.any(Number),
    });
    expect(lane?.source).toMatchObject({
      request: {
        source: { kind: 'http', url: 'https://reads.example.org/tumor.bam' },
        index: { kind: 'http', url: 'https://reads.example.org/tumor.bam.bai' },
      },
      input: { kind: 'url', url: 'https://reads.example.org/tumor.bam' },
      index: { kind: 'url', url: 'https://reads.example.org/tumor.bam.bai' },
    });
    expect(JSON.stringify(lane?.source)).not.toContain('/external/range-proxy/');
    expect(admitIndexedRangeSource).toHaveBeenCalledTimes(2);
    expect(materializeIndexedRangeSource).toHaveBeenCalledTimes(1);
    expect(startAlignmentCoverageOperation).not.toHaveBeenCalled();
    expect(result.current.notice).toEqual({
      kind: 'success',
      text: 'Added 1 aligned-read track.',
    });
  });

  it('appends a second distinct BAM from a later add gesture without replacing the first', async () => {
    mockDialogOpen
      .mockResolvedValueOnce('/data/tumor.bam')
      .mockResolvedValueOnce('/data/normal.bam');
    vi.mocked(readAlignmentHeader).mockResolvedValue(readableHeader());
    const { result } = renderHook(() => useBamTrackImport(GENOME));

    await act(async () => result.current.addFiles(['/data/tumor.bam']));
    expect(
      useLaneContractStore
        .getState()
        .lanesForOwner('tab')
        .map((lane) => lane.dataset.source?.bamPath)
    ).toEqual(['/canonical/data/tumor.bam']);

    await act(async () => result.current.addFiles(['/data/normal.bam']));

    const lanes = useLaneContractStore.getState().lanesForOwner('tab');
    expect(lanes.map((lane) => lane.dataset.source?.bamPath)).toEqual([
      '/canonical/data/tumor.bam',
      '/canonical/data/normal.bam',
    ]);
    expect(new Set(lanes.map((lane) => lane.dataset.trackId)).size).toBe(2);
    expect(result.current.notice).toEqual({
      kind: 'success',
      text: 'Coverage preparation started for normal.bam. Follow it in Jobs.',
    });
  });

  it('keeps one lane and reports a duplicate source clearly', async () => {
    mockDialogOpen.mockResolvedValue('/data/tumor.bam');
    vi.mocked(readAlignmentHeader).mockResolvedValue(readableHeader());
    const { result } = renderHook(() => useBamTrackImport(GENOME));

    await act(async () => result.current.addFiles(['/data/tumor.bam']));
    await act(async () => result.current.addFiles(['/data/tumor.bam']));

    expect(useLaneContractStore.getState().lanesForOwner('tab')).toHaveLength(1);
    expect(result.current.notice).toEqual({
      kind: 'warn',
      text: 'Already added: tumor.bam.',
    });
  });

  it('automatically indexes a local BAM before adding its tile-backed lane', async () => {
    mockDialogOpen.mockResolvedValue('/data/unindexed.bam');
    vi.mocked(readAlignmentHeader).mockResolvedValue(readableHeader());
    vi.mocked(waitForAlignmentIndexResult).mockResolvedValue({
      format: 'bam',
      state: 'created',
      indexPath: '/data/unindexed.bam.bai',
    });
    const { result } = renderHook(() => useBamTrackImport(GENOME));

    await act(async () => result.current.addFiles(['/data/unindexed.bam']));

    expect(startAlignmentIndexOperation).toHaveBeenCalledWith({
      bamPath: '/data/unindexed.bam',
    });
    expect(waitForAlignmentIndexResult).toHaveBeenCalledWith('index:/data/unindexed.bam', {
      signal: expect.any(AbortSignal),
    });
    expect(readAlignmentHeader).toHaveBeenCalledWith({
      bamPath: '/data/unindexed.bam',
      indexPath: '/data/unindexed.bam.bai',
    });
    expect(startAlignmentCoverageOperation).toHaveBeenCalledWith({
      assemblyId: 'grch38',
      bamPath: '/canonical/data/unindexed.bam',
      indexPath: '/canonical/data/unindexed.bam.bai',
      sourceGeneration: expect.objectContaining({
        contract: 'aligned-read-source-generation.v1',
      }),
      chroms: GENOME.references.map((reference) => reference.name),
    });
    expect(useLaneContractStore.getState().lanesForOwner('tab')[0]?.dataset.source).toMatchObject({
      bamPath: '/canonical/data/unindexed.bam',
      indexPath: '/canonical/data/unindexed.bam.bai',
      generation: {
        contract: 'aligned-read-source-generation.v1',
        alignment: { canonicalPath: '/canonical/data/unindexed.bam' },
        index: { canonicalPath: '/canonical/data/unindexed.bam.bai' },
      },
    });
    expect(useLaneContractStore.getState().lanesForOwner('tab')[0]?.source).toMatchObject({
      admissionVersion: 2,
      formatId: 'bam',
      readerKind: 'bam',
      scientificKind: 'reads',
      request: {
        source: { kind: 'local-file', path: '/canonical/data/unindexed.bam' },
        index: { kind: 'local-file', path: '/canonical/data/unindexed.bam.bai' },
      },
      alignedReadGeneration: {
        contract: 'aligned-read-source-generation.v1',
      },
    });
    expect(result.current.notice).toEqual({
      kind: 'success',
      text: 'Coverage preparation started for unindexed.bam. Follow it in Jobs.',
    });
  });

  it('does not add a BAM when automatic indexing fails', async () => {
    mockDialogOpen.mockResolvedValue('/data/unsorted.bam');
    vi.mocked(readAlignmentHeader).mockResolvedValue({
      ...readableHeader(),
      index: { state: 'missing' },
    });
    vi.mocked(waitForAlignmentIndexResult).mockRejectedValue(
      new Error('Could not index this BAM. It must be coordinate-sorted and writable.')
    );
    const { result } = renderHook(() => useBamTrackImport(GENOME));

    await act(async () => result.current.addFiles(['/data/unsorted.bam']));

    expect(useLaneContractStore.getState().lanesForOwner('tab')).toHaveLength(0);
    expect(result.current.notice?.kind).toBe('error');
    expect(result.current.notice?.text).toContain('coordinate-sorted and writable');
  });

  it('detaches its index observer on unmount without canceling the owned job', async () => {
    vi.mocked(readAlignmentHeader).mockResolvedValue(readableHeader());
    let observedSignal: AbortSignal | undefined;
    vi.mocked(waitForAlignmentIndexResult).mockImplementation(
      (_operationId, options) =>
        new Promise((_resolve, reject) => {
          observedSignal = options?.signal;
          observedSignal?.addEventListener(
            'abort',
            () => reject(new Error('Stopped waiting for operation index:/data/pending.bam.')),
            { once: true }
          );
        })
    );
    const { result, unmount } = renderHook(() => useBamTrackImport(GENOME));

    let importPromise!: Promise<void>;
    act(() => {
      importPromise = result.current.addFiles(['/data/pending.bam']);
    });
    await vi.waitFor(() => expect(observedSignal).toBeDefined());

    unmount();
    expect(observedSignal?.aborted).toBe(true);
    await importPromise;

    expect(readAlignmentHeader).not.toHaveBeenCalled();
    expect(startAlignmentCoverageOperation).not.toHaveBeenCalled();
    expect(useLaneContractStore.getState().lanesForOwner('tab')).toHaveLength(0);
  });

  it('keeps the validated lane mounted and reports a background preparation failure', async () => {
    mockDialogOpen.mockResolvedValue('/data/no-coverage.bam');
    vi.mocked(readAlignmentHeader).mockResolvedValue(readableHeader());
    vi.mocked(startAlignmentCoverageOperation).mockRejectedValue(
      new Error('Coverage could not be prepared for chr2 (chrom not in BAM).')
    );
    const { result } = renderHook(() => useBamTrackImport(GENOME));

    await act(async () => result.current.addFiles(['/data/no-coverage.bam']));

    expect(useLaneContractStore.getState().lanesForOwner('tab')).toHaveLength(1);
    expect(result.current.notice).toEqual({
      kind: 'error',
      text: 'no-coverage.bam was added, but overview coverage could not be started: Coverage could not be prepared for chr2 (chrom not in BAM).',
    });
  });

  it('rejects a same-name chromosome from the wrong assembly before coverage preparation', async () => {
    mockDialogOpen.mockResolvedValue('/data/grch37.bam');
    vi.mocked(readAlignmentHeader).mockResolvedValue({
      ...readableHeader(),
      references: [
        { name: 'chr1', length: 999, md5: null },
        { name: 'chr2', length: 2_000, md5: null },
      ],
    });
    const { result } = renderHook(() => useBamTrackImport(GENOME));

    await act(async () => result.current.addFiles(['/data/grch37.bam']));

    expect(startAlignmentCoverageOperation).not.toHaveBeenCalled();
    expect(useLaneContractStore.getState().lanesForOwner('tab')).toHaveLength(0);
    expect(result.current.notice).toEqual({
      kind: 'error',
      text: 'grch37.bam: BAM is incompatible with GRCh38: reference "chr1" is 999 bp in the BAM, expected 1000 bp.',
    });
  });

  it('mounts the validated lane before background coverage preparation has completed', async () => {
    mockDialogOpen.mockResolvedValue('/data/cold.bam');
    vi.mocked(readAlignmentHeader).mockResolvedValue(readableHeader());
    let finishCoverage!: () => void;
    vi.mocked(startAlignmentCoverageOperation).mockReturnValue(
      new Promise((resolve) => {
        finishCoverage = () => resolve(undefined as never);
      })
    );
    const { result } = renderHook(() => useBamTrackImport(GENOME));

    let importPromise!: Promise<void>;
    act(() => {
      importPromise = result.current.addFiles(['/data/cold.bam']);
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(useLaneContractStore.getState().lanesForOwner('tab')).toHaveLength(1)
      );
    });

    expect(useLaneContractStore.getState().lanesForOwner('tab')).toHaveLength(1);
    expect(result.current.busy).toBeNull();
    expect(result.current.progress).toBeNull();
    expect(result.current.notice).toEqual({
      kind: 'success',
      text: 'Added 1 aligned-read track. Preparing overview coverage in the background.',
    });

    finishCoverage();
    await act(async () => importPromise);

    expect(useLaneContractStore.getState().lanesForOwner('tab')).toHaveLength(1);
    expect(result.current.busy).toBeNull();
    expect(result.current.progress).toBeNull();
  });

  it('attaches a CRAM with its readable index and explicitly selected reference FASTA', async () => {
    mockDialogOpen.mockResolvedValue('/references/GRCh38.fa');
    vi.mocked(waitForAlignmentIndexResult).mockResolvedValue({
      format: 'cram',
      state: 'present',
      indexPath: '/data/NA12718.final.cram.crai',
    });
    vi.mocked(readAlignmentHeader)
      .mockResolvedValueOnce(readableCramHeader())
      .mockResolvedValueOnce(readableCramHeader());
    const { result } = renderHook(() => useBamTrackImport(GENOME));

    await act(async () => result.current.addFiles(['/data/NA12718.final.cram']));

    expect(mockDialogOpen).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        title: 'Choose the reference FASTA for NA12718.final.cram',
      })
    );
    expect(readAlignmentHeader).toHaveBeenNthCalledWith(2, {
      bamPath: '/canonical/data/NA12718.final.cram',
      indexPath: '/canonical/data/NA12718.final.cram.crai',
      referencePath: '/canonical/references/GRCh38.fa',
      generation: expect.objectContaining({
        contract: 'aligned-read-source-generation.v1',
      }),
    });
    expect(startAlignmentCoverageOperation).toHaveBeenCalledWith({
      assemblyId: 'grch38',
      bamPath: '/canonical/data/NA12718.final.cram',
      indexPath: '/canonical/data/NA12718.final.cram.crai',
      referencePath: '/canonical/references/GRCh38.fa',
      sourceGeneration: expect.objectContaining({
        contract: 'aligned-read-source-generation.v1',
      }),
      chroms: GENOME.references.map((reference) => reference.name),
    });
    expect(useLaneContractStore.getState().lanesForOwner('tab')[0]?.dataset.source).toMatchObject({
      bamPath: '/canonical/data/NA12718.final.cram',
      indexPath: '/canonical/data/NA12718.final.cram.crai',
      referencePath: '/canonical/references/GRCh38.fa',
      generation: {
        reference: { canonicalPath: '/canonical/references/GRCh38.fa' },
        referenceIndex: { canonicalPath: '/canonical/references/GRCh38.fa.fai' },
      },
    });
  });

  it('adds no CRAM lane and explains recovery when reference selection is canceled', async () => {
    mockDialogOpen.mockResolvedValue(null);
    vi.mocked(waitForAlignmentIndexResult).mockResolvedValue({
      format: 'cram',
      state: 'present',
      indexPath: '/data/NA12718.final.cram.crai',
    });
    vi.mocked(readAlignmentHeader).mockResolvedValueOnce(readableCramHeader());
    const { result } = renderHook(() => useBamTrackImport(GENOME));

    await act(async () => result.current.addFiles(['/data/NA12718.final.cram']));

    expect(useLaneContractStore.getState().lanesForOwner('tab')).toHaveLength(0);
    expect(startAlignmentCoverageOperation).not.toHaveBeenCalled();
    expect(result.current.notice).toEqual({
      kind: 'error',
      text: 'NA12718.final.cram: This CRAM needs its matching indexed reference FASTA before it can be added.',
    });
  });

  it('repairs one lane through the native picker while preserving its identity and presentation', async () => {
    useLaneContractStore.getState().addLane(
      'tab',
      'grch38',
      {
        kind: 'pileup',
        trackType: 'pileup-genomewide',
        trackId: 'tumor-track',
        label: 'Tumor reads',
        color: 0xe11d48,
        coverageCutoffDepth: 175,
        trackPx: 276,
        records: [],
        source: { bamPath: '/missing/tumor.bam', indexPath: '/missing/tumor.bam.bai' },
      },
      false
    );
    mockDialogOpen.mockResolvedValue('/recovered/tumor.bam');
    vi.mocked(readAlignmentHeader).mockResolvedValue(readableHeader());
    const { result } = renderHook(() => useBamTrackImport(GENOME));

    await act(async () => result.current.repairTrack('tumor-track'));

    expect(mockDialogOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        multiple: false,
        title: 'Repair Tumor reads',
      })
    );
    expect(useLaneContractStore.getState().lanesForOwner('tab')).toMatchObject([
      {
        visible: false,
        dataset: {
          trackId: 'tumor-track',
          label: 'Tumor reads',
          color: 0xe11d48,
          coverageCutoffDepth: 175,
          source: {
            bamPath: '/canonical/recovered/tumor.bam',
            indexPath: '/canonical/recovered/tumor.bam.bai',
            generation: {
              alignment: { canonicalPath: '/canonical/recovered/tumor.bam' },
            },
          },
        },
      },
    ]);
    expect(result.current.lastOperation).toBe('repair');
    expect(result.current.notice).toEqual({
      kind: 'success',
      text: 'Coverage preparation started for Tumor reads. Follow it in Jobs.',
    });
  });

  it('opens a saved remote file again without asking the user to pick a path', async () => {
    useLaneContractStore.getState().addLane(
      'tab',
      'grch38',
      {
        kind: 'pileup',
        trackType: 'pileup-genomewide',
        trackId: 'remote-track',
        label: 'GRCh38: sample.bam',
        color: 0xe11d48,
        trackPx: 276,
        records: [],
        source: {
          bamPath: '/data/sample.cram',
          indexPath: '/data/sample.cram.crai',
          admissionError: 'invalid remote source',
          remote: {
            locator: {
              contract: 'remote-alignment-locator.v1',
              endpointId: 'endpoint-1',
              target: 'lab-hpc',
              alignmentPath: '/data/sample.cram',
              indexPath: '/data/sample.cram.crai',
            },
          },
        },
      },
      false
    );
    mockRemoteConnect.mockResolvedValue({
      protocol: 'dnaforge-remote-range.v1',
      sessionId: 'session-1',
      endpoint: {
        endpointId: 'endpoint-1',
        displayName: 'Lab HPC',
        target: 'lab-hpc',
        lastConnectedAt: 1,
        observedPlatform: 'linux',
        lastFailure: null,
      },
      locator: {
        contract: 'remote-alignment-locator.v1',
        endpointId: 'endpoint-1',
        target: 'lab-hpc',
        alignmentPath: '/data/sample.cram',
        indexPath: '/data/sample.cram.crai',
      },
      bamUrl: 'http://127.0.0.1:9/v1/handle/alignment.cram',
      indexPath: '/tmp/alignment.cram.crai',
      generation: {
        alignment: {
          canonicalPath: '/data/sample.cram',
          size: 10,
          mtimeNs: '1',
          ctimeNs: '1',
          device: null,
          inode: null,
        },
        index: {
          canonicalPath: '/data/sample.cram.crai',
          size: 4,
          mtimeNs: '1',
          ctimeNs: '1',
          device: null,
          inode: null,
        },
      },
    });
    vi.mocked(readAlignmentHeader).mockResolvedValue(readableCramHeader());
    const { result } = renderHook(() => useBamTrackImport(GENOME));

    await act(async () => result.current.repairTrack('remote-track'));

    expect(mockDialogOpen).not.toHaveBeenCalled();
    expect(mockRemoteRetry).toHaveBeenCalledWith('endpoint-1');
    expect(mockRemoteConnect).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: expect.stringMatching(/^remote-import-/u),
        endpointId: 'endpoint-1',
        target: 'lab-hpc',
        alignmentPath: '/data/sample.cram',
        indexPath: '/data/sample.cram.crai',
      })
    );
    const restored = useLaneContractStore.getState().lanesForOwner('tab')[0]?.dataset;
    expect(restored).toMatchObject({
      trackId: 'remote-track',
      label: 'GRCh38: sample.bam',
      source: { bamPath: 'http://127.0.0.1:9/v1/handle/alignment.cram' },
    });
    expect(restored?.source?.admissionError).toBeUndefined();
    expect(result.current.notice).toEqual({
      kind: 'success',
      text: 'Opened sample.cram again from lab-hpc.',
    });
  });

  it('validates a replacement lease before releasing the current stable remote source', async () => {
    useLaneContractStore.getState().addLane(
      'tab',
      'grch38',
      {
        kind: 'pileup',
        trackType: 'pileup-genomewide',
        trackId: 'remote-track',
        label: 'GRCh38: sample.cram',
        color: 0xe11d48,
        trackPx: 276,
        records: [],
        source: {
          bamPath: 'http://127.0.0.1:41000/v1/old/alignment.cram',
          indexPath: '/tmp/old.crai',
          remote: {
            locator: {
              contract: 'remote-alignment-locator.v1',
              endpointId: 'endpoint-1',
              target: 'lab-hpc',
              alignmentPath: '/data/sample.cram',
              indexPath: '/data/sample.cram.crai',
              signalPath: '/data/sample.bigWig',
            },
            sessionId: 'old-session',
          },
        },
      },
      true
    );
    mockRemoteConnect.mockResolvedValue({
      protocol: 'dnaforge-remote-range.v1',
      sessionId: 'replacement-session',
      endpoint: {
        endpointId: 'endpoint-1',
        displayName: 'Lab HPC',
        target: 'lab-hpc',
        lastConnectedAt: 1,
        observedPlatform: 'linux',
        lastFailure: null,
      },
      locator: {
        contract: 'remote-alignment-locator.v1',
        endpointId: 'endpoint-1',
        target: 'lab-hpc',
        alignmentPath: '/data/sample.cram',
        indexPath: '/data/sample.cram.crai',
        signalPath: '/data/sample.bigWig',
      },
      bamUrl: 'http://127.0.0.1:42000/v1/new/alignment.cram',
      bigWigUrl: 'http://127.0.0.1:42000/v1/new/signal.bigWig',
      indexPath: '/tmp/new.crai',
      generation: {
        alignment: {
          canonicalPath: '/data/sample.cram',
          size: 10,
          mtimeNs: '2',
          ctimeNs: '2',
          device: null,
          inode: null,
        },
        index: {
          canonicalPath: '/data/sample.cram.crai',
          size: 4,
          mtimeNs: '2',
          ctimeNs: '2',
          device: null,
          inode: null,
        },
        signal: {
          canonicalPath: '/data/sample.bigWig',
          size: 8,
          mtimeNs: '2',
          ctimeNs: '2',
          device: null,
          inode: null,
        },
      },
    });
    vi.mocked(readAlignmentHeader).mockResolvedValue(readableCramHeader());
    vi.mocked(attachRemoteSignalBigWig).mockRejectedValue(new Error('worker temporarily offline'));
    const { result } = renderHook(() => useBamTrackImport(GENOME));

    await act(async () => {
      await expect(result.current.reconnectRemoteTrack('remote-track')).resolves.toBe(true);
    });

    expect(
      mockRemoteRetry,
      'a watchdog handoff must not impersonate an explicit Retry'
    ).not.toHaveBeenCalled();

    expect(useLaneContractStore.getState().lanesForOwner('tab')[0]?.dataset.source).toMatchObject({
      bamPath: 'http://127.0.0.1:42000/v1/new/alignment.cram',
      remote: { sessionId: 'replacement-session' },
    });
    expect(mockRemoteDisconnect).not.toHaveBeenCalledWith('replacement-session');
    await waitFor(() => expect(mockRemoteDisconnect).toHaveBeenCalledWith('old-session'));
    expect(mockRemoteConnect.mock.invocationCallOrder[0]).toBeLessThan(
      mockRemoteDisconnect.mock.invocationCallOrder[0]
    );
  });

  it('edits a saved remote source without losing the track or releasing the old lease before validation', async () => {
    useLaneContractStore.getState().addLane(
      'tab',
      'grch38',
      {
        kind: 'pileup',
        trackType: 'pileup-genomewide',
        trackId: 'remote-track',
        label: 'GRCh38: sample.bam',
        color: 0xe11d48,
        trackPx: 276,
        records: [],
        source: {
          bamPath: 'http://127.0.0.1:41000/v1/old/alignment.bam',
          indexPath: '/tmp/old.bai',
          remote: {
            locator: {
              contract: 'remote-alignment-locator.v1',
              endpointId: 'old-endpoint',
              target: 'old-hpc',
              alignmentPath: '/old/sample.bam',
              indexPath: '/old/sample.bam.bai',
            },
            sessionId: 'old-session',
          },
        },
      },
      true
    );
    mockRemoteConnect.mockResolvedValue({
      protocol: 'dnaforge-remote-range.v1',
      sessionId: 'new-session',
      endpoint: {
        endpointId: 'new-endpoint',
        displayName: 'New HPC',
        target: 'new-hpc',
        lastConnectedAt: 2,
        observedPlatform: 'linux',
        lastFailure: null,
      },
      locator: {
        contract: 'remote-alignment-locator.v1',
        endpointId: 'new-endpoint',
        target: 'new-hpc',
        alignmentPath: '/new/sample.bam',
        indexPath: '/new/sample.bam.bai',
      },
      bamUrl: 'http://127.0.0.1:42000/v1/new/alignment.bam',
      indexPath: '/tmp/new.bai',
      generation: {
        alignment: {
          canonicalPath: '/new/sample.bam',
          size: 10,
          mtimeNs: '2',
          ctimeNs: '2',
          device: null,
          inode: null,
        },
        index: {
          canonicalPath: '/new/sample.bam.bai',
          size: 4,
          mtimeNs: '2',
          ctimeNs: '2',
          device: null,
          inode: null,
        },
      },
    });
    vi.mocked(readAlignmentHeader).mockResolvedValue(readableHeader());
    const { result } = renderHook(() => useBamTrackImport(GENOME));

    await act(async () =>
      result.current.editRemoteTrack('remote-track', {
        target: 'new-hpc',
        alignmentPath: '/new/sample.bam',
        indexPath: '/new/sample.bam.bai',
      })
    );

    expect(mockRemoteConnect).toHaveBeenCalledWith(
      expect.objectContaining({
        target: 'new-hpc',
        alignmentPath: '/new/sample.bam',
        endpointId: undefined,
      })
    );
    expect(mockRemoteRetry).not.toHaveBeenCalled();
    const updated = useLaneContractStore.getState().lanesForOwner('tab')[0]?.dataset;
    expect(updated).toMatchObject({
      trackId: 'remote-track',
      label: 'GRCh38: sample.bam',
      color: 0xe11d48,
      trackPx: 276,
      source: {
        bamPath: 'http://127.0.0.1:42000/v1/new/alignment.bam',
        remote: {
          locator: {
            endpointId: 'new-endpoint',
            target: 'new-hpc',
            alignmentPath: '/new/sample.bam',
          },
        },
      },
    });
    await waitFor(() => expect(mockRemoteDisconnect).toHaveBeenCalledWith('old-session'));
    expect(mockRemoteConnect.mock.invocationCallOrder[0]).toBeLessThan(
      mockRemoteDisconnect.mock.invocationCallOrder[0]
    );

    mockRemoteConnect.mockRejectedValueOnce(new Error('Remote alignment was not found.'));
    await expect(
      act(async () =>
        result.current.editRemoteTrack('remote-track', {
          target: 'third-hpc',
          alignmentPath: '/missing/sample.bam',
        })
      )
    ).rejects.toThrow('Remote alignment was not found.');
    expect(
      useLaneContractStore.getState().lanesForOwner('tab')[0]?.dataset.source?.remote?.locator
        .target
    ).toBe('new-hpc');
    expect(mockRemoteDisconnect).not.toHaveBeenCalledWith('new-session');
  });

  it('keeps the saved remote file on the row when ssh needs a password', async () => {
    useLaneContractStore.getState().addLane(
      'tab',
      'grch38',
      {
        kind: 'pileup',
        trackType: 'pileup-genomewide',
        trackId: 'remote-track',
        label: 'GRCh38: sample.cram',
        color: 0xe11d48,
        trackPx: 276,
        records: [],
        source: {
          bamPath: '/data/sample.cram',
          indexPath: '/data/sample.cram.crai',
          remote: {
            locator: {
              contract: 'remote-alignment-locator.v1',
              endpointId: 'endpoint-1',
              target: 'dnaforge-gcp-benchmark',
              alignmentPath: '/data/sample.cram',
              indexPath: '/data/sample.cram.crai',
            },
          },
        },
      },
      false
    );
    mockRemoteConnect.mockRejectedValue(
      new Error(
        'OpenSSH needs authentication. Retry to answer its prompt in DNAForge, or check your SSH agent.'
      )
    );
    const { result } = renderHook(() => useBamTrackImport(GENOME));

    await act(async () => result.current.repairTrack('remote-track'));

    const source = useLaneContractStore.getState().lanesForOwner('tab')[0]?.dataset.source;
    expect(mockDialogOpen).not.toHaveBeenCalled();
    expect(source?.remote?.locator.alignmentPath).toBe('/data/sample.cram');
    expect(source?.admissionError).toContain('Retry to answer its prompt in DNAForge');
    expect(result.current.notice?.kind).toBe('error');
  });

  it('leaves the lane untouched when native Repair is canceled', async () => {
    const original = {
      kind: 'pileup' as const,
      trackType: 'pileup-genomewide',
      trackId: 'tumor-track',
      label: 'Tumor reads',
      color: 0xe11d48,
      trackPx: 276,
      records: [],
      source: { bamPath: '/missing/tumor.bam', indexPath: '/missing/tumor.bam.bai' },
    };
    useLaneContractStore.getState().addLane('tab', 'grch38', original);
    mockDialogOpen.mockResolvedValue(null);
    const { result } = renderHook(() => useBamTrackImport(GENOME));

    await act(async () => result.current.repairTrack('tumor-track'));

    expect(useLaneContractStore.getState().lanesForOwner('tab')[0]?.dataset).toEqual(original);
    expect(startAlignmentIndexOperation).not.toHaveBeenCalled();
  });
});
