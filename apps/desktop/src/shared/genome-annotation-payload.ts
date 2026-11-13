import type {
  GenomeFeature,
  ResolvedAnnotation,
  ResolvedGene,
  ResolvedTranscript,
} from '@waypoint/genome-data';
import { resolveTranscripts } from '../features/sequence/components/spliced-feature-resolver';
import {
  isLayerIdentityAttributeKey,
  uniqueAnnotationLayerTypes,
} from '../features/sequence/annotation-layer-identity';

const OVERVIEW_PRUNED_COMPONENT_TYPES = new Set([
  'exon',
  'CDS',
  'five_prime_UTR',
  'three_prime_UTR',
  'UTR',
  'start_codon',
  'stop_codon',
  'sig_peptide',
  'mat_peptide',
  'transit_peptide',
  'proprotein',
  'misc_feature',
  'source',
]);

const OVERVIEW_ATTRIBUTE_KEYS = new Set([
  'ID',
  'Name',
  'gene',
  'gene_name',
  'locus_tag',
  'product',
  'transcript_id',
  '_lane',
]);

export function compactRawAnnotationsForTile(
  rawFeatures: GenomeFeature[],
  options: { preserveResolvedCds?: boolean } = {}
): ResolvedAnnotation[] {
  return compactOverviewAnnotations(
    resolveTranscripts(rawFeatures),
    options.preserveResolvedCds ?? false
  );
}

function compactOverviewAnnotations(
  annotations: ResolvedAnnotation[],
  preserveResolvedCds: boolean
): ResolvedAnnotation[] {
  const compacted: ResolvedAnnotation[] = [];
  for (const annotation of annotations) {
    if (!isOverviewAnnotationPayloadEligible(annotation, preserveResolvedCds)) continue;
    if ('transcripts' in annotation && Array.isArray(annotation.transcripts)) {
      compacted.push(compactGene(annotation));
      continue;
    }
    if ('exons' in annotation && 'cds' in annotation && Array.isArray(annotation.exons)) {
      compacted.push(compactTranscript(annotation));
      continue;
    }
    compacted.push(compactFeature(annotation));
  }
  return compacted;
}

function isOverviewAnnotationPayloadEligible(
  annotation: ResolvedAnnotation,
  preserveResolvedCds: boolean
): boolean {
  if ('transcripts' in annotation && Array.isArray(annotation.transcripts)) return true;
  if (
    preserveResolvedCds &&
    annotation.type === 'CDS' &&
    'exons' in annotation &&
    'cds' in annotation &&
    Array.isArray(annotation.exons) &&
    Array.isArray(annotation.cds)
  )
    return true;
  if (OVERVIEW_PRUNED_COMPONENT_TYPES.has(annotation.type)) return false;
  return true;
}

function compactGene(gene: ResolvedGene): ResolvedGene {
  return {
    ...compactFeature(gene),
    geneId: gene.geneId,
    transcripts: gene.transcripts.map(compactTranscript),
  };
}

function compactTranscript(transcript: ResolvedTranscript): ResolvedTranscript {
  return {
    ...compactFeature(transcript),
    transcriptId: transcript.transcriptId,
    ...(transcript.geneId ? { geneId: transcript.geneId } : {}),
    exons: transcript.exons.map((part) => ({ start: part.start, end: part.end })),
    cds: transcript.cds.map((part) => ({ start: part.start, end: part.end })),
  };
}

function compactFeature(feature: GenomeFeature): GenomeFeature {
  return {
    chrom: feature.chrom,
    source: feature.source,
    type: feature.type,
    start: feature.start,
    end: feature.end,
    score: feature.score,
    strand: feature.strand,
    phase: feature.phase,
    attributes: pickOverviewAttributes(feature.attributes),
    raw: '',
  };
}

function pickOverviewAttributes(attributes: Record<string, string[]>): Record<string, string[]> {
  const picked: Record<string, string[]> = {};
  for (const [key, values] of Object.entries(attributes)) {
    if (!values || values.length === 0) continue;
    if (OVERVIEW_ATTRIBUTE_KEYS.has(key) || isLayerIdentityAttributeKey(key)) {
      picked[key] = values.slice(0, 4);
    }
  }
  return picked;
}

export interface BudgetedAnnotationPayload {
  features: ResolvedAnnotation[];
  featureModel: 'resolved-transcript-v2';
  sourceRecordCount: number;
  sourceRepresentationComplete: boolean;
  layerTypes: string[];
  byteCount: number;
  message: string;
}

export interface ExactAnnotationOwnerPayload {
  features: ResolvedAnnotation[];
  featureModel: 'resolved-transcript-v2';
  sourceRecordCount: number;
  sourceRepresentationComplete: true;
  layerTypes: string[];
  byteCount: number;
}

export function createExactAnnotationOwnerPayload(input: {
  rawFeatures: GenomeFeature[];
  ownerStart: number;
  ownerEnd: number;
}): ExactAnnotationOwnerPayload {
  const resolved = compactRawAnnotationsForTile(input.rawFeatures, { preserveResolvedCds: true });
  const features: ResolvedAnnotation[] = [];
  for (const annotation of resolved) {
    if (isResolvedGene(annotation)) {
      for (const transcript of annotation.transcripts) {
        if (isOwnedByStart(transcript, input.ownerStart, input.ownerEnd)) {
          features.push(transcript);
        }
      }
      continue;
    }
    if (isOwnedByStart(annotation, input.ownerStart, input.ownerEnd)) {
      features.push(annotation);
    }
  }
  return {
    features,
    featureModel: 'resolved-transcript-v2',
    sourceRecordCount: input.rawFeatures.length,
    sourceRepresentationComplete: true,
    layerTypes: uniqueAnnotationLayerTypes(input.rawFeatures),
    byteCount: estimateFeatureBytes(features),
  };
}

export function createBudgetedBestAvailableAnnotationPayload(input: {
  rawFeatures: GenomeFeature[];
  byteBudget: number;
}): BudgetedAnnotationPayload {
  const compacted = compactRawAnnotationsForTile(input.rawFeatures);
  const capped = capFeaturesToByteBudget(compacted, input.byteBudget);
  return {
    features: capped,
    featureModel: 'resolved-transcript-v2',
    sourceRecordCount: input.rawFeatures.length,
    sourceRepresentationComplete: capped.length === compacted.length,
    layerTypes: uniqueAnnotationLayerTypes(input.rawFeatures),
    byteCount: estimateFeatureBytes(capped),
    message:
      capped.length < compacted.length
        ? `Annotation viewport tile was capped to ${input.byteBudget} bytes.`
        : 'Annotation viewport tile was compacted to fit the byte budget.',
  };
}

export function capFeaturesToByteBudget<T extends GenomeFeature>(
  features: T[],
  byteBudget: number
): T[] {
  const capped: T[] = [];
  let used = 0;
  for (const feature of features) {
    const featureBytes = estimateFeatureBytes([feature]);
    if (used + featureBytes > byteBudget) break;
    capped.push(feature);
    used += featureBytes;
  }
  return capped;
}

export function estimateFeatureBytes(features: GenomeFeature[]): number {
  let total = 0;
  for (const feature of features) {
    total += feature.raw.length + 128;
  }
  return total;
}

function isResolvedGene(annotation: ResolvedAnnotation): annotation is ResolvedGene {
  return 'transcripts' in annotation && Array.isArray(annotation.transcripts);
}

function isOwnedByStart(feature: GenomeFeature, ownerStart: number, ownerEnd: number): boolean {
  return feature.start >= ownerStart && feature.start < ownerEnd;
}
