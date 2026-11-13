import type { ScientificTrackKind } from './admitted-track-source';
import type {
  AnnotationRecord,
  PeakRecord,
  QuantitativeBin,
  RepeatRecord,
  TranscriptRecord,
} from './records';

export interface RegionalTrackCoordinates {
  readonly chrom: string;
  readonly localStart: number;
  readonly localEnd: number;
  readonly globalStart: number;
}

export type AdaptedUcscTrackRecords =
  | { readonly scientificKind: 'transcript'; readonly records: TranscriptRecord[] }
  | { readonly scientificKind: 'interval'; readonly records: AnnotationRecord[] }
  | { readonly scientificKind: 'quantitative'; readonly records: QuantitativeBin[] }
  | { readonly scientificKind: 'peak'; readonly records: PeakRecord[] }
  | { readonly scientificKind: 'repeat'; readonly records: RepeatRecord[] };

type RawRecord = Readonly<Record<string, unknown>>;
type Adapter = (
  rawRecords: ReadonlyArray<RawRecord>,
  coordinates: RegionalTrackCoordinates
) => AdaptedUcscTrackRecords;

const ADAPTERS: Readonly<Partial<Record<ScientificTrackKind, Adapter>>> = {
  transcript: adaptTranscripts,
  interval: adaptIntervals,
  quantitative: adaptQuantitative,
  peak: adaptPeaks,
  repeat: adaptRepeats,
};

export function adaptUcscTrackRecords(
  scientificKind: ScientificTrackKind,
  rawRecords: ReadonlyArray<RawRecord>,
  coordinates: RegionalTrackCoordinates
): AdaptedUcscTrackRecords {
  const adapter = ADAPTERS[scientificKind];
  if (!adapter) {
    throw new Error(`UCSC ${scientificKind} records use their established dedicated workflow.`);
  }
  return adapter(rawRecords, coordinates);
}

function adaptIntervals(
  rawRecords: ReadonlyArray<RawRecord>,
  coordinates: RegionalTrackCoordinates
): Extract<AdaptedUcscTrackRecords, { scientificKind: 'interval' }> {
  return {
    scientificKind: 'interval',
    records: rawRecords.flatMap((raw) => {
      const bounds = recordBounds(raw, coordinates);
      if (!bounds) return [];
      const name = firstNonEmptyString(raw.name, raw.name2, raw.label);
      const strand = strandValue(raw.strand, true);
      const color = recordColor(raw);
      return [
        {
          chrom: coordinates.chrom,
          start: bounds.globalStart,
          end: bounds.globalEnd,
          ...(name ? { name } : {}),
          ...(strand ? { strand } : {}),
          ...(color === undefined ? {} : { color }),
          extra: { ...raw },
        },
      ];
    }),
  };
}

