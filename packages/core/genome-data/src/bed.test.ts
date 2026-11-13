import { describe, expect, it } from 'vitest';

import { parseBedFile, parseBedLine, parseItemRgb, type BedParseStats } from './bed';

describe('parseItemRgb', () => {
  it('packs a valid R,G,B triple into 0xRRGGBB', () => {
    expect(parseItemRgb('255,0,0')).toBe(0xff0000);
    expect(parseItemRgb('0,255,0')).toBe(0x00ff00);
    expect(parseItemRgb('0,0,255')).toBe(0x0000ff);
    expect(parseItemRgb('128,64,32')).toBe(0x804020);
  });

  it('treats "0" as unset', () => {
    expect(parseItemRgb('0')).toBe(null);
  });

  it('treats blank as unset', () => {
    expect(parseItemRgb('')).toBe(null);
    expect(parseItemRgb('   ')).toBe(null);
  });

  it('returns null for malformed cells', () => {
    expect(parseItemRgb('255,0')).toBe(null);
    expect(parseItemRgb('255,0,0,0')).toBe(null);
    expect(parseItemRgb('256,0,0')).toBe(null);
    expect(parseItemRgb('-1,0,0')).toBe(null);
    expect(parseItemRgb('a,b,c')).toBe(null);
  });

  it('tolerates whitespace around the triple', () => {
    expect(parseItemRgb(' 10,20,30 ')).toBe(0x0a141e);
  });
});

describe('parseBedLine — BED3 / BED6 / BED9', () => {
  it('parses BED3 (chrom/start/end only)', () => {
    expect(parseBedLine('chr11\t100\t200')).toEqual({
      chrom: 'chr11',
      start: 100,
      end: 200,
    });
  });

  it('parses BED6 (+ name/score/strand)', () => {
    expect(parseBedLine('chr11\t100\t200\tFOXO\t500\t+')).toEqual({
      chrom: 'chr11',
      start: 100,
      end: 200,
      name: 'FOXO',
      strand: '+',
    });
  });

  it('parses BED9 (+ thickStart/thickEnd/itemRgb)', () => {
    expect(parseBedLine('chr11\t100\t200\tFOXO\t500\t-\t110\t180\t255,128,0')).toEqual({
      chrom: 'chr11',
      start: 100,
      end: 200,
      name: 'FOXO',
      strand: '-',
      color: 0xff8000,
    });
  });

  it('keeps the record when itemRgb is "0" (unset)', () => {
    const r = parseBedLine('chr11\t100\t200\tFOXO\t500\t+\t110\t180\t0');
    expect(r?.color).toBeUndefined();
    expect(r?.name).toBe('FOXO');
  });

  it('keeps the record when itemRgb is malformed (no color, no failure)', () => {
    const r = parseBedLine('chr11\t100\t200\tFOXO\t500\t+\t110\t180\tnotrgb');
    expect(r?.color).toBeUndefined();
  });
});

describe('parseBedLine — strand handling', () => {
  it('accepts +, -, .', () => {
    expect(parseBedLine('chr11\t100\t200\tx\t0\t+')?.strand).toBe('+');
    expect(parseBedLine('chr11\t100\t200\tx\t0\t-')?.strand).toBe('-');
    expect(parseBedLine('chr11\t100\t200\tx\t0\t.')?.strand).toBe('.');
  });

  it('drops strand silently when malformed', () => {
    expect(parseBedLine('chr11\t100\t200\tx\t0\tfoo')?.strand).toBeUndefined();
  });
});

describe('parseBedLine — comments + headers + malformed lines', () => {
  it('returns null for comments', () => {
    expect(parseBedLine('# this is a comment')).toBe(null);
  });

  it('returns null for blank lines', () => {
    expect(parseBedLine('')).toBe(null);
    expect(parseBedLine('   ')).toBe(null);
  });

  it('returns null for UCSC track / browser headers', () => {
    expect(parseBedLine('track name="cCRE" visibility=2')).toBe(null);
    expect(parseBedLine('browser position chr11:1-1000')).toBe(null);
  });

  it('returns null when start/end are not numbers', () => {
    expect(parseBedLine('chr11\tnotanumber\t200')).toBe(null);
  });

  it('returns null when start < 0', () => {
    expect(parseBedLine('chr11\t-1\t200')).toBe(null);
  });

  it('returns null when end <= start (degenerate interval)', () => {
    expect(parseBedLine('chr11\t100\t100')).toBe(null);
    expect(parseBedLine('chr11\t200\t100')).toBe(null);
  });

  it('returns null when fewer than 3 columns', () => {
    expect(parseBedLine('chr11\t100')).toBe(null);
  });
});

describe('parseBedFile — multi-line + stats', () => {
  it('parses multiple records with EXACT count', () => {
    const text = [
      '# cCRE for chr11 — example',
      'browser position chr11',
      'track name="cCRE"',
      'chr11\t100\t200\tA\t0\t+',
      'chr11\t300\t400\tB\t0\t-',
      'chr11\t500\t600\tC\t0\t.',
      '',
    ].join('\n');
    const records = parseBedFile(text);
    expect(records).toHaveLength(3);
    expect(records[0].name).toBe('A');
    expect(records[1].name).toBe('B');
    expect(records[2].name).toBe('C');
  });

  it('captures stats: total, parsed, skipped, malformed', () => {
    const text = [
      '# header',
      '',
      'chr11\t100\t200\tA',
      'chr11\tbogus\t300\tB',
      'chr11\t300\t400\tC',
    ].join('\n');
    const stats: BedParseStats = { total: 0, parsed: 0, skipped: 0, malformed: 0 };
    const records = parseBedFile(text, stats);
    expect(records).toHaveLength(2);
    expect(stats.total).toBe(5);
    expect(stats.parsed).toBe(2);
    expect(stats.skipped).toBe(2);
    expect(stats.malformed).toBe(1);
  });

  it('preserves record order (matches input order)', () => {
    const text = ['chr11\t300\t400\tB', 'chr11\t100\t200\tA', 'chr11\t500\t600\tC'].join('\n');
    const records = parseBedFile(text);
    expect(records.map((r) => r.name)).toEqual(['B', 'A', 'C']);
  });

  it('round-trips itemRgb colors through to AnnotationRecord.color', () => {
    const text = [
      'chr11\t100\t200\tTssA\t0\t.\t100\t200\t255,0,0',
      'chr11\t300\t400\tEnh\t0\t.\t300\t400\t255,255,0',
    ].join('\n');
    const records = parseBedFile(text);
    expect(records[0].color).toBe(0xff0000);
    expect(records[1].color).toBe(0xffff00);
  });

  it('handles trailing newline without producing a phantom record', () => {
    const text = 'chr11\t100\t200\tA\n';
    expect(parseBedFile(text)).toHaveLength(1);
  });

  it('returns empty array for empty input', () => {
    expect(parseBedFile('')).toEqual([]);
  });
});
