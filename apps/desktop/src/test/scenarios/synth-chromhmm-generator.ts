import type { AnnotationRecord } from '@waypoint/genome-data';

const CHROMHMM_25_STATE_COLORS = [
  0xff0000, 0xff4500, 0xff4500, 0xff4500, 0x008000, 0x008000, 0x008000, 0x009600, 0xc2e105,
  0xc2e105, 0xc2e105, 0xc2e105, 0xffc34d, 0xffc34d, 0xffff00, 0xffff66, 0xffff66, 0xffff66,
  0xcd5c5c, 0x808080, 0x9370db, 0xbdb76b, 0xc0c0c0, 0x787878, 0xc0c0c0,
];

function makeLcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export interface SyntheticChromHMMOptions {
  count: number;
  chromLength: number;
  seed?: number;
  meanWidthBp?: number;
  widthVarMultiplier?: number;
  chrom?: string;
}

export function generateSyntheticChromHMM(options: SyntheticChromHMMOptions): AnnotationRecord[] {
  const {
    count,
    chromLength,
    seed = 42,
    meanWidthBp = 5000,
    widthVarMultiplier = 5,
    chrom = 'chr11',
  } = options;

  if (count < 0) throw new Error(`count must be non-negative`);
  if (chromLength <= 0) throw new Error(`chromLength must be positive`);
  if (meanWidthBp <= 0) throw new Error(`meanWidthBp must be positive`);
  if (count === 0) return [];

  const rng = makeLcg(seed);
  const records: AnnotationRecord[] = new Array(count);

  const widths = new Float64Array(count);
  let totalWidth = 0;
  for (let i = 0; i < count; i++) {
    const w = meanWidthBp * (0.2 + Math.pow(rng(), 2) * widthVarMultiplier);
    widths[i] = w;
    totalWidth += w;
  }
  const scale = chromLength / totalWidth;

  let cursor = 0;
  let prevColorIdx = -1;
  for (let i = 0; i < count; i++) {
    const w = Math.max(1, Math.floor(widths[i] * scale));
    const start = cursor;
    const end = Math.min(chromLength, cursor + w);
    let colorIdx;
    do {
      colorIdx = Math.floor(rng() * CHROMHMM_25_STATE_COLORS.length);
    } while (colorIdx === prevColorIdx);
    records[i] = {
      chrom,
      start,
      end,
      color: CHROMHMM_25_STATE_COLORS[colorIdx],
    };
    cursor = end;
    prevColorIdx = colorIdx;
    if (cursor >= chromLength) break;
  }
  if (records[count - 1].end < chromLength) {
    records[count - 1] = { ...records[count - 1], end: chromLength };
  }
  return records;
}

export { CHROMHMM_25_STATE_COLORS };
