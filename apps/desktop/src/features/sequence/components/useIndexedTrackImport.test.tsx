import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { directTrackAdmissionRequest, type TrackAdmissionRequestV1 } from '@waypoint/genome-data';

import { useLaneContractStore } from '../lane-contract-store';
import { admitTrackSource } from '../track-admission';
import { useIndexedTrackImport } from './useIndexedTrackImport';

vi.mock('../track-admission', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../track-admission')>()),
  admitTrackSource: vi.fn(),
}));

const GENOME = {
  laneOwnerId: 'tab-1',
  assemblyId: 'grch38',
  assemblyDisplayName: 'GRCh38',
  assemblyReferences: [{ name: 'chr1', length: 1_000 }],
};

function admittedSource(request: TrackAdmissionRequestV1) {
  if (request.source.kind !== 'local-file' && request.source.kind !== 'http') {
    throw new Error('Test expected a direct source.');
  }
  const source =
    request.source.kind === 'local-file'
      ? { kind: 'path' as const, path: request.source.path }
      : { kind: 'url' as const, url: request.source.url };
  const locator = source.kind === 'path' ? source.path : source.url;
  const isBigBed = request.formatId === 'bigbed';
  return {
    admissionVersion: 2 as const,
    request,
    admittedAt: '2026-08-17T00:00:00.000Z',
    uri: source.kind === 'path' ? `file://${locator}` : locator,
    input: source,
    formatId: isBigBed ? ('bigbed' as const) : ('bigwig' as const),
    recommendedTypes: [isBigBed ? 'peak' : 'quantitative'],
    fingerprint: `generation:${locator}`,
    readerKind: 'bbi' as const,
    scientificKind: isBigBed ? ('peak' as const) : ('quantitative' as const),
    assemblyId: GENOME.assemblyId,
    referenceReceipt: {
      assemblyId: GENOME.assemblyId,
      referenceSignature: 'chr1',
      sourceSignature: 'chr1',
      contigMap: { chr1: 'chr1' },
      checkedContigs: 1,
      status: 'compatible' as const,
      checkedAt: '2026-08-17T00:00:00.000Z',
    },
    provenance: {
      provider: source.kind === 'path' ? ('local-file' as const) : ('direct-url' as const),
      sourceKind: source.kind === 'path' ? ('local-file' as const) : ('remote-url' as const),
      label: 'signal.bigWig',
    },
  };
}

describe('useIndexedTrackImport', () => {
  beforeEach(() => {
    useLaneContractStore.getState().clear();
    vi.mocked(admitTrackSource)
      .mockReset()
      .mockImplementation(async ({ request }) => admittedSource(request));
  });

  it('attaches local workflow outputs without copying them', async () => {
    const { result } = renderHook(() => useIndexedTrackImport(GENOME));

    await act(async () =>
      result.current.addBigWigFiles(['/analysis/run1/plus.bigWig', '/analysis/run1/minus.bw'])
    );

    expect(vi.mocked(admitTrackSource)).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        request: expect.objectContaining({
          source: { kind: 'local-file', path: '/analysis/run1/plus.bigWig' },
          ingress: { kind: 'file-picker' },
        }),
      })
    );
    const lanes = useLaneContractStore.getState().lanesForOwner(GENOME.laneOwnerId);
    expect(lanes.map((lane) => lane.dataset.label)).toEqual(['plus.bigWig', 'minus.bw']);
    expect(lanes.map((lane) => lane.dataset.trackPx)).toEqual([96, 96]);
    expect(lanes.map((lane) => lane.source?.input)).toEqual([
      { kind: 'path', path: '/analysis/run1/plus.bigWig' },
      { kind: 'path', path: '/analysis/run1/minus.bw' },
    ]);
    expect(result.current.notice).toEqual({ kind: 'success', text: 'Added 2 data tracks.' });
  });

  it('attaches a direct URL and deduplicates the same workflow endpoint', async () => {
    const { result } = renderHook(() => useIndexedTrackImport(GENOME));
    const url = 'https://results.example.org/run/signal.bigWig';
    const request = directTrackAdmissionRequest({
      assemblyId: GENOME.assemblyId,
      input: { kind: 'url', url },
      formatId: 'bigwig',
      ingress: 'url',
      label: 'RNA-seq coverage',
    });

    await act(async () =>
      expect(result.current.addRequests([request])).resolves.toMatchObject([
        { status: 'added', label: 'RNA-seq coverage' },
      ])
    );
    await act(async () =>
      expect(result.current.addRequests([request])).resolves.toMatchObject([
        { status: 'duplicate', label: 'RNA-seq coverage' },
      ])
    );

    expect(vi.mocked(admitTrackSource)).toHaveBeenCalledTimes(1);
    expect(useLaneContractStore.getState().lanesForOwner(GENOME.laneOwnerId)).toEqual([
      expect.objectContaining({ dataset: expect.objectContaining({ label: 'RNA-seq coverage' }) }),
    ]);
    expect(result.current.notice).toEqual({
      kind: 'warn',
      text: 'Already added: RNA-seq coverage.',
    });
  });

  it('attaches a BigBed URL with explicit scientific interpretation', async () => {
    const { result } = renderHook(() => useIndexedTrackImport(GENOME));
    const url = 'https://results.example.org/run/accessibility.bb';

    await act(async () =>
      expect(
        result.current.addRequests([
          directTrackAdmissionRequest({
            assemblyId: GENOME.assemblyId,
            input: { kind: 'url', url },
            formatId: 'bigbed',
            scientificKind: 'peak',
            ingress: 'url',
            label: 'Accessible peaks',
          }),
        ])
      ).resolves.toMatchObject([{ status: 'added', label: 'Accessible peaks' }])
    );

    expect(admitTrackSource).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          formatId: 'bigbed',
          scientificKind: 'peak',
          ingress: { kind: 'url' },
        }),
      })
    );
    expect(
      useLaneContractStore.getState().lanesForOwner(GENOME.laneOwnerId)[0]?.dataset
    ).toMatchObject({
      trackType: 'peak',
      label: 'Accessible peaks',
      trackPx: 72,
    });
  });

  it('keeps manifest provenance on the same generic attachment path', async () => {
    const { result } = renderHook(() => useIndexedTrackImport(GENOME));

    await act(async () => {
      await result.current.addRequests([
        {
          contract: 'dnaforge.track-admission-request.v1',
          assemblyId: 'grch38',
          source: { kind: 'http', url: 'https://results.example.org/run/signal.bigWig' },
          formatId: 'bigwig',
          ingress: { kind: 'manifest', manifestId: 'outputs.dnaforge-tracks.json' },
        },
      ]);
    });

    expect(admitTrackSource).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          ingress: { kind: 'manifest', manifestId: 'outputs.dnaforge-tracks.json' },
        }),
      })
    );
  });
});
