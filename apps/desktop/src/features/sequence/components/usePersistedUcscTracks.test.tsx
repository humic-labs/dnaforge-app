import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IndexedGenomeDataTrackState } from '../../../shared/indexed-genome';
import { useLaneContractStore } from '../lane-contract-store';
import { usePersistedDataTracks } from './usePersistedUcscTracks';

const VALID_TRACK: IndexedGenomeDataTrackState = {
  trackId: 'ucsc:hg38-gc5BaseBw',
  trackType: 'quantitative',
  label: 'GC Percent',
  order: 0,
  color: 0x3b82f6,
  trackPx: 160,
  laneHeightPx: 8,
  maxLanes: 32,
  visible: true,
  quantitativePresentation: {
    version: 1,
    graph: 'bar',
    showRange: true,
    smoothingSigmaBins: 1,
    scale: { mode: 'robust-global', transform: 'linear' },
  },
  source: {
    admissionVersion: 1,
    uri: 'https://example.org/gc5Base.bw',
    formatId: 'bigwig',
    readerKind: 'bbi',
    scientificKind: 'quantitative',
    quantitativeColumnSemantics: 'continuous-signal',
    assemblyId: 'grch38',
    referenceReceipt: {
      assemblyId: 'grch38',
      referenceSignature: 'grch38',
      sourceSignature: 'gc5BaseBw',
      contigMap: { chr1: 'chr1' },
      checkedContigs: 1,
      status: 'compatible',
      checkedAt: '2026-07-28T00:00:00.000Z',
    },
    provenance: {
      provider: 'ucsc',
      sourceKind: 'ucsc-native',
      catalogId: 'hg38:gc5BaseBw',
      ucscGenome: 'hg38',
      track: 'gc5BaseBw',
      label: 'GC Percent',
    },
    fingerprint: 'ucsc-native\u0000hg38\u0000gc5BaseBw\u0000',
  },
};

describe('usePersistedDataTracks', () => {
  beforeEach(() => {
    useLaneContractStore.getState().clear();
  });

  it('contains and prunes one malformed descriptor while restoring valid tracks', async () => {
    const malformed = {
      ...VALID_TRACK,
      trackId: 'ucsc:hg38-broken',
      label: 'Broken signal',
      trackPx: Number.NaN,
    };
    let persisted: readonly IndexedGenomeDataTrackState[] = [VALID_TRACK, malformed];
    const onChange = vi.fn(
      (
        update: (
          previous: readonly IndexedGenomeDataTrackState[]
        ) => readonly IndexedGenomeDataTrackState[]
      ) => {
        persisted = update(persisted);
      }
    );

    const { result } = renderHook(() =>
      usePersistedDataTracks({
        laneOwnerId: 'tab',
        assemblyId: 'grch38',
        persistedTracks: persisted,
        onChange,
      })
    );

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.issues).toEqual([
      {
        trackId: 'ucsc:hg38-broken',
        label: 'Broken signal',
        message: 'Persisted data track Broken signal has an invalid track height.',
      },
    ]);
    expect(
      useLaneContractStore
        .getState()
        .lanesForOwner('tab')
        .map((lane) => lane.dataset.trackId)
    ).toEqual(['ucsc:hg38-gc5BaseBw']);
    await waitFor(() => expect(persisted).toEqual([VALID_TRACK]));
  });

  it('reports and prunes a valid descriptor from a different assembly', async () => {
    const wrongAssembly = {
      ...VALID_TRACK,
      source: {
        ...VALID_TRACK.source,
        assemblyId: 'ce11',
        referenceReceipt: {
          ...VALID_TRACK.source.referenceReceipt,
          assemblyId: 'ce11',
        },
        provenance: {
          ...VALID_TRACK.source.provenance,
          ucscGenome: 'ce11',
        },
      },
    };
    let persisted: readonly IndexedGenomeDataTrackState[] = [wrongAssembly];
    const onChange = vi.fn(
      (
        update: (
          previous: readonly IndexedGenomeDataTrackState[]
        ) => readonly IndexedGenomeDataTrackState[]
      ) => {
        persisted = update(persisted);
      }
    );

    const { result } = renderHook(() =>
      usePersistedDataTracks({
        laneOwnerId: 'tab',
        assemblyId: 'grch38',
        persistedTracks: persisted,
        onChange,
      })
    );

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.issues).toEqual([
      expect.objectContaining({
        trackId: VALID_TRACK.trackId,
        message: expect.stringContaining('belongs to assembly ce11, not grch38'),
      }),
    ]);
    expect(useLaneContractStore.getState().lanesForOwner('tab')).toEqual([]);
    await waitFor(() => expect(persisted).toEqual([]));
  });
});
