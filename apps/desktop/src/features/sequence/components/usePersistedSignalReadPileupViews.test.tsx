import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IndexedGenomeSignalReadPileupViewState } from '../../../shared/indexed-genome';
import { useLaneContractStore, type ActiveStressDataset } from '../lane-contract-store';
import { usePersistedSignalReadPileupViews } from './usePersistedSignalReadPileupViews';

const READS: ActiveStressDataset = {
  kind: 'pileup',
  trackType: 'pileup-genomewide',
  trackId: 'reads',
  label: 'GRCh38: reads.bam',
  color: 0xa8ceff,
  laneHeightPx: 3,
  maxLanes: 80,
  overflowBandHeightPx: 36,
  trackPx: 276,
  records: [],
  source: { bamPath: '/run/reads.bam', indexPath: '/run/reads.bam.bai' },
};

const SIGNAL: ActiveStressDataset = {
  kind: 'annotation',
  trackType: 'quantitative',
  trackId: 'signal',
  label: 'coverage.bigWig',
  color: 0xa8ceff,
  laneHeightPx: 8,
  maxLanes: 32,
  trackPx: 96,
  records: [],
};

const VIEW: IndexedGenomeSignalReadPileupViewState = {
  contract: 'dnaforge.signal-read-pileup-view.v1',
  trackId: 'combined',
  readsTrackId: 'reads',
  signalTrackId: 'signal',
  label: 'Coverage to reads',
  order: 2,
  visible: true,
  color: 0xa8ceff,
  trackPx: 276,
  laneHeightPx: 3,
  maxLanes: 80,
  overflowBandHeightPx: 36,
  coverageCutoffDepth: 80,
  loadingAnimation: 'diagonal-scan',
};

