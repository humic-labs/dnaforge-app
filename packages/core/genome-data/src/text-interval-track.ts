import type { AnnotationRecord, PeakRecord, RepeatRecord, TranscriptRecord } from './records';
import type { ScientificTrackKind } from './admitted-track-source';
import { parseItemRgb } from './bed';

export type TextIntervalTrackFormatId =
  | 'bed'
  | 'gff3'
  | 'gtf'
  | 'genepred'
  | 'refflat'
  | 'narrowpeak'
  | 'broadpeak';

export type TextIntervalScientificKind = Extract<
  ScientificTrackKind,
  'transcript' | 'interval' | 'peak' | 'repeat'
>;

export type TextIntervalRecord = AnnotationRecord | TranscriptRecord | PeakRecord | RepeatRecord;

export interface TextIntervalReferenceExtent {
  readonly name: string;
  readonly maxEnd: number;
}

export interface TextIntervalParseStats {
  readonly totalLines: number;
  readonly commentLines: number;
  readonly parsedRecords: number;
}

export interface ParsedTextIntervalTrack {
  readonly formatId: TextIntervalTrackFormatId;
  readonly scientificKind: TextIntervalScientificKind;
  readonly records: ReadonlyArray<TextIntervalRecord>;
  readonly referenceExtents: ReadonlyArray<TextIntervalReferenceExtent>;
  readonly stats: TextIntervalParseStats;
}

export interface ParseTextIntervalTrackOptions {
  readonly scientificKind?: TextIntervalScientificKind;
}

interface SourceLine {
  readonly number: number;
  readonly text: string;
}

interface BedRow {
  readonly line: number;
  readonly chrom: string;
  readonly start: number;
  readonly end: number;
  readonly name?: string;
  readonly score?: number;
  readonly strand?: '+' | '-' | '.';
  readonly thickStart?: number;
  readonly thickEnd?: number;
  readonly color?: number;
  readonly blocks?: ReadonlyArray<{ readonly start: number; readonly end: number }>;
  readonly columns: ReadonlyArray<string>;
}

interface GxfRow {
  readonly line: number;
  readonly chrom: string;
  readonly source: string;
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly score?: number;
  readonly strand: '+' | '-' | '.';
  readonly phase?: 0 | 1 | 2;
  readonly attributes: Readonly<Record<string, ReadonlyArray<string>>>;
}

interface TranscriptGroup {
  chrom: string;
  transcriptId: string;
  start: number;
  end: number;
  strand: '+' | '-';
  geneId?: string;
  geneName?: string;
  transcriptType?: string;
  exons: Array<{ start: number; end: number }>;
  cds: Array<{ start: number; end: number; phase?: 0 | 1 | 2 }>;
  attributes?: Readonly<Record<string, ReadonlyArray<string>>>;
}

const TRANSCRIPT_TYPES = new Set([
  'mrna',
  'transcript',
  'ncrna',
  'lnc_rna',
  'lncrna',
  'mirna',
  'snorna',
  'snrna',
  'trna',
  'rrna',
  'primary_transcript',
  'pseudogenic_transcript',
]);

export function parseTextIntervalTrack(
  formatId: TextIntervalTrackFormatId,
  text: string,
  options: ParseTextIntervalTrackOptions = {}
): ParsedTextIntervalTrack {
  const { content, totalLines, commentLines } = contentLines(text);
  if (content.length === 0) throw new Error(`${formatName(formatId)} contains no data records.`);

  let scientificKind: TextIntervalScientificKind;
  let records: TextIntervalRecord[];
  switch (formatId) {
    case 'bed': {
      const rows = content.map((line) => parseBedRow(line, 'BED'));
      scientificKind = requestedKind(formatId, options.scientificKind) ?? inferBedKind(rows);
      records = adaptBedRows(rows, scientificKind);
      break;
    }
    case 'narrowpeak':
    case 'broadpeak': {
      assertRequestedKind(formatId, options.scientificKind, 'peak');
      scientificKind = 'peak';
      records = content.map((line) => parsePeakRow(line, formatId));
      break;
    }
    case 'gff3':
    case 'gtf': {
      const rows = content.map((line) => parseGxfRow(line, formatId));
      scientificKind =
        requestedKind(formatId, options.scientificKind) ?? inferGxfKind(rows, formatId);
      records =
        scientificKind === 'transcript'
          ? adaptGxfTranscripts(rows, formatId)
          : adaptGxfIntervals(rows, scientificKind);
      break;
    }
    case 'genepred':
    case 'refflat': {
      assertRequestedKind(formatId, options.scientificKind, 'transcript');
      scientificKind = 'transcript';
      records = content.map((line) => parseGeneTableRow(line, formatId));
      break;
    }
  }

  if (records.length === 0) {
    throw new Error(`${formatName(formatId)} contains no renderable ${scientificKind} records.`);
  }
  records.sort(
    (left, right) =>
      left.chrom.localeCompare(right.chrom) || left.start - right.start || left.end - right.end
  );
  return {
    formatId,
    scientificKind,
    records,
    referenceExtents: referenceExtents(records),
    stats: { totalLines, commentLines, parsedRecords: records.length },
  };
}

