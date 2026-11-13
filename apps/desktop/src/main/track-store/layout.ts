import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { HARD_CAP_BYTES } from '../../shared/oversized-guard';
import {
  ASSEMBLY_ACCESSION_PATTERN,
  TRACK_CURRENT_FILE,
  TRACK_CURRENT_SCHEMA,
  TRACK_META_FILE,
  TRACK_STORE_DIRECTORY,
  TRACK_VERSION_PATTERN,
  describeTrackSlugProblem,
  parseTrackCurrent,
  parseTrackMeta,
  trackSlugProblem,
  type TrackCurrent,
  type TrackFileText,
  type TrackListing,
  type TrackMeta,
  type TrackRef,
} from '../../shared/track-store';

export class TrackStoreError extends Error {
  constructor(
    readonly code:
      | 'bad-accession'
      | 'bad-track-name'
      | 'bad-version'
      | 'not-found'
      | 'unreadable'
      | 'too-large'
      | 'already-exists',
    message: string
  ) {
    super(message);
    this.name = 'TrackStoreError';
  }
}

export function trackStoreRoot(dataRoot: string): string {
  return join(dataRoot, TRACK_STORE_DIRECTORY);
}

export function assertAccession(accession: string): void {
  if (!ASSEMBLY_ACCESSION_PATTERN.test(accession)) {
    throw new TrackStoreError(
      'bad-accession',
      `"${accession}" is not a versioned accession such as NC_000913.3.`
    );
  }
}

export function assertTrackSlug(track: string): void {
  const problem = trackSlugProblem(track);
  if (problem) throw new TrackStoreError('bad-track-name', describeTrackSlugProblem(problem));
}

function assertVersion(version: string): void {
  if (!TRACK_VERSION_PATTERN.test(version)) {
    throw new TrackStoreError('bad-version', `"${version}" is not a track version.`);
  }
}

export function assemblyDirectory(storeRoot: string, accession: string): string {
  assertAccession(accession);
  return join(storeRoot, accession);
}

export function trackDirectory(storeRoot: string, accession: string, track: string): string {
  assertTrackSlug(track);
  return join(assemblyDirectory(storeRoot, accession), track);
}

export function versionDirectory(
  storeRoot: string,
  accession: string,
  track: string,
  version: string
): string {
  assertVersion(version);
  return join(trackDirectory(storeRoot, accession, track), version);
}

