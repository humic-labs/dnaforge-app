import { useEffect, useRef } from 'react';

import type { IndexedGenomeVariantSourceState } from '../../../shared/indexed-genome';
import { useLaneContractStore, type Lane } from '../lane-contract-store';
import { laneFromVariantSource, variantTrackId } from '../variant-track-lane';

const EMPTY_LANES: readonly Lane[] = [];

export function usePersistedVariantTrack({
  laneOwnerId,
  assemblyId,
  source,
  onChange,
}: {
  readonly laneOwnerId: string;
  readonly assemblyId: string;
  readonly source: IndexedGenomeVariantSourceState | null;
  readonly onChange: (source: IndexedGenomeVariantSourceState | null) => void;
}): void {
  const ownedLanes = useLaneContractStore(
    (state) => state.lanesByOwnerId[laneOwnerId] ?? EMPTY_LANES
  );
  const addLane = useLaneContractStore((state) => state.addLane);
  const replaceLaneDataset = useLaneContractStore((state) => state.replaceLaneDataset);
  const removeLane = useLaneContractStore((state) => state.removeLane);
  const previousTrackIdRef = useRef<string | null>(null);
  const observedProjectedLaneRef = useRef(false);

  useEffect(() => {
    const previousTrackId = previousTrackIdRef.current;
    if (!source?.admittedSource) {
      if (previousTrackId) removeLane(laneOwnerId, previousTrackId);
      previousTrackIdRef.current = null;
      observedProjectedLaneRef.current = false;
      return;
    }

    const lane = laneFromVariantSource(source, assemblyId);
    if (previousTrackId && previousTrackId !== lane.dataset.trackId) {
      removeLane(laneOwnerId, previousTrackId);
      observedProjectedLaneRef.current = false;
    }
    const replaced = replaceLaneDataset(
      laneOwnerId,
      lane.dataset.trackId,
      assemblyId,
      lane.dataset,
      lane.source
    );
    if (replaced === 'missing') {
      addLane(laneOwnerId, assemblyId, lane.dataset, lane.visible, lane.source, undefined, 'skip');
    }
    previousTrackIdRef.current = lane.dataset.trackId;
  }, [addLane, assemblyId, laneOwnerId, removeLane, replaceLaneDataset, source]);

  useEffect(() => {
    if (!source?.admittedSource) {
      observedProjectedLaneRef.current = false;
      return;
    }
    const trackId = variantTrackId(source);
    if (ownedLanes.some((lane) => lane.dataset.trackId === trackId)) {
      observedProjectedLaneRef.current = true;
      return;
    }
    if (previousTrackIdRef.current !== trackId || !observedProjectedLaneRef.current) return;
    observedProjectedLaneRef.current = false;
    previousTrackIdRef.current = null;
    onChange(null);
  }, [onChange, ownedLanes, source]);
}
