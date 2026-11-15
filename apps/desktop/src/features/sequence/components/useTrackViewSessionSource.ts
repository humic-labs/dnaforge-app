import { useLayoutEffect, useMemo } from 'react';
import type { Tab } from '../../canvas/public/types';
import { getTrackViewSession } from '../track-view-control';
import type { TrackViewSource } from '../track-view-session';
import { useLaneContractStore } from '../lane-contract-store';

export function useTrackViewSessionSource(tab: Tab, source: TrackViewSource) {
  const session = useMemo(() => getTrackViewSession(tab.id), [tab.id, tab.entityId]);
  const token = useMemo(() => Symbol(tab.id), [tab.id]);
  useLaneContractStore((state) => state.lanesByOwnerId[tab.id]);
  useLayoutEffect(() => {
    session?.attachSource(token, source);
  });
  useLayoutEffect(() => () => session?.detachSource(token), [session, token]);
  return session;
}
