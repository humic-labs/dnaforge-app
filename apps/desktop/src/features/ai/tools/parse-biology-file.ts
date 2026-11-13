
import { isGff3Format, parseGff3AsPlasmid, type PlasmidFeature } from '@waypoint/plasmid-viewer';
import {
  decodeSequenceDocument,
  type AnnotatedSequence,
  type Annotation,
  type SequenceDocument,
  type SequenceFormat,
} from '@waypoint/sequence-utils';
import { platform } from '../../../platform';
import { HARD_CAP_BYTES } from '../../../shared/oversized-guard';

export type BiologyFormat = Extract<SequenceFormat, 'genbank' | 'fasta'> | 'gff3';

export interface BiologyFeature {
  displayName: string;
  type: string;
  start: number;
  end: number;
  direction: 'forward' | 'reverse' | 'none';
  color?: string;
  qualifiers: Record<string, string[]>;
  segments?: Array<{ start: number; end: number }>;
  exons?: Array<{ start: number; end: number }>;
  cds?: Array<{ start: number; end: number }>;
  transcriptId?: string;
}

export interface ParsedBiologyFile {
  format: BiologyFormat;
  sequence: AnnotatedSequence;
  features: BiologyFeature[];
  content: string;
}

export async function parseBiologyFile(absolutePath: string): Promise<ParsedBiologyFile> {
  const fileInfo = await platform().fs.stat(absolutePath);
  if (fileInfo.size > HARD_CAP_BYTES) {
    const mb = (fileInfo.size / 1024 / 1024).toFixed(1);
    const capMb = (HARD_CAP_BYTES / 1024 / 1024).toFixed(0);
    throw new Error(
      `File too large to parse in full (${mb} MB, maximum ${capMb} MB) — this is the same ` +
        `limit that applies when a person opens it. Assemblies this large are served by the ` +
        `indexed-genome path instead of being read end to end.`
    );
  }

  const content = await platform().fs.readTextFile(absolutePath);

  return parseBiologyContent(content, absolutePath);
}

export function parseBiologyContent(content: string, filePath?: string): ParsedBiologyFile {
  if (isGff3Format(content)) {
    const parsed = parseGff3AsPlasmid(content);
    const features = plasmidFeaturesToBiologyFeatures(parsed.features);
    return {
      format: 'gff3',
      sequence: {
        id: filePath ?? parsed.name,
        name: parsed.name,
        sequence: parsed.sequence,
        length: parsed.length,
        annotations: biologyFeaturesToAnnotations(features),
        circular: parsed.circular,
      },
      features,
      content,
    };
  }

  let document: SequenceDocument;
  try {
    document = decodeSequenceDocument(content, {
      path: filePath,
      filename: filePath?.split(/[\\/]/).pop(),
    });
  } catch {
    throw new Error('File is not a recognized biology format (GenBank, GFF3, or FASTA).');
  }

  if (document.format !== 'genbank' && document.format !== 'fasta') {
    throw new Error('File is not a recognized biology format (GenBank, GFF3, or FASTA).');
  }

  return {
    format: document.format,
    sequence: document.sequence,
    features: annotationsToBiologyFeatures(document.sequence.annotations),
    content,
  };
}

export function annotationsToBiologyFeatures(
  annotations: readonly Annotation[] = []
): BiologyFeature[] {
  return annotations.map((annotation) => ({
    displayName: annotation.name || annotation.type,
    type: annotation.type,
    start: annotation.start,
    end: annotation.end,
    direction:
      annotation.direction === 1 ? 'forward' : annotation.direction === -1 ? 'reverse' : 'none',
    color: annotation.color,
    qualifiers: normalizeQualifiers(annotation.qualifiers),
    segments: annotation.segments,
  }));
}

function plasmidFeaturesToBiologyFeatures(features: readonly PlasmidFeature[]): BiologyFeature[] {
  return features.map((feature) => ({
    displayName: feature.displayName || feature.type,
    type: feature.type,
    start: feature.start,
    end: feature.end,
    direction: feature.direction,
    color: feature.color,
    qualifiers: normalizeQualifiers(feature.qualifiers),
    segments: feature.segments ? [...feature.segments] : undefined,
    exons: feature.exons ? [...feature.exons] : undefined,
    cds: feature.cds ? [...feature.cds] : undefined,
    transcriptId: feature.transcriptId,
  }));
}

function biologyFeaturesToAnnotations(features: readonly BiologyFeature[]): Annotation[] {
  return features.map((feature) => ({
    name: feature.displayName,
    type: feature.type,
    start: feature.start,
    end: feature.end,
    direction:
      feature.direction === 'forward' ? 1 : feature.direction === 'reverse' ? -1 : 0,
    color: feature.color,
    qualifiers: feature.qualifiers,
    segments: feature.segments,
  }));
}

function normalizeQualifiers(
  qualifiers: Record<string, string[] | string | undefined> | undefined
): Record<string, string[]> {
  const normalized: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(qualifiers ?? {})) {
    if (Array.isArray(value)) {
      if (value.length > 0) normalized[key] = value;
    } else if (value !== undefined) {
      normalized[key] = [value];
    }
  }
  return normalized;
}
