import type { GenomeFeature, IndexedGenomeManifest } from '../../shared/indexed-genome';
import type { VariantSummary } from './variant-client';

const QUERY_WINDOW_BP = 1_000_000;
const MAX_QUERY_SPAN_BP = 2_000_000;
const MAX_REPORTED_ANNOTATIONS = 50;
const QUERY_CONCURRENCY = 4;

export interface AffectedMutationAnnotation {
  readonly type: string;
  readonly label: string;
  readonly start: number;
  readonly end: number;
  readonly strand: GenomeFeature['strand'];
}

export interface MutationCodingEffect {
  readonly label: string;
  readonly frameEffect: 'in-frame' | 'frameshift-risk' | null;
}

export interface MutationAnnotationImpact {
  readonly variantId: string;
  readonly overlapsAnnotation: boolean;
  readonly overlapsCds: boolean;
  readonly codingEffect: MutationCodingEffect | null;
  readonly annotations: ReadonlyArray<AffectedMutationAnnotation>;
  readonly hiddenAnnotationCount: number;
  readonly truncated: boolean;
}

export type MutationAnnotationImpactState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly impact: MutationAnnotationImpact }
  | { readonly status: 'unavailable'; readonly message: string };

interface AnnotationQueryGroup {
  readonly key: string;
  readonly manifest: IndexedGenomeManifest;
  readonly chrom: string;
  readonly start: number;
  readonly end: number;
  readonly variantIds: Set<string>;
}

interface VariantQueryAssignment {
  readonly variant: VariantSummary;
  readonly groupKeys: string[];
  readonly truncated: boolean;
}

type ReadFeatures = (
  manifest: IndexedGenomeManifest,
  chrom: string,
  start: number,
  end: number,
  zoomLevel: number
) => Promise<GenomeFeature[]>;

export function classifyMutationAnnotationImpact(
  variant: VariantSummary,
  features: ReadonlyArray<GenomeFeature>,
  options: { readonly truncated?: boolean } = {}
): MutationAnnotationImpact {
  const overlapping = features
    .filter(
      (feature) =>
        isMutationRelevantFeature(feature) &&
        feature.chrom === variant.chrom &&
        feature.end > variant.start &&
        feature.start < variant.end
    )
    .sort(compareAffectedFeatures);
  const unique = new Map<string, AffectedMutationAnnotation>();

  for (const feature of overlapping) {
    const annotation = affectedAnnotation(feature);
    const key = [
      annotation.type,
      annotation.label,
      annotation.start,
      annotation.end,
      annotation.strand,
    ].join('\u0000');
    if (!unique.has(key)) unique.set(key, annotation);
  }

  const allAnnotations = [...unique.values()];
  const annotations = allAnnotations.slice(0, MAX_REPORTED_ANNOTATIONS);
  const overlapsCds = allAnnotations.some((annotation) => isCdsType(annotation.type));

  return {
    variantId: variant.id,
    overlapsAnnotation: allAnnotations.length > 0,
    overlapsCds,
    codingEffect: overlapsCds ? codingEffectForVariant(variant) : null,
    annotations,
    hiddenAnnotationCount: Math.max(0, allAnnotations.length - annotations.length),
    truncated: options.truncated === true,
  };
}

