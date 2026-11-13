import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DEFAULT_CYTOBAND_STAIN_COLORS,
  cytoBandStainColor,
  filterCytoBandsInRange,
  parseCytoBandTsv,
  type CytoBand,
} from './cytoband';

const GRCH38_CYTOBANDS = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'test-fixtures',
  'cytobands',
  'hg38-cytoBand-grch38.tsv'
);

describe('parseCytoBandTsv — tolerance and strictness', () => {
  it('parses a minimal valid row', () => {
    const result = parseCytoBandTsv('chr11\t0\t100\tp1\tgneg');
    expect(result).toEqual<CytoBand[]>([
      { chrom: 'chr11', start: 0, end: 100, name: 'p1', stain: 'gneg' },
    ]);
  });

  it('skips comment lines (# prefix)', () => {
    const text = [
      '# header line',
      'chr11\t0\t100\tp1\tgneg',
      '# inline comment',
      'chr11\t100\t200\tp2\tgpos50',
    ].join('\n');
    const result = parseCytoBandTsv(text);
    expect(result.map((b) => b.name)).toEqual(['p1', 'p2']);
  });

  it('skips blank lines (including whitespace-only)', () => {
    const text = ['chr11\t0\t100\tp1\tgneg', '', '   ', 'chr11\t100\t200\tp2\tgpos50'].join('\n');
    const result = parseCytoBandTsv(text);
    expect(result.length).toBe(2);
  });

  it('tolerates CRLF line endings', () => {
    const text = 'chr11\t0\t100\tp1\tgneg\r\nchr11\t100\t200\tp2\tgpos50\r\n';
    const result = parseCytoBandTsv(text);
    expect(result.length).toBe(2);
  });

  it('throws on wrong column count', () => {
    expect(() => parseCytoBandTsv('chr11\t0\t100\tp1')).toThrowError(/4 columns, expected 5/);
  });

  it('throws on negative start', () => {
    expect(() => parseCytoBandTsv('chr11\t-1\t100\tp1\tgneg')).toThrowError(/invalid start/);
  });

  it('throws on non-integer start', () => {
    expect(() => parseCytoBandTsv('chr11\tabc\t100\tp1\tgneg')).toThrowError(/invalid start/);
  });

  it('throws on end ≤ start', () => {
    expect(() => parseCytoBandTsv('chr11\t100\t100\tp1\tgneg')).toThrowError(/invalid end/);
    expect(() => parseCytoBandTsv('chr11\t100\t50\tp1\tgneg')).toThrowError(/invalid end/);
  });

  it('throws on unknown stain', () => {
    expect(() => parseCytoBandTsv('chr11\t0\t100\tp1\tunknown-stain')).toThrowError(
      /unknown stain/
    );
  });

  it('accepts every documented stain category', () => {
    const text = [
      'chr11\t0\t10\ta\tgneg',
      'chr11\t10\t20\tb\tgpos25',
      'chr11\t20\t30\tc\tgpos50',
      'chr11\t30\t40\td\tgpos75',
      'chr11\t40\t50\te\tgpos100',
      'chr11\t50\t60\tf\tacen',
      'chr11\t60\t70\tg\tgvar',
      'chr11\t70\t80\th\tstalk',
    ].join('\n');
    const result = parseCytoBandTsv(text);
    expect(result.map((b) => b.stain)).toEqual([
      'gneg',
      'gpos25',
      'gpos50',
      'gpos75',
      'gpos100',
      'acen',
      'gvar',
      'stalk',
    ]);
  });
});

describe('cytoBandStainColor', () => {
  it('returns the default color for each stain', () => {
    for (const stain of Object.keys(DEFAULT_CYTOBAND_STAIN_COLORS) as Array<
      keyof typeof DEFAULT_CYTOBAND_STAIN_COLORS
    >) {
      expect(cytoBandStainColor(stain)).toBe(DEFAULT_CYTOBAND_STAIN_COLORS[stain]);
    }
  });

  it('overrides take precedence over defaults', () => {
    expect(cytoBandStainColor('gneg', { gneg: '#abcdef' })).toBe('#abcdef');
  });

  it('falls through to default when the override map omits the stain', () => {
    expect(cytoBandStainColor('gneg', { gpos50: '#abcdef' })).toBe(
      DEFAULT_CYTOBAND_STAIN_COLORS.gneg
    );
  });
});

describe('filterCytoBandsInRange', () => {
  const fixture: CytoBand[] = [
    { chrom: 'chr11', start: 0, end: 100, name: 'a', stain: 'gneg' },
    { chrom: 'chr11', start: 100, end: 200, name: 'b', stain: 'gpos50' },
    { chrom: 'chr11', start: 200, end: 300, name: 'c', stain: 'gneg' },
    { chrom: 'chr11', start: 300, end: 400, name: 'd', stain: 'acen' },
  ];

  it('returns all bands when the range covers the whole set', () => {
    expect(filterCytoBandsInRange(fixture, 0, 400).map((b) => b.name)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });

  it('returns only bands that overlap a partial range', () => {
    expect(filterCytoBandsInRange(fixture, 150, 250).map((b) => b.name)).toEqual(['b', 'c']);
  });

  it('excludes bands that abut the range boundary (end === range start)', () => {
    expect(filterCytoBandsInRange(fixture, 100, 200).map((b) => b.name)).toEqual(['b']);
  });

  it('empty range (end ≤ start) returns []', () => {
    expect(filterCytoBandsInRange(fixture, 100, 100)).toEqual([]);
    expect(filterCytoBandsInRange(fixture, 200, 100)).toEqual([]);
  });

  it('range entirely outside any band → []', () => {
    expect(filterCytoBandsInRange(fixture, 500, 600)).toEqual([]);
  });
});

describe('GRCh38 cytoband table: chr11 rows', () => {
  const text = readFileSync(GRCH38_CYTOBANDS, 'utf8');
  const bands = parseCytoBandTsv(text).filter((band) => band.chrom === 'chr11');

  it('parses without throwing', () => {
    expect(bands.length).toBeGreaterThan(20);
  });

  it('every band is on chr11', () => {
    for (const b of bands) {
      expect(b.chrom).toBe('chr11');
    }
  });

  it('bands are non-overlapping and cover a contiguous range', () => {
    const sorted = [...bands].sort((a, b) => a.start - b.start);
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i];
      const b = sorted[i + 1];
      expect(a.end, `${a.name} → ${b.name}: gap or overlap`).toBe(b.start);
    }
  });

  it('total span matches chr11 length (135,086,622 bp)', () => {
    const sorted = [...bands].sort((a, b) => a.start - b.start);
    expect(sorted[0].start).toBe(0);
    expect(sorted[sorted.length - 1].end).toBe(135_086_622);
  });

  it('centromere bands are tagged "acen"', () => {
    const acen = bands.filter((b) => b.stain === 'acen');
    expect(acen.length).toBe(2);
    expect(acen.map((b) => b.name).sort()).toEqual(['p11.11', 'q11']);
  });
});
