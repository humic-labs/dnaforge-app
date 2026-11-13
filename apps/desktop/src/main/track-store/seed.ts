import { existsSync } from 'node:fs';
import { cp, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  ASSEMBLY_ACCESSION_PATTERN,
  TRACK_CURRENT_FILE,
  TRACK_VERSION_PATTERN,
  parseTrackCurrent,
  trackSlugProblem,
} from '../../shared/track-store';
import { exists, readMeta, trackDirectory, versionDirectory, writeCurrent } from './layout';

export function resolveTrackResourceRoot(input: {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly appPath: string;
}): string {
  if (input.isPackaged) return join(input.resourcesPath, 'tracks');
  const candidates = [
    join(input.appPath, 'resources/tracks'),
    resolve(input.appPath, '../../resources/tracks'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

export interface SeedResult {
  readonly seeded: number;
  readonly present: number;
  readonly problems: readonly string[];
}

export async function seedTrackStore(input: {
  readonly resourceRoot: string;
  readonly storeRoot: string;
  readonly now: () => Date;
}): Promise<SeedResult> {
  let seeded = 0;
  let present = 0;
  const problems: string[] = [];
  for (const accession of await directories(input.resourceRoot)) {
    if (!ASSEMBLY_ACCESSION_PATTERN.test(accession)) continue;
    const assemblyResourceDir = join(input.resourceRoot, accession);
    for (const track of await directories(assemblyResourceDir)) {
      if (trackSlugProblem(track) !== null) continue;
      const trackResourceDir = join(assemblyResourceDir, track);
      for (const version of await directories(trackResourceDir)) {
        if (!TRACK_VERSION_PATTERN.test(version)) continue;
        const source = join(trackResourceDir, version);
        try {
          const meta = await readMeta(source);
          if (meta.track !== track || meta.assembly.accession !== accession) {
            problems.push(`${source}: meta.json does not match its directory; not seeded.`);
            continue;
          }
          const destination = versionDirectory(input.storeRoot, accession, track, version);
          if (await exists(destination)) {
            present += 1;
          } else {
            await cp(source, destination, { recursive: true, errorOnExist: true, force: false });
            seeded += 1;
          }
        } catch (error) {
          problems.push(`${source}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      try {
        await seedCurrent(input, accession, track, trackResourceDir);
      } catch (error) {
        problems.push(
          `${trackResourceDir}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }
  return { seeded, present, problems };
}

async function seedCurrent(
  input: { readonly storeRoot: string; readonly now: () => Date },
  accession: string,
  track: string,
  trackResourceDir: string
): Promise<void> {
  const storeTrackDir = trackDirectory(input.storeRoot, accession, track);
  if (await exists(join(storeTrackDir, TRACK_CURRENT_FILE))) return;
  const bundledCurrentPath = join(trackResourceDir, TRACK_CURRENT_FILE);
  if (!(await exists(bundledCurrentPath))) return;
  const bundled = parseTrackCurrent(JSON.parse(await readFile(bundledCurrentPath, 'utf8')));
  if (!(await exists(versionDirectory(input.storeRoot, accession, track, bundled.version)))) {
    throw new Error(`bundled current.json names version ${bundled.version}, which was not seeded.`);
  }
  await writeCurrent(
    input.storeRoot,
    { accession, track, version: bundled.version },
    { selectedAt: input.now().toISOString(), reason: 'Bundled with DNAForge' }
  );
}

async function directories(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return [];
    throw error;
  }
}
