import { describe, expect, it } from 'vitest';
import { translateCDS } from './translation';
import { compareProjectedCodons, type CodonComparisonAxis } from './codon-mutations';

const axis = (columns: number[]): CodonComparisonAxis => ({
  biologicalLength: columns.length,
  bioToColumn: (base) => columns[base] ?? null,
  columnToBio: (column) => (columns.indexOf(column) < 0 ? null : columns.indexOf(column)),
});
function compare(
  reference: string,
  query: string,
  referenceColumns: number[],
  queryColumns: number[],
  direction: 'forward' | 'reverse' = 'forward'
) {
  return compareProjectedCodons({
    reference: translateCDS(reference, 0, reference.length, direction, reference.length, false),
    referenceAxis: axis(referenceColumns),
    query: translateCDS(query, 0, query.length, direction, query.length, false),
    queryAxis: axis(queryColumns),
    columnLength: Math.max(...referenceColumns, ...queryColumns) + 1,
    direction,
  });
}
const ordinary = [0, 1, 2, 3, 4, 5, 6, 7, 8];

describe('query codon mutation comparison', () => {
  it('marks a changed amino acid and a premature stop using the reference protein', () => {
    const codons = compare('ATGAAATAA', 'ATGTAATAA', ordinary, ordinary);
    expect(codons[0].mutation?.kind).toBe('match');
    expect(codons[1]).toMatchObject({
      aa: '*',
      mutation: {
        kind: 'substitution',
        referenceAa: 'K',
        queryAa: '*',
        queryResidueIndex: 2,
        prematureStop: true,
        frameShifted: false,
      },
    });
    expect(codons[2].mutation?.prematureStop).toBe(false);
  });
  it('distinguishes a synonymous DNA change', () => {
    expect(compare('ATGAAATAA', 'ATGAAGTAA', ordinary, ordinary)[1].mutation).toMatchObject({
      kind: 'synonymous',
      referenceAa: 'K',
      queryAa: 'K',
    });
  });
  it('marks inserted codons without marking a downstream frame-preserving shift', () => {
    const codons = compare(
      'ATGAAATAA',
      'ATGCCCAAATAA',
      [0, 1, 2, 6, 7, 8, 9, 10, 11],
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
    );
    expect(codons[1]).toMatchObject({
      aa: 'P',
      mutation: { kind: 'inserted', frameShifted: false },
    });
    expect(codons[2]).toMatchObject({ aa: 'K', mutation: { kind: 'match' } });
  });
  it('marks the actual downstream frame after a one-base insertion', () => {
    const codons = compare(
      'ATGAAATAA',
      'ATGCAAATAA',
      [0, 1, 2, 4, 5, 6, 7, 8, 9],
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
    );
    expect(codons[1].mutation?.kind).toBe('inserted');
    expect(codons[2]).toMatchObject({
      aa: 'I',
      mutation: { kind: 'frameshifted', frameShifted: true },
    });
  });
  it('marks a deletion-induced frame and retains a fully deleted reference codon as a ghost', () => {
    const shifted = compare('ATGAAATAA', 'ATGAATAA', ordinary, [0, 1, 2, 4, 5, 6, 7, 8]);
    expect(shifted.find((codon) => codon.residueIndex === 2)).toMatchObject({
      aa: 'N',
      mutation: { kind: 'frameshifted', frameShifted: true },
    });
    const deleted = compare('ATGAAATAA', 'ATGTAA', ordinary, [0, 1, 2, 6, 7, 8]);
    expect(deleted[1]).toMatchObject({
      aa: '-',
      startBp: 3,
      endBp: 6,
      mutation: { kind: 'deleted', referenceAa: 'K' },
    });
    expect(deleted[2]).toMatchObject({ aa: '*', mutation: { kind: 'match' } });
  });
  it('stops marking a frame change after a compensating indel', () => {
    const codons = compare(
      'ATGAAACCCTAA',
      'ATGTAACCCTAA',
      [0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      [0, 1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12]
    );
    expect(codons[1].mutation?.kind).toBe('inserted');
    expect(codons.find((codon) => codon.residueIndex === 3)).toMatchObject({
      aa: 'P',
      mutation: { kind: 'match', frameShifted: false },
    });
  });
  it('keeps a three-base deletion across codon boundaries in frame and marks every deleted column', () => {
    const codons = compare(
      'ATGAAACCCTAA',
      'ATGACCTAA',
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
      [0, 1, 2, 3, 7, 8, 9, 10, 11]
    );
    expect(codons.find((codon) => codon.residueIndex === 2)?.mutation).toMatchObject({
      kind: 'substitution',
      frameShifted: false,
    });
    const deleted = codons.filter((codon) => codon.mutation?.kind === 'deleted');
    expect(deleted.map((codon) => [codon.startBp, codon.endBp])).toEqual([
      [4, 6],
      [6, 7],
    ]);
    expect(codons.find((codon) => codon.residueIndex === 3)?.mutation?.kind).toBe('match');
  });
  it('does not invent frameshifts when annotation bounds expose additional unchanged DNA', () => {
    const same = axis([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const codons = compareProjectedCodons({
      reference: translateCDS('ATGAAATAACCC', 3, 9, 'forward', 12, false),
      referenceAxis: same,
      query: translateCDS('ATGAAATAACCC', 0, 12, 'forward', 12, false),
      queryAxis: same,
      columnLength: 12,
      direction: 'forward',
    });
    expect(codons[0].mutation).toMatchObject({ kind: 'unknown', frameShifted: false });
    expect(codons[1].mutation?.kind).toBe('match');
    expect(codons[3].mutation).toMatchObject({ kind: 'unknown', frameShifted: false });
  });
  it('uses coding order on the reverse strand', () => {
    const codons = compare(
      'TTATTTCAT',
      'TTATTTGGGCAT',
      [0, 1, 2, 3, 4, 5, 9, 10, 11],
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
      'reverse'
    );
    expect(codons[1]).toMatchObject({
      aa: 'P',
      mutation: { kind: 'inserted', frameShifted: false },
    });
    expect(codons[2].mutation?.kind).toBe('match');
  });
  it('recognizes removal of a reference stop', () => {
    expect(compare('ATGAAATAA', 'ATGAAACAA', ordinary, ordinary)[2].mutation).toMatchObject({
      kind: 'substitution',
      referenceAa: '*',
      queryAa: 'Q',
      stopLost: true,
    });
  });
  it('marks the known new protein after a lost stop instead of treating its residues as unknown', () => {
    const columns = axis(Array.from({ length: 15 }, (_, i) => i));
    const codons = compareProjectedCodons({
      reference: translateCDS('ATGAAATAAGGTTAA', 0, 9, 'forward', 15, false),
      referenceAxis: columns,
      query: translateCDS('ATGAAACAAGGTTAA', 0, 15, 'forward', 15, false),
      queryAxis: columns,
      columnLength: 15,
      direction: 'forward',
    });
    expect(codons[2].mutation?.stopLost).toBe(true);
    expect(codons.slice(3).map((codon) => ({ aa: codon.aa, kind: codon.mutation?.kind }))).toEqual([
      { aa: 'G', kind: 'inserted' },
      { aa: '*', kind: 'inserted' },
    ]);
  });
});

describe('stop identity and coverage', () => {
  it('does not report an ambiguous query codon as a definite substitution or stop loss', () => {
    const codons = compare('ATGAAATAA', 'ATGNNNNNN', ordinary, ordinary);
    expect(codons[1].mutation).toMatchObject({
      kind: 'unknown',
      prematureStop: false,
      stopLost: false,
    });
    expect(codons[2].mutation).toMatchObject({
      kind: 'unknown',
      prematureStop: false,
      stopLost: false,
    });
  });
  it('marks a stop introduced entirely by inserted bases', () => {
    const refColumns = [0, 1, 2, 6, 7, 8, 9, 10, 11];
    const codons = compare(
      'ATGAAATAA',
      'ATGTAAAAATAA',
      refColumns,
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
    );
    expect(codons[1]).toMatchObject({
      aa: '*',
      mutation: { kind: 'inserted', prematureStop: true },
    });
  });
  it('recognizes a changed interpretation under another declared genetic code', () => {
    const same = axis([0, 1, 2, 3, 4, 5]);
    const codons = compareProjectedCodons({
      reference: translateCDS('ATGTGA', 0, 6, 'forward', 6, false),
      referenceAxis: same,
      query: translateCDS('ATGTGA', 0, 6, 'forward', 6, false, { sequenceGeneticCode: 4 }),
      queryAxis: same,
      columnLength: 6,
      direction: 'forward',
    });
    expect(codons[1]).toMatchObject({
      aa: 'W',
      mutation: { kind: 'substitution', referenceAa: '*', stopLost: true },
    });
  });
  it('does not label an unobserved terminal reference codon as a deletion', () => {
    const codons = compare('ATGAAATAA', 'AAATAA', ordinary, [3, 4, 5, 6, 7, 8]);
    expect(codons.some((codon) => codon.mutation?.kind === 'deleted')).toBe(false);
  });
  it('compares a codon split by an intron without inferring a frame shift', () => {
    const same = axis([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const options = {
      segments: [
        { start: 1, end: 2 },
        { start: 6, end: 12 },
      ],
    };
    const codons = compareProjectedCodons({
      reference: translateCDS('ATCCCGAAATAA', 0, 12, 'forward', 12, false, options),
      referenceAxis: same,
      query: translateCDS('ATCCCGGAATAA', 0, 12, 'forward', 12, false, options),
      queryAxis: same,
      columnLength: 12,
      direction: 'forward',
    });
    expect(
      codons
        .filter((codon) => codon.residueIndex === 1)
        .every((codon) => codon.mutation?.kind === 'match')
    ).toBe(true);
    expect(codons.find((codon) => codon.residueIndex === 2)).toMatchObject({
      aa: 'E',
      mutation: { kind: 'substitution', frameShifted: false },
    });
  });
});
