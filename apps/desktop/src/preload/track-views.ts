import { rendererIpc } from '../shared/ipc-contract';
import type { TrackViewsBridge } from '../shared/track-view';

export const trackViewsPreloadBridge: TrackViewsBridge = {
  locations: () => rendererIpc.invoke('trackViews:locations'),
  list: () => rendererIpc.invoke('trackViews:list'),
  read: (id) => rendererIpc.invoke('trackViews:read', id),
  save: (request) => rendererIpc.invoke('trackViews:save', request),
};
