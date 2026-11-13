export type CytoBandStain =
  | 'gneg'
  | 'gpos25'
  | 'gpos50'
  | 'gpos75'
  | 'gpos100'
  | 'acen'
  | 'gvar'
  | 'stalk';

export interface CytoBand {
  chrom: string;
  start: number;
  end: number;
  name: string;
  stain: CytoBandStain;
}

export function parseCytoBandTsv(text: string): CytoBand[] {
  const out: CytoBand[] = [];
  const lines = text.split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const raw = lines[lineIndex];
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith('#')) continue;
    const cols = line.split('\t');
    if (cols.length !== 5) {
      throw new Error(
        `parseCytoBandTsv: line ${lineIndex + 1} has ${cols.length} columns, expected 5 (chrom, start, end, name, stain). Got: ${JSON.stringify(line)}`
      );
    }
    const [chrom, startStr, endStr, name, stainStr] = cols;
    const start = Number.parseInt(startStr, 10);
    const end = Number.parseInt(endStr, 10);
    if (!Number.isInteger(start) || start < 0) {
      throw new Error(
        `parseCytoBandTsv: line ${lineIndex + 1} has invalid start "${startStr}" (expected non-negative integer).`
      );
    }
    if (!Number.isInteger(end) || end <= start) {
      throw new Error(
        `parseCytoBandTsv: line ${lineIndex + 1} has invalid end "${endStr}" (expected integer greater than start ${start}).`
      );
    }
    if (!isCytoBandStain(stainStr)) {
      throw new Error(
        `parseCytoBandTsv: line ${lineIndex + 1} has unknown stain "${stainStr}" (expected one of: gneg, gpos25, gpos50, gpos75, gpos100, acen, gvar, stalk).`
      );
    }
    out.push({ chrom, start, end, name, stain: stainStr });
  }
  return out;
}

function isCytoBandStain(value: string): value is CytoBandStain {
  return (
    value === 'gneg' ||
    value === 'gpos25' ||
    value === 'gpos50' ||
    value === 'gpos75' ||
    value === 'gpos100' ||
    value === 'acen' ||
    value === 'gvar' ||
    value === 'stalk'
  );
}

export const DEFAULT_CYTOBAND_STAIN_COLORS: Record<CytoBandStain, string> = {
  gneg: '#ffffff',
  gpos25: '#c0c0c0',
  gpos50: '#909090',
  gpos75: '#606060',
  gpos100: '#000000',
  acen: '#dd4444',
  gvar: '#4488ff',
  stalk: '#888888',
};

export function cytoBandStainColor(
  stain: CytoBandStain,
  overrides?: Partial<Record<CytoBandStain, string>>
): string {
  return overrides?.[stain] ?? DEFAULT_CYTOBAND_STAIN_COLORS[stain];
}

export function filterCytoBandsInRange(
  bands: ReadonlyArray<CytoBand>,
  start: number,
  end: number
): CytoBand[] {
  if (end <= start) return [];
  const out: CytoBand[] = [];
  for (const band of bands) {
    if (band.start < end && band.end > start) {
      out.push(band);
    }
  }
  return out;
}
