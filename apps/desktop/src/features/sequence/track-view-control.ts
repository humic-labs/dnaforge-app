import type { Tab } from '../canvas/public/types';
import { useCanvasStore } from '../canvas/public/store';
import { TrackViewSession } from './track-view-session';
import type {
  TrackViewDocument,
  SaveTrackViewRequest,
  SavedTrackView,
} from '../../shared/track-view';
import type {
  IndexedGenomeBamTrackState,
  IndexedGenomeDataTrackState,
} from '../../shared/indexed-genome';

export type TrackViewSnapshot = Omit<
  TrackViewDocument,
  'schema' | 'kind' | 'id' | 'name' | 'createdAt' | 'updatedAt' | 'dataTracks' | 'bamTracks'
> & { dataTracks: IndexedGenomeDataTrackState[]; bamTracks: IndexedGenomeBamTrackState[] };

export interface TrackViewControl {
  inspect(): {
    revision: string;
    document: TrackViewSnapshot & { name: string };
    savedRevision: string | null;
    path: string | null;
    workspaceRoot: string | null;
    dirty: boolean;
  };
  save(request: {
    name: string;
    mode: 'save' | 'rename' | 'copy';
    expectedRevision: string;
    destination?: SaveTrackViewRequest['destination'];
  }): Promise<
    | { ok: true; saved: SavedTrackView; dirty: boolean; warning?: string }
    | { ok: false; error: string }
  >;
}
const sessions = new Map<string, TrackViewSession>();
function supportsTrackView(tab: Tab | undefined) {
  return (
    tab?.type === 'sequence' &&
    Boolean(tab.trackView || tab.indexedGenome || tab.sequenceDocument?.kind === 'indexed-sequence')
  );
}
function findTab(tabId: string) {
  return Object.values(useCanvasStore.getState().panels)
    .flatMap((panel) => panel.tabs)
    .find((tab) => tab.id === tabId);
}
useCanvasStore.subscribe(() => {
  for (const [tabId, session] of sessions) {
    const tab = findTab(tabId);
    if (tab && supportsTrackView(tab)) session.receiveTab(tab);
    else {
      sessions.delete(tabId);
      session.dispose();
    }
  }
});
export function getTrackViewSession(tabId: string) {
  const tab = findTab(tabId);
  if (!tab || !supportsTrackView(tab)) return null;
  let session = sessions.get(tabId);
  if (!session) {
    session = new TrackViewSession(tab);
    sessions.set(tabId, session);
  }
  return session;
}
export function getTrackViewControl(tabId: string): TrackViewControl | null {
  return getTrackViewSession(tabId);
}
