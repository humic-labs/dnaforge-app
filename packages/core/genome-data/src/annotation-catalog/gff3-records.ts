import { parseGff3Line } from '../gff3';
import type { GenomeFeature } from '../types';
import {
  type CatalogRecord,
  type FeatureKind,
  type FeatureLocation,
  type PromoterBox,
  type Strand,
  type TerminationMechanism,
  type TerminatorPart,
} from './records';
import type { AssemblyIdentity } from './sources';

export const GFF3_TYPE_BY_KIND: Readonly<Record<FeatureKind, string>> = {
  promoter: 'promoter',
  terminator: 'terminator',
  tss: 'TSS',
  transcription_unit: 'transcript',
};

const KIND_BY_TYPE: ReadonlyMap<string, FeatureKind> = new Map<string, FeatureKind>([
  ['promoter', 'promoter'],
  ['terminator', 'terminator'],
  ['TSS', 'tss'],
  ['transcription_start_site', 'tss'],
  ['transcript', 'transcription_unit'],
  ['operon', 'transcription_unit'],
  ['transcription_unit', 'transcription_unit'],
]);

const MAX_EXAMPLES = 25;

export interface ParseGff3TrackInput {
  readonly text: string;
  readonly track: string;
  readonly assembly: AssemblyIdentity;
  readonly aliases?: readonly string[];
  readonly kinds: readonly FeatureKind[];
}

export interface ParseGff3TrackResult {
  readonly records: readonly CatalogRecord[];
  readonly rejected: { readonly count: number; readonly examples: readonly string[] };
  readonly skipped: number;
}

export function parseGff3Track(input: ParseGff3TrackInput): ParseGff3TrackResult {
  const seqids = new Set([input.assembly.accession, ...(input.aliases ?? [])]);
  const declared = new Set(input.kinds);
  const records: CatalogRecord[] = [];
  const examples: string[] = [];
  const seen = new Set<string>();
  let rejectedCount = 0;
  let skipped = 0;
  const reject = (message: string) => {
    rejectedCount += 1;
    if (examples.length < MAX_EXAMPLES) examples.push(message);
  };

  const lines = input.text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].endsWith('\r') ? lines[index].slice(0, -1) : lines[index];
    if (line.length === 0) continue;
    if (line.startsWith('##FASTA') || line.startsWith('>')) break;
    if (line.startsWith('#')) continue;
    const lineNumber = index + 1;
    const feature = parseGff3Line(line);
    if (!feature) {
      reject(`line ${lineNumber}: not a nine-column GFF3 row`);
      continue;
    }
    const kind = KIND_BY_TYPE.get(feature.type);
    if (!kind || !declared.has(kind)) {
      skipped += 1;
      continue;
    }
    const parsed = toRecord(feature, kind, {
      lineNumber,
      track: input.track,
      lengthBp: input.assembly.lengthBp,
      seqids,
      accession: input.assembly.accession,
    });
    if (typeof parsed === 'string') {
      reject(parsed);
      continue;
    }
    if (seen.has(parsed.id)) {
      reject(`line ${lineNumber}: duplicate ID ${parsed.id.slice(input.track.length + 1)}`);
      continue;
    }
    seen.add(parsed.id);
    records.push(parsed);
  }
  return { records, rejected: { count: rejectedCount, examples }, skipped };
}

interface RowContext {
  readonly lineNumber: number;
  readonly track: string;
  readonly lengthBp: number;
  readonly seqids: ReadonlySet<string>;
  readonly accession: string;
}