export function versionIdOf(bytes: Uint8Array): string {
  return sha256Hex(bytes).slice(0, 12);
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readJson(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isMissing(error)) throw new TrackStoreError('not-found', `${path} does not exist.`);
    throw new TrackStoreError('unreadable', `${path} could not be read: ${messageOf(error)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new TrackStoreError('unreadable', `${path} is not valid JSON: ${messageOf(error)}`);
  }
}

export async function readCurrent(trackDir: string): Promise<TrackCurrent> {
  const raw = await readJson(join(trackDir, TRACK_CURRENT_FILE));
  try {
    return parseTrackCurrent(raw);
  } catch (error) {
    throw new TrackStoreError(
      'unreadable',
      `${join(trackDir, TRACK_CURRENT_FILE)} is not a ${TRACK_CURRENT_SCHEMA} file: ${messageOf(error)}`
    );
  }
}

export async function readMeta(versionDir: string): Promise<TrackMeta> {
  const raw = await readJson(join(versionDir, TRACK_META_FILE));
  try {
    return parseTrackMeta(raw);
  } catch (error) {
    throw new TrackStoreError(
      'unreadable',
      `${join(versionDir, TRACK_META_FILE)} is not valid track metadata: ${messageOf(error)}`
    );
  }
}

async function listDirectories(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isMissing(error)) return [];
    throw new TrackStoreError('unreadable', `${path} could not be listed: ${messageOf(error)}`);
  }
}

export async function listAssemblies(storeRoot: string): Promise<string[]> {
  return (await listDirectories(storeRoot)).filter((name) => ASSEMBLY_ACCESSION_PATTERN.test(name));
}

export async function listTracks(storeRoot: string, accession: string): Promise<TrackListing[]> {
  const assemblyDir = assemblyDirectory(storeRoot, accession);
  const readTrack = async (track: string): Promise<TrackListing> => {
    const trackDir = join(assemblyDir, track);
    const problems: string[] = [];
    const versions = (await listDirectories(trackDir)).filter((name) =>
      TRACK_VERSION_PATTERN.test(name)
    );
    let current: TrackCurrent | null = null;
    let meta: TrackMeta | null = null;
    try {
      current = await readCurrent(trackDir);
    } catch (error) {
      problems.push(messageOf(error));
    }
    if (current) {
      if (!versions.includes(current.version)) {
        problems.push(`current.json names version ${current.version}, which is not present.`);
      } else {
        try {
          meta = await readMeta(join(trackDir, current.version));
          if (meta.track !== track) {
            problems.push(`meta.json says track "${meta.track}" but the directory is "${track}".`);
            meta = null;
          } else if (meta.assembly.accession !== accession) {
            problems.push(
              `meta.json says assembly ${meta.assembly.accession} but the directory is ${accession}.`
            );
            meta = null;
          }
        } catch (error) {
          problems.push(messageOf(error));
        }
      }
    }
    return { accession, track, current, meta, versions, problems };
  };
  const tracks = (await listDirectories(assemblyDir)).filter(
    (track) => trackSlugProblem(track) === null
  );
  const listings: TrackListing[] = [];
  const batchSize = 4;
  for (let first = 0; first < tracks.length; first += batchSize) {
    const batch = await Promise.allSettled(tracks.slice(first, first + batchSize).map(readTrack));
    for (const listing of batch) {
      if (listing.status === 'rejected') throw listing.reason;
      listings.push(listing.value);
    }
  }
  return listings;
}

async function resolveVersionDirectory(storeRoot: string, ref: TrackRef): Promise<string> {
  const trackDir = trackDirectory(storeRoot, ref.accession, ref.track);
  const version = ref.version ?? (await readCurrent(trackDir)).version;
  return versionDirectory(storeRoot, ref.accession, ref.track, version);
}

export async function readTrackMeta(storeRoot: string, ref: TrackRef): Promise<TrackMeta> {
  return readMeta(await resolveVersionDirectory(storeRoot, ref));
}

export async function readTrackFileText(storeRoot: string, ref: TrackRef): Promise<TrackFileText> {
  const versionDir = await resolveVersionDirectory(storeRoot, ref);
  const meta = await readMeta(versionDir);
  const path = join(versionDir, meta.file.name);
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (error) {
    if (isMissing(error)) throw new TrackStoreError('not-found', `${path} does not exist.`);
    throw new TrackStoreError('unreadable', `${path} could not be read: ${messageOf(error)}`);
  }
  if (size > HARD_CAP_BYTES) {
    throw new TrackStoreError(
      'too-large',
      `${path} is ${size} bytes; the renderer reads track files up to ${HARD_CAP_BYTES} bytes.`
    );
  }
  return { meta, path, text: await readFile(path, 'utf8') };
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
  const text = `${JSON.stringify(value, null, 2)}\n`;
  try {
    await writeFile(temporary, text, 'utf8');
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function writeCurrent(
  storeRoot: string,
  ref: Required<TrackRef>,
  input: { readonly selectedAt: string; readonly reason?: string }
): Promise<TrackCurrent> {
  const trackDir = trackDirectory(storeRoot, ref.accession, ref.track);
  assertVersion(ref.version);
  const current: TrackCurrent = {
    schema: TRACK_CURRENT_SCHEMA,
    version: ref.version,
    selectedAt: input.selectedAt,
    ...(input.reason ? { reason: input.reason } : {}),
  };
  await mkdir(trackDir, { recursive: true });
  await writeJsonAtomic(join(trackDir, TRACK_CURRENT_FILE), current);
  return current;
}

export async function writeVersion(
  storeRoot: string,
  meta: TrackMeta,
  bytes: Uint8Array
): Promise<string> {
  const expectedVersion = versionIdOf(bytes);
  if (meta.version !== expectedVersion) {
    throw new TrackStoreError(
      'bad-version',
      `meta.json names version ${meta.version} but the file's bytes give ${expectedVersion}.`
    );
  }
  const versionDir = versionDirectory(storeRoot, meta.assembly.accession, meta.track, meta.version);
  if (await exists(versionDir)) {
    throw new TrackStoreError('already-exists', `${versionDir} already exists.`);
  }
  const staging = `${versionDir}.${process.pid}.staging`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    await writeFile(join(staging, meta.file.name), bytes);
    await writeFile(join(staging, TRACK_META_FILE), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
    await rename(staging, versionDir);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return versionDir;
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
