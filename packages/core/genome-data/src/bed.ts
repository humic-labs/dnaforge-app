import type { AnnotationRecord } from './records';

export interface BedParseStats {
  total: number;
  parsed: number;
  skipped: number;
  malformed: number;
}

const HEADER_PREFIXES = ['#', 'track ', 'browser '];

function isHeaderLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return true;
  return HEADER_PREFIXES.some((p) => trimmed.startsWith(p));
}

export function parseBedLine(line: string): AnnotationRecord | null {
  if (isHeaderLine(line)) return null;

  const cols = line.split('\t');
  if (cols.length < 3) return null;

  const chrom = cols[0];
  const start = Number(cols[1]);
  const end = Number(cols[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || end <= start) return null;

  const record: AnnotationRecord = { chrom, start, end };

  if (cols.length >= 4 && cols[3] !== '') record.name = cols[3];

  if (cols.length >= 6) {
    const s = cols[5];
    if (s === '+' || s === '-' || s === '.') record.strand = s;
  }

  if (cols.length >= 9) {
    const color = parseItemRgb(cols[8]);
    if (color !== null) record.color = color;
  }

  return record;
}

export function parseBedFile(text: string, stats?: BedParseStats): AnnotationRecord[] {
  const out: AnnotationRecord[] = [];
  const lines = text.split('\n');
  let total = 0;
  let parsed = 0;
  let skipped = 0;
  let malformed = 0;

  for (const raw of lines) {
    total += 1;
    if (raw.length === 0) {
      skipped += 1;
      continue;
    }
    if (isHeaderLine(raw)) {
      skipped += 1;
      continue;
    }
    const record = parseBedLine(raw);
    if (record === null) {
      malformed += 1;
      continue;
    }
    out.push(record);
    parsed += 1;
  }

  if (stats) {
    stats.total = total;
    stats.parsed = parsed;
    stats.skipped = skipped;
    stats.malformed = malformed;
  }

  return out;
}

export function parseItemRgb(cell: string): number | null {
  const trimmed = cell.trim();
  if (trimmed === '' || trimmed === '0') return null;
  const parts = trimmed.split(',');
  if (parts.length !== 3) return null;
  const r = Number(parts[0]);
  const g = Number(parts[1]);
  const b = Number(parts[2]);
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null;
  if (r < 0 || g < 0 || b < 0 || r > 255 || g > 255 || b > 255) return null;
  return (r << 16) | (g << 8) | b;
}
