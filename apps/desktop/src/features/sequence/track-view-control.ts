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
const controls = new Map<string, TrackViewControl>();
export function registerTrackViewControl(tabId: string, control: TrackViewControl) {
  controls.set(tabId, control);
  return () => {
    if (controls.get(tabId) === control) controls.delete(tabId);
  };
}
export function getTrackViewControl(tabId: string) {
  return controls.get(tabId) ?? null;
}
