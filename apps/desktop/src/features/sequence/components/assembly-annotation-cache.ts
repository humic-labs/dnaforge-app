import type { Feature } from '@waypoint/genome-renderer';

export interface ProcessedAssemblyFeaturesCacheClassification {
  hit: boolean;
  cachedChroms: number;
  emptyChroms: string[];
  featuresByChrom: ReadonlyMap<string, Feature[]>;
}

export function classifyProcessedAssemblyFeaturesCache(
  indexedChroms: readonly string[],
  byChrom: Record<string, readonly unknown[] | undefined> | null | undefined
): ProcessedAssemblyFeaturesCacheClassification {
  const featuresByChrom = new Map<string, Feature[]>();
  const emptyChroms: string[] = [];
  for (const chrom of indexedChroms) {
    const feats = byChrom?.[chrom];
    if (Array.isArray(feats) && feats.length > 0) {
      featuresByChrom.set(chrom, feats as Feature[]);
    } else {
      emptyChroms.push(chrom);
    }
  }
  return {
    hit: featuresByChrom.size === indexedChroms.length,
    cachedChroms: featuresByChrom.size,
    emptyChroms,
    featuresByChrom,
  };
}
