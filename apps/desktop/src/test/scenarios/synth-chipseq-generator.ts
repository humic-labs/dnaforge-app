import type { AnnotationRecord } from '@waypoint/genome-data';

export const CHIPSEQ_DEFAULT_COLOR = 0xd93eb5;

function makeLcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export interface SyntheticChipSeqOptions {
  count: number;
  chromLength: number;
  seed?: number;
  meanWidthBp?: number;
  widthRangeMultiplier?: number;
  color?: number;
  chrom?: string;
}

export function generateSyntheticChipSeq(options: SyntheticChipSeqOptions): AnnotationRecord[] {
  const {
    count,
    chromLength,
    seed = 42,
    meanWidthBp = 300,
    widthRangeMultiplier = 3,
    color = CHIPSEQ_DEFAULT_COLOR,
    chrom = 'chr11',
  } = options;

  if (count < 0) throw new Error(`count must be non-negative`);
  if (chromLength <= 0) throw new Error(`chromLength must be positive`);
  if (meanWidthBp <= 0) throw new Error(`meanWidthBp must be positive`);
  if (count === 0) return [];

  const rng = makeLcg(seed);
  const records: AnnotationRecord[] = new Array(count);

  const clusterSpanBp = Math.min(1_000_000, chromLength / 50);
  const clusterDensity = 0.5;
  const numClusters = Math.max(1, Math.floor((chromLength * clusterDensity) / clusterSpanBp));

  const clusterAnchors: number[] = [];
  for (let i = 0; i < numClusters; i++) {
    clusterAnchors.push(Math.floor(rng() * (chromLength - clusterSpanBp)));
  }
  clusterAnchors.sort((a, b) => a - b);

  for (let i = 0; i < count; i++) {
    const clusterIdx = Math.floor(rng() * clusterAnchors.length);
    const cAnchor = clusterAnchors[clusterIdx];
    const offsetInCluster = Math.floor(rng() * clusterSpanBp);
    const peakCenter = cAnchor + offsetInCluster;

    const widthSample = meanWidthBp * (0.5 + rng() * widthRangeMultiplier);
    const width = Math.max(100, Math.floor(widthSample));

    const start = Math.max(0, peakCenter - Math.floor(width / 2));
    const end = Math.min(chromLength, start + width);
    records[i] = { chrom, start, end, color };
  }
  records.sort((a, b) => a.start - b.start);
  return records;
}
