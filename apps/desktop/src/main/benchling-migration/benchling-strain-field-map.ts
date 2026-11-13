import type { LimsSourceMetadata } from '../../shared/lims';
import type { BenchlingStrainField } from './native-record-classifier';
import { isBenchlingMissingSourceValue } from './benchling-source-value';

const MARKER_LABELS = new Set([
  'Resistance',
  'Resistance marker',
  'Resistance, Suppressors, Sensitivities',
  'Resistances [plasmid]',
  'Resistances, auxotrophies, sensitivities',
  'ZL_Bacterial Selection Marker',
  'ZL_Yeast Selection Marker',
]);

export function mapBenchlingStrainFields(input: {
  stableId: string;
  fields: readonly BenchlingStrainField[];
}): Record<string, unknown> {
  const mapped: Record<string, unknown> = {
    sourceMetadata: sourceMetadata(input),
  };
  addUnambiguousScalar(mapped, 'genotypeCanonical', input.fields, 'Genotype');
  addUnambiguousScalar(mapped, 'species', input.fields, 'Organism');
  addUnambiguousScalar(mapped, 'source', input.fields, 'Source');

  const markers = input.fields
    .filter(({ label, value }) => MARKER_LABELS.has(label) && !isBenchlingMissingSourceValue(value))
    .map(({ value }) => value);
  if (markers.length > 0) mapped.markers = markers;
  return mapped;
}

function addUnambiguousScalar(
  target: Record<string, unknown>,
  targetKey: string,
  fields: readonly BenchlingStrainField[],
  sourceLabel: string
): void {
  const values = fields
    .filter(({ label, value }) => label === sourceLabel && !isBenchlingMissingSourceValue(value))
    .map(({ value }) => value);
  if (values.length === 1) target[targetKey] = values[0];
}

function sourceMetadata(input: {
  stableId: string;
  fields: readonly BenchlingStrainField[];
}): LimsSourceMetadata {
  return {
    schemaVersion: 1,
    origin: {
      type: 'connector',
      connectorType: 'benchling',
      sourceName: 'Benchling strain export',
      sourceId: input.stableId,
    },
    values: groupedValues(input.fields),
    entries: input.fields.map(({ label, value, position }) => ({ label, value, position })),
  };
}

function groupedValues(fields: readonly BenchlingStrainField[]): Record<string, unknown> {
  const grouped: Record<string, unknown> = {};
  for (const { label, value } of fields) {
    const existing = grouped[label];
    if (existing === undefined) {
      grouped[label] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      grouped[label] = [existing, value];
    }
  }
  return grouped;
}