export async function loadMutationAnnotationImpacts(input: {
  readonly variants: ReadonlyArray<VariantSummary>;
  readonly manifests: ReadonlyMap<string, IndexedGenomeManifest>;
  readonly readFeatures: ReadFeatures;
}): Promise<Map<string, MutationAnnotationImpactState>> {
  const result = new Map<string, MutationAnnotationImpactState>();
  const assignments = new Map<string, VariantQueryAssignment>();
  const groups = new Map<string, AnnotationQueryGroup>();

  for (const variant of input.variants) {
    const manifest = input.manifests.get(variant.chrom);
    if (!hasIndexedAnnotations(manifest)) {
      result.set(variant.id, {
        status: 'unavailable',
        message: `Reference annotations are unavailable for ${variant.chrom}.`,
      });
      continue;
    }
    const assignment = assignVariantQueries(variant, manifest, groups);
    assignments.set(variant.id, assignment);
  }

  const groupResults = new Map<string, GenomeFeature[]>();
  const groupErrors = new Map<string, string>();
  const pendingGroups = [...groups.values()];
  let nextGroupIndex = 0;

  const worker = async () => {
    while (nextGroupIndex < pendingGroups.length) {
      const group = pendingGroups[nextGroupIndex++];
      try {
        groupResults.set(
          group.key,
          await input.readFeatures(group.manifest, group.chrom, group.start, group.end, 1)
        );
      } catch (cause) {
        groupErrors.set(
          group.key,
          cause instanceof Error ? cause.message : 'Reference annotation lookup failed.'
        );
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(QUERY_CONCURRENCY, pendingGroups.length) }, async () => worker())
  );

  for (const assignment of assignments.values()) {
    const failedGroup = assignment.groupKeys.find((key) => groupErrors.has(key));
    if (failedGroup) {
      result.set(assignment.variant.id, {
        status: 'unavailable',
        message:
          groupErrors.get(failedGroup) ??
          `Reference annotations are unavailable for ${assignment.variant.chrom}.`,
      });
      continue;
    }
    const features = assignment.groupKeys.flatMap((key) => groupResults.get(key) ?? []);
    result.set(assignment.variant.id, {
      status: 'ready',
      impact: classifyMutationAnnotationImpact(assignment.variant, features, {
        truncated: assignment.truncated,
      }),
    });
  }

  return result;
}

