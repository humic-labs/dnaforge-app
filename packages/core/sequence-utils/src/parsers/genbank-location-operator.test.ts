import { describe, it, expect } from 'vitest';
import { parseGenBankFull } from './genbank';

function record(location: string): string {
  return [
    'LOCUS       t                        100 bp    DNA     linear   UNA 01-JAN-2020',
    'FEATURES             Location/Qualifiers',
    `     CDS             ${location}`,
    '                     /label="x"',
    'ORIGIN',
    `        1 ${'acgt'.repeat(25)}`,
    '//',
    '',
  ].join('\n');
}

function cdsOf(location: string) {
  const parsed = parseGenBankFull(record(location));
  const cds = parsed.annotations.find((a) => a.type === 'CDS');
  if (!cds) throw new Error(`no CDS parsed from ${location}`);
  return cds;
}

describe('GenBank location operator — only join() yields segments', () => {
  it('populates segments for join()', () => {
    expect(cdsOf('join(1..30,61..100)').segments).toEqual([
      { start: 1, end: 30 },
      { start: 61, end: 100 },
    ]);
  });

  it('populates segments for complement(join(...))', () => {
    const cds = cdsOf('complement(join(1..30,61..100))');
    expect(cds.segments).toHaveLength(2);
    expect(cds.direction).toBe(-1);
  });

  it('does NOT populate segments for order() — order does not imply joining', () => {
    expect(cdsOf('order(1..30,61..100)').segments).toBeUndefined();
  });

  it('does NOT populate segments for a plain contiguous range', () => {
    expect(cdsOf('1..100').segments).toBeUndefined();
  });

  it('stamps _locationString alongside segments for round-trip fidelity', () => {
    const cds = cdsOf('join(1..30,61..100)');
    expect(cds.qualifiers?._locationString?.[0]).toContain('join(');
  });
});
