import type { GenomeFeature } from '@waypoint/genome-data';

const TRANSCRIPT_CHILD_TYPES: ReadonlySet<string> = new Set([
  'exon',
  'CDS',
  'five_prime_UTR',
  'three_prime_UTR',
  'UTR',
  'start_codon',
  'stop_codon',
]);

export function findOrphanParentIds(features: ReadonlyArray<GenomeFeature>): string[] {
  const byId = new Map<string, GenomeFeature>();
  for (const f of features) {
    const id = f.attributes.ID?.[0];
    if (id) byId.set(id, f);
  }

  const orphans = new Set<string>();
  for (const f of features) {
    if (!TRANSCRIPT_CHILD_TYPES.has(f.type)) continue;
    const parentRefs = f.attributes.Parent;
    if (!parentRefs || parentRefs.length === 0) continue;
    for (const parentRef of parentRefs) {
      const trimmed = parentRef.trim();
      if (!trimmed) continue;
      if (byId.has(trimmed)) continue;
      orphans.add(trimmed);
    }
  }
  return [...orphans].sort((a, b) => a.localeCompare(b));
}

export function findOrphanParentIdsBounded(
  features: ReadonlyArray<GenomeFeature>,
  maxIds: number
): { ids: string[]; truncated: boolean; total: number } {
  const all = findOrphanParentIds(features);
  if (maxIds <= 0) return { ids: [], truncated: all.length > 0, total: all.length };
  if (all.length <= maxIds) return { ids: all, truncated: false, total: all.length };
  return { ids: all.slice(0, maxIds), truncated: true, total: all.length };
}

export function markUnresolvedParents(
  features: GenomeFeature[],
  rescuedParentIds: ReadonlySet<string>
): number {
  let markedCount = 0;
  for (const f of features) {
    if (!TRANSCRIPT_CHILD_TYPES.has(f.type)) continue;
    const parentRefs = f.attributes.Parent;
    if (!parentRefs || parentRefs.length === 0) continue;
    const missing = parentRefs.find((ref) => {
      const trimmed = ref.trim();
      return trimmed.length > 0 && !rescuedParentIds.has(trimmed);
    });
    if (!missing) continue;
    f.attributes._unresolvedParentId = [missing.trim()];
    markedCount += 1;
  }
  return markedCount;
}
