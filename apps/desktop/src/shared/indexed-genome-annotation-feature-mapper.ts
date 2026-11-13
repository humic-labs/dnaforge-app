import { annotationCanonicalIdentityV2, type Feature } from '@waypoint/genome-renderer/pure';

import type { GenomeAnnotationGlyphPayloadItem } from './indexed-genome';

const FEATURE_ID_MODULUS = 1_000_000_000;

function directionForStrand(strand: '+' | '-' | '.'): Feature['direction'] {
  if (strand === '+') return 'forward';
  if (strand === '-') return 'reverse';
  return 'none';
}

function stableRendererFeatureId(parts: readonly string[]): number {
  let hash = 0x811c9dc5;
  for (const part of parts) {
    for (let index = 0; index < part.length; index += 1) {
      hash ^= part.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    hash ^= 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % FEATURE_ID_MODULUS;
}

export function rendererFeatureCandidateFromAnnotationGlyph(input: {
  glyph: GenomeAnnotationGlyphPayloadItem;
  genomeIdentity: string;
  genomeName: string;
  color?: number;
}): Feature {
  const { glyph } = input;
  const direction = directionForStrand(glyph.strand);
  const exons = glyph.exons && glyph.exons.length > 0 ? glyph.exons : [];
  return {
    id: stableRendererFeatureId([
      input.genomeIdentity,
      input.genomeName,
      glyph.id,
      glyph.trackId ?? glyph.type,
      glyph.type,
      String(glyph.startBp),
      String(glyph.endBp),
      glyph.strand,
    ]),
    type: glyph.type,
    canonicalIdentity: annotationCanonicalIdentityV2({
      genomeIdentity: input.genomeIdentity,
      sourceId: glyph.id,
      transcriptId: glyph.transcriptId ?? null,
      trackId: glyph.trackId ?? glyph.type,
      type: glyph.type,
      startBp: glyph.startBp,
      endBp: glyph.endBp,
      direction,
    }),
    ...(glyph.trackId ? { annotationTrackId: glyph.trackId } : {}),
    ...(glyph.trackLane == null ? {} : { annotationTrackLane: glyph.trackLane }),
    ...(glyph.trackLaneCapacity == null
      ? {}
      : { annotationTrackLaneCapacity: glyph.trackLaneCapacity }),
    start: glyph.startBp,
    end: glyph.endBp,
    direction,
    displayName: glyph.label,
    color: input.color ?? glyph.color,
    lane: glyph.lane,
    ...(exons.length > 0 ? { exons } : {}),
    ...(glyph.cds ? { cds: glyph.cds } : {}),
    ...(glyph.transcriptId ? { transcriptId: glyph.transcriptId } : {}),
    sourceId: glyph.id,
    qualifiers: {
      ...(glyph.qualifiers ?? {}),
      ID: glyph.qualifiers?.ID ?? glyph.id,
      Name: glyph.label,
      _lane: String(glyph.lane),
    },
  };
}
