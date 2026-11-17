import { describe, expect, it } from 'vitest';
import {
  resolveGenomicMarkup,
  type GenomicMarkupDataset,
  type GenomicMarkupObservation,
  type GenomicMarkupStyle,
} from './genomic-markup';

const reference = { id: 'NC_000913.3', chrom: 'NC_000913.3', length: 4_641_652 };
const style: GenomicMarkupStyle = {
  geometry: 'bars',
  colorScale: {
    kind: 'continuous',
    domain: [0, 10],
    colors: ['#000000', '#ffffff'],
    missingColor: '#94a3b8',
    transform: 'linear',
  },
};
const observations: readonly GenomicMarkupObservation[] = [
  { id: 'guide-1', annotationId: 'b1007', start: 1_069_990, end: 1_070_020, value: 0 },
  { id: 'guide-2', annotationId: 'b1008', start: 1_070_030, end: 1_070_031, value: null },
];
const dataset: GenomicMarkupDataset = {
  id: 'real-guide-source',
  reference,
  unit: 'log2 fold change',
  samples: [
    { id: 'control', label: 'Control', observations },
    { id: 'stress', label: 'Stress', observations: [{ ...observations[0], value: 10 }] },
  ],
};
const window = { reference, start: 1_070_000, end: 1_070_050 };

describe('shared genomic markup binding', () => {
  it('resolves the same stable observation and color in full-reference and extracted-locus viewers', () => {
    const full = resolveGenomicMarkup({
      dataset,
      sampleId: 'control',
      window: { reference, start: 0, end: reference.length },
      style,
    });
    const locus = resolveGenomicMarkup({ dataset, sampleId: 'control', window, style });

    expect(full.records[0]).toMatchObject({ start: 1_069_990, end: 1_070_020, color: '#000000' });
    expect(locus.records[0]).toMatchObject({
      id: 'guide-1',
      start: 0,
      end: 20,
      sourceStart: 1_069_990,
      sourceEnd: 1_070_020,
      annotationId: 'b1007',
      value: 0,
      color: '#000000',
    });
    expect(locus.annotationColors).toEqual(full.annotationColors);
  });

  it('keeps missing observations distinct from measured zero', () => {
    const result = resolveGenomicMarkup({ dataset, sampleId: 'control', window, style });
    expect(result.records.map(({ value, color }) => ({ value, color }))).toEqual([
      { value: 0, color: '#000000' },
      { value: null, color: '#94a3b8' },
    ]);
    expect(result.annotationColors.get('b1008')).toBe('#94a3b8');
  });

  it('selects one explicit sample and rejects an absent sample', () => {
    expect(
      resolveGenomicMarkup({ dataset, sampleId: 'stress', window, style }).records[0]
    ).toMatchObject({
      value: 10,
      color: '#ffffff',
    });
    expect(() => resolveGenomicMarkup({ dataset, sampleId: 'unknown', window, style })).toThrow(
      'Unknown genomic markup sample'
    );
  });

  it.each([
    { ...reference, id: 'U00096.2' },
    { ...reference, chrom: 'different-contig' },
    { ...reference, length: reference.length - 1 },
  ])('rejects a source/reference mismatch: %j', (differentReference) => {
    expect(() =>
      resolveGenomicMarkup({
        dataset,
        sampleId: 'control',
        window: { ...window, reference: differentReference },
        style,
      })
    ).toThrow('same reference');
  });

  it('requires explicit annotation aggregation and averages the full sample without changing raw points', () => {
    const guides: GenomicMarkupDataset = {
      ...dataset,
      samples: [
        {
          id: 'control',
          label: 'Control',
          observations: [
            { id: 'inside', start: 1_070_010, end: 1_070_011, annotationId: 'b1007', value: 0 },
            { id: 'outside', start: 1_070_060, end: 1_070_061, annotationId: 'b1007', value: 10 },
            { id: 'missing', start: 1_070_012, end: 1_070_013, annotationId: 'b1007', value: null },
          ],
        },
      ],
    };
    expect(() =>
      resolveGenomicMarkup({ dataset: guides, sampleId: 'control', window, style })
    ).toThrow('Multiple observations overlap this target');
    const result = resolveGenomicMarkup({
      dataset: guides,
      sampleId: 'control',
      window,
      style,
      annotationAggregation: 'mean',
    });
    expect(result.records.map(({ id, value }) => ({ id, value }))).toEqual([
      { id: 'inside', value: 0 },
      { id: 'missing', value: null },
    ]);
    expect(result.annotationColors.get('b1007')).toBe('#808080');
    expect(result.annotationValues.get('b1007')).toBe(5);
    expect(result.annotationAggregation).toBe('mean');
  });

  it('preserves all-missing annotation groups when explicitly averaging', () => {
    const missing: GenomicMarkupDataset = {
      ...dataset,
      samples: [
        {
          id: 'control',
          label: 'Control',
          observations: [
            { ...observations[0], value: null },
            { ...observations[1], annotationId: 'b1007' },
          ],
        },
      ],
    };
    expect(
      resolveGenomicMarkup({
        dataset: missing,
        sampleId: 'control',
        window,
        style,
        annotationAggregation: 'mean',
      }).annotationColors.get('b1007')
    ).toBe('#94a3b8');
  });

  it('rejects duplicate observation IDs and invalid source positions', () => {
    const resolve = (rows: readonly GenomicMarkupObservation[]) =>
      resolveGenomicMarkup({
        dataset: { ...dataset, samples: [{ id: 'control', label: 'Control', observations: rows }] },
        sampleId: 'control',
        window,
        style,
      });
    expect(() => resolve([observations[0], observations[0]])).toThrow(
      'observation IDs must be unique'
    );
    expect(() => resolve([{ ...observations[0], end: reference.length + 1 }])).toThrow('half-open');
    expect(() => resolve([{ ...observations[0], value: Number.NaN }])).toThrow(
      'finite numbers or null'
    );
  });
});
