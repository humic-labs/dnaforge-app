import { mainIpc } from '../../shared/ipc-contract';
import type { TrackRef } from '../../shared/track-store';
import {
  listAssemblies,
  listTracks,
  readTrackFileText,
  readTrackMeta,
  seedTrackStore,
  trackStoreLocations,
} from '../track-store';

let seeding: Promise<{ seeded: number }> | null = null;

function ensureSeeded(): Promise<{ seeded: number }> {
  if (!seeding) {
    seeding = seedOnce().catch((error: unknown) => {
      seeding = null;
      throw error;
    });
  }
  return seeding;
}

async function seedOnce(): Promise<{ seeded: number }> {
  const { storeRoot, resourceRoot } = trackStoreLocations();
  const result = await seedTrackStore({ resourceRoot, storeRoot, now: () => new Date() });
  for (const problem of result.problems) {
    console.warn('[TrackStore] bundled track not seeded:', problem);
  }
  if (result.seeded > 0) {
    console.info(`[TrackStore] seeded ${result.seeded} bundled track version(s) into ${storeRoot}`);
  }
  return { seeded: result.seeded };
}

export function seedTrackStoreAtStartup(): void {
  void ensureSeeded().catch((error: unknown) => {
    console.error('[TrackStore] seeding bundled tracks failed', error);
  });
}

export function registerTrackStoreIpcHandlers(): void {
  mainIpc.handle('trackStore:root', async () => trackStoreLocations().storeRoot);
  mainIpc.handle('trackStore:listAssemblies', async () => {
    await ensureSeeded();
    return listAssemblies(trackStoreLocations().storeRoot);
  });
  mainIpc.handle('trackStore:listTracks', async (_event, accession: string) => {
    await ensureSeeded();
    return listTracks(trackStoreLocations().storeRoot, accession);
  });
  mainIpc.handle('trackStore:readMeta', async (_event, ref: TrackRef) => {
    await ensureSeeded();
    return readTrackMeta(trackStoreLocations().storeRoot, ref);
  });
  mainIpc.handle('trackStore:readTrackFile', async (_event, ref: TrackRef) => {
    await ensureSeeded();
    return readTrackFileText(trackStoreLocations().storeRoot, ref);
  });
  mainIpc.handle('trackStore:refresh', async () => {
    seeding = null;
    return ensureSeeded();
  });
}