function toRecord(
  feature: GenomeFeature,
  kind: FeatureKind,
  ctx: RowContext
): CatalogRecord | string {
  const attrs = feature.attributes;
  const localId = first(attrs, 'ID');
  const where = localId ? `line ${ctx.lineNumber} (${localId})` : `line ${ctx.lineNumber}`;
  if (!localId) return `${where}: no ID attribute`;
  if (!ctx.seqids.has(feature.chrom)) {
    return `${where}: column 1 is ${feature.chrom}, not ${ctx.accession}`;
  }
  const { start, end } = feature;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start ||
    end > ctx.lengthBp
  ) {
    return `${where}: columns 4-5 give [${start + 1}, ${end}], outside 1..${ctx.lengthBp}`;
  }
  const strand: Strand | null = feature.strand === '+' ? '+' : feature.strand === '-' ? '-' : null;
  if (strand === null) return `${where}: strand must be + or -`;

  let location: FeatureLocation;
  const oneBase = end === start + 1;
  if (kind === 'tss') {
    if (!oneBase) return `${where}: a TSS must be one base long`;
    location = { shape: 'point', bp: start };
  } else if (first(attrs, 'resolution') === 'point') {
    if (!oneBase) return `${where}: resolution=point on a row longer than one base`;
    location = { shape: 'point', bp: start };
  } else {
    location = { shape: 'region', start, end };
  }

  let score: number | null = null;
  if (feature.score !== null && feature.score !== '') {
    score = Number(feature.score);
    if (!Number.isFinite(score)) return `${where}: column 6 "${feature.score}" is not a number`;
  }

  const base = {
    id: `${ctx.track}:${localId}`,
    strand,
    name: first(attrs, 'Name') ?? null,
    score,
    conditions: list(attrs, 'condition'),
  };
  const spans = parts(attrs, ctx.lengthBp);

  switch (kind) {
    case 'tss':
      return {
        ...base,
        kind: 'tss',
        location: { shape: 'point', bp: start },
        classification: first(attrs, 'classification') ?? null,
      };
    case 'transcription_unit': {
      if (location.shape !== 'region') return `${where}: a transcription unit must be a region`;
      const genes = list(attrs, 'gene');
      const locusTags = list(attrs, 'locus_tag');
      const endEvidence = first(attrs, 'end_evidence');
      return {
        ...base,
        kind: 'transcription_unit',
        location,
        genes,
        geneLocusTags: locusTags.length === genes.length ? locusTags : [],
        endEvidence:
          endEvidence === 'measured' || endEvidence === 'gene-derived' ? endEvidence : null,
      };
    }
    case 'terminator': {
      const terminatorParts: TerminatorPart[] = [];
      for (const part of spans) {
        const element = terminatorElement(part.role);
        if (element) terminatorParts.push({ element, start: part.start, end: part.end });
      }
      return {
        ...base,
        kind: 'terminator',
        location,
        mechanism: mechanismOf(first(attrs, 'mechanism')),
        parts: terminatorParts,
        terminationBp: basePosition(first(attrs, 'termination_site'), ctx.lengthBp),
        peakBp: basePosition(first(attrs, 'peak'), ctx.lengthBp),
      };
    }
    case 'promoter': {
      const boxes: PromoterBox[] = [];
      for (const part of spans) {
        if (part.role === 'minus10' || part.role === 'minus35') {
          boxes.push({ element: part.role, start: part.start, end: part.end });
        }
      }
      return {
        ...base,
        kind: 'promoter',
        location,
        transcriptionStartBp: basePosition(first(attrs, 'transcription_start'), ctx.lengthBp),
        boxes,
        sigmaFactor: first(attrs, 'sigma_factor') ?? null,
      };
    }
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

function first(attrs: Record<string, string[]>, key: string): string | undefined {
  const value = attrs[key]?.[0];
  return value !== undefined && value.length > 0 ? value : undefined;
}

function list(attrs: Record<string, string[]>, key: string): readonly string[] {
  return (attrs[key] ?? []).filter((value) => value.length > 0);
}

function parts(
  attrs: Record<string, string[]>,
  lengthBp: number
): readonly { role: string; start: number; end: number }[] {
  const out: { role: string; start: number; end: number }[] = [];
  for (const item of list(attrs, 'parts')) {
    const match = /^([a-z0-9_]+):(\d+)-(\d+)$/.exec(item);
    if (!match) continue;
    const start1 = Number(match[2]);
    const end1 = Number(match[3]);
    if (start1 < 1 || end1 < start1 || end1 > lengthBp) continue;
    out.push({ role: match[1], start: start1 - 1, end: end1 });
  }
  return out;
}

function terminatorElement(role: string): TerminatorPart['element'] | null {
  switch (role) {
    case 'stem':
    case 'stem_5p':
    case 'stem_3p':
      return 'stem';
    case 'loop':
      return 'loop';
    case 'u_tract':
    case 'tail':
      return 'u-tract';
    default:
      return null;
  }
}

function mechanismOf(value: string | undefined): TerminationMechanism {
  if (value === 'intrinsic') return 'intrinsic';
  if (value === 'rho-dependent' || value === 'rho_dependent') return 'rho-dependent';
  return 'unclassified';
}

function basePosition(value: string | undefined, lengthBp: number): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const bp = Number(value) - 1;
  return bp >= 0 && bp < lengthBp ? bp : null;
}
