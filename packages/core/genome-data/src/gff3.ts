import type { GenomeFeature } from './types';

export function parseGff3Line(line: string, fileOffset?: number): GenomeFeature | null {
  if (!line || line.startsWith('#')) return null;

  const cols = line.split('\t');
  if (cols.length < 9) return null;

  const start1 = Number.parseInt(cols[3], 10);
  const end1 = Number.parseInt(cols[4], 10);
  if (!Number.isFinite(start1) || !Number.isFinite(end1)) return null;

  const strand = cols[6] === '+' || cols[6] === '-' ? cols[6] : '.';

  return {
    chrom: cols[0],
    source: cols[1],
    type: cols[2],
    start: start1 - 1,
    end: end1,
    score: cols[5] === '.' ? null : cols[5],
    strand,
    phase: cols[7] === '.' ? null : cols[7],
    attributes: parseAttributes(cols[8]),
    raw: line,
    fileOffset,
  };
}

function parseAttributes(raw: string): Record<string, string[]> {
  const attrs: Record<string, string[]> = {};
  for (const part of raw.split(';')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const key = eq >= 0 ? part.slice(0, eq) : part;
    if (!key) continue;
    const values: string[] = [];
    if (eq >= 0) {
      let from = eq + 1;
      while (from <= part.length) {
        let comma = part.indexOf(',', from);
        if (comma < 0) comma = part.length;
        if (comma > from) values.push(safeDecode(part.slice(from, comma)));
        from = comma + 1;
      }
    }
    attrs[key] = values;
  }
  return attrs;
}

function safeDecode(value: string): string {
  if (value.indexOf('%') < 0) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
