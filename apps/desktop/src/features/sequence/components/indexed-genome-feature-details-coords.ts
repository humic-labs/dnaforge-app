import type { Assembly } from '@waypoint/genome-renderer';
import { globalBpToChrom } from '@waypoint/genome-renderer';

export interface FeatureDetailsCoords {
  chrom: string;
  start: number;
  end: number;
}

export function resolveFeatureDetailsCoords(
  annotation: { start: number; end: number },
  opts: { rendererAssembly: Assembly | null; anchorChrom: string }
): FeatureDetailsCoords | null {
  const start = Math.max(0, Math.floor(annotation.start) - 1);
  const end = Math.max(start + 1, Math.ceil(annotation.end));

  if (!opts.rendererAssembly) {
    return { chrom: opts.anchorChrom, start, end };
  }

  const locus = globalBpToChrom(opts.rendererAssembly, start);
  if (!locus) return null;
  const localStart = start - locus.placement.globalStartBp;
  const localEnd = end - locus.placement.globalStartBp;
  if (localStart < 0 || localEnd > locus.placement.chromosome.length) return null;
  return { chrom: locus.chrom, start: localStart, end: localEnd };
}
