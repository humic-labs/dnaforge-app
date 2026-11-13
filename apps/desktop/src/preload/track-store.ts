import { rendererIpc } from '../shared/ipc-contract';
import type { TrackStoreBridge } from '../shared/track-store';

export const trackStorePreloadBridge: TrackStoreBridge = {
  root: () => rendererIpc.invoke('trackStore:root'),
  listAssemblies: () => rendererIpc.invoke('trackStore:listAssemblies'),
  listTracks: (accession) => rendererIpc.invoke('trackStore:listTracks', accession),
  readMeta: (ref) => rendererIpc.invoke('trackStore:readMeta', ref),
  readTrackFile: (ref) => rendererIpc.invoke('trackStore:readTrackFile', ref),
  refresh: () => rendererIpc.invoke('trackStore:refresh'),
};