function contentLines(text: string): {
  content: SourceLine[];
  totalLines: number;
  commentLines: number;
} {
  const rawLines = text.split(/\r?\n/u);
  if (rawLines[rawLines.length - 1] === '') rawLines.pop();
  const content: SourceLine[] = [];
  let commentLines = 0;
  rawLines.forEach((raw, index) => {
    const trimmed = raw.trim();
    if (
      trimmed === '' ||
      trimmed.startsWith('#') ||
      trimmed.startsWith('track ') ||
      trimmed.startsWith('browser ')
    ) {
      commentLines += 1;
      return;
    }
    content.push({ number: index + 1, text: raw });
  });
  return { content, totalLines: rawLines.length, commentLines };
}

function parseBedRow(
  source: SourceLine,
  name: string,
  options: { readonly parseExtendedColumns?: boolean } = {}
): BedRow {
  const columns = source.text.split('\t');
  if (columns.length < 3) fail(name, source.number, 'expected at least 3 tab-delimited columns');
  const chrom = requiredCell(columns[0], name, source.number, 'chrom');
  const start = coordinate(columns[1], name, source.number, 'start');
  const end = coordinate(columns[2], name, source.number, 'end');
  if (end <= start) fail(name, source.number, 'end must be greater than start');
  const strand = strandValue(columns[5], name, source.number);
  const score = optionalNumber(columns[4], name, source.number, 'score');
  const parseExtendedColumns = options.parseExtendedColumns ?? true;
  const thickStart = parseExtendedColumns
    ? optionalCoordinate(columns[6], name, source.number, 'thickStart')
    : undefined;
  const thickEnd = parseExtendedColumns
    ? optionalCoordinate(columns[7], name, source.number, 'thickEnd')
    : undefined;
  const blocks =
    parseExtendedColumns && columns.length >= 12
      ? parseBedBlocks(columns, source.number, start, end)
      : undefined;
  return {
    line: source.number,
    chrom,
    start,
    end,
    ...(columns[3] ? { name: columns[3] } : {}),
    ...(score === undefined ? {} : { score }),
    ...(strand === undefined ? {} : { strand }),
    ...(thickStart === undefined ? {} : { thickStart }),
    ...(thickEnd === undefined ? {} : { thickEnd }),
    ...(parseExtendedColumns && columns[8] && parseItemRgb(columns[8]) !== null
      ? { color: parseItemRgb(columns[8]) as number }
      : {}),
    ...(blocks ? { blocks } : {}),
    columns,
  };
}

function parseBedBlocks(
  columns: ReadonlyArray<string>,
  line: number,
  recordStart: number,
  recordEnd: number
): ReadonlyArray<{ start: number; end: number }> {
  const count = coordinate(columns[9], 'BED', line, 'blockCount');
  if (count < 1) fail('BED', line, 'blockCount must be positive');
  const sizes = integerList(columns[10], 'BED', line, 'blockSizes');
  const starts = integerList(columns[11], 'BED', line, 'blockStarts');
  if (sizes.length !== count || starts.length !== count) {
    fail('BED', line, 'blockCount does not match blockSizes and blockStarts');
  }
  return sizes.map((size, index) => {
    const start = recordStart + starts[index];
    const end = start + size;
    if (size <= 0 || start < recordStart || end > recordEnd) {
      fail('BED', line, 'block coordinates fall outside the feature bounds');
    }
    return { start, end };
  });
}

function inferBedKind(rows: ReadonlyArray<BedRow>): TextIntervalScientificKind {
  return rows.length > 0 && rows.every((row) => row.blocks && row.blocks.length > 0)
    ? 'transcript'
    : 'interval';
}

