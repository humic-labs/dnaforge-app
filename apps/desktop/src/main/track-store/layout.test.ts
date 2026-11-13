import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TRACK_META_SCHEMA, type TrackMeta } from '../../shared/track-store';
import {
  TrackStoreError,
  listAssemblies,
  listTracks,
  readTrackFileText,
  readTrackMeta,
  sha256Hex,
  versionIdOf,
  writeCurrent,
  writeVersion,
} from './layout';

const ACCESSION = 'NC_000913.3';
const GFF3 = new TextEncoder().encode(
  '##gff-version 3\n##sequence-region NC_000913.3 1 4641652\nNC_000913.3\ttest\tterminator\t100\t130\t.\t+\t.\tID=t:1\n'
);

function metaFor(bytes: Uint8Array, overrides: Partial<TrackMeta> = {}): TrackMeta {
  return {
    schema: TRACK_META_SCHEMA,
    track: 'test-terminators',
    version: versionIdOf(bytes),
    assembly: { accession: ACCESSION, lengthBp: 4_641_652 },
    file: {
      name: 'test-terminators.gff3',
      format: 'gff3',
      sha256: sha256Hex(bytes),
      byteLength: bytes.byteLength,
    },
    residency: { kind: 'managed' },
    kinds: ['terminator'],
    label: 'Test terminators',
    evidence: 'measured',
    license: { spdx: 'CC0-1.0', attribution: 'Test data' },
    ...overrides,
  };
}

describe('track store layout', () => {
  let storeRoot: string;
  beforeEach(async () => {
    storeRoot = join(await mkdtemp(join(tmpdir(), 'track-store-')), 'tracks');
  });
  afterEach(async () => {
    await rm(join(storeRoot, '..'), { recursive: true, force: true });
  });

  it('names a version by the first 12 hex digits of the file digest', () => {
    expect(versionIdOf(GFF3)).toMatch(/^[0-9a-f]{12}$/);
    expect(versionIdOf(GFF3)).toBe(sha256Hex(GFF3).slice(0, 12));
  });

  it('writes an immutable version directory and a live pointer, then reads them back', async () => {
    const meta = metaFor(GFF3);
    const versionDir = await writeVersion(storeRoot, meta, GFF3);
    expect(versionDir).toBe(join(storeRoot, ACCESSION, 'test-terminators', meta.version));
    await writeCurrent(
      storeRoot,
      { accession: ACCESSION, track: 'test-terminators', version: meta.version },
      { selectedAt: '2026-09-17T10:00:00.000Z', reason: 'test' }
    );

    expect(await listAssemblies(storeRoot)).toEqual([ACCESSION]);
    const [listing] = await listTracks(storeRoot, ACCESSION);
    expect(listing).toMatchObject({
      accession: ACCESSION,
      track: 'test-terminators',
      current: { version: meta.version, reason: 'test' },
      meta: { label: 'Test terminators' },
      versions: [meta.version],
      problems: [],
    });
    const file = await readTrackFileText(storeRoot, {
      accession: ACCESSION,
      track: 'test-terminators',
    });
    expect(file.text).toBe(new TextDecoder().decode(GFF3));
    expect(file.path).toBe(join(versionDir, 'test-terminators.gff3'));
    expect(
      await readTrackMeta(storeRoot, { accession: ACCESSION, track: 'test-terminators' })
    ).toEqual(meta);
    expect(JSON.parse(await readFile(join(versionDir, 'meta.json'), 'utf8'))).toEqual(meta);
  });

  it('refuses a version whose name does not match the bytes, and never overwrites one', async () => {
    const meta = metaFor(GFF3);
    await expect(
      writeVersion(storeRoot, { ...meta, version: '000000000000' }, GFF3)
    ).rejects.toThrow(/names version 000000000000 but the file's bytes give/);
    await writeVersion(storeRoot, meta, GFF3);
    await expect(writeVersion(storeRoot, meta, GFF3)).rejects.toMatchObject({
      code: 'already-exists',
    });
  });

  it('rejects names that cannot be directories before touching the disk', async () => {
    const meta = metaFor(GFF3);
    for (const track of ['', 'Bad Name', '../escape', 'con', 'a'.repeat(49)]) {
      await expect(writeVersion(storeRoot, { ...meta, track }, GFF3)).rejects.toBeInstanceOf(
        TrackStoreError
      );
    }
    await expect(listTracks(storeRoot, 'not-an-accession')).rejects.toMatchObject({
      code: 'bad-accession',
    });
    await expect(
      readTrackMeta(storeRoot, { accession: ACCESSION, track: 'test-terminators', version: 'xyz' })
    ).rejects.toMatchObject({ code: 'bad-version' });
  });

  it('lists a broken track with its problems instead of hiding it', async () => {
    const meta = metaFor(GFF3);
    await writeVersion(storeRoot, meta, GFF3);
    let [listing] = await listTracks(storeRoot, ACCESSION);
    expect(listing.current).toBeNull();
    expect(listing.problems[0]).toMatch(/current\.json does not exist/);

    await writeCurrent(
      storeRoot,
      { accession: ACCESSION, track: 'test-terminators', version: 'abcdefabcdef' },
      { selectedAt: '2026-09-17T10:00:00.000Z' }
    );
    [listing] = await listTracks(storeRoot, ACCESSION);
    expect(listing.meta).toBeNull();
    expect(listing.problems).toEqual([
      'current.json names version abcdefabcdef, which is not present.',
    ]);

    const otherDir = join(storeRoot, ACCESSION, 'renamed-by-hand', meta.version);
    await mkdir(otherDir, { recursive: true });
    await writeFile(join(otherDir, 'meta.json'), JSON.stringify(meta));
    await writeFile(join(otherDir, meta.file.name), GFF3);
    await writeCurrent(
      storeRoot,
      { accession: ACCESSION, track: 'renamed-by-hand', version: meta.version },
      { selectedAt: '2026-09-17T10:00:00.000Z' }
    );
    const renamed = (await listTracks(storeRoot, ACCESSION)).find(
      (t) => t.track === 'renamed-by-hand'
    );
    expect(renamed?.meta).toBeNull();
    expect(renamed?.problems).toEqual([
      'meta.json says track "test-terminators" but the directory is "renamed-by-hand".',
    ]);
  });

  it('ignores directories that are not accessions, tracks or versions', async () => {
    await mkdir(join(storeRoot, 'notes'), { recursive: true });
    await mkdir(join(storeRoot, ACCESSION, 'Bad Name'), { recursive: true });
    await mkdir(join(storeRoot, ACCESSION, 'ok-track', 'scratch'), { recursive: true });
    expect(await listAssemblies(storeRoot)).toEqual([ACCESSION]);
    const listings = await listTracks(storeRoot, ACCESSION);
    expect(listings.map((t) => t.track)).toEqual(['ok-track']);
    expect(listings[0].versions).toEqual([]);
  });

  it('returns nothing, not an error, for a store that does not exist yet', async () => {
    expect(await listAssemblies(join(storeRoot, 'missing'))).toEqual([]);
    expect(await listTracks(join(storeRoot, 'missing'), ACCESSION)).toEqual([]);
  });
});
