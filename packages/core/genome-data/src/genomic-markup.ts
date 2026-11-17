import { compileDataColors, dataColor, type DataColorScale } from '@waypoint/platform';

export interface GenomicMarkupReference {
  readonly id: string;
  readonly chrom: string;
  readonly length: number;
}

export interface GenomicMarkupObservation {
  readonly id: string;
  readonly start: number;
  readonly end: number;
  readonly value: number | null;
  readonly annotationId?: string;
  readonly label?: string;
}

export interface GenomicMarkupSample {
  readonly id: string;
  readonly label: string;
  readonly observations: readonly GenomicMarkupObservation[];
}

export interface GenomicMarkupDataset {
  readonly id: string;
  readonly reference: GenomicMarkupReference;
  readonly unit: string;
  readonly samples: readonly GenomicMarkupSample[];
}

export interface GenomicMarkupSourceWindow {
  readonly reference: GenomicMarkupReference;
  readonly start: number;
  readonly end: number;
}

export interface GenomicMarkupStyle {
  readonly geometry: 'bars' | 'band' | 'points' | 'arcs' | 'matrix';
  readonly colorScale: DataColorScale;
}

export interface ResolvedGenomicMarkupObservation extends GenomicMarkupObservation {
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly color: string;
}

export interface ResolvedGenomicMarkupSample {
  readonly sampleId: string;
  readonly label: string;
  readonly records: readonly ResolvedGenomicMarkupObservation[];
}

export interface ResolvedGenomicMarkup {
  readonly datasetId: string;
  readonly sampleId: string;
  readonly reference: GenomicMarkupReference;
  readonly window: Readonly<{ start: number; end: number }>;
  readonly unit: string;
  readonly style: GenomicMarkupStyle;
  readonly records: readonly ResolvedGenomicMarkupObservation[];
  readonly sampleRows: readonly ResolvedGenomicMarkupSample[];
  readonly annotationAggregation: 'none' | 'mean';
  readonly annotationValues: ReadonlyMap<string, number | null>;
  readonly annotationColors: ReadonlyMap<string, string>;
}

export function resolveGenomicMarkup({
  dataset,
  sampleId,
  window,
  style,
  annotationAggregation,
}: {
  readonly dataset: GenomicMarkupDataset;
  readonly sampleId: string;
  readonly window: GenomicMarkupSourceWindow;
  readonly style: GenomicMarkupStyle;
  readonly annotationAggregation?: 'mean';
}): ResolvedGenomicMarkup {
  requireIdentifier(dataset.id, 'Dataset');
  requireReference(dataset.reference);
  requireReference(window.reference);
  if (
    dataset.reference.id !== window.reference.id ||
    dataset.reference.chrom !== window.reference.chrom ||
    dataset.reference.length !== window.reference.length
  ) {
    throw new Error('Genomic markup source and viewer must use the same reference.');
  }
  requireInterval(window.start, window.end, window.reference.length);
  if (!['bars', 'band', 'points', 'arcs', 'matrix'].includes(style.geometry)) {
    throw new Error('Unsupported genomic markup geometry.');
  }
  if (style.geometry === 'matrix' && dataset.samples.length > 32) {
    throw new Error('Genomic markup matrices support at most 32 source samples.');
  }
  if (annotationAggregation !== undefined && annotationAggregation !== 'mean') {
    throw new Error('Unsupported genomic markup annotation aggregation.');
  }
  const sampleIds = new Set<string>();
  for (const sample of dataset.samples) {
    requireIdentifier(sample.id, 'Sample');
    if (sampleIds.has(sample.id)) throw new Error('Genomic markup sample IDs must be unique.');
    sampleIds.add(sample.id);
  }
  const sample = dataset.samples.find((candidate) => candidate.id === sampleId);
  if (!sample) throw new Error(`Unknown genomic markup sample: ${sampleId}.`);
  const sampleRows: ResolvedGenomicMarkupSample[] = [];
  const annotationRows: Array<{ annotationId: string; value: number | null }> = [];
  for (const sourceSample of style.geometry === 'matrix' ? dataset.samples : [sample]) {
    const observationIds = new Set<string>();
    const records: ResolvedGenomicMarkupObservation[] = [];
    for (const observation of sourceSample.observations) {
      requireIdentifier(observation.id, 'Observation');
      if (observationIds.has(observation.id)) {
        throw new Error('Genomic markup observation IDs must be unique within a sample.');
      }
      observationIds.add(observation.id);
      requireInterval(observation.start, observation.end, dataset.reference.length);
      if (observation.value !== null && !Number.isFinite(observation.value)) {
        throw new Error('Genomic markup values must be finite numbers or null.');
      }
      if (observation.annotationId !== undefined) {
        requireIdentifier(observation.annotationId, 'Annotation');
        if (sourceSample.id === sampleId) {
          annotationRows.push({ annotationId: observation.annotationId, value: observation.value });
        }
      }
      if (observation.end <= window.start || observation.start >= window.end) continue;
      const color = dataColor(observation.value, style.colorScale);
      requireColor(color);
      records.push({
        ...observation,
        sourceStart: observation.start,
        sourceEnd: observation.end,
        start: Math.max(observation.start, window.start) - window.start,
        end: Math.min(observation.end, window.end) - window.start,
        color,
      });
    }
    sampleRows.push({
      sampleId: sourceSample.id,
      label: sourceSample.label,
      records,
    });
  }
  const colorRows =
    annotationAggregation === 'mean' ? meanAnnotationRows(annotationRows) : annotationRows;
  const annotationColors = new Map(
    compileDataColors({
      records: colorRows,
      bindings: colorRows.map((row, inputIndex) => ({ inputIndex, target: row.annotationId })),
      targetKey: (target) => target,
      color: (row) => dataColor(row.value, style.colorScale),
    }).map(({ target, color }) => [target, color])
  );
  return {
    datasetId: dataset.id,
    sampleId,
    reference: dataset.reference,
    window: { start: window.start, end: window.end },
    unit: dataset.unit,
    style,
    records: sampleRows.find((row) => row.sampleId === sampleId)!.records,
    sampleRows,
    annotationAggregation: annotationAggregation ?? 'none',
    annotationValues: new Map(colorRows.map(({ annotationId, value }) => [annotationId, value])),
    annotationColors,
  };
}

function meanAnnotationRows(
  rows: readonly { annotationId: string; value: number | null }[]
): Array<{ annotationId: string; value: number | null }> {
  const values = new Map<string, number[]>();
  for (const row of rows) {
    const group = values.get(row.annotationId) ?? [];
    if (row.value !== null) group.push(row.value);
    values.set(row.annotationId, group);
  }
  return [...values].map(([annotationId, group]) => ({
    annotationId,
    value: group.length ? group.reduce((sum, value) => sum + value / group.length, 0) : null,
  }));
}

function requireReference(reference: GenomicMarkupReference): void {
  requireIdentifier(reference.id, 'Reference');
  requireIdentifier(reference.chrom, 'Chromosome');
  if (!Number.isSafeInteger(reference.length) || reference.length <= 0) {
    throw new Error('Genomic markup reference length must be a positive integer.');
  }
}

function requireIdentifier(value: string, kind: string): void {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${kind} needs a stable ID.`);
}

function requireInterval(start: number, end: number, length: number): void {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start ||
    end > length
  ) {
    throw new Error('Genomic markup intervals must be valid 0-based half-open source ranges.');
  }
}

function requireColor(color: string): void {
  if (!/^#[0-9a-f]{6}$/i.test(color)) {
    throw new Error('Genomic markup colors must be six-digit hex colors.');
  }
}
