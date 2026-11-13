import type {
  AnnotationEvidenceClass,
  CatalogRecord,
  FeatureKind,
  PromoterBox,
  PromoterRecord,
  Strand,
  TerminationMechanism,
  TerminatorPart,
  TerminatorRecord,
  TranscriptionStartSiteRecord,
  TranscriptionUnitRecord,
} from '@waypoint/genome-data/annotation-catalog';
import { recordSpan } from '@waypoint/genome-data/annotation-catalog';

import type { AnnotationCatalogGeneSpan, AnnotationCatalogTrackData } from './types';

const BASE = { name: null, conditions: [] } as const;

export function tssRecord(
  bp: number,
  strand: Strand = '+',
  score: number | null = null
): TranscriptionStartSiteRecord {
  return {
    ...BASE,
    id: `tss:${strand}:${bp}`,
    kind: 'tss',
    strand,
    score,
    location: { shape: 'point', bp },
    classification: null,
  };
}

export function promoterRecord(input: {
  start: number;
  end: number;
  strand?: Strand;
  transcriptionStartBp?: number | null;
  boxes?: PromoterBox[];
  score?: number | null;
}): PromoterRecord {
  const strand = input.strand ?? '+';
  return {
    ...BASE,
    id: `promoter:${strand}:${input.start}-${input.end}`,
    kind: 'promoter',
    strand,
    score: input.score ?? null,
    location: { shape: 'region', start: input.start, end: input.end },
    transcriptionStartBp: input.transcriptionStartBp ?? null,
    boxes: input.boxes ?? [],
    sigmaFactor: null,
  };
}

export function terminatorRecord(input: {
  start: number;
  end: number;
  strand?: Strand;
  mechanism?: TerminationMechanism;
  parts?: TerminatorPart[];
  point?: boolean;
  terminationBp?: number | null;
  peakBp?: number | null;
}): TerminatorRecord {
  const strand = input.strand ?? '+';
  return {
    ...BASE,
    id: `terminator:${strand}:${input.start}-${input.end}`,
    kind: 'terminator',
    strand,
    score: null,
    location: input.point
      ? { shape: 'point', bp: input.start }
      : { shape: 'region', start: input.start, end: input.end },
    mechanism: input.mechanism ?? 'intrinsic',
    parts: input.parts ?? [],
    terminationBp: input.terminationBp ?? null,
    peakBp: input.peakBp ?? null,
  };
}

export function unitRecord(input: {
  start: number;
  end: number;
  strand?: Strand;
  genes?: string[];
  geneLocusTags?: string[];
}): TranscriptionUnitRecord {
  const strand = input.strand ?? '+';
  return {
    ...BASE,
    id: `unit:${strand}:${input.start}-${input.end}`,
    kind: 'transcription_unit',
    strand,
    score: null,
    location: { shape: 'region', start: input.start, end: input.end },
    genes: input.genes ?? [],
    geneLocusTags: input.geneLocusTags ?? [],
    endEvidence: null,
  };
}

export function catalogTrackData(input: {
  kind: FeatureKind;
  records: CatalogRecord[];
  evidence?: AnnotationEvidenceClass;
  genomeLengthBp?: number;
  genes?: AnnotationCatalogGeneSpan[];
}): AnnotationCatalogTrackData {
  return {
    kind: input.kind,
    records: [...input.records].sort((a, b) => recordSpan(a).start - recordSpan(b).start),
    evidence: input.evidence ?? 'measured',
    genomeLengthBp: input.genomeLengthBp ?? 1_000_000,
    genesByName: new Map((input.genes ?? []).map((gene) => [gene.name, gene])),
  };
}

export function seededIntegers(seed: number, count: number, max: number): number[] {
  let state = seed >>> 0;
  const values: number[] = [];
  for (let i = 0; i < count; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    values.push(state % max);
  }
  return values;
}
