import type { TranscriptRecord } from '@waypoint/genome-data';
import type { Feature } from '../../../types';

import {
  buildTranscriptGlyphBlocks,
  type DirectionalBlock,
  type TranscriptGlyphFeature,
} from '../overview/transcript-glyph-vertices';
import { ANNOTATION_BAR_HEIGHT, ANNOTATION_LANE_TOTAL, type WebGLThemeMode } from '../shared/theme';
import { assignAnnotationLanes, type AnnotationLaneAssignment } from './annotation-track-draw-ops';

export interface ImportedTranscriptGlyphBuild {
  readonly blocks: ReadonlyArray<DirectionalBlock>;
  readonly assignment: AnnotationLaneAssignment;
  readonly features: ReadonlyArray<Feature>;
}

export function importedTranscriptFeature(
  record: TranscriptRecord,
  id: number,
  lane: number
): Feature {
  const qualifiers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(record.extra ?? {})) {
    if (typeof value === 'string' || typeof value === 'number') qualifiers[key] = String(value);
  }
  const firstCodingSegment =
    record.strand === '+' ? record.cds[0] : record.cds[record.cds.length - 1];
  if (!qualifiers.codon_start && firstCodingSegment?.phase !== undefined) {
    const hasGenePredFrames =
      record.extra?.exonFrames !== undefined || record.extra?.exon_frames !== undefined;
    const skip = hasGenePredFrames ? (3 - firstCodingSegment.phase) % 3 : firstCodingSegment.phase;
    qualifiers.codon_start = String(skip + 1);
  }
  return {
    id,
    lane,
    start: record.start,
    end: record.end,
    type: record.transcriptType ?? 'mRNA',
    direction: record.strand === '+' ? 'forward' : 'reverse',
    displayName: record.geneName ?? record.transcriptId,
    transcriptId: record.transcriptId,
    color: record.color ?? 0x2563eb,
    exons: record.exons.map((exon) => ({ start: exon.start + 1, end: exon.end })),
    cds: record.cds.map((segment) => ({ start: segment.start + 1, end: segment.end })),
    qualifiers,
  };
}

export function buildImportedTranscriptGlyphBlocks(input: {
  readonly records: ReadonlyArray<TranscriptRecord>;
  readonly chromosomeLength: number;
  readonly maxLanes: number;
  readonly themeMode: WebGLThemeMode;
  readonly assignment?: AnnotationLaneAssignment;
}): ImportedTranscriptGlyphBuild {
  const assignment =
    input.assignment ??
    assignAnnotationLanes(input.records, input.chromosomeLength, input.maxLanes);
  const laneByFeature = new Map<TranscriptGlyphFeature, number>();
  const features = input.records.flatMap((record, index) => {
    const lane = assignment.lanes[index];
    if (lane < 0) return [];
    const feature = importedTranscriptFeature(record, -index - 1, lane);
    laneByFeature.set(feature, lane);
    return [feature];
  });
  const blocks = buildTranscriptGlyphBlocks(features, {
    getOffset: (feature) => {
      const lane = laneByFeature.get(feature);
      return lane === undefined ? null : lane * ANNOTATION_LANE_TOTAL + ANNOTATION_LANE_TOTAL / 2;
    },
    halfHeight: ANNOTATION_BAR_HEIGHT / 2,
    themeMode: input.themeMode,
    cdsDetail: 0,
  });
  return { blocks, assignment, features };
}