function adaptBedRows(
  rows: ReadonlyArray<BedRow>,
  scientificKind: TextIntervalScientificKind
): TextIntervalRecord[] {
  if (scientificKind === 'transcript') {
    return rows.map((row, index) => bedTranscript(row, index));
  }
  if (scientificKind === 'peak') return rows.map((row) => bedPeak(row));
  return rows.map((row) => bedInterval(row));
}

function bedInterval(row: BedRow): AnnotationRecord {
  return {
    chrom: row.chrom,
    start: row.start,
    end: row.end,
    ...(row.name ? { name: row.name } : {}),
    ...(row.color === undefined ? {} : { color: row.color }),
    ...(row.strand ? { strand: row.strand } : {}),
    ...(row.score === undefined ? {} : { extra: { score: row.score } }),
  };
}

function bedPeak(row: BedRow): PeakRecord {
  return {
    ...bedInterval(row),
    ...(row.score === undefined ? {} : { score: row.score }),
  };
}

function bedTranscript(row: BedRow, index: number): TranscriptRecord {
  const exons = row.blocks ? [...row.blocks] : [{ start: row.start, end: row.end }];
  const thickStart = row.thickStart ?? row.start;
  const thickEnd = row.thickEnd ?? row.start;
  const cds =
    thickEnd > thickStart
      ? exons.flatMap((exon) => {
          const start = Math.max(exon.start, thickStart);
          const end = Math.min(exon.end, thickEnd);
          return end > start ? [{ start, end }] : [];
        })
      : [];
  return {
    chrom: row.chrom,
    start: row.start,
    end: row.end,
    transcriptId: row.name ?? `${row.chrom}:${row.start}-${row.end}:${index + 1}`,
    strand: row.strand === '-' ? '-' : '+',
    exons,
    cds,
    ...(row.color === undefined ? {} : { color: row.color }),
    ...(row.score === undefined ? {} : { extra: { score: row.score } }),
  };
}

function parsePeakRow(source: SourceLine, format: 'narrowpeak' | 'broadpeak'): PeakRecord {
  const expected = format === 'narrowpeak' ? 10 : 9;
  const columns = source.text.split('\t');
  if (columns.length < expected) {
    fail(formatName(format), source.number, `expected ${expected} tab-delimited columns`);
  }
  const row = parseBedRow(source, formatName(format), { parseExtendedColumns: false });
  const signalValue = numberCell(columns[6], formatName(format), source.number, 'signalValue');
  const pValue = numberCell(columns[7], formatName(format), source.number, 'pValue');
  const qValue = numberCell(columns[8], formatName(format), source.number, 'qValue');
  const peak =
    format === 'narrowpeak'
      ? numberCell(columns[9], formatName(format), source.number, 'peak')
      : undefined;
  return {
    ...bedInterval(row),
    ...(row.score === undefined ? {} : { score: row.score }),
    signalValue,
    pValue,
    qValue,
    ...(peak !== undefined && peak >= 0 ? { summit: row.start + peak } : {}),
  };
}

function parseGxfRow(source: SourceLine, format: 'gff3' | 'gtf'): GxfRow {
  const name = formatName(format);
  const columns = source.text.split('\t');
  if (columns.length !== 9) fail(name, source.number, 'expected exactly 9 tab-delimited columns');
  const start1 = coordinate(columns[3], name, source.number, 'start');
  const end = coordinate(columns[4], name, source.number, 'end');
  if (start1 < 1 || end < start1) fail(name, source.number, 'coordinates are invalid');
  const score =
    columns[5] === '.' ? undefined : numberCell(columns[5], name, source.number, 'score');
  const strand = strandValue(columns[6], name, source.number) ?? '.';
  const rawPhase = columns[7];
  const phase =
    rawPhase === '.'
      ? undefined
      : (coordinate(rawPhase, name, source.number, 'phase') as 0 | 1 | 2);
  if (phase !== undefined && phase !== 0 && phase !== 1 && phase !== 2) {
    fail(name, source.number, 'phase must be 0, 1, 2, or .');
  }
  return {
    line: source.number,
    chrom: requiredCell(columns[0], name, source.number, 'seqid'),
    source: columns[1],
    type: requiredCell(columns[2], name, source.number, 'type'),
    start: start1 - 1,
    end,
    ...(score === undefined ? {} : { score }),
    strand,
    ...(phase === undefined ? {} : { phase }),
    attributes:
      format === 'gff3' ? parseGff3Attributes(columns[8]) : parseGtfAttributes(columns[8]),
  };
}