function assignVariantQueries(
  variant: VariantSummary,
  manifest: IndexedGenomeManifest,
  groups: Map<string, AnnotationQueryGroup>
): VariantQueryAssignment {
  const chromLength = manifest.length as number;
  const span = variant.end - variant.start;
  const ranges =
    span <= MAX_QUERY_SPAN_BP
      ? [bucketRange(variant.start, variant.end, chromLength)]
      : [
          bucketRange(variant.start, variant.start + 1, chromLength),
          bucketRange(Math.max(variant.start, variant.end - 1), variant.end, chromLength),
        ];
  const groupKeys: string[] = [];

  for (const range of ranges) {
    const key = `${manifest.gffPath}\u0000${variant.chrom}\u0000${range.start}\u0000${range.end}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        manifest,
        chrom: variant.chrom,
        start: range.start,
        end: range.end,
        variantIds: new Set(),
      };
      groups.set(key, group);
    }
    group.variantIds.add(variant.id);
    if (!groupKeys.includes(key)) groupKeys.push(key);
  }

  return {
    variant,
    groupKeys,
    truncated: span > MAX_QUERY_SPAN_BP,
  };
}

function bucketRange(
  start: number,
  end: number,
  chromosomeLength: number
): { start: number; end: number } {
  const queryStart = Math.floor(start / QUERY_WINDOW_BP) * QUERY_WINDOW_BP;
  const requiredEnd = Math.ceil(end / QUERY_WINDOW_BP) * QUERY_WINDOW_BP;
  const queryEnd = Math.min(chromosomeLength, Math.max(queryStart + QUERY_WINDOW_BP, requiredEnd));
  return { start: queryStart, end: queryEnd };
}

function hasIndexedAnnotations(
  manifest: IndexedGenomeManifest | undefined
): manifest is IndexedGenomeManifest & {
  gffPath: string;
  tbiPath: string;
  length: number;
} {
  return Boolean(
    manifest &&
    typeof manifest.gffPath === 'string' &&
    manifest.gffPath.length > 0 &&
    typeof manifest.tbiPath === 'string' &&
    manifest.tbiPath.length > 0 &&
    Number.isSafeInteger(manifest.length) &&
    (manifest.length ?? 0) > 0
  );
}

function affectedAnnotation(feature: GenomeFeature): AffectedMutationAnnotation {
  return {
    type: feature.type,
    label: annotationLabel(feature),
    start: feature.start,
    end: feature.end,
    strand: feature.strand,
  };
}

function annotationLabel(feature: GenomeFeature): string {
  const type = feature.type.toLowerCase();
  const keys =
    type === 'gene'
      ? ['gene_name', 'gene', 'Name', 'locus_tag', 'ID']
      : type === 'cds'
        ? ['protein_id', 'Name', 'Parent', 'gene', 'ID']
        : type === 'exon'
          ? ['transcript_id', 'Parent', 'ID', 'gene']
          : isTranscriptType(type)
            ? ['transcript_id', 'Name', 'gene', 'ID']
            : [
                'Name',
                'gene_name',
                'gene',
                'transcript_id',
                'protein_id',
                'locus_tag',
                'ID',
                'Parent',
              ];

  for (const key of keys) {
    const value = feature.attributes[key]?.find((entry) => entry.trim().length > 0);
    if (value) return value;
  }
  return `${feature.type} ${feature.start + 1}–${feature.end}`;
}

function codingEffectForVariant(variant: VariantSummary): MutationCodingEffect {
  if (variant.variantClass === 'substitution') {
    return { label: 'CDS substitution', frameEffect: null };
  }
  if (variant.variantClass === 'structural') {
    return { label: 'Structural variant overlaps CDS', frameEffect: null };
  }
  if (variant.variantClass === 'replacement') {
    return { label: 'CDS replacement', frameEffect: null };
  }
  if (variant.variantClass === 'mixed') {
    return codingLengthEffect(variant, 'CDS mixed-allele change');
  }
  return codingLengthEffect(
    variant,
    variant.variantClass === 'insertion' ? 'CDS insertion' : 'CDS deletion'
  );
}

function codingLengthEffect(variant: VariantSummary, baseLabel: string): MutationCodingEffect {
  const deltas = variant.alts
    .filter((alt) => !isSymbolicAllele(alt))
    .map((alt) => alt.length - variant.ref.length);
  if (deltas.length === 0 || deltas.some((delta) => delta === 0)) {
    return { label: baseLabel, frameEffect: null };
  }
  const inFrame = deltas.every((delta) => Math.abs(delta) % 3 === 0);
  return {
    label: `${inFrame ? 'In-frame' : 'Frameshift-risk'} ${baseLabel}`,
    frameEffect: inFrame ? 'in-frame' : 'frameshift-risk',
  };
}

function isSymbolicAllele(allele: string): boolean {
  return allele.startsWith('<') || allele.includes('[') || allele.includes(']');
}

function isCdsType(type: string): boolean {
  return type.toLowerCase() === 'cds';
}

function isMutationRelevantFeature(feature: GenomeFeature): boolean {
  const type = feature.type.toLowerCase();
  return type !== 'region' && type !== 'chromosome';
}

function isTranscriptType(type: string): boolean {
  return (
    type === 'mrna' ||
    type === 'transcript' ||
    type.endsWith('_rna') ||
    ['lncrna', 'ncrna', 'mirna', 'snorna', 'trna', 'rrna'].includes(type)
  );
}

function compareAffectedFeatures(left: GenomeFeature, right: GenomeFeature): number {
  const typeDelta = featureTypeOrder(left.type) - featureTypeOrder(right.type);
  return (
    typeDelta ||
    left.start - right.start ||
    left.end - right.end ||
    annotationLabel(left).localeCompare(annotationLabel(right))
  );
}

function featureTypeOrder(type: string): number {
  const normalized = type.toLowerCase();
  if (normalized === 'gene') return 0;
  if (isTranscriptType(normalized)) return 1;
  if (normalized === 'exon') return 2;
  if (normalized === 'cds') return 3;
  return 4;
}
