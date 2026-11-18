import { describe, expect, it } from 'vitest';
import { prepareSequenceDataLayer } from '@waypoint/genome-data';
import {
  parseSequenceDataLayerDocument,
  sequenceDataLayerCommandSchema,
  serializeSequenceDataLayerDocument,
  type SequenceDataLayerDocument,
} from './sequence-data-layer';

function fixture(): SequenceDataLayerDocument {
  const id = `layer-${'a'.repeat(64)}`;
  const target = {
    documentId: 'existing-sequence',
    sequenceFingerprint: `sha256:${'b'.repeat(64)}`,
    length: 100,
  };
  const mapping = {
    kind: 'positions' as const,
    startColumn: 'position',
    coordinateSystem: 'one-based-inclusive' as const,
  };
  const csv = 'position,activity\n1,0\n100,\n';
  const prepared = prepareSequenceDataLayer({
    datasetId: id,
    label: 'Activity',
    unit: 'activity',
    csv,
    target,
    mapping,
    valueColumns: ['activity'],
    unresolvedPolicy: 'reject',
    aggregation: 'none',
  });
  return {
    schema: 'dnaforge.sequence-data-layer.v1',
    id,
    label: 'Activity',
    unit: 'activity',
    createdAt: '2026-11-16T00:00:00.000Z',
    target,
    annotations: [],
    source: { kind: 'csv-snapshot', csv, sha256: `sha256:${'c'.repeat(64)}` },
    mapping,
    valueColumns: ['activity'],
    unresolvedPolicy: 'reject',
    aggregation: 'none',
    dataset: prepared.dataset,
    report: prepared.report,
    annotationAggregation: prepared.annotationAggregation,
    presentation: {
      sampleId: 'activity',
      annotationColors: true,
      signalVisible: true,
      style: {
        geometry: 'bars',
        colorScale: {
          kind: 'continuous',
          domain: [-1, 1],
          colors: ['#000000', '#ffffff'],
          missingColor: '#cbd5e1',
          transform: 'linear',
        },
      },
    },
    creationRequest: {
      id: 'first-layer',
      inputHash: `sha256:${'d'.repeat(64)}`,
      requestedPresentation: null,
    },
  };
}

describe('saved sequence data layer format', () => {
  it.each(['annotation-mapping-v1', 'annotation-document-v1'])(
    'accepts %s fingerprints in saved artifacts and creation requests',
    (prefix) => {
      const original = fixture();
      const fingerprint = `${prefix}:sha256:${'e'.repeat(64)}`;
      const document = {
        ...original,
        target: { ...original.target, annotationFingerprint: fingerprint },
      };
      expect(
        parseSequenceDataLayerDocument(serializeSequenceDataLayerDocument(document)).target
          .annotationFingerprint
      ).toBe(fingerprint);
      expect(
        sequenceDataLayerCommandSchema.safeParse({
          operation: 'create',
          project: '/project',
          requestId: 'create',
          targetDocumentId: document.target.documentId,
          expectedSequenceFingerprint: document.target.sequenceFingerprint,
          expectedAnnotationFingerprint: fingerprint,
          csv: { kind: 'text', text: document.source.csv },
          mapping: document.mapping,
          valueColumns: document.valueColumns,
          label: document.label,
          unit: document.unit,
          unresolvedPolicy: document.unresolvedPolicy,
          aggregation: document.aggregation,
        }).success
      ).toBe(true);
    }
  );

  it('round-trips source, mapping, numeric zero and missing values without losing scientific identity', () => {
    const document = fixture();
    const restored = parseSequenceDataLayerDocument(serializeSequenceDataLayerDocument(document));
    expect(restored).toEqual(document);
    expect(restored.dataset.samples[0].observations.map((row) => row.value)).toEqual([0, null]);
  });

  it('persists native span-arcs presentation without modifying the source intervals', () => {
    const document = fixture();
    document.presentation.style.geometry = 'arcs';
    const restored = parseSequenceDataLayerDocument(serializeSequenceDataLayerDocument(document));
    expect(restored.presentation.style.geometry).toBe('arcs');
    expect(restored.dataset).toEqual(document.dataset);
    expect(restored.source).toEqual(document.source);
  });

  it('persists matrix geometry and its remembered single sample without changing source measurements', () => {
    const document = fixture();
    document.presentation.style.geometry = 'matrix';
    const restored = parseSequenceDataLayerDocument(serializeSequenceDataLayerDocument(document));
    expect(restored.presentation).toEqual(document.presentation);
    expect(restored.dataset).toEqual(document.dataset);
    expect(restored.dataset.samples[0].observations.map(({ value }) => value)).toEqual([0, null]);
    expect(restored.source).toEqual(document.source);
  });

  it('refuses forged mapping outcomes and modified resolved coordinates', () => {
    const document = fixture();
    const changed = structuredClone(document);
    (changed.dataset.samples[0].observations[0] as { start: number }).start = 45;
    expect(() => serializeSequenceDataLayerDocument(changed)).toThrow('does not match');
    const forged = {
      ...document,
      report: { ...document.report, counts: { ...document.report.counts, mapped: 1 } },
    };
    expect(() => serializeSequenceDataLayerDocument(forged)).toThrow('does not match');
  });

  it('refuses invalid scales and nonexistent selected samples', () => {
    const document = fixture();
    expect(() =>
      serializeSequenceDataLayerDocument({
        ...document,
        presentation: { ...document.presentation, sampleId: 'missing' },
      })
    ).toThrow('Unknown genomic markup sample');
    expect(() =>
      serializeSequenceDataLayerDocument({
        ...document,
        presentation: {
          ...document.presentation,
          style: {
            ...document.presentation.style,
            colorScale: {
              kind: 'continuous',
              domain: [1, 1],
              colors: ['#000000', '#ffffff'],
              missingColor: '#cbd5e1',
              transform: 'linear',
            },
          },
        },
      })
    ).toThrow('increasing');
  });

  it('requires explicit mapping and unresolved policies at the command boundary', () => {
    expect(
      sequenceDataLayerCommandSchema.safeParse({
        operation: 'create',
        project: '/project',
        requestId: 'create',
      }).success
    ).toBe(false);
    expect(
      sequenceDataLayerCommandSchema.safeParse({
        operation: 'inspect',
        project: '/project',
        id: '../../outside',
      }).success
    ).toBe(false);
    expect(
      sequenceDataLayerCommandSchema.safeParse({
        operation: 'target',
        project: '/project',
        targetDocumentId: 'sequence',
      }).success
    ).toBe(true);
  });
});