function inferGxfKind(
  rows: ReadonlyArray<GxfRow>,
  format: 'gff3' | 'gtf'
): TextIntervalScientificKind {
  if (format === 'gtf' && rows.some((row) => attribute(row, 'transcript_id'))) {
    return 'transcript';
  }
  return rows.some(
    (row) =>
      TRANSCRIPT_TYPES.has(row.type.toLowerCase()) ||
      ((row.type.toLowerCase() === 'exon' || row.type.toLowerCase() === 'cds') &&
        (attribute(row, 'Parent') || attribute(row, 'transcript_id')))
  )
    ? 'transcript'
    : 'interval';
}

function adaptGxfTranscripts(
  rows: ReadonlyArray<GxfRow>,
  format: 'gff3' | 'gtf'
): TranscriptRecord[] {
  const geneNames = new Map<string, string>();
  for (const row of rows) {
    if (!['gene', 'pseudogene'].includes(row.type.toLowerCase())) continue;
    const id = attribute(row, format === 'gff3' ? 'ID' : 'gene_id');
    const name = attribute(row, 'Name') ?? attribute(row, 'gene_name');
    if (id && name) geneNames.set(id, name);
  }

  const groups = new Map<string, TranscriptGroup>();
  const groupFor = (row: GxfRow, transcriptId: string): TranscriptGroup => {
    const key = `${row.chrom}\u0000${transcriptId}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        chrom: row.chrom,
        transcriptId,
        start: row.start,
        end: row.end,
        strand: row.strand === '-' ? '-' : '+',
        exons: [],
        cds: [],
      };
      groups.set(key, group);
    }
    group.start = Math.min(group.start, row.start);
    group.end = Math.max(group.end, row.end);
    return group;
  };

  for (const row of rows) {
    const type = row.type.toLowerCase();
    if (TRANSCRIPT_TYPES.has(type)) {
      const transcriptId = attribute(row, format === 'gff3' ? 'ID' : 'transcript_id');
      if (!transcriptId) continue;
      const group = groupFor(row, transcriptId);
      const geneId = attribute(row, format === 'gff3' ? 'Parent' : 'gene_id');
      group.geneId = geneId ?? group.geneId;
      group.geneName =
        attribute(row, 'Name') ??
        attribute(row, 'gene_name') ??
        (geneId ? geneNames.get(geneId) : undefined) ??
        group.geneName;
      group.transcriptType = row.type;
      group.attributes = row.attributes;
    }
  }

  for (const row of rows) {
    const type = row.type.toLowerCase();
    if (type !== 'exon' && type !== 'cds') continue;
    const transcriptIds =
      format === 'gff3'
        ? (row.attributes.Parent ?? [])
        : attribute(row, 'transcript_id')
          ? [attribute(row, 'transcript_id') as string]
          : [];
    for (const transcriptId of transcriptIds) {
      const group = groupFor(row, transcriptId);
      const geneId = attribute(row, 'gene_id');
      group.geneId = geneId ?? group.geneId;
      group.geneName =
        attribute(row, 'gene_name') ??
        (group.geneId ? geneNames.get(group.geneId) : undefined) ??
        group.geneName;
      if (type === 'exon') group.exons.push({ start: row.start, end: row.end });
      else {
        group.cds.push({
          start: row.start,
          end: row.end,
          ...(row.phase === undefined ? {} : { phase: row.phase }),
        });
      }
    }
  }

  return [...groups.values()].map((group) => {
    const exons = normalizeIntervals(group.exons.length > 0 ? group.exons : group.cds);
    const finalExons = exons.length > 0 ? exons : [{ start: group.start, end: group.end }];
    const cds = normalizeCds(group.cds);
    return {
      chrom: group.chrom,
      start: Math.min(group.start, ...finalExons.map((part) => part.start)),
      end: Math.max(group.end, ...finalExons.map((part) => part.end)),
      transcriptId: group.transcriptId,
      ...(group.geneId ? { geneId: group.geneId } : {}),
      ...(group.geneName ? { geneName: group.geneName } : {}),
      strand: group.strand,
      ...(group.transcriptType ? { transcriptType: group.transcriptType } : {}),
      exons: finalExons,
      cds,
      ...(group.attributes ? { extra: { attributes: group.attributes } } : {}),
    };
  });
}

function adaptGxfIntervals(
  rows: ReadonlyArray<GxfRow>,
  scientificKind: Exclude<TextIntervalScientificKind, 'transcript'>
): Array<AnnotationRecord | PeakRecord | RepeatRecord> {
  return rows.map((row) => {
    const name =
      attribute(row, 'Name') ??
      attribute(row, 'gene_name') ??
      attribute(row, 'ID') ??
      attribute(row, 'transcript_id');
    const base: AnnotationRecord = {
      chrom: row.chrom,
      start: row.start,
      end: row.end,
      ...(name ? { name } : {}),
      strand: row.strand,
      extra: {
        source: row.source,
        type: row.type,
        ...(row.score === undefined ? {} : { score: row.score }),
        attributes: row.attributes,
      },
    };
    if (scientificKind === 'peak') return { ...base, score: row.score } satisfies PeakRecord;
    if (scientificKind === 'repeat') {
      return {
        ...base,
        ...(attribute(row, 'repClass') ? { repeatClass: attribute(row, 'repClass') } : {}),
        ...(attribute(row, 'repFamily') ? { repeatFamily: attribute(row, 'repFamily') } : {}),
      } satisfies RepeatRecord;
    }
    return base;
  });
}

function parseGeneTableRow(source: SourceLine, format: 'genepred' | 'refflat'): TranscriptRecord {
  const name = formatName(format);
  const columns = source.text.split('\t');
  const offset = format === 'refflat' ? 1 : 0;
  if (columns.length < offset + 10) {
    fail(name, source.number, `expected at least ${offset + 10} tab-delimited columns`);
  }
  const geneName =
    format === 'refflat' ? requiredCell(columns[0], name, source.number, 'geneName') : undefined;
  const transcriptId = requiredCell(columns[offset], name, source.number, 'name');
  const chrom = requiredCell(columns[offset + 1], name, source.number, 'chrom');
  const strand = columns[offset + 2];
  if (strand !== '+' && strand !== '-') fail(name, source.number, 'strand must be + or -');
  const start = coordinate(columns[offset + 3], name, source.number, 'txStart');
  const end = coordinate(columns[offset + 4], name, source.number, 'txEnd');
  const cdsStart = coordinate(columns[offset + 5], name, source.number, 'cdsStart');
  const cdsEnd = coordinate(columns[offset + 6], name, source.number, 'cdsEnd');
  const exonCount = coordinate(columns[offset + 7], name, source.number, 'exonCount');
  const exonStarts = integerList(columns[offset + 8], name, source.number, 'exonStarts');
  const exonEnds = integerList(columns[offset + 9], name, source.number, 'exonEnds');
  if (
    end <= start ||
    exonCount < 1 ||
    exonStarts.length !== exonCount ||
    exonEnds.length !== exonCount
  ) {
    fail(name, source.number, 'transcript or exon coordinates are inconsistent');
  }
  const exons = exonStarts.map((exonStart, index) => {
    const exonEnd = exonEnds[index];
    if (exonEnd <= exonStart || exonStart < start || exonEnd > end) {
      fail(name, source.number, 'exon coordinates fall outside the transcript bounds');
    }
    return { start: exonStart, end: exonEnd };
  });
  const cds =
    cdsEnd > cdsStart
      ? exons.flatMap((exon) => {
          const partStart = Math.max(exon.start, cdsStart);
          const partEnd = Math.min(exon.end, cdsEnd);
          return partEnd > partStart ? [{ start: partStart, end: partEnd }] : [];
        })
      : [];
  return {
    chrom,
    start,
    end,
    transcriptId,
    ...(geneName ? { geneName } : {}),
    strand,
    exons,
    cds,
  };
}

function requestedKind(
  format: TextIntervalTrackFormatId,
  requested: TextIntervalScientificKind | undefined
): TextIntervalScientificKind | undefined {
  if (requested && !['transcript', 'interval', 'peak', 'repeat'].includes(requested)) {
    throw new Error(`${formatName(format)} cannot be admitted as ${requested}.`);
  }
  return requested;
}

function assertRequestedKind(
  format: TextIntervalTrackFormatId,
  requested: TextIntervalScientificKind | undefined,
  required: TextIntervalScientificKind
): void {
  if (requested && requested !== required) {
    throw new Error(`${formatName(format)} must be admitted as ${required}, not ${requested}.`);
  }
}

function parseGff3Attributes(raw: string): Readonly<Record<string, ReadonlyArray<string>>> {
  const attributes: Record<string, string[]> = {};
  for (const part of raw.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf('=');
    const key = separator >= 0 ? trimmed.slice(0, separator).trim() : trimmed;
    const value = separator >= 0 ? trimmed.slice(separator + 1) : '';
    if (!key) continue;
    attributes[key] = value.split(',').filter(Boolean).map(safeDecode);
  }
  return attributes;
}

function parseGtfAttributes(raw: string): Readonly<Record<string, ReadonlyArray<string>>> {
  const attributes: Record<string, string[]> = {};
  for (const part of raw.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const match = /^(\S+)\s+(?:"((?:[^"\\]|\\.)*)"|(\S+))$/u.exec(trimmed);
    if (!match) continue;
    const value = (match[2] ?? match[3] ?? '').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    (attributes[match[1]] ??= []).push(value);
  }
  return attributes;
}

function attribute(row: GxfRow, name: string): string | undefined {
  return row.attributes[name]?.[0];
}

function normalizeIntervals(
  intervals: ReadonlyArray<{ readonly start: number; readonly end: number }>
): Array<{ start: number; end: number }> {
  const seen = new Set<string>();
  return intervals
    .filter((part) => {
      const key = `${part.start}:${part.end}`;
      if (part.end <= part.start || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((part) => ({ start: part.start, end: part.end }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
}

function normalizeCds(
  intervals: ReadonlyArray<{
    readonly start: number;
    readonly end: number;
    readonly phase?: 0 | 1 | 2;
  }>
): Array<{ start: number; end: number; phase?: 0 | 1 | 2 }> {
  const seen = new Set<string>();
  return intervals
    .filter((part) => {
      const key = `${part.start}:${part.end}:${part.phase ?? '.'}`;
      if (part.end <= part.start || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((part) => ({ ...part }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
}

function referenceExtents(
  records: ReadonlyArray<TextIntervalRecord>
): TextIntervalReferenceExtent[] {
  const maxEndByName = new Map<string, number>();
  for (const record of records) {
    maxEndByName.set(record.chrom, Math.max(maxEndByName.get(record.chrom) ?? 0, record.end));
  }
  return [...maxEndByName]
    .map(([name, maxEnd]) => ({ name, maxEnd }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function requiredCell(
  value: string | undefined,
  format: string,
  line: number,
  field: string
): string {
  if (!value) fail(format, line, `${field} is required`);
  return value;
}

function coordinate(
  value: string | undefined,
  format: string,
  line: number,
  field: string
): number {
  if (!value || !/^\d+$/u.test(value)) fail(format, line, `${field} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail(format, line, `${field} is out of range`);
  return parsed;
}

function optionalCoordinate(
  value: string | undefined,
  format: string,
  line: number,
  field: string
): number | undefined {
  return value === undefined || value === '' ? undefined : coordinate(value, format, line, field);
}

function numberCell(
  value: string | undefined,
  format: string,
  line: number,
  field: string
): number {
  const parsed = Number(value);
  if (value === undefined || value === '' || !Number.isFinite(parsed)) {
    fail(format, line, `${field} must be a finite number`);
  }
  return parsed;
}

function optionalNumber(
  value: string | undefined,
  format: string,
  line: number,
  field: string
): number | undefined {
  return value === undefined || value === '' || value === '.'
    ? undefined
    : numberCell(value, format, line, field);
}

function strandValue(
  value: string | undefined,
  format: string,
  line: number
): '+' | '-' | '.' | undefined {
  if (value === undefined || value === '') return undefined;
  if (value === '+' || value === '-' || value === '.') return value;
  fail(format, line, 'strand must be +, -, or .');
}

function integerList(
  value: string | undefined,
  format: string,
  line: number,
  field: string
): number[] {
  if (!value) fail(format, line, `${field} is required`);
  const parts = value.replace(/,$/u, '').split(',');
  if (parts.length === 0 || parts.some((part) => !/^\d+$/u.test(part))) {
    fail(format, line, `${field} must be a comma-delimited integer list`);
  }
  return parts.map(Number);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function formatName(format: TextIntervalTrackFormatId): string {
  switch (format) {
    case 'gff3':
      return 'GFF3';
    case 'gtf':
      return 'GTF';
    case 'genepred':
      return 'genePred';
    case 'refflat':
      return 'refFlat';
    case 'narrowpeak':
      return 'narrowPeak';
    case 'broadpeak':
      return 'broadPeak';
    default:
      return 'BED';
  }
}

function fail(format: string, line: number, detail: string): never {
  throw new Error(`${format} line ${line}: ${detail}.`);
}