describe('usePersistedSignalReadPileupViews', () => {
  beforeEach(() => {
    useLaneContractStore.getState().clear();
    useLaneContractStore.getState().addLane('tab', 'grch38', READS, true);
    useLaneContractStore.getState().addLane('tab', 'grch38', SIGNAL, true);
  });

  it('restores the composition as soon as both lanes exist and keeps it durable', async () => {
    let persisted: readonly IndexedGenomeSignalReadPileupViewState[] = [VIEW];
    const onChange = vi.fn((update) => {
      persisted = update(persisted);
    });
    const { result, rerender } = renderHook(
      ({ ready }) =>
        usePersistedSignalReadPileupViews({
          laneOwnerId: 'tab',
          assemblyId: 'grch38',
          persistedViews: persisted,
          sourcesReady: ready,
          onChange,
        }),
      { initialProps: { ready: false } }
    );

    expect(result.current.status).toBe('waiting-for-sources');
    expect(useLaneContractStore.getState().lanesForOwner('tab')).toHaveLength(3);
    expect(
      useLaneContractStore
        .getState()
        .lanesForOwner('tab')
        .find((lane) => lane.dataset.trackId === 'combined')?.dataset.experimentalHybrid
        ?.waitingForSources
    ).toBeUndefined();
    rerender({ ready: true });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(
      useLaneContractStore
        .getState()
        .lanesForOwner('tab')
        .map((lane) => lane.dataset.trackId)
    ).toEqual(['reads', 'signal', 'combined']);
    await waitFor(() => expect(persisted).toEqual([VIEW]));
  });

  it.each([true, false])(
    'keeps the saved cross-family row order when a signal arrives late (visible=%s)',
    async (visible) => {
      const store = () => useLaneContractStore.getState();
      store().clear();
      store().addLane('tab', 'grch38', READS, true, undefined, 1, 'skip');
      store().addLane(
        'tab',
        'grch38',
        { ...SIGNAL, trackId: 'notes', trackType: 'interval' },
        false,
        undefined,
        3,
        'skip'
      );
      const saved = { ...VIEW, visible };
      let persisted: readonly IndexedGenomeSignalReadPileupViewState[] = [saved];
      const onChange = vi.fn((update) => {
        persisted = update(persisted);
      });
      const { result, rerender } = renderHook(
        ({ ready }) =>
          usePersistedSignalReadPileupViews({
            laneOwnerId: 'tab',
            assemblyId: 'grch38',
            persistedViews: persisted,
            sourcesReady: ready,
            onChange,
          }),
        { initialProps: { ready: false } }
      );
      expect(
        store()
          .lanesForOwner('tab')
          .find((lane) => lane.dataset.trackId === 'combined')?.dataset.experimentalHybrid
          ?.waitingForSources
      ).toBe(true);
      act(() => {
        store().addLane('tab', 'grch38', SIGNAL, true, undefined, 0, 'skip');
      });
      rerender({ ready: true });
      await waitFor(() => expect(result.current.status).toBe('ready'));
      expect(
        store()
          .lanesForOwner('tab')
          .map((lane) => ({
            id: lane.dataset.trackId,
            order: lane.order,
          }))
      ).toEqual([
        { id: 'signal', order: 0 },
        { id: 'reads', order: 1 },
        { id: 'combined', order: 2 },
        { id: 'notes', order: 3 },
      ]);
      expect(persisted).toEqual([saved]);
      expect(
        store()
          .lanesForOwner('tab')
          .find((lane) => lane.dataset.trackId === 'combined')?.visible
      ).toBe(visible);
      expect(store().canUndoLaneChange('tab')).toBe(false);
    }
  );

  it('keeps a visible composition shell while its BigWig source is still restoring', async () => {
    useLaneContractStore.getState().removeLane('tab', 'signal');
    const { result } = renderHook(() =>
      usePersistedSignalReadPileupViews({
        laneOwnerId: 'tab',
        assemblyId: 'grch38',
        persistedViews: [VIEW],
        sourcesReady: false,
        onChange: vi.fn(),
      })
    );

    await waitFor(() =>
      expect(
        useLaneContractStore
          .getState()
          .lanesForOwner('tab')
          .find((lane) => lane.dataset.trackId === 'combined')?.dataset.experimentalHybrid
          ?.waitingForSources
      ).toBe(true)
    );
    expect(result.current.status).toBe('waiting-for-sources');
    expect(result.current.issues).toEqual([]);

    act(() => {
      useLaneContractStore.getState().addLane('tab', 'grch38', SIGNAL, true, undefined, 1, 'skip');
    });

    await waitFor(() =>
      expect(
        useLaneContractStore
          .getState()
          .lanesForOwner('tab')
          .find((lane) => lane.dataset.trackId === 'combined')?.dataset.experimentalHybrid
          ?.waitingForSources
      ).toBeUndefined()
    );
    expect(result.current.issues).toEqual([]);
  });

  it('normalizes legacy and current IDs that describe the same source pair', async () => {
    const duplicate = { ...VIEW, trackId: 'combined-new', label: 'A second copy' };
    let persisted: readonly IndexedGenomeSignalReadPileupViewState[] = [VIEW, duplicate];
    const onChange = vi.fn((update) => {
      persisted = update(persisted);
    });
    const { result } = renderHook(() =>
      usePersistedSignalReadPileupViews({
        laneOwnerId: 'tab',
        assemblyId: 'grch38',
        persistedViews: persisted,
        sourcesReady: true,
        onChange,
      })
    );

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(
      useLaneContractStore
        .getState()
        .lanesForOwner('tab')
        .filter((lane) => lane.dataset.experimentalHybrid)
        .map((lane) => lane.dataset.trackId)
    ).toEqual(['combined']);
    await waitFor(() => expect(persisted).toEqual([VIEW]));
  });

  it('persists an intentional source deletion and does not resurrect the combined lane', async () => {
    let persisted: readonly IndexedGenomeSignalReadPileupViewState[] = [VIEW];
    const onChange = vi.fn((update) => {
      persisted = update(persisted);
    });
    const { result } = renderHook(() =>
      usePersistedSignalReadPileupViews({
        laneOwnerId: 'tab',
        assemblyId: 'grch38',
        persistedViews: persisted,
        sourcesReady: true,
        onChange,
      })
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await waitFor(() =>
      expect(
        useLaneContractStore
          .getState()
          .lanesForOwner('tab')
          .some((lane) => lane.dataset.trackId === 'combined')
      ).toBe(true)
    );

    act(() => {
      useLaneContractStore.getState().removeLane('tab', 'signal');
    });

    await waitFor(() => expect(persisted).toEqual([]));
    expect(
      useLaneContractStore
        .getState()
        .lanesForOwner('tab')
        .some((lane) => lane.dataset.trackId === 'combined')
    ).toBe(false);
    act(() => {
      useLaneContractStore.getState().addLane('tab', 'grch38', SIGNAL, true, undefined, 1, 'skip');
    });
    expect(
      useLaneContractStore
        .getState()
        .lanesForOwner('tab')
        .some((lane) => lane.dataset.trackId === 'combined')
    ).toBe(false);
  });

  it('preserves and automatically restores a composition whose signal source arrives late', async () => {
    useLaneContractStore.getState().removeLane('tab', 'signal');
    let persisted: readonly IndexedGenomeSignalReadPileupViewState[] = [VIEW];
    const onChange = vi.fn((update) => {
      persisted = update(persisted);
    });
    const { result } = renderHook(() =>
      usePersistedSignalReadPileupViews({
        laneOwnerId: 'tab',
        assemblyId: 'grch38',
        persistedViews: persisted,
        sourcesReady: true,
        onChange,
      })
    );

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.issues).toEqual([
      expect.objectContaining({
        trackId: 'combined',
        message: 'Signal-to-reads view Coverage to reads has no admitted quantitative signal.',
      }),
    ]);
    expect(persisted).toEqual([VIEW]);

    act(() => {
      useLaneContractStore.getState().addLane('tab', 'grch38', SIGNAL, true, undefined, 1, 'skip');
    });

    await waitFor(() => {
      expect(
        useLaneContractStore
          .getState()
          .lanesForOwner('tab')
          .map((lane) => lane.dataset.trackId)
      ).toEqual(['reads', 'signal', 'combined']);
    });
    await waitFor(() => expect(result.current.issues).toEqual([]));
    expect(persisted).toEqual([VIEW]);
  });
});
