import type { AssemblyIdentity } from './sources';
import type {
  CatalogRecord,
  FeatureLocation,
  PromoterBox,
  Strand,
  TerminationMechanism,
  TerminatorPart,
} from './records';

export const SOURCE_RECORDS_SCHEMA = 'dnaforge.annotation-source-records.v0';

export interface ParseSourceRecordsInput {
  readonly raw: unknown;
  readonly expectedSourceId: string;
  readonly assembly: AssemblyIdentity;
}

export interface ParseSourceRecordsResult {
  readonly records: readonly CatalogRecord[];
  readonly rejected: { readonly count: number; readonly examples: readonly string[] };
}

export function parseSourceRecords(input: ParseSourceRecordsInput): ParseSourceRecordsResult {
  const { raw, expectedSourceId, assembly } = input;
  if (!isObject(raw)) throw new Error('Dataset file must be a JSON object');
  if (raw.schema !== SOURCE_RECORDS_SCHEMA)
    throw new Error(`Dataset schema must be ${SOURCE_RECORDS_SCHEMA}`);
  if (raw.sourceId !== expectedSourceId) {
    throw new Error(
      `Dataset file is for source "${String(raw.sourceId)}", expected "${expectedSourceId}"`
    );
  }
  const fileAssembly = raw.assembly;
  if (
    !isObject(fileAssembly) ||
    fileAssembly.accession !== assembly.accession ||
    fileAssembly.length !== assembly.lengthBp
  ) {
    throw new Error(
      `Dataset file assembly does not match ${assembly.accession} (${assembly.lengthBp} bp)`
    );
  }
  if (!Array.isArray(raw.records)) throw new Error('Dataset records must be an array');

  const records: CatalogRecord[] = [];
  const examples: string[] = [];
  let rejectedCount = 0;
  const seen = new Set<string>();
  for (const entry of raw.records) {
    const parsed = parseRecord(entry, assembly.lengthBp);
    if (typeof parsed !== 'string' && seen.has(parsed.id)) {
      rejectedCount += 1;
      if (examples.length < 25) examples.push(`duplicate id ${parsed.id}`);
      continue;
    }
    if (typeof parsed === 'string') {
      rejectedCount += 1;
      if (examples.length < 25) examples.push(parsed);
      continue;
    }
    seen.add(parsed.id);
    records.push(parsed);
  }
  return { records, rejected: { count: rejectedCount, examples } };
}

function parseRecord(raw: unknown, lengthBp: number): CatalogRecord | string {
  if (!isObject(raw)) return 'record is not an object';
  const id = raw.id;
  if (typeof id !== 'string' || id.length === 0) return 'record without a string id';
  const where = `record ${id}`;
  const { start, end, strand, kind, resolution } = raw;
  if (!isInt(start) || !isInt(end) || start < 0 || end <= start || end > lengthBp) {
    return `${where}: coordinates [${String(start)}, ${String(end)}) outside 0..${lengthBp}`;
  }
  const parsedStrand: Strand | null = strand === '+' ? '+' : strand === '-' ? '-' : null;
  if (parsedStrand === null) return `${where}: strand must be + or -`;
  let location: FeatureLocation;
  if (resolution === 'point') {
    if (end !== start + 1) return `${where}: a point must have end = start + 1`;
    location = { shape: 'point', bp: start };
  } else if (resolution === 'region') {
    location = { shape: 'region', start, end };
  } else {
    return `${where}: resolution must be point or region`;
  }

  const attributes = isObject(raw.attributes) ? raw.attributes : {};
  const base = {
    id,
    strand: parsedStrand,
    name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : null,
    score: typeof raw.score === 'number' && Number.isFinite(raw.score) ? raw.score : null,
    conditions: stringList(attributes.conditions ?? attributes.condition),
  };
  const parts = Array.isArray(raw.parts) ? raw.parts.filter(isObject) : [];
  const spanOf = (part: Record<string, unknown>) =>
    isInt(part.start) &&
    isInt(part.end) &&
    part.start >= 0 &&
    part.end > part.start &&
    part.end <= lengthBp
      ? { start: part.start, end: part.end }
      : null;

  switch (kind) {
    case 'tss': {
      if (location.shape !== 'point') return `${where}: a TSS must be a point`;
      return {
        ...base,
        kind: 'tss',
        location,
        classification:
          typeof attributes.classification === 'string' ? attributes.classification : null,
      };
    }
    case 'transcription_unit': {
      if (location.shape !== 'region') return `${where}: a transcription unit must be a region`;
      const genes = stringList(attributes.genes);
      const locusTags = stringList(attributes.locusTags);
      return {
        ...base,
        kind: 'transcription_unit',
        location,
        genes,
        geneLocusTags: locusTags.length === genes.length ? locusTags : [],
        endEvidence:
          attributes.endEvidence === 'measured' || attributes.endEvidence === 'gene-derived'
            ? attributes.endEvidence
            : null,
      };
    }
    case 'terminator': {
      const terminatorParts: TerminatorPart[] = [];
      for (const part of parts) {
        const span = spanOf(part);
        const element = terminatorElement(part.role);
        if (span && element) terminatorParts.push({ element, ...span });
      }
      return {
        ...base,
        kind: 'terminator',
        location,
        mechanism: mechanismOf(attributes.mechanism),
        parts: terminatorParts,
        terminationBp: basePosition(attributes.terminationBp, lengthBp),
        peakBp: basePosition(attributes.peakBp, lengthBp),
      };
    }
    case 'promoter': {
      const boxes: PromoterBox[] = [];
      for (const part of parts) {
        const span = spanOf(part);
        if (span && (part.role === 'minus10' || part.role === 'minus35'))
          boxes.push({ element: part.role, ...span });
      }
      return {
        ...base,
        kind: 'promoter',
        location,
        transcriptionStartBp: basePosition(attributes.transcriptionStartBp, lengthBp),
        boxes,
        sigmaFactor: typeof attributes.sigmaFactor === 'string' ? attributes.sigmaFactor : null,
      };
    }
    default:
      return `${where}: unknown kind "${String(kind)}"`;
  }
}

function terminatorElement(role: unknown): TerminatorPart['element'] | null {
  switch (role) {
    case 'stem':
    case 'stem_5p':
    case 'stem_3p':
      return 'stem';
    case 'loop':
      return 'loop';
    case 'u_tract':
    case 'u-tract':
    case 'tail':
      return 'u-tract';
    default:
      return null;
  }
}

function mechanismOf(value: unknown): TerminationMechanism {
  if (value === 'intrinsic') return 'intrinsic';
  if (value === 'rho-dependent' || value === 'rho_dependent') return 'rho-dependent';
  return 'unclassified';
}

function stringList(value: unknown): readonly string[] {
  if (typeof value === 'string') return value.length > 0 ? [value] : [];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function basePosition(value: unknown, lengthBp: number): number | null {
  return isInt(value) && value >= 0 && value < lengthBp ? value : null;
}

function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
