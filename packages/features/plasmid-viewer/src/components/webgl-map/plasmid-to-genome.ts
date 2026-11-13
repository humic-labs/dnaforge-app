import type { ParsedPlasmid, PlasmidFeature, Primer } from '../../types';
import { primersForSequenceDisplay } from '@waypoint/sequence-utils';
import { synthesizeTranscript } from '@waypoint/genome-data';
import type {
  Feature,
  Genome,
  GenomeOrf,
  GenomeOrfIdentity,
  Primer as GenomePrimer,
} from '@waypoint/genome-renderer';

import {
  isTranscriptSourceType,
  PRIMER_COLOR,
  PRIMER_RENDER_ID_OFFSET,
} from '@waypoint/genome-renderer';

export { PRIMER_COLOR, PRIMER_RENDER_ID_OFFSET };
export const PRIMER_PBS_COLOR = 0x8b5cf6;
export const PRIMER_OVERHANG_COLOR = 0xd97706;

export interface ConvertPlasmidOptions {
  showFeatures?: boolean;
  showPrimers?: boolean;
  orfs?: GenomeOrf[];
  candidateOrf?: GenomeOrfIdentity | null;
  editablePrimerPbsEndpoints?: boolean;
}

export function cssColorToHex(color: string): number {
  const hex = color.replace(/^#/, '');
  const parsed = parseInt(hex, 16);
  return Number.isFinite(parsed) ? parsed : 0x9ca3af;
}

function firstQualifierValues(
  qualifiers: PlasmidFeature['qualifiers']
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(qualifiers ?? {})) {
    out[key] = Array.isArray(value) ? value[0] : value;
  }
  return out;
}

function compositeGeometry(
  feature: PlasmidFeature,
  index: number
): Pick<Feature, 'exons' | 'cds' | 'transcriptId' | 'compositeKind'> {
  const supplied = {
    exons: feature.exons,
    cds: feature.cds,
    transcriptId: feature.transcriptId,
    compositeKind: feature.compositeKind,
  };
  const coding = feature.type === 'CDS';
  if (feature.exons?.length || (!coding && !isTranscriptSourceType(feature.type))) return supplied;
  const parts = feature.segments?.length
    ? feature.segments
    : [{ start: feature.start, end: feature.end }];

  if (
    feature.end < feature.start ||
    parts.some((part, i) => i > 0 && part.start < parts[i - 1].start)
  ) {
    return supplied;
  }
  const resolved = synthesizeTranscript({
    transcriptId:
      feature.transcriptId ??
      feature.qualifiers.transcript_id?.[0] ??
      feature.sourceId ??
      feature.canonicalIdentity ??
      feature.qualifiers.ID?.[0] ??
      `annotation:${index}`,
    chrom: '',
    source: '',
    type: feature.type,
    strand: feature.direction === 'forward' ? '+' : feature.direction === 'reverse' ? '-' : '.',
    exonParts: parts,

    cdsParts: coding ? [] : (feature.cds ?? []),
    attributes: Object.fromEntries(
      Object.entries(feature.qualifiers).filter(
        (entry): entry is [string, string[]] => entry[1] !== undefined
      )
    ),
    compositeKind: feature.compositeKind ?? (coding ? 'compound-cds' : 'transcript'),
  });
  return {
    exons: resolved.exons,
    cds: coding ? parts.map((part) => ({ ...part })) : resolved.cds,
    transcriptId: resolved.transcriptId,
    compositeKind: resolved.compositeKind,
  };
}

export function convertFeature(pf: PlasmidFeature, index: number): Feature {
  const qualifiers = firstQualifierValues(pf.qualifiers);
  const sourceLane = stableSourceLane(qualifiers);
  return {
    id: index,
    sourceId: pf.sourceId,
    canonicalIdentity: pf.canonicalIdentity,
    type: pf.type,
    start: pf.start - 1,
    end: pf.end,
    direction: pf.direction,
    displayName: pf.displayName,
    color: cssColorToHex(pf.color),
    outlineOnly: pf.outlineOnly,
    lane: sourceLane ?? 0,
    cdsLane: pf.type === 'CDS' ? sourceLane : undefined,
    segments: pf.segments,
    ...compositeGeometry(pf, index),
    qualifiers,
    qualifierValues: Object.fromEntries(
      Object.entries(pf.qualifiers).flatMap(([key, values]) =>
        values === undefined ? [] : [[key, [...values]]]
      )
    ),
  };
}

function stableSourceLane(qualifiers: Record<string, string | undefined>): number | undefined {
  const raw = qualifiers._lane;
  if (raw === undefined || raw === 'overflow') return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function primerRenderId(index: number): number {
  return PRIMER_RENDER_ID_OFFSET + index;
}

export function convertPrimer(
  primer: Primer,
  index: number,
  editablePbsEndpoint = false
): GenomePrimer {
  return {
    id: primer.id,
    sourcePrimerId: primer.sourcePrimerId,
    renderId: primerRenderId(index),
    name: primer.name,
    start: primer.start,
    end: primer.end,
    direction: primer.direction,
    color: PRIMER_COLOR,
    bases: primer.bases,
    overhangLength: primer.overhangLength,
    editablePbsEndpoint: editablePbsEndpoint && !primer.isScarMarkerOnly && primer.bases.length > 0,
    pbsColor: primer.pbsColor ? cssColorToHex(primer.pbsColor) : PRIMER_PBS_COLOR,
    overhangColor: primer.overhangColor
      ? cssColorToHex(primer.overhangColor)
      : PRIMER_OVERHANG_COLOR,
    cutPositionInOverhang: primer.cutPositionInOverhang,
    enzymeName: primer.enzymeName,
    suppressCutSiteRendering: primer.suppressCutSiteRendering,
    recognitionStart: primer.recognitionStart,
    recognitionEnd: primer.recognitionEnd,
    scarAbsolutePosition: primer.scarAbsolutePosition,
    cognate4bpLength: primer.cognate4bpLength,
    synthetic4bpSpacerLength: primer.synthetic4bpSpacerLength,
    spacerLength: primer.spacerLength,
    junctionIndex: primer.junctionIndex,
    isScarMarkerOnly: primer.isScarMarkerOnly,
    mismatches: primer.mismatches.map((m) => ({ position: m.position })),
    ...(primer.isDraft ? { isDraft: true } : {}),
    ...(primer.isCandidate ? { isCandidate: true } : {}),
  };
}

export function convertPlasmid(
  plasmid: ParsedPlasmid,
  options: ConvertPlasmidOptions = {}
): Genome {
  const {
    showFeatures = true,
    showPrimers = true,
    orfs,
    candidateOrf,
    editablePrimerPbsEndpoints = false,
  } = options;
  return {
    name: plasmid.name,
    length: plasmid.length,
    circular: plasmid.circular,
    features: showFeatures ? plasmid.features.map((f, i) => convertFeature(f, i)) : [],
    primers: primersForSequenceDisplay(plasmid.primers, showPrimers).map((p, i) =>
      convertPrimer(p, i, editablePrimerPbsEndpoints)
    ),
    orfs,
    candidateOrf,
    sequence: plasmid.sequence || undefined,
    strandOverrides: plasmid.strandOverrides,
    sequenceWindow: plasmid.sequenceWindow,

    geneticCode: plasmid.geneticCode,
    geneticCodeBasis: plasmid.geneticCodeBasis,
    nucleicAcid: plasmid.nucleicAcid,
  };
}
