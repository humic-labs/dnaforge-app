import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { assemblyAccession, parseGff3Track } from '@waypoint/genome-data/annotation-catalog';
import { describe, expect, it } from 'vitest';

import { parseTrackCurrent, parseTrackMeta } from '../../shared/track-store';
import { sha256Hex, versionIdOf } from './layout';

const ACCESSION = 'NC_000913.3';
const BUNDLED = resolve(__dirname, '../../../resources/tracks', ACCESSION);

const EXPECTED_COUNTS: Readonly<Record<string, number>> = {
  'adams2021-intrinsic-terminators': 125,
  'adams2021-rho-termination': 1078,
  'ettwiller2016-tss': 16_352,
  'termite-ecoli-terminators': 1069,
  'transtermhp-terminators': 1441,
  'yan2018-transcription-units': 631,
  'yan2018-tss': 2567,
  'yan2018-unit-gene-lists': 3055,
  'yan2018-unit-gene-lists-merged': 2335,
};

async function loadBundled(track: string) {
  const trackDir = join(BUNDLED, track);
  const current = parseTrackCurrent(
    JSON.parse(await readFile(join(trackDir, 'current.json'), 'utf8'))
  );
  const versionDir = join(trackDir, current.version);
  const metaJson = JSON.parse(await readFile(join(versionDir, 'meta.json'), 'utf8')) as {
    recordCount: number;
    countsByKind: Record<string, number>;
  };
  const meta = parseTrackMeta(metaJson);
  const bytes = new Uint8Array(await readFile(join(versionDir, meta.file.name)));
  const text = new TextDecoder().decode(bytes);
  const parsed = parseGff3Track({
    text,
    track,
    assembly: {
      accession: assemblyAccession(meta.assembly.accession),
      lengthBp: meta.assembly.lengthBp,
    },
    aliases: meta.assembly.aliases,
    kinds: meta.kinds.filter(
      (kind): kind is 'promoter' | 'terminator' | 'tss' | 'transcription_unit' =>
        kind === 'promoter' ||
        kind === 'terminator' ||
        kind === 'tss' ||
        kind === 'transcription_unit'
    ),
  });
  return { current, meta, metaJson, bytes, text, parsed };
}

describe('bundled tracks', () => {
  it('ships exactly the nine MG1655 sources', async () => {
    const tracks = (await readdir(BUNDLED, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(tracks).toEqual(Object.keys(EXPECTED_COUNTS).sort());
  });

  for (const [track, count] of Object.entries(EXPECTED_COUNTS)) {
    it(`${track}: version, checksum and every record survive the round trip`, async () => {
      const { current, meta, metaJson, bytes, parsed } = await loadBundled(track);
      expect(meta.track).toBe(track);
      expect(meta.assembly).toEqual({
        accession: ACCESSION,
        lengthBp: 4_641_652,
        aliases: ['U00096.3'],
      });
      expect(meta.residency).toEqual({ kind: 'managed' });
      expect(meta.file.format).toBe('gff3');
      expect(meta.file.sha256).toBe(sha256Hex(bytes));
      expect(meta.file.byteLength).toBe(bytes.byteLength);
      expect(meta.version).toBe(versionIdOf(bytes));
      expect(current.version).toBe(meta.version);
      expect(current.selectedAt).toBeUndefined();
      expect(meta.license.attribution.length).toBeGreaterThan(20);
      expect(meta.provenance?.producedBy?.tool).toMatch(/^scripts\/annotation-datasets\//);

      expect(parsed.rejected).toEqual({ count: 0, examples: [] });
      expect(parsed.skipped).toBe(0);
      expect(parsed.records).toHaveLength(count);
      expect(metaJson.recordCount).toBe(count);
      const byKind: Record<string, number> = {};
      for (const record of parsed.records) byKind[record.kind] = (byKind[record.kind] ?? 0) + 1;
      expect(byKind).toEqual(metaJson.countsByKind);
      for (const record of parsed.records) expect(record.id.startsWith(`${track}:`)).toBe(true);
    });
  }

  it('keeps the measured ends the sources published, and only those', async () => {
    const measured = async (track: string) =>
      (await loadBundled(track)).parsed.records.some(
        (record) => record.kind === 'terminator' && record.terminationBp !== null
      );
    expect(await measured('termite-ecoli-terminators')).toBe(true);
    expect(await measured('adams2021-intrinsic-terminators')).toBe(true);
    expect(await measured('transtermhp-terminators')).toBe(false);
    expect(await measured('adams2021-rho-termination')).toBe(false);
    const rho = (await loadBundled('adams2021-rho-termination')).parsed.records;
    expect(rho.every((record) => record.kind === 'terminator' && record.peakBp !== null)).toBe(
      true
    );
  });

  it('keeps hairpin parts, comma-bearing names and conditions, and gene lists intact', async () => {
    const termite = (await loadBundled('termite-ecoli-terminators')).parsed.records;
    const withParts = termite.filter(
      (record) => record.kind === 'terminator' && record.parts.length === 4
    );
    expect(withParts.length).toBeGreaterThan(1000);
    expect(termite.every((record) => record.conditions.length >= 1)).toBe(true);
    expect(termite.some((record) => record.conditions.some((c) => c.includes(',')))).toBe(true);

    const intrinsic = (await loadBundled('adams2021-intrinsic-terminators')).parsed.records;
    expect(intrinsic.every((record) => record.location.shape === 'point')).toBe(true);
    const rho = (await loadBundled('adams2021-rho-termination')).parsed.records;
    expect(rho.some((record) => record.name?.includes(', '))).toBe(true);

    const units = (await loadBundled('yan2018-unit-gene-lists-merged')).parsed.records;
    const multi = units.filter(
      (record) => record.kind === 'transcription_unit' && record.genes.length > 1
    );
    expect(multi.length).toBe(1264);
    expect(
      units.every(
        (record) =>
          record.kind === 'transcription_unit' &&
          record.geneLocusTags.length === record.genes.length &&
          record.endEvidence === 'gene-derived'
      )
    ).toBe(true);
  });
});
