import { withUserMessage } from '@waypoint/user-messages';
import type { GenomeFeature, GenomeFeatureDetails } from '../../../shared/indexed-genome';

export interface IndexedTranscriptIsoform {
  featureId: string;
  geneId?: string;
  name: string;
  chrom: string;
  start0: number;
  end0: number;
  strand: '+' | '-';
  isSelected: boolean;
}

export function isIndexedTranscriptFeatureType(type: string): boolean {
  const normalized = type.trim().toLowerCase().replace(/-/g, '_');
  return (
    normalized === 'transcript' ||
    normalized.endsWith('_transcript') ||
    normalized === 'mrna' ||
    normalized.endsWith('rna')
  );
}

export function resolveIndexedTranscriptIsoforms(
  details: GenomeFeatureDetails,
  selectedFeatureId: string
): IndexedTranscriptIsoform[] {
  if (details.truncated) {
    throw withUserMessage(
      new Error('The feature closure is incomplete, so alternative isoforms cannot be listed.'),
      'sequence.isoformIncomplete'
    );
  }
  const features = dedupeFeatures([
    ...(details.feature ? [details.feature] : []),
    ...details.relatedFeatures,
  ]);
  const selected = features.find(
    (feature) =>
      isIndexedTranscriptFeatureType(feature.type) &&
      featureIds(feature).includes(selectedFeatureId)
  );
  if (!selected) {
    throw new Error(
      `Transcript ${selectedFeatureId} was not present in the bounded feature closure.`
    );
  }
  const geneIds = new Set(featureParents(selected));
  const siblingRows = features.filter((feature) => {
    if (!isIndexedTranscriptFeatureType(feature.type)) return false;
    if (feature === selected) return true;
    return geneIds.size > 0 && featureParents(feature).some((parent) => geneIds.has(parent));
  });

  const isoformsById = new Map<string, IndexedTranscriptIsoform>();
  for (const feature of siblingRows) {
    const featureId = featureIds(feature)[0];
    if (!featureId || isoformsById.has(featureId)) continue;
    if (
      !Number.isSafeInteger(feature.start) ||
      !Number.isSafeInteger(feature.end) ||
      feature.start < 0 ||
      feature.end <= feature.start ||
      (feature.strand !== '+' && feature.strand !== '-')
    ) {
      if (featureId === selectedFeatureId) {
        throw new Error(`Transcript ${selectedFeatureId} has invalid coordinates or strand.`);
      }
      continue;
    }
    const geneId = featureParents(feature).find((parent) => geneIds.has(parent));
    isoformsById.set(featureId, {
      featureId,
      ...(geneId ? { geneId } : {}),
      name: featureLabel(feature, featureId),
      chrom: feature.chrom,
      start0: feature.start,
      end0: feature.end,
      strand: feature.strand,
      isSelected: featureId === selectedFeatureId,
    });
  }

  const isoforms = [...isoformsById.values()];
  if (!isoforms.some((isoform) => isoform.isSelected)) {
    throw new Error(`Transcript ${selectedFeatureId} could not be represented as an isoform.`);
  }
  return isoforms.sort(
    (left, right) =>
      Number(right.isSelected) - Number(left.isSelected) ||
      left.start0 - right.start0 ||
      left.end0 - right.end0 ||
      left.name.localeCompare(right.name) ||
      left.featureId.localeCompare(right.featureId)
  );
}

function featureIds(feature: GenomeFeature): string[] {
  return (feature.attributes.ID ?? []).map((value) => value.trim()).filter(Boolean);
}

function featureParents(feature: GenomeFeature): string[] {
  return (feature.attributes.Parent ?? []).map((value) => value.trim()).filter(Boolean);
}

function featureLabel(feature: GenomeFeature, fallback: string): string {
  for (const key of ['Name', 'transcript_name', 'transcript_id', 'Alias']) {
    const value = feature.attributes[key]?.find((candidate) => candidate.trim().length > 0);
    if (value) return value.trim();
  }
  return fallback;
}

function dedupeFeatures(features: GenomeFeature[]): GenomeFeature[] {
  const seen = new Set<string>();
  return features.filter((feature) => {
    const key = `${feature.chrom}:${feature.type}:${feature.start}:${feature.end}:${featureIds(feature).join(',')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
