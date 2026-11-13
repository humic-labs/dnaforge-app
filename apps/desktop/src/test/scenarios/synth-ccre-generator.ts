import type { AnnotationRecord } from '@waypoint/genome-data';

const SYNTH_CCRE_CLASS_COLORS = [0xff0000, 0xffa500, 0xffff00, 0x0000ff, 0x00ff00];

function makeLcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export interface SyntheticCcreOptions {
  count: number;
  chromLength: number;
  seed?: number;
  minWidthBp?: number;
  maxWidthBp?: number;
  chrom?: string;
}

export function generateSyntheticCcre(options: SyntheticCcreOptions): AnnotationRecord[] {
  const {
    count,
    chromLength,
    seed = 42,
    minWidthBp = 100,
    maxWidthBp = 500,
    chrom = 'chr11',
  } = options;

  if (count < 0) throw new Error(`count must be non-negative, got ${count}`);
  if (chromLength <= 0) throw new Error(`chromLength must be positive`);
  if (minWidthBp <= 0 || maxWidthBp < minWidthBp) {
    throw new Error(`invalid width range: [${minWidthBp}, ${maxWidthBp}]`);
  }
  if (count === 0) return [];

  const rng = makeLcg(seed);
  const stride = chromLength / count;
  const widthRange = maxWidthBp - minWidthBp;
  const records: AnnotationRecord[] = new Array(count);

  for (let i = 0; i < count; i++) {
    const center = stride * (i + 0.5) + (rng() - 0.5) * stride * 0.5;
    const width = Math.floor(minWidthBp + rng() * widthRange);
    const start = Math.max(0, Math.floor(center - width / 2));
    const end = Math.min(chromLength, start + width);
    const color = SYNTH_CCRE_CLASS_COLORS[Math.floor(rng() * SYNTH_CCRE_CLASS_COLORS.length)];
    records[i] = { chrom, start, end, color };
  }

  records.sort((a, b) => a.start - b.start);
  return records;
}