function adaptTranscripts(
  rawRecords: ReadonlyArray<RawRecord>,
  coordinates: RegionalTrackCoordinates
): Extract<AdaptedUcscTrackRecords, { scientificKind: 'transcript' }> {
  const records: TranscriptRecord[] = [];
  for (const raw of rawRecords) {
    const bounds = recordBounds(raw, coordinates);
    if (!bounds) continue;
    const transcriptId = firstNonEmptyString(raw.name, raw.transcriptId, raw.transcript_id);
    const strand = strandValue(raw.strand, false);
    if (!transcriptId || !strand) continue;

    const exons = exonIntervals(raw, bounds.localStart)
      .filter((exon) => exon.end > exon.start)
      .sort((left, right) => left.start - right.start);
    if (exons.length === 0) continue;

    const cdsStart = coordinate(raw.thickStart ?? raw.cdsStart ?? raw.cds_start);
    const cdsEnd = coordinate(raw.thickEnd ?? raw.cdsEnd ?? raw.cds_end);
    const frames = coordinateList(raw.exonFrames ?? raw.exon_frames);
    const cds =
      cdsStart !== null && cdsEnd !== null && cdsEnd > cdsStart
        ? exons.flatMap((exon, index) => {
            const start = Math.max(exon.start, cdsStart);
            const end = Math.min(exon.end, cdsEnd);
            if (end <= start) return [];
            const frame = frames[index];
            const phase: 0 | 1 | 2 | undefined =
              frame === 0 || frame === 1 || frame === 2 ? frame : undefined;
            return [
              {
                start: coordinates.globalStart + start,
                end: coordinates.globalStart + end,
                ...(phase === undefined ? {} : { phase }),
              },
            ];
          })
        : [];
    const color = recordColor(raw);
    records.push({
      chrom: coordinates.chrom,
      start: bounds.globalStart,
      end: bounds.globalEnd,
      transcriptId,
      geneId: firstNonEmptyString(raw.geneId, raw.gene_id, raw.name2),
      geneName: firstNonEmptyString(raw.geneName, raw.gene_name, raw.geneName2, raw.name2),
      strand,
      transcriptType: firstNonEmptyString(raw.transcriptType, raw.transcript_type, raw.type),
      exons: exons.map((exon) => ({
        start: coordinates.globalStart + exon.start,
        end: coordinates.globalStart + exon.end,
      })),
      cds,
      ...(color === undefined ? {} : { color }),
      extra: { ...raw },
    });
  }
  records.sort(compareStartEnd);
  return { scientificKind: 'transcript', records };
}

function adaptPeaks(
  rawRecords: ReadonlyArray<RawRecord>,
  coordinates: RegionalTrackCoordinates
): Extract<AdaptedUcscTrackRecords, { scientificKind: 'peak' }> {
  const records: PeakRecord[] = [];
  for (const raw of rawRecords) {
    const bounds = recordBounds(raw, coordinates);
    if (!bounds) continue;
    const peakOffset = coordinate(raw.peak);
    const absoluteSummit = coordinate(raw.summit);
    const summit =
      peakOffset !== null && peakOffset >= 0
        ? bounds.globalStart + peakOffset
        : absoluteSummit !== null
          ? coordinates.globalStart + absoluteSummit
          : undefined;
    const color = recordColor(raw);
    records.push({
      chrom: coordinates.chrom,
      start: bounds.globalStart,
      end: bounds.globalEnd,
      name: firstNonEmptyString(raw.name, raw.label),
      strand: strandValue(raw.strand, true),
      ...(color === undefined ? {} : { color }),
      ...(summit === undefined ? {} : { summit }),
      score: finiteNumber(raw.score),
      signalValue: finiteNumber(raw.signalValue ?? raw.signal_value),
      pValue: finiteNumber(raw.pValue ?? raw.p_value),
      qValue: finiteNumber(raw.qValue ?? raw.q_value),
      extra: { ...raw },
    });
  }
  records.sort(compareStartEnd);
  return { scientificKind: 'peak', records };
}

function adaptRepeats(
  rawRecords: ReadonlyArray<RawRecord>,
  coordinates: RegionalTrackCoordinates
): Extract<AdaptedUcscTrackRecords, { scientificKind: 'repeat' }> {
  const intervalRecords = adaptIntervals(rawRecords, coordinates).records;
  return {
    scientificKind: 'repeat',
    records: intervalRecords.map((record) => {
      const raw = record.extra ?? {};
      return {
        ...record,
        repeatClass: firstNonEmptyString(raw.repClass, raw.repeatClass, raw.class),
        repeatFamily: firstNonEmptyString(raw.repFamily, raw.repeatFamily, raw.family),
        color:
          record.color ??
          repeatClassColor(firstNonEmptyString(raw.repClass, raw.repeatClass, raw.class)),
      };
    }),
  };
}

function repeatClassColor(repeatClass: string | undefined): number {
  switch (repeatClass?.toUpperCase()) {
    case 'LINE':
      return 0x2563eb;
    case 'SINE':
      return 0x0d9488;
    case 'LTR':
      return 0x9333ea;
    case 'DNA':
      return 0xea580c;
    case 'SIMPLE_REPEAT':
    case 'LOW_COMPLEXITY':
      return 0x64748b;
    default:
      return 0x475569;
  }
}

