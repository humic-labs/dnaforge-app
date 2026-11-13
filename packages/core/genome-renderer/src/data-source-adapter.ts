import type {
  GenomeDataSource,
  GenomeFeature,
  InMemoryGenomeManifest,
  ZoomLevel,
} from '@waypoint/genome-data';

import { assignFeatureLanes } from './geometry/lane-assignment';
import { featureTypeColor } from './feature-colors';
import { genomeFeatures, type Feature, type Genome } from './types';

const FEATURE_ID_MODULUS = 1_000_000_000;

export interface MaterializeGenomeDataSourceRangeInput {
  source: GenomeDataSource;
  chrom: string;
  start: number;
  end: number;
  zoomLevel: ZoomLevel;
  name?: string;
  circular?: boolean;
}

export interface MaterializedGenomeDataSourceRange {
  genome: Genome;
  range: [number, number];
  rawFeatureCount: number;
}

export async function materializeGenomeDataSourceRange(
  input: MaterializeGenomeDataSourceRangeInput
): Promise<MaterializedGenomeDataSourceRange> {
  const length = await input.source.getChromosomeLength(input.chrom);
  const range = normalizeRange(input.start, input.end, length);
  const rawFeatures = await input.source.getFeatures(
    input.chrom,
    range[0],
    range[1],
    input.zoomLevel
  );
  const features = rawFeatures
    .filter((feature) => feature.chrom === input.chrom)
    .filter((feature) => feature.end > range[0] && feature.start < range[1])
    .map(indexedFeatureToRendererFeature)
    .sort(compareRendererFeatures);

  const laneAssignments = assignFeatureLanes(features, length).laneAssignments;
  const featuresWithLanes = features.map((feature, index) => ({
    ...feature,
    lane: laneAssignments.get(index) ?? 0,
  }));

  return {
    range,
    rawFeatureCount: rawFeatures.length,
    genome: {
      name: input.name ?? input.chrom,
      length,
      circular: input.circular ?? false,
      features: featuresWithLanes,
      sequence: undefined,
    },
  };
}

function indexedFeatureToRendererFeature(feature: GenomeFeature): Feature {
  return {
    id: stableRendererFeatureId(feature),
    type: feature.type,
    start: feature.start,
    end: feature.end,
    direction: directionForStrand(feature.strand),
    displayName: featureDisplayName(feature),
    color: featureTypeColor(feature.type),
    lane: 0,
    qualifiers: firstAttributeValues(feature.attributes),
  };
}

function normalizeRange(start: number, end: number, length: number): [number, number] {
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new Error(`Range must be finite, got ${start}-${end}`);
  }
  const normalizedStart = Math.trunc(start);
  const normalizedEnd = Math.trunc(end);
  if (normalizedStart < 0 || normalizedEnd < 0 || normalizedEnd < normalizedStart) {
    throw new Error(`Invalid 0-based half-open range ${start}-${end}`);
  }
  return [Math.min(normalizedStart, length), Math.min(normalizedEnd, length)];
}

function directionForStrand(strand: GenomeFeature['strand']): Feature['direction'] {
  if (strand === '+') return 'forward';
  if (strand === '-') return 'reverse';
  return 'none';
}

function featureDisplayName(feature: GenomeFeature): string {
  return (
    firstAttribute(feature, 'Name') ??
    firstAttribute(feature, 'gene') ??
    firstAttribute(feature, 'locus_tag') ??
    firstAttribute(feature, 'product') ??
    firstAttribute(feature, 'mobile_element_type') ??
    firstAttribute(feature, 'ID') ??
    feature.type
  );
}

function firstAttribute(feature: GenomeFeature, key: string): string | undefined {
  return feature.attributes[key]?.[0];
}

function firstAttributeValues(attributes: Record<string, string[]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, values] of Object.entries(attributes)) {
    const first = values[0];
    if (first !== undefined) out[key] = first;
  }
  return out;
}

function stableRendererFeatureId(feature: GenomeFeature): number {
  return stableUint32([
    feature.chrom,
    feature.source,
    feature.type,
    String(feature.start),
    String(feature.end),
    feature.strand,
    feature.phase ?? '',
    String(feature.fileOffset ?? ''),
    featureDisplayName(feature),
  ]);
}

function stableUint32(parts: string[]): number {
  let hash = 0x811c9dc5;
  for (const part of parts) {
    for (let i = 0; i < part.length; i += 1) {
      hash ^= part.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    hash ^= 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % FEATURE_ID_MODULUS;
}

function compareRendererFeatures(a: Feature, b: Feature): number {
  return (
    a.start - b.start ||
    a.end - b.end ||
    a.type.localeCompare(b.type) ||
    a.displayName.localeCompare(b.displayName) ||
    a.id - b.id
  );
}

export function rendererGenomeToInMemoryManifest(genome: Genome): InMemoryGenomeManifest {
  const chrom = genome.name || 'sequence';
  const features: GenomeFeature[] = genomeFeatures(genome).map((feature) =>
    rendererFeatureToGenomeFeature(feature, chrom)
  );
  return {
    chrom,
    sequence: genome.sequence ?? '',
    features,
    circular: genome.circular,
  };
}

function rendererFeatureToGenomeFeature(feature: Feature, chrom: string): GenomeFeature {
  const strand = strandForDirection(feature.direction);
  const attributes = qualifiersToAttributes(feature.qualifiers, feature.displayName, feature.type);
  const gffStart = feature.start + 1;
  const gffEnd = feature.end;
  const attrString = attributes
    ? Object.entries(attributes)
        .map(([k, vs]) => `${k}=${vs.map(encodeGffAttrValue).join(',')}`)
        .join(';')
    : '.';
  const raw = `${chrom}\trenderer\t${feature.type}\t${gffStart}\t${gffEnd}\t.\t${strand}\t.\t${attrString}`;
  return {
    chrom,
    source: 'renderer',
    type: feature.type,
    start: feature.start,
    end: feature.end,
    score: null,
    strand,
    phase: null,
    attributes: attributes ?? {},
    raw,
  };
}

function strandForDirection(direction: Feature['direction']): GenomeFeature['strand'] {
  if (direction === 'forward') return '+';
  if (direction === 'reverse') return '-';
  return '.';
}

function qualifiersToAttributes(
  qualifiers: Record<string, string | undefined> | undefined,
  displayName: string,
  type: string
): Record<string, string[]> | null {
  const out: Record<string, string[]> = {};
  if (qualifiers) {
    for (const [k, v] of Object.entries(qualifiers)) {
      if (typeof v === 'string' && v.length > 0) {
        out[k] = [v];
      }
    }
  }
  if (displayName && displayName !== type) {
    const recognized = ['Name', 'gene', 'locus_tag', 'product', 'ID'];
    const alreadyHasLabel = recognized.some((key) => out[key]?.[0] === displayName);
    if (!alreadyHasLabel) {
      out.Name = [displayName];
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

function encodeGffAttrValue(value: string): string {
  return value.replace(/[\\;,=&\t\n]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}
