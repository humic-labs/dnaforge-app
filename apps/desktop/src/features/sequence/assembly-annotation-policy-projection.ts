import type { GenomeFeature } from '@waypoint/genome-data';
import { assignFeatureLanesByType } from '@waypoint/genome-renderer/pure';

import { annotationLayerType } from './annotation-layer-identity';
import type { TranscriptCarrierFeature } from './components/indexed-genome-legacy-adapter';
import {
  collapseToCanonicalIsoforms,
  type TranscriptDisplayMode,
} from './components/isoform-collapse';

export const ASSEMBLY_ANNOTATION_TYPE_ORDER = [
  'gene',
  'mRNA',
  'lncRNA',
  'ncRNA',
  'miRNA',
  'snoRNA',
  'tRNA',
] as const;

const ASSEMBLY_ANNOTATION_SPACER_LANES = 1;
const EMPTY_EXPANDED_GENE_IDS: ReadonlySet<string> = new Set<string>();

export type AssemblyAnnotationLaneLimit = number | null;

export interface AssemblyAnnotationSourceGeometry {
  chrom: string;
  type: string;
  start: number;
  end: number;
  strand: GenomeFeature['strand'];
  segments?: ReadonlyArray<{ start: number; end: number }>;
  exons?: ReadonlyArray<{ start: number; end: number }>;
  cds?: ReadonlyArray<{ start: number; end: number }>;
  transcriptId?: string;
}

export interface AssemblyAnnotationPolicyIrFeature {
  stableFeatureIdentity: string;
  sourceFeature: TranscriptCarrierFeature;
  sourceGeometry: AssemblyAnnotationSourceGeometry;
  annotationType: string;
  expandedLane: number;
  expandedTrackLane: number;
  canonicalLane: number | null;
  canonicalTrackLane: number | null;
}

export interface AssemblyAnnotationPolicyProjectionIr {
  chrom: string;
  chromosomeLengthBp: number;
  features: ReadonlyArray<AssemblyAnnotationPolicyIrFeature>;
  expandedBandOrder: ReadonlyArray<string>;
  canonicalBandOrder: ReadonlyArray<string>;
}

export interface ProjectedAssemblyAnnotationFeature {
  stableFeatureIdentity: string;
  sourceFeature: TranscriptCarrierFeature;
  sourceGeometry: AssemblyAnnotationSourceGeometry;
  annotationType: string;
  lane: number;
  trackLane: number;
}

export interface AssemblyAnnotationPolicyProjection {
  features: ReadonlyArray<ProjectedAssemblyAnnotationFeature>;
  droppedCount: number;
  typeFilteredCount: number;
}

interface SourceRecord {
  stableFeatureIdentity: string;
  feature: TranscriptCarrierFeature;
  sourceGeometry: AssemblyAnnotationSourceGeometry;
  annotationType: string;
}

interface UncappedLaneProjection {
  laneByIdentity: ReadonlyMap<string, number>;
  trackLaneByIdentity: ReadonlyMap<string, number>;
  bandOrder: ReadonlyArray<string>;
}

