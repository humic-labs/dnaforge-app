import { act, fireEvent, render, renderHook, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useLaneContractStore } from '../lane-contract-store';
import { indexedGenomeDataTrackFromLane } from '../ucsc-track-persistence';
import { usePersistedBamTracks } from './usePersistedBamTracks';
import { usePersistedDataTracks, cancelRemoteSignalRestore } from './usePersistedUcscTracks';
import { useBamTrackImport } from './useBamTrackImport';
import { parseTrackViewDocument, serializeTrackViewDocument } from '../../../shared/track-view';
import { trackViewFixture } from '../../../shared/track-view-fixture';
import { readAlignmentHeader } from '../alignment-header-client';
import { RemoteTrackConnectionDialog } from './RemoteTrackConnectionDialog';
import { RemoteSignalConnectionDialog } from './RemoteSignalConnectionDialog';
import type {
  IndexedGenomeBamTrackState,
  IndexedGenomeDataTrackState,
} from '../../../shared/indexed-genome';
import type { RemoteGenomicsRuntimeStatusEventV1 } from '../../../shared/remote-genomics-ipc';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  connectSignal: vi.fn(),
  disconnect: vi.fn().mockResolvedValue(undefined),
  cancel: vi.fn().mockResolvedValue(true),
  openBbi: vi.fn(),
  closeBbi: vi.fn().mockResolvedValue(undefined),
  queryQuantitative: vi.fn().mockResolvedValue([]),
  statusListeners: new Set<(event: RemoteGenomicsRuntimeStatusEventV1) => void>(),
}));

vi.mock('../../../platform', () => ({
  platform: () => ({
    remoteGenomics: {
      connectAlignment: mocks.connect,
      connectSignal: mocks.connectSignal,
      disconnectSession: mocks.disconnect,
      cancelConnect: mocks.cancel,
      subscribeStatus: (listener: (event: RemoteGenomicsRuntimeStatusEventV1) => void) => {
        mocks.statusListeners.add(listener);
        return () => mocks.statusListeners.delete(listener);
      },
    },
    fs: {
      stat: vi.fn(),
      watchFile: vi.fn().mockResolvedValue(undefined),
      unwatchFile: vi.fn().mockResolvedValue(undefined),
    },
    on: () => () => undefined,
  }),
}));

vi.mock('../alignment-header-client', async (load) => ({
  ...(await load<typeof import('../alignment-header-client')>()),
  readAlignmentHeader: vi.fn().mockResolvedValue({
    format: 'bam',
    isCram: false,
    referenceRequired: false,
    references: [{ name: 'chr1', length: 1_000, md5: null }],
    index: { state: 'present' },
  }),
}));

vi.mock('../alignment-coverage-operation-client', () => ({
  startAlignmentCoverageOperation: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../bbi-reader-runtime', () => ({
  getBbiReaderWorkerClient: () => ({
    open: mocks.openBbi,
    closeSource: mocks.closeBbi,
    queryQuantitative: mocks.queryQuantitative,
  }),
}));

const references = [{ name: 'chr1', length: 1_000 }];
const locator = {
  contract: 'remote-alignment-locator.v1' as const,
  endpointId: 'endpoint-integration',
  target: 'lab-hpc',
  alignmentPath: '/project/reads.bam',
  indexPath: '/project/reads.bam.bai',
  signalPath: '/project/coverage.bigWig',
};
const remoteTrack: IndexedGenomeBamTrackState = {
  trackId: 'remote-reads',
  label: 'Remote reads',
  visible: true,
  coverageCutoffDepth: 0,
  source: { bamPath: locator.alignmentPath, indexPath: locator.indexPath, remote: locator },
};
const fileGeneration = (path: string, size: number) => ({
  canonicalPath: path,
  size,
  mtimeNs: '1',
  ctimeNs: '1',
  device: '1',
  inode: '2',
});
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
  bigWigUrl: `http://127.0.0.1:43119/v1/${sourceId}/signal.bigWig`,
  indexPath: '/tmp/source-index/reads.bam.bai',
  generation: {
    alignment: fileGeneration(locator.alignmentPath, 100),
    index: fileGeneration(locator.indexPath, 10),
    signal: fileGeneration(locator.signalPath, 1_000),
  },
});

const signalMaterialization = (
  sessionId = 'independent-lease',
  sourceId = 'independent-source'
) => {
  const paired = materialization(sessionId, sourceId);
  return {
    protocol: paired.protocol,
    sessionId,
    endpoint: paired.endpoint,
    locator: {
      contract: 'remote-signal-locator.v1' as const,
      endpointId: locator.endpointId,
      target: locator.target,
      signalPath: locator.signalPath,
    },
    bigWigUrl: paired.bigWigUrl,
    generation: { signal: paired.generation.signal },
  };
};

function savedSignal(): IndexedGenomeDataTrackState {
  const admitted = signalMaterialization();
  return indexedGenomeDataTrackFromLane({
    assemblyId: 'grch38',
    order: 0,
    visible: true,
    dataset: {
      kind: 'annotation',
      trackId: 'saved-signal',
      trackType: 'quantitative',
      label: 'Saved SSH coverage',
      color: 0x2563eb,
      trackPx: 128,
      records: [],
      remoteSignal: { locator: admitted.locator, sessionId: admitted.sessionId },
    },
    source: {
      admissionVersion: 1,
      uri: admitted.bigWigUrl,
      input: { kind: 'url', url: admitted.bigWigUrl },
      formatId: 'bigwig',
      readerKind: 'bbi',
      scientificKind: 'quantitative',
      fingerprint: 'live-only',
      assemblyId: 'grch38',
      referenceReceipt: {
        assemblyId: 'grch38',
        referenceSignature: 'chr1',
        sourceSignature: 'chr1',
        contigMap: { chr1: 'chr1' },
        checkedContigs: 1,
        status: 'compatible',
        checkedAt: '2026-10-02T00:00:00.000Z',
      },
      provenance: { provider: 'direct-url', sourceKind: 'remote-url', label: 'Saved SSH coverage' },
      expectedValidators: { contentLength: 1000 },
    },
  })!;
}

