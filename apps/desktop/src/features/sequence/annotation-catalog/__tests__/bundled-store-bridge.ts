import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  parseTrackCurrent,
  parseTrackMeta,
  type TrackListing,
  type TrackMeta,
  type TrackRef,
  type TrackStoreBridge,
} from '../../../../shared/track-store';

export const BUNDLED_TRACKS_ROOT = resolve(__dirname, '../../../../../resources/tracks');

async function directories(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

async function listing(root: string, accession: string, track: string): Promise<TrackListing> {
  const trackDir = join(root, accession, track);
  const current = parseTrackCurrent(await readJson(join(trackDir, 'current.json')));
  const meta = parseTrackMeta(await readJson(join(trackDir, current.version, 'meta.json')));
  return {
    accession,
    track,
    current,
    meta,
    versions: (await directories(trackDir)).filter((name) => /^[0-9a-f]{12}$/.test(name)),
    problems: [],
  };
}

async function metaFor(
  root: string,
  ref: TrackRef
): Promise<{ meta: TrackMeta; versionDir: string }> {
  const trackDir = join(root, ref.accession, ref.track);
  const version =
    ref.version ?? parseTrackCurrent(await readJson(join(trackDir, 'current.json'))).version;
  const versionDir = join(trackDir, version);
  return { meta: parseTrackMeta(await readJson(join(versionDir, 'meta.json'))), versionDir };
}

export function bundledStoreBridge(root: string = BUNDLED_TRACKS_ROOT): TrackStoreBridge {
  return {
    root: async () => root,
    listAssemblies: () => directories(root),
    listTracks: async (accession) =>
      Promise.all(
        (await directories(join(root, accession))).map((track) => listing(root, accession, track))
      ),
    readMeta: async (ref) => (await metaFor(root, ref)).meta,
    readTrackFile: async (ref) => {
      const { meta, versionDir } = await metaFor(root, ref);
      const path = join(versionDir, meta.file.name);
      return { meta, path, text: await readFile(path, 'utf8') };
    },
    refresh: async () => ({ seeded: 0 }),
  };
}

export function bundledTrackNames(accession: string): Promise<string[]> {
  return directories(join(BUNDLED_TRACKS_ROOT, accession));
}
