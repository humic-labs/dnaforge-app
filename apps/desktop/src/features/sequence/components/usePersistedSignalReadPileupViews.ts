import { useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { IndexedGenomeSignalReadPileupViewState } from '../../../shared/indexed-genome';
import {
  indexedGenomeSignalReadPileupViewFromLane,
  indexedGenomeSignalReadPileupViewsEqual,
  laneFromIndexedGenomeSignalReadPileupView,
} from '../experimental-hybrid-pileup';
import { useLaneContractStore, type Lane } from '../lane-contract-store';

const EMPTY_LANES: readonly Lane[] = [];

export interface SignalReadPileupViewRestoreIssue {
  readonly trackId: string;
  readonly label: string;
  readonly message: string;
}

export type PersistedSignalReadPileupViewUpdater = (
  previous: readonly IndexedGenomeSignalReadPileupViewState[]
) => readonly IndexedGenomeSignalReadPileupViewState[];

export function usePersistedSignalReadPileupViews({
  laneOwnerId,
  assemblyId,
  persistedViews,
  sourcesReady,
  onChange,
}: {
  laneOwnerId: string;
  assemblyId: string;
  persistedViews: readonly IndexedGenomeSignalReadPileupViewState[];
  sourcesReady: boolean;
  onChange: (update: PersistedSignalReadPileupViewUpdater) => void;
}): {
  status: 'waiting-for-sources' | 'restoring' | 'ready';
  issues: readonly SignalReadPileupViewRestoreIssue[];
} {
  const ownedLanes = useLaneContractStore(
    (state) => state.lanesByOwnerId[laneOwnerId] ?? EMPTY_LANES
  );
  const addLane = useLaneContractStore((state) => state.addLane);
  const replaceLaneDataset = useLaneContractStore((state) => state.replaceLaneDataset);
  const persistedRef = useRef(persistedViews);
  persistedRef.current = persistedViews;
  const unresolvedViewsRef = useRef<readonly IndexedGenomeSignalReadPileupViewState[]>([]);
  const restoredSourcePairsRef = useRef(new Set<string>());
  const restoreContextRef = useRef('');
  const restoreContext = `${laneOwnerId}\u0000${assemblyId}`;
  if (restoreContextRef.current !== restoreContext) {
    restoreContextRef.current = restoreContext;
    unresolvedViewsRef.current = [];
    restoredSourcePairsRef.current = new Set();
  }
  const persistedIdentity = useMemo(() => JSON.stringify(persistedViews), [persistedViews]);
  const sourceAvailabilityIdentity = useMemo(
    () =>
      JSON.stringify(
        ownedLanes.flatMap((lane) => {
          if (lane.dataset.experimentalHybrid) return [];
          return [
            {
              trackId: lane.dataset.trackId,
              kind: lane.dataset.kind,
              trackType: lane.dataset.trackType,
              pileupSource: lane.dataset.source
                ? {
                    admissionError: lane.dataset.source.admissionError ?? null,
                    remoteSessionId: lane.dataset.source.remote?.sessionId ?? null,
                  }
                : null,
              admittedSource: lane.source
                ? {
                    formatId: lane.source.formatId,
                    scientificKind: lane.source.scientificKind,
                    fingerprint: lane.source.fingerprint,
                  }
                : null,
            },
          ];
        })
      ),
    [ownedLanes]
  );
  const [status, setStatus] = useState<'waiting-for-sources' | 'restoring' | 'ready'>(
    sourcesReady ? (persistedViews.length > 0 ? 'restoring' : 'ready') : 'waiting-for-sources'
  );
  const [issues, setIssues] = useState<readonly SignalReadPileupViewRestoreIssue[]>([]);

  useLayoutEffect(() => {
    const snapshot = uniqueViewsBySourcePair(persistedRef.current);
    setIssues([]);
    if (snapshot.length === 0) {
      unresolvedViewsRef.current = [];
      setStatus(sourcesReady ? 'ready' : 'waiting-for-sources');
      return;
    }
    setStatus(sourcesReady ? 'restoring' : 'waiting-for-sources');
    const nextIssues: SignalReadPileupViewRestoreIssue[] = [];
    const unresolved: IndexedGenomeSignalReadPileupViewState[] = [];
    for (const persisted of snapshot) {
      const pair = viewSourcePair(persisted);
      let sourceLanes = useLaneContractStore.getState().lanesForOwner(laneOwnerId);
      const existing = sourceLanes.find((lane) => laneSourcePair(lane) === pair);
      if (existing && !existing.dataset.experimentalHybrid?.waitingForSources) {
        restoredSourcePairsRef.current.add(pair);
        continue;
      }
      if (existing) {
        const existingHybrid = existing.dataset.experimentalHybrid;
        if (!existingHybrid) continue;
        try {
          const resolvedLane = laneFromIndexedGenomeSignalReadPileupView(
            persisted,
            assemblyId,
            sourceLanes
          );
          replaceLaneDataset(
            laneOwnerId,
            resolvedLane.dataset.trackId,
            assemblyId,
            resolvedLane.dataset,
            resolvedLane.source
          );
          restoredSourcePairsRef.current.add(pair);
        } catch (error) {
          unresolved.push(persisted);
          if (sourcesReady) {
            const issue = viewRestoreIssue(persisted, error);
            nextIssues.push(issue);
            replaceLaneDataset(
              laneOwnerId,
              existing.dataset.trackId,
              assemblyId,
              {
                ...existing.dataset,
                experimentalHybrid: {
                  ...existingHybrid,
                  sourceError: issue.message,
                },
              },
              existing.source
            );
          }
        }
        continue;
      }
      if (restoredSourcePairsRef.current.has(pair)) continue;
      try {
        let lane = laneFromIndexedGenomeSignalReadPileupView(persisted, assemblyId, sourceLanes, {
          allowPendingSignal: true,
        });
        if (lane.dataset.experimentalHybrid?.waitingForSources && sourcesReady) {
          const issue = viewRestoreIssue(
            persisted,
            new Error(
              `Signal-to-reads view ${persisted.label} has no admitted quantitative signal.`
            )
          );
          nextIssues.push(issue);
          lane = {
            ...lane,
            dataset: {
              ...lane.dataset,
              experimentalHybrid: {
                ...lane.dataset.experimentalHybrid,
                sourceError: issue.message,
              },
            },
          };
        }
        addLane(laneOwnerId, assemblyId, lane.dataset, lane.visible, undefined, lane.order, 'skip');
        sourceLanes = useLaneContractStore.getState().lanesForOwner(laneOwnerId);
        const restoredLane = sourceLanes.find((candidate) => laneSourcePair(candidate) === pair);
        if (!restoredLane) {
          throw new Error(
            `Signal-to-reads view ${persisted.label} conflicts with an existing track identity.`
          );
        }
        if (restoredLane.dataset.experimentalHybrid?.waitingForSources) {
          unresolved.push(persisted);
        } else {
          restoredSourcePairsRef.current.add(pair);
        }
      } catch (error) {
        unresolved.push(persisted);
        if (sourcesReady) {
          nextIssues.push(viewRestoreIssue(persisted, error));
        }
      }
    }
    unresolvedViewsRef.current = unresolved;
    setIssues(nextIssues);
    setStatus(sourcesReady ? 'ready' : 'waiting-for-sources');
  }, [
    addLane,
    assemblyId,
    laneOwnerId,
    persistedIdentity,
    replaceLaneDataset,
    sourceAvailabilityIdentity,
    sourcesReady,
  ]);

  useLayoutEffect(() => {
    if (status !== 'ready') return;
    const live = useLaneContractStore
      .getState()
      .lanesForOwner(laneOwnerId)
      .flatMap((lane) => {
        const descriptor = indexedGenomeSignalReadPileupViewFromLane(lane);
        return descriptor ? [descriptor] : [];
      });
    const livePairs = new Set(live.map(viewSourcePair));
    const desired = uniqueViewsBySourcePair([
      ...live,
      ...unresolvedViewsRef.current.filter((view) => !livePairs.has(viewSourcePair(view))),
    ]);
    onChange((previous) =>
      indexedGenomeSignalReadPileupViewsEqual(previous, desired) ? previous : desired
    );
  }, [laneOwnerId, onChange, ownedLanes, status]);

  return { status, issues };
}

function viewRestoreIssue(
  persisted: IndexedGenomeSignalReadPileupViewState,
  error: unknown
): SignalReadPileupViewRestoreIssue {
  return {
    trackId: typeof persisted?.trackId === 'string' ? persisted.trackId : '',
    label:
      typeof persisted?.label === 'string' && persisted.label.trim().length > 0
        ? persisted.label
        : 'Signal + reads',
    message: error instanceof Error ? error.message : String(error),
  };
}

function viewSourcePair(view: IndexedGenomeSignalReadPileupViewState): string {
  return `${view.readsTrackId}\u0000${view.signalTrackId}`;
}

function laneSourcePair(lane: Lane): string | null {
  const hybrid = lane.dataset.experimentalHybrid;
  return hybrid ? `${hybrid.alignmentTrackId}\u0000${hybrid.quantitativeTrackId}` : null;
}

function uniqueViewsBySourcePair(
  views: readonly IndexedGenomeSignalReadPileupViewState[]
): IndexedGenomeSignalReadPileupViewState[] {
  const pairs = new Set<string>();
  return views.filter((view) => {
    const pair = viewSourcePair(view);
    if (pairs.has(pair)) return false;
    pairs.add(pair);
    return true;
  });
}