export function buildAssemblyAnnotationPolicyProjectionIr(input: {
  chrom: string;
  chromosomeLengthBp: number;
  resolvedExpandedFeatures: ReadonlyArray<TranscriptCarrierFeature>;
}): AssemblyAnnotationPolicyProjectionIr {
  const sourceRecords = buildSourceRecords(input.chrom, input.resolvedExpandedFeatures);
  const expanded = assignUncappedLanes(sourceRecords, input.chromosomeLengthBp);

  const recordsByFeature = new Map<TranscriptCarrierFeature, SourceRecord[]>();
  for (const record of sourceRecords) {
    const records = recordsByFeature.get(record.feature);
    if (records) records.push(record);
    else recordsByFeature.set(record.feature, [record]);
  }
  const canonicalFeatures = collapseToCanonicalIsoforms(
    sourceRecords.map((record) => record.feature),
    { mode: 'canonical', expandedGeneIds: EMPTY_EXPANDED_GENE_IDS }
  );
  const canonicalRecords: SourceRecord[] = [];
  const canonicalOccurrenceByFeature = new Map<TranscriptCarrierFeature, number>();
  for (const feature of canonicalFeatures) {
    const occurrence = canonicalOccurrenceByFeature.get(feature) ?? 0;
    const record = recordsByFeature.get(feature)?.[occurrence];
    if (!record) {
      throw new Error('Canonical annotation projection returned a feature outside its source IR');
    }
    canonicalOccurrenceByFeature.set(feature, occurrence + 1);
    canonicalRecords.push(record);
  }
  const canonical = assignUncappedLanes(canonicalRecords, input.chromosomeLengthBp);

  const features = sourceRecords.map((record): AssemblyAnnotationPolicyIrFeature => {
    const expandedLane = expanded.laneByIdentity.get(record.stableFeatureIdentity);
    const expandedTrackLane = expanded.trackLaneByIdentity.get(record.stableFeatureIdentity);
    if (expandedLane === undefined || expandedTrackLane === undefined) {
      throw new Error('Uncapped expanded annotation projection dropped a source feature');
    }
    return {
      stableFeatureIdentity: record.stableFeatureIdentity,
      sourceFeature: record.feature,
      sourceGeometry: record.sourceGeometry,
      annotationType: record.annotationType,
      expandedLane,
      expandedTrackLane,
      canonicalLane: canonical.laneByIdentity.get(record.stableFeatureIdentity) ?? null,
      canonicalTrackLane: canonical.trackLaneByIdentity.get(record.stableFeatureIdentity) ?? null,
    };
  });

  return {
    chrom: input.chrom,
    chromosomeLengthBp: input.chromosomeLengthBp,
    features,
    expandedBandOrder: expanded.bandOrder,
    canonicalBandOrder: canonical.bandOrder,
  };
}

export function projectAssemblyAnnotationPolicy(
  ir: AssemblyAnnotationPolicyProjectionIr,
  input: {
    isoformMode: TranscriptDisplayMode;
    laneLimit: AssemblyAnnotationLaneLimit;
  }
): AssemblyAnnotationPolicyProjection {
  const canonical = input.isoformMode === 'canonical';
  const typeFilteredCount = canonical
    ? ir.features.reduce((count, feature) => count + (feature.canonicalLane === null ? 0 : 1), 0)
    : ir.features.length;
  const normalizedLimit = normalizeLaneLimit(input.laneLimit);
  const bandOrder = canonical ? ir.canonicalBandOrder : ir.expandedBandOrder;
  const presentTypes = new Set(bandOrder);
  const fixedBandCapacity = normalizedLimit !== null && !presentTypes.has('CDS');
  const laneStartByType =
    normalizedLimit === null
      ? null
      : finiteLaneStarts(ir.features, canonical, bandOrder, normalizedLimit, fixedBandCapacity);

  const features: ProjectedAssemblyAnnotationFeature[] = [];
  for (const feature of ir.features) {
    const uncappedLane = canonical ? feature.canonicalLane : feature.expandedLane;
    const trackLane = canonical ? feature.canonicalTrackLane : feature.expandedTrackLane;
    if (uncappedLane === null || trackLane === null) continue;
    if (normalizedLimit !== null && trackLane >= normalizedLimit) continue;
    const lane =
      laneStartByType === null
        ? uncappedLane
        : (laneStartByType.get(feature.annotationType) ?? 0) + trackLane;
    features.push({
      stableFeatureIdentity: feature.stableFeatureIdentity,
      sourceFeature: feature.sourceFeature,
      sourceGeometry: feature.sourceGeometry,
      annotationType: feature.annotationType,
      lane,
      trackLane,
    });
  }

  return {
    features,
    droppedCount: typeFilteredCount - features.length,
    typeFilteredCount,
  };
}

function buildSourceRecords(
  chrom: string,
  features: ReadonlyArray<TranscriptCarrierFeature>
): SourceRecord[] {
  const occurrenceByBaseIdentity = new Map<string, number>();
  const records: SourceRecord[] = [];
  for (const feature of features) {
    if (feature.chrom !== chrom) continue;
    const baseIdentity = stableSourceFeatureIdentity(feature);
    const occurrence = occurrenceByBaseIdentity.get(baseIdentity) ?? 0;
    occurrenceByBaseIdentity.set(baseIdentity, occurrence + 1);
    records.push({
      stableFeatureIdentity: `${baseIdentity}#${occurrence}`,
      feature,
      sourceGeometry: sourceGeometry(feature),
      annotationType: annotationLayerType(feature),
    });
  }
  return records;
}

