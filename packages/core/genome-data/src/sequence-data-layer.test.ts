import { describe, expect, it } from 'vitest';
import { resolveGenomicMarkup, type GenomicMarkupStyle } from './genomic-markup';
import {
  parseSequenceLayerCsv,
  prepareSequenceDataLayer,
  type PrepareSequenceDataLayerInput,
  type SequenceDataLayerAnnotation,
} from './sequence-data-layer';

const target = {
  documentId: 'existing-sequence-42',
  sequenceFingerprint: `sha256:${'a'.repeat(64)}`,
  annotationFingerprint: `annotation-document-v1:sha256:${'b'.repeat(64)}`,
  length: 100,
};
const annotations: readonly SequenceDataLayerAnnotation[] = [
  { id: 'gene-a', start0: 10, end0: 20, qualifiers: { locus_tag: ['b1007'], ID: ['gene-b1007'] } },
  { id: 'cds-a', start0: 10, end0: 20, qualifiers: { locus_tag: ['b1007'], ID: ['cds-b1007'] } },
  { id: 'gene-b', start0: 30, end0: 40, qualifiers: { locus_tag: ['b1008'], ID: ['gene-b1008'] } },
];
const input: PrepareSequenceDataLayerInput = {
  datasetId: 'experiment-owned-by-user',
  label: 'Mutagenesis run',
  unit: 'relative activity',
  csv: 'position,control,stress\n0,0,\n99,3.5,-2e-1\n',
  target,
  mapping: { kind: 'positions', startColumn: 'position', coordinateSystem: 'zero-based-half-open' },
  valueColumns: ['control', 'stress'],
  unresolvedPolicy: 'reject',
  aggregation: 'none',
};
const annotationInput: PrepareSequenceDataLayerInput = {
  ...input,
  csv: 'locus,control\nb1007,0\nb1008,4\n',
  mapping: { kind: 'annotation', identifierColumn: 'locus', identifierField: 'locus_tag' },
  valueColumns: ['control'],
  annotations,
};

describe('bounded sequence layer CSV', () => {
  it('preserves quoted commas, escaped quotes, newlines and stable source row identities', () => {
    const csv =
      '\ufeffposition,label,value\r\n1,"first, second",0\r\n2,"line one\nline ""two""",\r\n';
    const parsed = parseSequenceLayerCsv(csv);
    expect(parsed.columns).toEqual(['position', 'label', 'value']);
    expect(parsed.rows).toEqual([
      {
        id: 'row-1',
        number: 2,
        cells: ['1', 'first, second', '0'],
        values: { position: '1', label: 'first, second', value: '0' },
      },
      {
        id: 'row-2',
        number: 3,
        cells: ['2', 'line one\nline "two"', ''],
        values: { position: '2', label: 'line one\nline "two"', value: '' },
      },
    ]);
    expect(parseSequenceLayerCsv(csv)).toEqual(parsed);
  });

  it.each(['a,a\n1,2', 'a, a \n1,2', ',b\n1,2', '', '"a\n1', 'a\n"one"two', 'a\none"two', 'a\n\0'])(
    'rejects malformed CSV rather than guessing its structure: %j',
    (csv) => {
      expect(() => parseSequenceLayerCsv(csv)).toThrow();
    }
  );

  it('enforces byte, row and column bounds during parsing', () => {
    expect(() => parseSequenceLayerCsv('a\né', { maxBytes: 3 })).toThrow('byte limit');
    expect(() => parseSequenceLayerCsv('a\n1\n2', { maxRows: 1 })).toThrow('too many rows');
    expect(() => parseSequenceLayerCsv('a,b', { maxColumns: 1 })).toThrow('too many columns');
    expect(() => parseSequenceLayerCsv('a', { maxRows: 0 })).toThrow('Invalid CSV');
    expect(() => parseSequenceLayerCsv('a', { maxRows: 50_001 })).toThrow('Invalid CSV');
  });

  it('retains malformed-width rows for an explicit rejected mapping outcome', () => {
    const parsed = parseSequenceLayerCsv('position,control\n5,1,extra\n6\n');
    expect(parsed.rows.map((row) => row.cells)).toEqual([['5', '1', 'extra'], ['6']]);
    const result = prepareSequenceDataLayer({
      ...input,
      csv: 'position,control\n5,1,extra\n6\n',
      valueColumns: ['control'],
    });
    expect(result.report.outcomes.map((row) => row.kind === 'rejected' && row.code)).toEqual([
      'row-width',
      'row-width',
    ]);
    expect(result.report.counts.total).toBe(2);
  });
});

