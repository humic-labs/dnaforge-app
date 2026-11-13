import type { Annotation, AnnotatedSequence } from '@waypoint/sequence-utils';

import { untrustedField } from './sanitize';
import { displaySequenceName } from './sequence-region';
import type {
  SequenceDescriptorInput,
  FileTextMap,
  WholeEntityDescriptor,
  WholeEntityMeasured,
} from './types';

const LANDMARK_CAP = 20;
const NAME_CAP = 120;
const DEFINITION_CAP = 400;
const GIST_SOURCE_CAP = 6;

const NOTABLE_TYPES = new Set(
  [
    'cds',
    'gene',
    'mrna',
    'trna',
    'rrna',
    'ncrna',
    'rep_origin',
    'origin',
    'ori',
    'promoter',
    'terminator',
    'regulatory',
    'mobile_element',
  ].map((t) => t.toLowerCase())
);

const WHOLE_ENTITY_TOOLS = ['find_features', 'get_sequence'] as const;

function metadataString(
  metadata: Record<string, unknown> | undefined,
  keys: string[]
): string | null {
  if (!metadata) return null;
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim()) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function buildFeatureHistogram(annotations: Annotation[]): Record<string, number> {
  const histogram: Record<string, number> = {};
  for (const ann of annotations) {
    histogram[ann.type] = (histogram[ann.type] ?? 0) + 1;
  }
  return histogram;
}

function featureName(ann: Annotation): string | null {
  const raw =
    ann.name ||
    ann.label ||
    ann.qualifiers?.label?.[0] ||
    ann.qualifiers?.gene?.[0] ||
    ann.qualifiers?.product?.[0];
  return untrustedField(raw, NAME_CAP)?.value ?? null;
}

function buildLandmarks(annotations: Annotation[]): string[] {
  const notable = annotations
    .filter((a) => NOTABLE_TYPES.has(a.type.toLowerCase()))
    .map((a) => ({ name: featureName(a), size: Math.abs(a.end - a.start) }))
    .filter((x): x is { name: string; size: number } => x.name !== null);
  notable.sort((a, b) => b.size - a.size);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of notable) {
    if (seen.has(item.name)) continue;
    seen.add(item.name);
    out.push(item.name);
    if (out.length >= LANDMARK_CAP) break;
  }
  return out;
}

function buildFunctionalGist(annotations: Annotation[]): string | null {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const ann of annotations) {
    if (ann.type.toUpperCase() !== 'CDS') continue;
    const raw = ann.qualifiers?.gene?.[0] || ann.qualifiers?.product?.[0] || ann.name;
    const cleaned = untrustedField(raw, NAME_CAP)?.value;
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    names.push(cleaned);
    if (names.length >= GIST_SOURCE_CAP) break;
  }
  if (names.length === 0) return null;
  return `Encodes: ${names.join(', ')}`;
}

export function buildWholeEntityDescriptor(
  input: SequenceDescriptorInput,
  sequence: AnnotatedSequence,
  sourceVersion: number
): WholeEntityDescriptor {
  const annotations = sequence.annotations ?? [];
  const topology: 'circular' | 'linear' = sequence.circular ? 'circular' : 'linear';
  const metadata = sequence.metadata;

  const definitionRaw = sequence.description || metadataString(metadata, ['definition']);
  const organismRaw = metadataString(metadata, ['organism', 'source']);
  const taxonIdRaw = metadataString(metadata, ['taxonId', 'taxon_id', 'taxon', 'db_xref_taxon']);

  const gist = buildFunctionalGist(annotations);

  const measured: WholeEntityMeasured = {
    format:
      metadataString(metadata, ['format', 'fileFormat']) ??
      (sequence.circular ? 'genbank' : 'unknown'),
    moleculeType: metadataString(metadata, ['moleculeType', 'molType']) ?? 'DNA',
    topology,
    length: sequence.length,
    featureCount: annotations.length,
    featureHistogram: buildFeatureHistogram(annotations),
    landmarks: buildLandmarks(annotations),
    functionalGistIsInferred: gist !== null,
    metadataAvailable: {
      definition: definitionRaw !== null,
      organism: organismRaw !== null,
      taxonId: taxonIdRaw !== null,
    },
  };

  const fileText: FileTextMap = {};
  const definition = untrustedField(definitionRaw, DEFINITION_CAP, { middleOut: true });
  if (definition) fileText.definition = definition;
  const organism = untrustedField(organismRaw, NAME_CAP);
  if (organism) fileText.organism = organism;
  const taxonId = untrustedField(taxonIdRaw, 32);
  if (taxonId) fileText.taxonId = taxonId;
  if (gist) fileText.functionalGist = { value: gist, trust: 'untrusted-data' };

  const label = `${displaySequenceName(sequence, input.documentId)} — whole ${topology} sequence (${sequence.length.toLocaleString()} bp)`;

  return {
    schemaVersion: 2,
    kind: 'whole_entity',
    label,
    locator: { documentId: input.documentId },
    coordinateSystem: '1-indexed-inclusive',
    sourceVersion,
    measured,
    fileText,
    bases: 'never',
    fetch: {
      tools: [...WHOLE_ENTITY_TOOLS],
    },
  };
}
