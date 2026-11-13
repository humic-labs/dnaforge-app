import { trackStoreRoot } from './layout';

export { DNAFORGE_DATA_ROOT_ENV, resolveDnaforgeDataRoot } from './data-root';
export {
  TrackStoreError,
  listAssemblies,
  listTracks,
  readTrackFileText,
  readTrackMeta,
  trackStoreRoot,
  versionIdOf,
  writeCurrent,
  writeVersion,
} from './layout';
export { resolveTrackResourceRoot, seedTrackStore } from './seed';

interface TrackStoreLocations {
  readonly dataRoot: string;
  readonly storeRoot: string;
  readonly resourceRoot: string;
}

let locations: TrackStoreLocations | null = null;

export function initializeTrackStore(input: {
  readonly dataRoot: string;
  readonly resourceRoot: string;
}): TrackStoreLocations {
  locations = {
    dataRoot: input.dataRoot,
    storeRoot: trackStoreRoot(input.dataRoot),
    resourceRoot: input.resourceRoot,
  };
  return locations;
}

export function trackStoreLocations(): TrackStoreLocations {
  if (!locations) throw new Error('The track store has not been initialized.');
  return locations;
}

export function resetTrackStoreForTests(): void {
  locations = null;
}

export function trackStoreEnv(): { readonly DNAFORGE_DATA_ROOT?: string } {
  return locations ? { DNAFORGE_DATA_ROOT: locations.dataRoot } : {};
}