const mountSignalOnly = (
  initial: IndexedGenomeDataTrackState,
  expected = references,
  laneOwnerId = 'signal-only'
) =>
  renderHook(() => {
    const [tracks, setTracks] = useState<readonly IndexedGenomeDataTrackState[]>([initial]);
    const data = usePersistedDataTracks({
      laneOwnerId,
      assemblyId: 'grch38',
      references: expected,
      persistedTracks: tracks,
      onChange: setTracks,
    });
    return { data, tracks };
  });

interface SavedSourceProjection {
  bamTracks: readonly IndexedGenomeBamTrackState[];
  dataTracks: readonly IndexedGenomeDataTrackState[];
}

const mountSources = (laneOwnerId: string, initial: SavedSourceProjection) =>
  renderHook(() => {
    const [bamTracks, setBamTracks] = useState(initial.bamTracks);
    const [dataTracks, setDataTracks] = useState(initial.dataTracks);
    const bam = usePersistedBamTracks({
      laneOwnerId,
      assemblyId: 'grch38',
      assemblyDisplayName: 'GRCh38',
      references,
      persistedTracks: bamTracks,
      onChange: setBamTracks,
    });
    const data = usePersistedDataTracks({
      laneOwnerId,
      assemblyId: 'grch38',
      persistedTracks: dataTracks,
      references,
      pairedBamTracks: bamTracks,
      pairedSourcesReady: bam.status === 'ready',
      onChange: setDataTracks,
    });
    return { bam, data, bamTracks, dataTracks };
  });

