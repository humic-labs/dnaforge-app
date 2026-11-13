import { app } from 'electron';
import { registerTrackStoreIpcHandlers, seedTrackStoreAtStartup } from '../ipc/track-store';
import {
  initializeTrackStore,
  resolveDnaforgeDataRoot,
  resolveTrackResourceRoot,
} from '../track-store';
import type { MainFeature } from './main-feature';

function prepareTrackStore(): void {
  initializeTrackStore({
    dataRoot: resolveDnaforgeDataRoot({
      platform: process.platform,
      env: process.env,
      home: app.getPath('home'),
    }),
    resourceRoot: resolveTrackResourceRoot({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
    }),
  });
  seedTrackStoreAtStartup();
}

export const trackStoreFeature: MainFeature = {
  id: 'track-store',
  prepare: prepareTrackStore,
  registerIpc: () => {
    registerTrackStoreIpcHandlers();
    return () => undefined;
  },
};