function adaptQuantitative(
  rawRecords: ReadonlyArray<RawRecord>,
  coordinates: RegionalTrackCoordinates
): Extract<AdaptedUcscTrackRecords, { scientificKind: 'quantitative' }> {
  const records: QuantitativeBin[] = [];
  for (const raw of rawRecords) {
    const bounds = recordBounds(raw, coordinates);
    const value = finiteNumber(raw.value ?? raw.score);
    if (!bounds || value === undefined) continue;
    records.push({
      chrom: coordinates.chrom,
      start: bounds.globalStart,
      end: bounds.globalEnd,
      value,
    });
  }
  records.sort(compareStartEnd);
  return { scientificKind: 'quantitative', records };
}

function recordBounds(
  raw: RawRecord,
  coordinates: RegionalTrackCoordinates
): { localStart: number; localEnd: number; globalStart: number; globalEnd: number } | null {
  const localStart = coordinate(raw.chromStart ?? raw.start ?? raw.txStart);
  const localEnd = coordinate(raw.chromEnd ?? raw.end ?? raw.txEnd);
  if (
    localStart === null ||
    localEnd === null ||
    localEnd <= localStart ||
    localStart >= coordinates.localEnd ||
    localEnd <= coordinates.localStart
  ) {
    return null;
  }
  return {
    localStart,
    localEnd,
    globalStart: coordinates.globalStart + localStart,
    globalEnd: coordinates.globalStart + localEnd,
  };
}

function exonIntervals(
  raw: RawRecord,
  transcriptStart: number
): Array<{ start: number; end: number }> {
  const absoluteStarts = coordinateList(raw.exonStarts ?? raw.exon_starts);
  const absoluteEnds = coordinateList(raw.exonEnds ?? raw.exon_ends);
  if (absoluteStarts.length > 0 && absoluteStarts.length === absoluteEnds.length) {
    return absoluteStarts.map((start, index) => ({ start, end: absoluteEnds[index] }));
  }

  const blockSizes = coordinateList(raw.blockSizes ?? raw.block_sizes);
  const blockStarts = coordinateList(raw.chromStarts ?? raw.blockStarts ?? raw.block_starts);
  if (blockSizes.length === 0 || blockSizes.length !== blockStarts.length) return [];
  return blockStarts.map((relativeStart, index) => ({
    start: transcriptStart + relativeStart,
    end: transcriptStart + relativeStart + blockSizes[index],
  }));
}

function coordinateList(value: unknown): number[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',').filter((entry) => entry.trim() !== '')
      : [];
  return values.flatMap((entry) => {
    const parsed = coordinate(entry);
    return parsed === null ? [] : [parsed];
  });
}

function coordinate(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value);
  return null;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function strandValue(value: unknown, allowUnstranded: true): '+' | '-' | '.' | undefined;
function strandValue(value: unknown, allowUnstranded: false): '+' | '-' | undefined;
function strandValue(value: unknown, allowUnstranded: boolean): '+' | '-' | '.' | undefined {
  if (value === '+' || value === '-') return value;
  return allowUnstranded ? '.' : undefined;
}

function recordColor(raw: RawRecord): number | undefined {
  const value = raw.itemRgb ?? raw.reserved ?? raw.color;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffff) {
    return value;
  }
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  const rgb = /^(\d{1,3}),(\d{1,3}),(\d{1,3})$/.exec(trimmed);
  if (rgb) {
    const channels = rgb.slice(1).map(Number);
    if (channels.every((channel) => channel >= 0 && channel <= 255)) {
      return (channels[0] << 16) | (channels[1] << 8) | channels[2];
    }
  }
  const hex = /^#?([0-9a-f]{6})$/i.exec(trimmed);
  return hex ? Number.parseInt(hex[1], 16) : undefined;
}

function compareStartEnd(
  left: { start: number; end: number },
  right: { start: number; end: number }
): number {
  return left.start - right.start || left.end - right.end;
}