describe('sequence dataset mapping', () => {
  it.each(['annotation-mapping-v1', 'annotation-document-v1'])(
    'accepts %s annotation pins while retaining legacy artifact compatibility',
    (prefix) => {
      expect(
        prepareSequenceDataLayer({
          ...annotationInput,
          target: { ...target, annotationFingerprint: `${prefix}:sha256:${'b'.repeat(64)}` },
        }).publishable
      ).toBe(true);
    }
  );

  it('maps an arbitrary existing sequence and retains measured zero separately from missing values', () => {
    const result = prepareSequenceDataLayer(input);
    expect(result.publishable).toBe(true);
    expect(result.dataset.reference).toEqual({
      id: target.documentId,
      chrom: target.documentId,
      length: 100,
    });
    expect(result.dataset.samples[0]).toEqual({
      id: 'control',
      label: 'control',
      observations: [
        { id: 'row-1', start: 0, end: 1, value: 0 },
        { id: 'row-2', start: 99, end: 100, value: 3.5 },
      ],
    });
    expect(result.dataset.samples[1].observations.map((row) => row.value)).toEqual([null, -0.2]);
    expect(result.report.counts).toEqual({
      total: 2,
      mapped: 2,
      unmapped: 0,
      ambiguous: 0,
      rejected: 0,
    });
  });

  it('converts only the explicitly selected coordinate convention', () => {
    const zero = prepareSequenceDataLayer({
      ...input,
      csv: 'start,end,control\n10,20,1',
      valueColumns: ['control'],
      mapping: {
        kind: 'positions',
        startColumn: 'start',
        endColumn: 'end',
        coordinateSystem: 'zero-based-half-open',
      },
    });
    const one = prepareSequenceDataLayer({
      ...input,
      csv: 'start,end,control\n11,20,1',
      valueColumns: ['control'],
      mapping: {
        kind: 'positions',
        startColumn: 'start',
        endColumn: 'end',
        coordinateSystem: 'one-based-inclusive',
      },
    });
    expect(zero.dataset).toEqual(one.dataset);
    const single = prepareSequenceDataLayer({
      ...input,
      csv: 'position,control\n100,1',
      valueColumns: ['control'],
      mapping: {
        kind: 'positions',
        startColumn: 'position',
        coordinateSystem: 'one-based-inclusive',
      },
    });
    expect(single.dataset.samples[0].observations[0]).toMatchObject({ start: 99, end: 100 });
  });

  it.each(['-1', '100', '2.5', '1e1', '0x10', '9007199254740993', ''])(
    'reports invalid or out-of-bounds positions: %j',
    (position) => {
      const result = prepareSequenceDataLayer({
        ...input,
        csv: `position,control\n${position},1`,
        valueColumns: ['control'],
      });
      expect(result.publishable).toBe(false);
      expect(result.report.outcomes[0]).toMatchObject({
        kind: 'rejected',
        code: 'invalid-position',
      });
      expect(result.dataset.samples[0].observations).toEqual([]);
    }
  );

  it.each(['NaN', 'Infinity', '1e999', '0x10', '1,000', 'missing'])(
    'reports non-decimal measurements without silently replacing them: %j',
    (value) => {
      const result = prepareSequenceDataLayer({
        ...input,
        csv: `position,control\n1,"${value}"`,
        valueColumns: ['control'],
      });
      expect(result.report.outcomes[0]).toMatchObject({ kind: 'rejected', code: 'invalid-number' });
      expect(result.publishable).toBe(false);
    }
  );

  it('coalesces gene and CDS entries at the same locus interval and keeps the chosen stable color key', () => {
    const result = prepareSequenceDataLayer(annotationInput);
    expect(result.publishable).toBe(true);
    expect(result.report.counts.mapped).toBe(2);
    expect(result.dataset.samples[0].observations[0]).toEqual({
      id: 'row-1',
      start: 10,
      end: 20,
      value: 0,
      annotationId: 'b1007',
      label: 'b1007',
    });
  });

  it('reports repeated identifiers at distinct intervals as ambiguous even with explicit mean aggregation', () => {
    const result = prepareSequenceDataLayer({
      ...annotationInput,
      aggregation: 'mean',
      annotations: [
        ...annotations,
        { id: 'other-gene', start0: 50, end0: 60, qualifiers: { locus_tag: ['b1007'] } },
      ],
    });
    expect(result.publishable).toBe(false);
    expect(result.report.outcomes[0]).toMatchObject({
      kind: 'ambiguous',
      identifier: 'b1007',
      candidates: [
        { start: 10, end: 20, annotationId: 'b1007' },
        { start: 50, end: 60, annotationId: 'b1007' },
      ],
    });
    expect(result.report.counts).toEqual({
      total: 2,
      mapped: 1,
      unmapped: 0,
      ambiguous: 1,
      rejected: 0,
    });
  });

  it('uses the selected identifier field exactly and does not guess gene names or case', () => {
    const result = prepareSequenceDataLayer({
      ...annotationInput,
      csv: 'locus,control\nB1007,1\n,2\ngene-b1008,3',
      mapping: { kind: 'annotation', identifierColumn: 'locus', identifierField: 'ID' },
    });
    expect(result.report.outcomes.map((row) => row.kind)).toEqual([
      'unmapped',
      'unmapped',
      'mapped',
    ]);
    expect(result.dataset.samples[0].observations[0].annotationId).toBe('gene-b1008');
    const canonical = prepareSequenceDataLayer({
      ...annotationInput,
      csv: 'locus,control\ngene-a,1',
      mapping: { kind: 'annotation', identifierColumn: 'locus', identifierField: 'id' },
    });
    expect(canonical.publishable).toBe(true);
    expect(canonical.dataset.samples[0].observations[0].annotationId).toBe('gene-a');
  });

  it('requires explicit aggregation instead of silently overriding repeated annotation measurements', () => {
    const repeated = { ...annotationInput, csv: 'locus,control\nb1007,0\nb1007,10\nb1007,' };
    const none = prepareSequenceDataLayer(repeated);
    expect(none.report.counts.rejected).toBe(3);
    expect(none.publishable).toBe(false);
    const mean = prepareSequenceDataLayer({ ...repeated, aggregation: 'mean' });
    expect(mean.report.counts.mapped).toBe(3);
    expect(mean.annotationAggregation).toBe('mean');
    expect(mean.dataset.samples[0].observations.map((row) => row.value)).toEqual([0, 10, null]);
    const style: GenomicMarkupStyle = {
      geometry: 'points',
      colorScale: {
        kind: 'continuous',
        domain: [0, 10],
        colors: ['#000000', '#ffffff'],
        missingColor: '#cccccc',
        transform: 'linear',
      },
    };
    const resolved = resolveGenomicMarkup({
      dataset: mean.dataset,
      sampleId: 'control',
      window: { reference: mean.dataset.reference, start: 0, end: 100 },
      style,
      annotationAggregation: mean.annotationAggregation === 'mean' ? 'mean' : undefined,
    });
    expect(resolved.annotationValues.get('b1007')).toBe(5);
    expect(resolved.records).toHaveLength(3);
  });

  it('retains every excluded outcome and permits partial mapping only under the explicit policy', () => {
    const mixed = { ...annotationInput, csv: 'locus,control\nb1007,1\nunknown,2\nb1008,invalid' };
    expect(prepareSequenceDataLayer(mixed).publishable).toBe(false);
    const excluded = prepareSequenceDataLayer({ ...mixed, unresolvedPolicy: 'exclude' });
    expect(excluded.publishable).toBe(true);
    expect(excluded.report.counts).toEqual({
      total: 3,
      mapped: 1,
      unmapped: 1,
      ambiguous: 0,
      rejected: 1,
    });
    expect(excluded.report.outcomes.map((row) => row.rowId)).toEqual(['row-1', 'row-2', 'row-3']);
    expect(excluded.dataset.samples[0].observations).toHaveLength(1);
    expect(
      prepareSequenceDataLayer({
        ...mixed,
        csv: 'locus,control\nunknown,2',
        unresolvedPolicy: 'exclude',
      }).publishable
    ).toBe(false);
    expect(
      prepareSequenceDataLayer({
        ...input,
        csv: 'position,control',
        valueColumns: ['control'],
        unresolvedPolicy: 'exclude',
      }).publishable
    ).toBe(false);
  });

  it('requires pinned target content and annotation state without inferring either from a filename', () => {
    expect(() =>
      prepareSequenceDataLayer({
        ...input,
        target: { ...target, sequenceFingerprint: target.documentId },
      })
    ).toThrow('SHA-256');
    expect(() =>
      prepareSequenceDataLayer({
        ...annotationInput,
        target: { ...target, annotationFingerprint: undefined },
      })
    ).toThrow('annotation fingerprint');
    expect(() => prepareSequenceDataLayer({ ...input, target: { ...target, length: 0 } })).toThrow(
      'positive sequence length'
    );
    expect(() =>
      prepareSequenceDataLayer({
        ...annotationInput,
        annotations: [{ id: 'bad', start0: 10, end0: 101 }],
      })
    ).toThrow('invalid annotation interval');
  });

  it('rejects unknown and duplicate measurement columns before producing a candidate', () => {
    expect(() => prepareSequenceDataLayer({ ...input, valueColumns: ['absent'] })).toThrow(
      'Unknown CSV column'
    );
    expect(() =>
      prepareSequenceDataLayer({ ...input, valueColumns: ['control', 'control'] })
    ).toThrow('unique measurement columns');
    expect(() => prepareSequenceDataLayer({ ...input, valueColumns: [] })).toThrow(
      'unique measurement columns'
    );
  });
});
