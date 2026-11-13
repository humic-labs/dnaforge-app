import { expect, it } from 'vitest';
import { type Annotation } from '@waypoint/sequence-utils';
import { runSequenceSearchForMode } from '../hooks/useSequenceSearch';
import { getCachedSplicedSequence, getCodonsForSingleCDS } from './codon-calculator';

it('search and visible codons honor a chosen record code over a feature declaration', () => {
  const cds: Annotation = {
    name: 'alpha',
    type: 'CDS',
    start: 1,
    end: 6,
    direction: 1,
    qualifiers: { transl_table: ['2'] },
  };
  const input = {
    sequence: 'ATATGA',
    annotations: [cds],
    circular: false,
    query: 'MW',
    mode: 'aminoAcid' as const,
    sequenceGeneticCode: 1,
  };
  expect(runSequenceSearchForMode(input)).toHaveLength(1);
  expect(runSequenceSearchForMode({ ...input, geneticCodeBasis: 'chosen' })).toEqual([]);
  expect(getCodonsForSingleCDS(cds, 0, 6, input.sequence, 1).map((codon) => codon.aa)).toEqual([
    'M',
    'W',
  ]);
  expect(
    getCodonsForSingleCDS(cds, 0, 6, input.sequence, 1, 'chosen').map((codon) => codon.aa)
  ).toEqual(['I', '*']);
});

it('editing a frame qualifier retires the cached coding projection', () => {
  const cds: Annotation = { name: 'beta', type: 'CDS', start: 1, end: 7, direction: 1 };
  expect(getCachedSplicedSequence(cds, 'AATGAAA').protein).toBe('NE');
  cds.qualifiers = { codon_start: ['2'] };
  expect(getCachedSplicedSequence(cds, 'AATGAAA').protein).toBe('MK');
  expect(getCachedSplicedSequence(cds, 'AATGAAA').genomicCoordinateMap).toEqual([
    0, 1, 2, 3, 4, 5, 6,
  ]);
});
