// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseGff3Line } from '@waypoint/genome-data';
import { resolveSplicedFeatures } from './spliced-feature-resolver';
import { isMaterializedFixtureFile } from '../../../test/fixture-availability';

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    try {
      readFileSync(resolve(dir, 'Cargo.toml'));
      return dir;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error('cannot locate worktree root from test file');
}

function canonicalGff3Path(fixtureDir: string, basename: string): string {
  return resolve(repoRoot(), 'test-fixtures/indexed', fixtureDir, `${basename}.gff3.gz`);
}

function readCanonicalGff3(fixtureDir: string, basename: string): string {
  const path = canonicalGff3Path(fixtureDir, basename);
  return gunzipSync(readFileSync(path)).toString('utf-8');
}

describe('canonical fixture roundtrip — pUC19', () => {
  const text = readCanonicalGff3('pUC19', 'pUC19');
  const lines = text.split('\n');

  it('emits the four documented pragmas as the first lines', () => {
    expect(lines[0]).toBe('##gff-version 3');
    expect(lines[1]).toMatch(/^##dna-indexer-version /);
    expect(lines[2]).toBe('##dna-indexer-schema 2');
    expect(lines[3]).toBe('##dna-indexer-topology circular');
  });

  it('parses every data row through the production GFF3 parser', () => {
    const dataLines = lines.filter((l) => l && !l.startsWith('##'));
    for (const line of dataLines) {
      const feature = parseGff3Line(line);
      expect(feature).not.toBeNull();
      expect(feature!.chrom).toBe('puc19');
      expect(feature!.attributes.ID).toBeDefined();
    }
    expect(
      dataLines.map((line) => {
        const feature = parseGff3Line(line)!;
        return {
          type: feature.type,
          label: feature.attributes.label?.[0] ?? null,
          start: feature.start,
          end: feature.end,
          strand: feature.strand,
        };
      })
    ).toEqual([
      { type: 'source', label: null, start: 0, end: 2686, strand: '+' },
      { type: 'CDS', label: 'lacZ-alpha', start: 145, end: 469, strand: '-' },
      { type: 'primer_bind', label: 'M13 fwd', start: 378, end: 395, strand: '+' },
      { type: 'misc_feature', label: 'MCS', start: 395, end: 452, strand: '+' },
      { type: 'primer_bind', label: 'M13 rev', start: 464, end: 481, strand: '-' },
      { type: 'protein_bind', label: 'lac operator', start: 488, end: 505, strand: '-' },
      { type: 'rep_origin', label: 'ori', start: 865, end: 866, strand: '+' },
      { type: 'CDS', label: 'AmpR', start: 1625, end: 2486, strand: '-' },
    ]);
  });

  it('every row has a parseable strand from the canonical column set', () => {
    const dataLines = lines.filter((l) => l && !l.startsWith('##'));
    for (const line of dataLines) {
      const cols = line.split('\t');
      expect(cols.length).toBe(9);
      expect(['+', '-', '.']).toContain(cols[6]);
      expect(cols[1]).toBe('DNAForge');
    }
  });

  it('produces resolver-clean output when fed through resolveSplicedFeatures', () => {
    const features = lines
      .filter((l) => l && !l.startsWith('##'))
      .map((l) => parseGff3Line(l))
      .filter((f): f is NonNullable<ReturnType<typeof parseGff3Line>> => f !== null);
    const resolved = resolveSplicedFeatures(features);

    expect(resolved).toHaveLength(features.length);
    expect(resolved).toEqual(features);
    for (const r of resolved) {
      expect(r.attributes.ID?.[0]).toBeTruthy();
      expect(r.chrom).toBe('puc19');
      expect(r.segments).toBeUndefined();
    }
    const source = resolved.find((f) => f.type === 'source');
    expect(source).toBeDefined();
    expect(source!.start).toBe(0);
    expect(source!.end).toBe(2686);
  });
});

const YEAST_CHR_IV_GFF3 = canonicalGff3Path('yeast-chrIV', 'chrIV');
const describeYeast = isMaterializedFixtureFile(YEAST_CHR_IV_GFF3) ? describe : describe.skip;

describeYeast('canonical fixture roundtrip — yeast chrIV (linear, real chromosome)', () => {
  it('emits topology=linear (not circular)', () => {
    const text = readCanonicalGff3('yeast-chrIV', 'chrIV');
    const topology = text.split('\n').find((l) => l.startsWith('##dna-indexer-topology'));
    expect(topology).toBe('##dna-indexer-topology linear');
  });
});