function assignUncappedLanes(
  records: ReadonlyArray<SourceRecord>,
  chromosomeLengthBp: number
): UncappedLaneProjection {
  const result = assignFeatureLanesByType(
    records.map((record) => ({
      start: record.feature.start,
      end: record.feature.end,
      type: record.annotationType,
    })),
    chromosomeLengthBp,
    { typeOrder: ASSEMBLY_ANNOTATION_TYPE_ORDER }
  );
  const laneByIdentity = new Map<string, number>();
  const trackLaneByIdentity = new Map<string, number>();
  for (let index = 0; index < records.length; index += 1) {
    const lane = result.laneAssignments.get(index);
    const trackLane = result.localLaneAssignments.get(index);
    if (lane !== undefined) laneByIdentity.set(records[index].stableFeatureIdentity, lane);
    if (trackLane !== undefined) {
      trackLaneByIdentity.set(records[index].stableFeatureIdentity, trackLane);
    }
  }
  return {
    laneByIdentity,
    trackLaneByIdentity,
    bandOrder: result.byType.map((band) => band.type),
  };
}

function finiteLaneStarts(
  features: ReadonlyArray<AssemblyAnnotationPolicyIrFeature>,
  canonical: boolean,
  bandOrder: ReadonlyArray<string>,
  laneLimit: number,
  fixedBandCapacity: boolean
): ReadonlyMap<string, number> {
  const laneStartByType = new Map<string, number>();
  let laneCursor = 0;
  for (let bandIndex = 0; bandIndex < bandOrder.length; bandIndex += 1) {
    const type = bandOrder[bandIndex];
    laneStartByType.set(type, laneCursor);
    let realizedLaneCount = 0;
    for (const feature of features) {
      if (feature.annotationType !== type) continue;
      const trackLane = canonical ? feature.canonicalTrackLane : feature.expandedTrackLane;
      if (trackLane === null || trackLane >= laneLimit) continue;
      realizedLaneCount = Math.max(realizedLaneCount, trackLane + 1);
    }
    const laneCapacity = fixedBandCapacity ? laneLimit : realizedLaneCount;
    laneCursor += laneCapacity;
    if (laneCapacity > 0 && bandIndex < bandOrder.length - 1) {
      laneCursor += ASSEMBLY_ANNOTATION_SPACER_LANES;
    }
  }
  return laneStartByType;
}

function normalizeLaneLimit(laneLimit: AssemblyAnnotationLaneLimit): number | null {
  return laneLimit === null ? null : Math.max(0, Math.trunc(laneLimit));
}

function stableSourceFeatureIdentity(feature: GenomeFeature): string {
  const sourceId =
    feature.attributes.ID?.[0] ??
    feature.attributes.transcript_id?.[0] ??
    feature.attributes.Name?.[0] ??
    '';
  return [
    annotationLayerType(feature),
    feature.type,
    sourceId,
    feature.chrom,
    feature.start,
    feature.end,
    feature.strand,
  ].join('|');
}

function sourceGeometry(feature: TranscriptCarrierFeature): AssemblyAnnotationSourceGeometry {
  const resolved = feature as TranscriptCarrierFeature & {
    segments?: ReadonlyArray<{ start: number; end: number }>;
    exons?: ReadonlyArray<{ start: number; end: number }>;
    cds?: ReadonlyArray<{ start: number; end: number }>;
    transcriptId?: string;
  };
  const exons = feature._resolvedExons ?? resolved.exons;
  const cds = feature._resolvedCds ?? resolved.cds;
  const transcriptId = feature._resolvedTranscriptId ?? resolved.transcriptId;
  return {
    chrom: feature.chrom,
    type: feature.type,
    start: feature.start,
    end: feature.end,
    strand: feature.strand,
    ...(resolved.segments ? { segments: resolved.segments } : {}),
    ...(exons ? { exons } : {}),
    ...(cds ? { cds } : {}),
    ...(transcriptId ? { transcriptId } : {}),
  };
}