describe('durable standalone SSH signal Save/Reopen', () => {
  beforeEach(() => {
    useLaneContractStore.getState().clear();
    mocks.connect.mockReset();
    mocks.connectSignal.mockReset();
    mocks.statusListeners.clear();
    mocks.cancel.mockClear();
    mocks.disconnect.mockReset().mockResolvedValue(undefined);
    mocks.openBbi.mockReset().mockResolvedValue({
      fileType: 'bigwig',
      references,
      zoomReductionLevels: [10],
      totalSummary: { basesCovered: 100, scoreMin: 0, scoreMax: 12 },
    });
    vi.mocked(readAlignmentHeader)
      .mockReset()
      .mockResolvedValue({
        format: 'bam',
        isCram: false,
        referenceRequired: false,
        references: references.map((reference) => ({ ...reference, md5: null })),
        index: { state: 'present' },
      });
  });
  afterEach(() => useLaneContractStore.getState().clear());

  it.each(['saved', 'foreground'] as const)(
    'keeps a terminal source status after successful %s BAM header admission',
    async (mode) => {
      let finishHeader!: (value: Awaited<ReturnType<typeof readAlignmentHeader>>) => void;
      vi.mocked(readAlignmentHeader).mockReturnValueOnce(
        new Promise((resolve) => {
          finishHeader = resolve;
        })
      );
      const status = {
        sourceId: 'pending-primary-source',
        endpointId: locator.endpointId,
        target: locator.target,
        displayName: 'Lab HPC',
        alignmentPath: locator.alignmentPath,
        indexPath: locator.indexPath,
        signalPath: locator.signalPath,
        state: 'online' as const,
        attempt: 0,
        nextRetryAt: null,
        transportGeneration: 1,
        lastFailure: null,
        updatedAt: 1,
      };
      mocks.connect.mockResolvedValue({
        ...materialization('pending-primary-lease', 'pending-primary-source'),
        runtimeStatus: status,
      });
      const sources = mountSources('initial-view', {
        bamTracks: mode === 'saved' ? [remoteTrack] : [],
        dataTracks: [],
      });
      const controller = renderHook(() =>
        useBamTrackImport({
          laneOwnerId: 'initial-view',
          assemblyId: 'grch38',
          displayName: 'GRCh38',
          references,
        })
      );
      let added: Promise<void> | undefined;
      try {
        if (mode === 'foreground')
          act(() => {
            added = controller.result.current.addRemote({
              target: locator.target,
              alignmentPath: locator.alignmentPath,
              indexPath: locator.indexPath,
              signalPath: locator.signalPath,
            });
          });
        await waitFor(() => expect(readAlignmentHeader).toHaveBeenCalledTimes(1));
        act(() => {
          for (const listener of mocks.statusListeners)
            listener({
              sequence: 1,
              reason: 'blocked',
              status: {
                ...status,
                state: 'blocked',
                updatedAt: 2,
                lastFailure: { code: 'source-changed', message: 'The file changed.' },
              },
            });
        });
        await act(async () => {
          finishHeader({
            format: 'bam',
            isCram: false,
            referenceRequired: false,
            references: references.map((reference) => ({ ...reference, md5: null })),
            index: { state: 'present' },
          });
          await added;
        });
        await waitFor(() => expect(sources.result.current.bam.status).toBe('ready'));
        const lanes = useLaneContractStore.getState().lanesForOwner('initial-view');
        expect(
          lanes.find((lane) => lane.dataset.kind === 'pileup')?.dataset.source?.remote?.connection
            ?.state
        ).toBe('blocked');
        expect(
          lanes.find((lane) => lane.dataset.remoteSignal)?.dataset.remoteSignal?.connection?.state
        ).toBe('blocked');
      } finally {
        controller.unmount();
        sources.unmount();
      }
    }
  );

  it('Cancel stops an opening placeholder before references arrive without canceling another signal', async () => {
    let expected: typeof references = [];
    const saved = savedSignal();
    const otherUri = 'ssh://lab-hpc/project/other.bigWig';
    const other = {
      ...saved,
      trackId: 'other-signal',
      remoteSignal: { ...saved.remoteSignal!, signalPath: '/project/other.bigWig' },
      source: {
        ...saved.source,
        uri: otherUri,
        input: { kind: 'url' as const, url: otherUri },
        fingerprint: ['remote-signal', otherUri].join('\0'),
      },
    };
    mocks.connectSignal.mockImplementation((request) => ({
      ...signalMaterialization(),
      locator: { ...signalMaterialization().locator, signalPath: request.signalPath },
      generation: { signal: fileGeneration(request.signalPath, 1000) },
    }));
    const hook = renderHook(() => {
      const [tracks, setTracks] = useState<readonly IndexedGenomeDataTrackState[]>([saved, other]);
      const data = usePersistedDataTracks({
        laneOwnerId: 'signal-only',
        assemblyId: 'grch38',
        references: expected,
        persistedTracks: tracks,
        onChange: setTracks,
      });
      return { data, tracks };
    });
    try {
      act(() => cancelRemoteSignalRestore('signal-only', saved.trackId));
      expected = references;
      hook.rerender();
      await waitFor(() => expect(hook.result.current.data.status).toBe('ready'));
      expect(mocks.connectSignal).toHaveBeenCalledTimes(1);
      expect(mocks.connectSignal).toHaveBeenCalledWith(
        expect.objectContaining({ signalPath: other.remoteSignal.signalPath })
      );
      expect(
        useLaneContractStore
          .getState()
          .lanesForOwner('signal-only')
          .find((lane) => lane.dataset.trackId === saved.trackId)?.source
      ).toBeUndefined();
      expect(hook.result.current.tracks).toHaveLength(2);
    } finally {
      hook.unmount();
    }
  });

  it('paired companion publishes the latest primary connection after a terminal status during its header', async () => {
    let finishHeader!: (value: unknown) => void;
    mocks.openBbi.mockReturnValueOnce(
      new Promise((resolve) => {
        finishHeader = resolve;
      })
    );
    mocks.connect.mockResolvedValue(materialization('paired-lease', 'paired-source'));
    const hook = mountSources('initial-view', { bamTracks: [remoteTrack], dataTracks: [] });
    try {
      await waitFor(() => expect(mocks.openBbi).toHaveBeenCalledTimes(1));
      act(() => {
        for (const listener of mocks.statusListeners)
          listener({
            sequence: 1,
            reason: 'blocked',
            status: {
              sourceId: 'paired-source',
              endpointId: locator.endpointId,
              target: locator.target,
              displayName: 'Lab HPC',
              alignmentPath: locator.alignmentPath,
              indexPath: locator.indexPath,
              signalPath: locator.signalPath,
              state: 'blocked',
              attempt: 0,
              nextRetryAt: null,
              transportGeneration: 1,
              updatedAt: Date.now() + 10,
              lastFailure: { code: 'source-changed', message: 'The file changed.' },
            },
          });
      });
      await act(async () =>
        finishHeader({ fileType: 'bigwig', references, zoomReductionLevels: [] })
      );
      await waitFor(() => expect(hook.result.current.bam.status).toBe('ready'));
      const signal = useLaneContractStore
        .getState()
        .lanesForOwner('initial-view')
        .find((lane) => lane.dataset.remoteSignal);
      expect(signal?.dataset.remoteSignal?.connection?.state).toBe('blocked');
    } finally {
      hook.unmount();
    }
  });

  it('publishes the current blocked connection when source-changed arrives during header admission', async () => {
    let finishHeader!: (value: unknown) => void;
    mocks.openBbi.mockReturnValueOnce(
      new Promise((resolve) => {
        finishHeader = resolve;
      })
    );
    const admitted = signalMaterialization();
    const status = {
      sourceId: 'independent-source',
      endpointId: locator.endpointId,
      target: locator.target,
      displayName: 'Lab HPC',
      alignmentPath: null,
      indexPath: null,
      signalPath: locator.signalPath,
      state: 'online' as const,
      attempt: 0,
      nextRetryAt: null,
      transportGeneration: 1,
      lastFailure: null,
      updatedAt: 1,
    };
    mocks.connectSignal.mockResolvedValue({ ...admitted, runtimeStatus: status });
    const hook = mountSignalOnly(savedSignal());
    try {
      await waitFor(() => expect(mocks.openBbi).toHaveBeenCalledTimes(1));
      act(() => {
        for (const listener of mocks.statusListeners)
          listener({
            sequence: 1,
            reason: 'blocked',
            status: {
              ...status,
              state: 'blocked',
              updatedAt: 2,
              lastFailure: {
                code: 'source-changed',
                message: 'The signal changed. Reconnect to verify it.',
              },
            },
          });
      });
      await act(async () =>
        finishHeader({ fileType: 'bigwig', references, zoomReductionLevels: [] })
      );
      await waitFor(() => expect(hook.result.current.data.status).toBe('ready'));
      expect(
        useLaneContractStore.getState().lanesForOwner('signal-only')[0]?.dataset.remoteSignal
          ?.connection
      ).toEqual(
        expect.objectContaining({
          state: 'blocked',
          updatedAt: 2,
          lastFailure: expect.objectContaining({ code: 'source-changed' }),
        })
      );
    } finally {
      hook.unmount();
    }
  });

  it('persists explicit removal of the visible placeholder while assembly identity is pending', async () => {
    const saved = savedSignal();
    const hook = mountSignalOnly(saved, []);
    try {
      expect(hook.result.current.data.status).toBe('restoring');
      expect(useLaneContractStore.getState().lanesForOwner('signal-only')).toHaveLength(1);
      act(() => useLaneContractStore.getState().removeLane('signal-only', saved.trackId));
      expect(hook.result.current.tracks).toEqual([]);
      expect(mocks.connectSignal).not.toHaveBeenCalled();
    } finally {
      hook.unmount();
    }
  });

  it('persists removal during actual header admission and rejects its late publication', async () => {
    let finishHeader!: (value: unknown) => void;
    mocks.openBbi.mockReturnValueOnce(
      new Promise((resolve) => {
        finishHeader = resolve;
      })
    );
    mocks.connectSignal.mockResolvedValue(signalMaterialization());
    const saved = savedSignal();
    const hook = mountSignalOnly(saved);
    try {
      await waitFor(() => expect(mocks.openBbi).toHaveBeenCalledTimes(1));
      act(() => useLaneContractStore.getState().removeLane('signal-only', saved.trackId));
      expect(hook.result.current.tracks).toEqual([]);
      await act(async () =>
        finishHeader({ fileType: 'bigwig', references, zoomReductionLevels: [] })
      );
      await waitFor(() => expect(hook.result.current.data.status).toBe('ready'));
      expect(useLaneContractStore.getState().lanesForOwner('signal-only')).toEqual([]);
      await waitFor(() => expect(mocks.disconnect).toHaveBeenCalledWith('independent-lease'));
    } finally {
      hook.unmount();
    }
  });

  it('keeps the durable placeholder and a recovery issue after denied noninteractive admission', async () => {
    mocks.connectSignal.mockRejectedValue(new Error('Permission denied (publickey).'));
    const saved = savedSignal();
    const hook = mountSignalOnly(saved);
    try {
      await waitFor(() => expect(hook.result.current.data.status).toBe('ready'));
      expect(hook.result.current.tracks).toEqual([saved]);
      expect(hook.result.current.data.issues).toEqual([
        expect.objectContaining({
          trackId: saved.trackId,
          message: expect.stringContaining('Open Connection details'),
        }),
      ]);
      const row = useLaneContractStore.getState().lanesForOwner('signal-only')[0]!;
      expect(row.source).toBeUndefined();
      expect(row.dataset.remoteSignal?.admissionError).toContain('SSH authentication');
      expect(mocks.connectSignal.mock.calls[0]?.[0]).not.toHaveProperty('allowInteractive');
      expect(mocks.connect).not.toHaveBeenCalled();
    } finally {
      hook.unmount();
    }
  });

  it('Reconnect opens a fresh standalone signal while preserving identity and display settings', async () => {
    const first = signalMaterialization('initial-signal-lease', 'initial-signal-source');
    const fresh = signalMaterialization('fresh-signal-lease', 'fresh-signal-source');
    mocks.connectSignal.mockResolvedValueOnce(first).mockResolvedValueOnce(fresh);
    const saved = { ...savedSignal(), color: 0x123456, trackPx: 220, visible: false };
    const data = mountSignalOnly(saved);
    const controller = renderHook(() =>
      useBamTrackImport({
        laneOwnerId: 'signal-only',
        assemblyId: 'grch38',
        displayName: 'GRCh38',
        references,
      })
    );
    try {
      await waitFor(() => expect(data.result.current.data.status).toBe('ready'));
      await act(async () => controller.result.current.repairTrack(saved.trackId));
      const restored = useLaneContractStore.getState().lanesForOwner('signal-only')[0]!;
      expect(restored.source?.uri).toBe(fresh.bigWigUrl);
      expect(restored.dataset).toEqual(
        expect.objectContaining({
          trackId: saved.trackId,
          color: saved.color,
          trackPx: saved.trackPx,
        })
      );
      expect(restored.visible).toBe(false);
      expect(mocks.connectSignal).toHaveBeenLastCalledWith(
        expect.objectContaining({
          allowInteractive: true,
          target: locator.target,
          signalPath: locator.signalPath,
          endpointId: locator.endpointId,
        })
      );
      expect(mocks.connect).not.toHaveBeenCalled();
      await waitFor(() => expect(mocks.disconnect).toHaveBeenCalledWith(first.sessionId));
      expect(mocks.disconnect).not.toHaveBeenCalledWith(fresh.sessionId);
    } finally {
      controller.unmount();
      data.unmount();
    }
  });

  it('same-source Reconnect hands ownership to the new signal lease and releases it on final removal', async () => {
    const sourceId = 'shared-pool-source';
    const initial = signalMaterialization('initial-owner-lease', sourceId);
    const replacement = signalMaterialization('replacement-owner-lease', sourceId);
    mocks.connectSignal.mockResolvedValueOnce(initial).mockResolvedValueOnce(replacement);
    const saved = savedSignal();
    const data = mountSignalOnly(saved);
    const controller = renderHook(() =>
      useBamTrackImport({
        laneOwnerId: 'signal-only',
        assemblyId: 'grch38',
        displayName: 'GRCh38',
        references,
      })
    );
    try {
      await waitFor(() => expect(data.result.current.data.status).toBe('ready'));
      await act(async () => controller.result.current.repairTrack(saved.trackId));
      const row = useLaneContractStore.getState().lanesForOwner('signal-only')[0]!;
      expect(row.source?.uri).toBe(initial.bigWigUrl);
      expect(row.dataset.remoteSignal?.sessionId).toBe(replacement.sessionId);
      await waitFor(() => expect(mocks.disconnect).toHaveBeenCalledWith(initial.sessionId));
      expect(mocks.disconnect).not.toHaveBeenCalledWith(replacement.sessionId);
      act(() => useLaneContractStore.getState().removeLane('signal-only', saved.trackId));
      expect(data.result.current.tracks).toEqual([]);
      await waitFor(() => expect(mocks.disconnect).toHaveBeenCalledWith(replacement.sessionId));
    } finally {
      controller.unmount();
      data.unmount();
    }
  });

  it('two signal-only views on one pooled source retain independent leases when one view removes its signal', async () => {
    const first = signalMaterialization('first-view-lease', 'both-views-source');
    const second = signalMaterialization('second-view-lease', 'both-views-source');
    mocks.connectSignal.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const saved = savedSignal();
    const viewA = mountSignalOnly(saved, references, 'signal-view-A');
    const viewB = mountSignalOnly(saved, references, 'signal-view-B');
    try {
      await waitFor(() => {
        expect(viewA.result.current.data.status).toBe('ready');
        expect(viewB.result.current.data.status).toBe('ready');
      });
      expect(useLaneContractStore.getState().lanesForOwner('signal-view-A')[0]?.source?.uri).toBe(
        first.bigWigUrl
      );
      expect(useLaneContractStore.getState().lanesForOwner('signal-view-B')[0]?.source?.uri).toBe(
        first.bigWigUrl
      );
      act(() => useLaneContractStore.getState().removeLane('signal-view-A', saved.trackId));
      await waitFor(() => expect(mocks.disconnect).toHaveBeenCalledWith(first.sessionId));
      expect(mocks.disconnect).not.toHaveBeenCalledWith(second.sessionId);
      expect(viewA.result.current.tracks).toEqual([]);
      expect(viewB.result.current.tracks).toHaveLength(1);
      expect(useLaneContractStore.getState().lanesForOwner('signal-view-B')).toHaveLength(1);
      act(() => useLaneContractStore.getState().removeLane('signal-view-B', saved.trackId));
      await waitFor(() => expect(mocks.disconnect).toHaveBeenCalledWith(second.sessionId));
    } finally {
      viewA.unmount();
      viewB.unmount();
    }
  });

  it("a fresh source event for the same locator cannot mark another signal-only view's old source online", async () => {
    const status = {
      sourceId: 'older-source',
      endpointId: locator.endpointId,
      target: locator.target,
      displayName: 'Lab HPC',
      alignmentPath: null,
      indexPath: null,
      signalPath: locator.signalPath,
      state: 'blocked' as const,
      attempt: 0,
      nextRetryAt: null,
      transportGeneration: 1,
      updatedAt: 1,
      lastFailure: { code: 'source-changed' as const, message: 'The source changed.' },
    };
    mocks.connectSignal
      .mockResolvedValueOnce({
        ...signalMaterialization('older-view-lease', 'older-source'),
        runtimeStatus: status,
      })
      .mockResolvedValueOnce({
        ...signalMaterialization('fresh-view-lease', 'fresh-source'),
        runtimeStatus: {
          ...status,
          sourceId: 'fresh-source',
          state: 'online',
          lastFailure: null,
          updatedAt: 2,
        },
      });
    const saved = savedSignal();
    const viewA = mountSignalOnly(saved, references, 'signal-view-A');
    const viewB = mountSignalOnly(saved, references, 'signal-view-B');
    try {
      await waitFor(() => {
        expect(viewA.result.current.data.status).toBe('ready');
        expect(viewB.result.current.data.status).toBe('ready');
      });
      act(() => {
        for (const listener of mocks.statusListeners)
          listener({
            sequence: 2,
            reason: 'connected',
            status: {
              ...status,
              sourceId: 'fresh-source',
              state: 'online',
              lastFailure: null,
              updatedAt: 3,
            },
          });
      });
      expect(
        useLaneContractStore.getState().lanesForOwner('signal-view-A')[0]?.dataset.remoteSignal
          ?.connection?.state
      ).toBe('blocked');
      expect(
        useLaneContractStore.getState().lanesForOwner('signal-view-B')[0]?.dataset.remoteSignal
          ?.connection?.state
      ).toBe('online');
    } finally {
      viewA.unmount();
      viewB.unmount();
    }
  });

  it('the actual Cancel connection button cancels a foreground admission despite the React click event', async () => {
    let finishConnect!: (value: unknown) => void;
    mocks.connect.mockReturnValueOnce(
      new Promise((resolve) => {
        finishConnect = resolve;
      })
    );
    const controller = renderHook(() =>
      useBamTrackImport({
        laneOwnerId: 'signal-only',
        assemblyId: 'grch38',
        displayName: 'GRCh38',
        references,
      })
    );
    let outcome!: Promise<unknown>;
    act(() => {
      outcome = controller.result.current
        .addRemote({
          allowInteractive: true,
          target: locator.target,
          alignmentPath: locator.alignmentPath,
          indexPath: locator.indexPath,
        })
        .catch((error) => error);
    });
    const dialog = render(
      <RemoteTrackConnectionDialog
        trackLabel="Remote reads"
        locator={locator}
        assemblyDisplayName="GRCh38"
        endpoints={[]}
        busy
        connecting
        notice={null}
        onCancelConnection={controller.result.current.cancelRemoteConnect}
        onRetry={async () => undefined}
        onSave={async () => undefined}
        onRemove={async () => undefined}
        onClose={() => undefined}
      />
    );
    try {
      fireEvent.click(dialog.getByRole('button', { name: 'Cancel connection' }));
      expect(mocks.cancel).toHaveBeenCalledWith(expect.any(String));
      await act(async () =>
        finishConnect(materialization('late-button-lease', 'late-button-source'))
      );
      expect(await outcome).toEqual(
        expect.objectContaining({ message: expect.stringContaining('cancelled') })
      );
      expect(mocks.disconnect).toHaveBeenCalledWith('late-button-lease');
      expect(useLaneContractStore.getState().lanesForOwner('signal-only')).toEqual([]);
    } finally {
      dialog.unmount();
      controller.unmount();
    }
  });

  it('retains the old blocked signal when the freshly connected candidate fails reference validation', async () => {
    const status = {
      sourceId: 'blocked-source',
      endpointId: locator.endpointId,
      target: locator.target,
      displayName: 'Lab HPC',
      alignmentPath: null,
      indexPath: null,
      signalPath: locator.signalPath,
      state: 'blocked' as const,
      attempt: 0,
      nextRetryAt: null,
      transportGeneration: 1,
      lastFailure: { code: 'source-changed' as const, message: 'The signal changed.' },
      updatedAt: 2,
    };
    const initial = {
      ...signalMaterialization('blocked-lease', 'blocked-source'),
      runtimeStatus: status,
    };
    mocks.connectSignal
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(signalMaterialization('rejected-lease', 'rejected-source'));
    const saved = savedSignal();
    const data = mountSignalOnly(saved);
    const controller = renderHook(() =>
      useBamTrackImport({
        laneOwnerId: 'signal-only',
        assemblyId: 'grch38',
        displayName: 'GRCh38',
        references,
      })
    );
    try {
      await waitFor(() => expect(data.result.current.data.status).toBe('ready'));
      const before = useLaneContractStore.getState().lanesForOwner('signal-only')[0]!;
      mocks.openBbi.mockResolvedValueOnce({
        fileType: 'bigwig',
        references: [{ name: 'chr1', length: 2000 }],
        zoomReductionLevels: [],
      });
      await act(async () => controller.result.current.repairTrack(saved.trackId));
      const after = useLaneContractStore.getState().lanesForOwner('signal-only')[0]!;
      expect(after.source).toBe(before.source);
      expect(after.dataset.remoteSignal?.connection).toEqual(
        before.dataset.remoteSignal?.connection
      );
      expect(after.dataset.remoteSignal?.sessionId).toBe('blocked-lease');
      expect(controller.result.current.notice).toEqual(
        expect.objectContaining({
          kind: 'error',
          text: expect.stringContaining('reference mismatch'),
        })
      );
      expect(mocks.disconnect).toHaveBeenCalledWith('rejected-lease');
      expect(mocks.disconnect).not.toHaveBeenCalledWith('blocked-lease');
      expect(data.result.current.tracks[0]?.remoteSignal).toEqual(saved.remoteSignal);
    } finally {
      controller.unmount();
      data.unmount();
    }
  });

  it('Edit source preserves saved identity and quantitative settings through another Save/Reopen', async () => {
    const fresh = signalMaterialization('edited-lease', 'edited-source');
    const editedPath = '/project/edited.bigWig';
    const edited = {
      ...fresh,
      locator: { ...fresh.locator, signalPath: editedPath },
      generation: { signal: { ...fresh.generation.signal, canonicalPath: editedPath } },
    };
    mocks.connectSignal
      .mockResolvedValueOnce(signalMaterialization())
      .mockResolvedValueOnce(edited)
      .mockResolvedValueOnce({
        ...edited,
        sessionId: 'reopened-edit-lease',
        bigWigUrl: 'http://127.0.0.1:43120/v1/reopened-edit-source/signal.bigWig',
      });
    const saved = { ...savedSignal(), trackPx: 210, color: 0x123456 };
    const data = mountSignalOnly(saved);
    const controller = renderHook(() =>
      useBamTrackImport({
        laneOwnerId: 'signal-only',
        assemblyId: 'grch38',
        displayName: 'GRCh38',
        references,
      })
    );
    let reopened: ReturnType<typeof mountSignalOnly> | undefined;
    let dialog: ReturnType<typeof render> | undefined;
    try {
      await waitFor(() => expect(data.result.current.data.status).toBe('ready'));
      dialog = render(
        <RemoteSignalConnectionDialog
          trackLabel={saved.label}
          locator={saved.remoteSignal!}
          busy={false}
          connecting={false}
          notice={null}
          onCancelConnection={() =>
            controller.result.current.cancelRemoteSignalConnect!(saved.trackId)
          }
          onRetry={() => controller.result.current.repairTrack(saved.trackId)}
          onSave={(request) =>
            controller.result.current.editRemoteSignalTrack!(saved.trackId, request)
          }
          onRemove={async () => undefined}
          onClose={() => undefined}
        />
      );
      fireEvent.click(dialog.getByRole('button', { name: 'Edit source…' }));
      fireEvent.change(dialog.getByRole('textbox', { name: 'BigWig path' }), {
        target: { value: editedPath },
      });
      fireEvent.click(dialog.getByRole('button', { name: 'Save and reconnect' }));
      await waitFor(() =>
        expect(data.result.current.tracks[0]?.remoteSignal?.signalPath).toBe(editedPath)
      );
      dialog.unmount();
      expect(data.result.current.tracks[0]?.remoteSignal?.signalPath).toBe(editedPath);
      expect(data.result.current.tracks[0]?.trackId).toBe(saved.trackId);
      const projection = JSON.parse(
        JSON.stringify(data.result.current.tracks[0])
      ) as IndexedGenomeDataTrackState;
      controller.unmount();
      data.unmount();
      act(() => useLaneContractStore.getState().clearOwner('signal-only'));
      reopened = mountSignalOnly(projection);
      await waitFor(() => expect(reopened!.result.current.data.status).toBe('ready'));
      const row = useLaneContractStore.getState().lanesForOwner('signal-only')[0]!;
      expect(row.dataset).toEqual(
        expect.objectContaining({ trackId: saved.trackId, trackPx: 210, color: 0x123456 })
      );
      expect(row.dataset.remoteSignal?.locator.signalPath).toBe(editedPath);
      expect(row.source?.uri).toContain('reopened-edit-source');
      expect(mocks.connect).not.toHaveBeenCalled();
    } finally {
      dialog?.unmount();
      controller.unmount();
      data.unmount();
      reopened?.unmount();
    }
  });

  it('closing a view during an acquired header admission releases the lease and rejects late publication', async () => {
    let finishHeader!: (value: unknown) => void;
    mocks.openBbi.mockReturnValueOnce(
      new Promise((resolve) => {
        finishHeader = resolve;
      })
    );
    mocks.connectSignal.mockResolvedValue(signalMaterialization());
    const hook = mountSignalOnly(savedSignal());
    await waitFor(() => expect(mocks.openBbi).toHaveBeenCalledTimes(1));
    hook.unmount();
    act(() => useLaneContractStore.getState().clearOwner('signal-only'));
    await act(async () =>
      finishHeader({ fileType: 'bigwig', references, zoomReductionLevels: [] })
    );
    await waitFor(() => expect(mocks.disconnect).toHaveBeenCalledWith('independent-lease'));
    expect(useLaneContractStore.getState().lanesForOwner('signal-only')).toEqual([]);
  });

  it('closing a view before connect resolves releases its late lease without restoring any lane', async () => {
    let finishConnect!: (value: unknown) => void;
    mocks.connectSignal.mockReturnValueOnce(
      new Promise((resolve) => {
        finishConnect = resolve;
      })
    );
    const hook = mountSignalOnly(savedSignal());
    await waitFor(() => expect(mocks.connectSignal).toHaveBeenCalledTimes(1));
    hook.unmount();
    act(() => useLaneContractStore.getState().clearOwner('signal-only'));
    await act(async () => finishConnect(signalMaterialization('late-lease', 'late-source')));
    await waitFor(() => expect(mocks.disconnect).toHaveBeenCalledWith('late-lease'));
    expect(mocks.cancel).toHaveBeenCalledWith(expect.any(String));
    expect(mocks.openBbi).not.toHaveBeenCalled();
    expect(useLaneContractStore.getState().lanesForOwner('signal-only')).toEqual([]);
  });

  it('keeps saved descriptors when the owner is cleared during view teardown', () => {
    const saved = savedSignal();
    const hook = mountSignalOnly(saved, []);
    act(() => useLaneContractStore.getState().clearOwner('signal-only'));
    expect(hook.result.current.tracks).toEqual([saved]);
    hook.unmount();
  });

  it('saves the typed locator under the authoritative document schema and rejects runtime fields', () => {
    const saved = savedSignal();
    const base = trackViewFixture();
    const reference = { ...saved.source.referenceReceipt, assemblyId: base.reference.assemblyId };
    const descriptor = {
      ...saved,
      source: {
        ...saved.source,
        assemblyId: base.reference.assemblyId,
        referenceReceipt: reference,
      },
    };
    const document = {
      ...base,
      bamTracks: [],
      dataTracks: [descriptor],
      signalReadPileupViews: [],
    };
    const serialized = serializeTrackViewDocument(document);
    expect(parseTrackViewDocument(serialized).dataTracks).toEqual([descriptor]);
    expect(serialized).not.toMatch(/127\.0\.0\.1|independent-lease|\/tmp\//u);
    expect(() =>
      serializeTrackViewDocument({
        ...document,
        dataTracks: [
          { ...descriptor, remoteSignal: { ...descriptor.remoteSignal, sessionId: 'forbidden' } },
        ],
      })
    ).toThrow();
    expect(() =>
      serializeTrackViewDocument({
        ...document,
        dataTracks: [
          {
            ...descriptor,
            source: { ...descriptor.source, uri: signalMaterialization().bigWigUrl },
          },
        ],
      })
    ).toThrow(/durable SSH signal/u);
    expect(() =>
      serializeTrackViewDocument({
        ...document,
        dataTracks: [
          {
            ...descriptor,
            remoteSignal: { ...descriptor.remoteSignal, signalPath: 'relative.bigWig' },
          },
        ],
      })
    ).toThrow();
  });

  it.each([false, true])(
    'restores the actual saved signal after reads removal = %s without recreating removed reads',
    async (removeReads) => {
      const phase = removeReads ? 'standalone' : 'paired';
      const firstLease = `lease-initial-${phase}`;
      const reopenedLease = `lease-reopened-${phase}`;
      mocks.connect
        .mockResolvedValueOnce(materialization(firstLease, `source-initial-${phase}`))
        .mockResolvedValueOnce(materialization(reopenedLease, `source-reopened-${phase}`));
      const signalMaterialization = materialization(reopenedLease, `source-reopened-${phase}`);
      mocks.connectSignal.mockResolvedValue({
        protocol: signalMaterialization.protocol,
        sessionId: reopenedLease,
        endpoint: signalMaterialization.endpoint,
        locator: {
          contract: 'remote-signal-locator.v1',
          endpointId: locator.endpointId,
          target: locator.target,
          signalPath: locator.signalPath,
        },
        bigWigUrl: signalMaterialization.bigWigUrl,
        generation: { signal: signalMaterialization.generation.signal },
      });
      const initial = mountSources('initial-view', { bamTracks: [remoteTrack], dataTracks: [] });
      let reopened: ReturnType<typeof mountSources> | undefined;
      try {
        await waitFor(() => expect(initial.result.current.bam.status).toBe('ready'));
        const signal = useLaneContractStore
          .getState()
          .lanesForOwner('initial-view')
          .find((lane) => lane.source?.scientificKind === 'quantitative');
        expect(signal).toBeDefined();
        if (removeReads) {
          act(() =>
            useLaneContractStore.getState().removeLane('initial-view', remoteTrack.trackId)
          );
          await waitFor(() => expect(initial.result.current.bamTracks).toHaveLength(0));
          expect(useLaneContractStore.getState().lanesForOwner('initial-view')).toHaveLength(1);
          expect(mocks.disconnect).not.toHaveBeenCalledWith(firstLease);
        }

        const snapshot: SavedSourceProjection = JSON.parse(
          JSON.stringify({
            bamTracks: initial.result.current.bamTracks,
            dataTracks: useLaneContractStore
              .getState()
              .lanesForOwner('initial-view')
              .flatMap((lane) => {
                const descriptor = indexedGenomeDataTrackFromLane(lane);
                return descriptor ? [descriptor] : [];
              }),
          })
        );
        expect(snapshot.dataTracks).toEqual(initial.result.current.dataTracks);
        expect(snapshot.dataTracks).toHaveLength(1);
        expect(snapshot.dataTracks[0]?.remoteSignal).toEqual({
          contract: 'remote-signal-locator.v1',
          endpointId: locator.endpointId,
          target: locator.target,
          signalPath: locator.signalPath,
        });
        expect(JSON.stringify(snapshot)).not.toContain('127.0.0.1');

        initial.unmount();
        act(() => useLaneContractStore.getState().clearOwner('initial-view'));
        await waitFor(() => expect(mocks.disconnect).toHaveBeenCalledWith(firstLease));
        reopened = mountSources('reopened-view', snapshot);
        await waitFor(() => {
          expect(reopened!.result.current.bam.status).toBe('ready');
          expect(reopened!.result.current.data.status).toBe('ready');
        });
        const restoredLanes = useLaneContractStore.getState().lanesForOwner('reopened-view');
        const restoredSignals = restoredLanes.filter(
          (lane) => lane.source?.scientificKind === 'quantitative'
        );
        const restoredReads = restoredLanes.filter((lane) => lane.dataset.kind === 'pileup');
        console.info(
          'standalone signal saved-source result',
          JSON.stringify({
            removeReads,
            savedBamTracks: snapshot.bamTracks.length,
            savedDataTracks: snapshot.dataTracks.length,
            reopenedSignalTracks: restoredSignals.length,
            reopenedReadTracks: restoredReads.length,
            remoteConnects: mocks.connect.mock.calls.length,
            restoreIssues: [
              ...reopened.result.current.bam.issues,
              ...reopened.result.current.data.issues,
            ],
          })
        );
        expect(restoredReads).toHaveLength(removeReads ? 0 : 1);
        expect(
          restoredSignals,
          'Saving a surviving signal must preserve its durable remote source'
        ).toHaveLength(1);
        expect(restoredSignals[0]?.dataset.trackId).toBe(signal!.dataset.trackId);
        expect(restoredSignals[0]?.source?.uri).not.toBe(signal!.source?.uri);
        expect(mocks.connect).toHaveBeenCalledTimes(removeReads ? 1 : 2);
        expect(mocks.connectSignal).toHaveBeenCalledTimes(removeReads ? 1 : 0);
        if (removeReads)
          expect(mocks.connectSignal).toHaveBeenCalledWith({
            requestId: expect.any(String),
            endpointId: locator.endpointId,
            target: locator.target,
            signalPath: locator.signalPath,
          });
      } finally {
        initial.unmount();
        reopened?.unmount();
        act(() => useLaneContractStore.getState().clear());
        if (mocks.connect.mock.calls.length > 1 || mocks.connectSignal.mock.calls.length > 0) {
          await waitFor(() => expect(mocks.disconnect).toHaveBeenCalledWith(reopenedLease));
        }
      }
    }
  );
});
