import type { AnnotationRecord } from '@waypoint/genome-data';

const REPEATMASKER_CLASS_COLORS = [
  0xe24a4a, 0xe24a4a, 0xe24a4a, 0xe24a4a, 0xe24a4a, 0xe24a4a, 0xe24a4a, 0xe24a4a, 0xe24a4a,
  0x4a78e2, 0x4a78e2, 0x4a78e2, 0x4a78e2, 0x4a78e2, 0x4a78e2, 0x2e8b57, 0x2e8b57, 0x2e8b57,
  0xff8c00, 0xff8c00, 0x808080,
];

function makeLcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export interface SyntheticRepeatMaskerOptions {
  count: number;
  chromLength: number;
  seed?: number;
  meanWidthBp?: number;
  longTailMultiplier?: number;
  chrom?: string;
}

export function generateSyntheticRepeatMasker(
  options: SyntheticRepeatMaskerOptions
): AnnotationRecord[] {
  const {
    count,
    chromLength,
    seed = 42,
    meanWidthBp = 200,
    longTailMultiplier = 50,
    chrom = 'chr11',
  } = options;

  if (count < 0) throw new Error(`count must be non-negative`);
  if (chromLength <= 0) throw new Error(`chromLength must be positive`);
  if (meanWidthBp <= 0) throw new Error(`meanWidthBp must be positive`);
  if (count === 0) return [];

  const rng = makeLcg(seed);
  const records: AnnotationRecord[] = new Array(count);
  const stride = chromLength / count;

  for (let i = 0; i < count; i++) {
    const isLong = rng() > 0.8;
    const widthSample = isLong
      ? meanWidthBp * (1 + rng() * longTailMultiplier)
      : meanWidthBp * (0.5 + rng() * 1.5);
    const width = Math.max(50, Math.floor(widthSample));

    const jitter = (rng() - 0.5) * stride * 0.6;
    const center = stride * (i + 0.5) + jitter;
    const start = Math.max(0, Math.floor(center - width / 2));
    const end = Math.min(chromLength, start + width);
    const color = REPEATMASKER_CLASS_COLORS[Math.floor(rng() * REPEATMASKER_CLASS_COLORS.length)];
    records[i] = { chrom, start, end, color };
  }
  records.sort((a, b) => a.start - b.start);
  return records;
}

export { REPEATMASKER_CLASS_COLORS };
