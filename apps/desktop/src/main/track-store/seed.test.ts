import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TRACK_CURRENT_SCHEMA, TRACK_META_SCHEMA, type TrackMeta } from '../../shared/track-store';
import { listTracks, sha256Hex, versionIdOf, writeCurrent } from './layout';
import { resolveTrackResourceRoot, seedTrackStore } from './seed';

const ACCESSION = 'NC_000913.3';
const NOW = () => new Date('2026-09-17T12:00:00.000Z');

async function bundle(resourceRoot: string, track: string, text: string, current = true) {
  const bytes = new TextEncoder().encode(text);
  const version = versionIdOf(bytes);
  const meta: TrackMeta = {
    schema: TRACK_META_SCHEMA,
    track,
    version,
    assembly: { accession: ACCESSION, lengthBp: 4_641_652 },
    file: {
      name: `${track}.gff3`,
      format: 'gff3',
      sha256: sha256Hex(bytes),
      byteLength: bytes.byteLength,
    },
    residency: { kind: 'managed' },
    kinds: ['terminator'],
    label: track,
    evidence: 'measured',
    license: { attribution: 'test' },
  };
  const dir = join(resourceRoot, ACCESSION, track, version);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'meta.json'), JSON.stringify(meta));
  await writeFile(join(dir, meta.file.name), bytes);
  if (current) {
    await writeFile(
      join(resourceRoot, ACCESSION, track, 'current.json'),
      JSON.stringify({ schema: TRACK_CURRENT_SCHEMA, version, selectedAt: '2026-01-01T00:00:00Z' })
    );
  }
  return { version, meta };
}

describe('seeding the track store from bundled resources', () => {
  let base: string;
  let resourceRoot: string;
  let storeRoot: string;
  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'track-seed-'));
    resourceRoot = join(base, 'resources', 'tracks');
    storeRoot = join(base, 'store', 'tracks');
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('copies each bundled version once and points current at it', async () => {
    const a = await bundle(resourceRoot, 'alpha', 'a\n');
    await bundle(resourceRoot, 'beta', 'b\n');
    const first = await seedTrackStore({ resourceRoot, storeRoot, now: NOW });
    expect(first).toEqual({ seeded: 2, present: 0, problems: [] });

    const listings = await listTracks(storeRoot, ACCESSION);
    expect(listings.map((t) => [t.track, t.current?.version, t.problems])).toEqual([
      ['alpha', a.version, []],
      ['beta', expect.any(String), []],
    ]);
    expect(listings[0].current).toMatchObject({
      selectedAt: '2026-09-17T12:00:00.000Z',
      reason: 'Bundled with DNAForge',
    });
    expect(
      await readFile(join(storeRoot, ACCESSION, 'alpha', a.version, 'alpha.gff3'), 'utf8')
    ).toBe('a\n');

    const second = await seedTrackStore({ resourceRoot, storeRoot, now: NOW });
    expect(second).toEqual({ seeded: 0, present: 2, problems: [] });
  });

  it("keeps the user's current selection when a newer bundled version arrives", async () => {
    const old = await bundle(resourceRoot, 'alpha', 'old\n');
    await seedTrackStore({ resourceRoot, storeRoot, now: NOW });
    await writeCurrent(
      storeRoot,
      { accession: ACCESSION, track: 'alpha', version: old.version },
      { selectedAt: '2026-09-17T13:00:00.000Z', reason: 'I chose this one' }
    );

    await rm(join(resourceRoot, ACCESSION, 'alpha'), { recursive: true });
    const fresh = await bundle(resourceRoot, 'alpha', 'new\n');
    const result = await seedTrackStore({ resourceRoot, storeRoot, now: NOW });
    expect(result).toEqual({ seeded: 1, present: 0, problems: [] });

    const [listing] = await listTracks(storeRoot, ACCESSION);
    expect(listing.versions).toEqual([old.version, fresh.version].sort());
    expect(listing.current).toMatchObject({ version: old.version, reason: 'I chose this one' });
  });

  it('reports a bundle whose metadata disagrees with its directory, and one whose current names a missing version', async () => {
    const bad = await bundle(resourceRoot, 'alpha', 'a\n');
    const badMetaPath = join(resourceRoot, ACCESSION, 'alpha', bad.version, 'meta.json');
    await writeFile(badMetaPath, JSON.stringify({ ...bad.meta, track: 'beta' }));
    await bundle(resourceRoot, 'gamma', 'g\n', false);
    await writeFile(
      join(resourceRoot, ACCESSION, 'gamma', 'current.json'),
      JSON.stringify({
        schema: TRACK_CURRENT_SCHEMA,
        version: '000000000000',
        selectedAt: '2026-01-01T00:00:00Z',
      })
    );

    const result = await seedTrackStore({ resourceRoot, storeRoot, now: NOW });
    expect(result.seeded).toBe(1);
    expect(result.problems).toEqual([
      expect.stringMatching(/alpha.*meta\.json does not match its directory/),
      expect.stringMatching(/alpha.*bundled current\.json names version .* which was not seeded/),
      expect.stringMatching(/gamma.*names version 000000000000, which was not seeded/),
    ]);
  });

  it('does nothing when there are no bundled tracks', async () => {
    expect(await seedTrackStore({ resourceRoot, storeRoot, now: NOW })).toEqual({
      seeded: 0,
      present: 0,
      problems: [],
    });
  });

  it('finds bundled tracks in a packaged build and in a checkout', () => {
    expect(
      resolveTrackResourceRoot({
        isPackaged: true,
        resourcesPath: '/App/Contents/Resources',
        appPath: '/x',
      })
    ).toBe('/App/Contents/Resources/tracks');
    expect(
      resolveTrackResourceRoot({
        isPackaged: false,
        resourcesPath: '/unused',
        appPath: '/repo/apps/desktop',
      })
    ).toBe('/repo/apps/desktop/resources/tracks');
  });
});
