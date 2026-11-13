import { expect, it, vi } from 'vitest';

const readCalls = vi.hoisted(() => vi.fn());
vi.mock('@waypoint/sequence-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@waypoint/sequence-utils')>();
  return {
    ...actual,
    codonReaderFor: (...args: Parameters<typeof actual.codonReaderFor>) => {
      const read = actual.codonReaderFor(...args);
      return (...input: Parameters<typeof read>) => {
        readCalls(...input);
        return read(...input);
      };
    },
  };
});

import { codonReaderFor, type Annotation } from '@waypoint/sequence-utils';
import { getCodonsForSingleCDS } from './codon-calculator';

it('reads repeated triplets once per row calculation across different genes', () => {
  const bases = 'GAC'.repeat(20);
  const first: Annotation = { name: 'first', type: 'CDS', start: 1, end: 60, direction: 1 };
  const second: Annotation = { ...first, name: 'second', start: 31 };
  readCalls.mockClear();
  const rows = [
    getCodonsForSingleCDS(first, 0, 15, bases),
    getCodonsForSingleCDS(first, 15, 30, bases),
    getCodonsForSingleCDS(second, 30, 60, bases),
  ];
  expect(rows.flat().every((codon) => codon.aa === 'D')).toBe(true);
  expect(readCalls).toHaveBeenCalledTimes(rows.length);
});

it('keeps positional exceptions and feature/user code precedence exact after reuse', () => {
  const bases = 'TGATGATGA';
  const first: Annotation = { name: 'first', type: 'CDS', start: 1, end: 9, direction: 1 };
  const feature = { ...first, qualifiers: { transl_table: ['4'] } };
  const repeatedDeclaration = { ...first, qualifiers: { transl_table: ['999', '4'] } };
  const exception = { ...first, qualifiers: { transl_except: ['(pos:4..6,aa:Sec)'] } };
  for (const [cds, code, basis] of [
    [first, 1, undefined],
    [feature, 1, undefined],
    [feature, 1, 'chosen'],
    [repeatedDeclaration, 1, undefined],
    [feature, 999, 'chosen'],
    [exception, 1, undefined],
    [first, 4, 'chosen'],
  ] as const) {
    const codons = getCodonsForSingleCDS(cds, 0, bases.length, bases, code, basis);
    const read = codonReaderFor(cds, code, basis);
    expect(codons.map((codon) => codon.display)).toEqual(
      codons.map((codon) => read(codon.codon, codon.startPos + 1))
    );
  }
  expect(getCodonsForSingleCDS(exception, 0, bases.length, bases).map((codon) => codon.aa)).toEqual(
    ['*', 'U', '*']
  );
});
